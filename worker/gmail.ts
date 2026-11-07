// Invite emails sent from the inviting admin's own Gmail (optional).
//
// An admin connects once (Settings → Invite emails). That asks Google for the gmail.send permission only:
// send mail as them, never read it. The refresh token is stored encrypted in google_tokens.
// Everything here fails soft: no connection, a missing permission, a revoked token or a Gmail error
// all come back as a status, and the app falls back to "share the sign-in link yourself".
import { type Env, nowIso } from './lib';
import { type InviteInfo, inviteRaw } from './invite-mail';

export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';

export type SendStatus = 'sent' | 'not_connected' | 'failed';
export interface SendResult {
  status: SendStatus;
  sent: string[];
  failed: string[];
  /** Why it fell back, for the admin (e.g. the connection expired). */
  reason?: string;
}

interface TokenRow { user_id: string; email: string; refresh_token: string; scope: string }

// ---------- encryption ----------
// Key: TOKEN_KEY if set, otherwise derived from GOOGLE_CLIENT_SECRET (so there's nothing extra to set up).
// Changing either just makes stored tokens unreadable: admins reconnect.
async function key(env: Env, info = 'google-refresh-token') {
  // Other instances' access tokens (worker/feed.ts) also work on instances without Google sign-in: the push key is
  // always there.
  const material = env.TOKEN_KEY || env.GOOGLE_CLIENT_SECRET || (info === 'google-refresh-token' ? undefined : env.VAPID_PRIVATE_KEY);
  if (!material) return null;
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('taskivities'), info: new TextEncoder().encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

export async function encrypt(env: Env, plain: string, info?: string) {
  const k = await key(env, info);
  if (!k) throw new Error('No encryption key');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plain)));
  return `v1.${toB64(iv)}.${toB64(ct)}`;
}
export async function decrypt(env: Env, stored: string, info?: string): Promise<string | null> {
  try {
    const [v, iv, ct] = stored.split('.');
    const k = await key(env, info);
    if (v !== 'v1' || !k) return null;
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, k, fromB64(ct)));
  } catch {
    return null;
  }
}

// ---------- the stored connection ----------
const getRow = (db: D1Database, userId: string) =>
  db.prepare('SELECT user_id, email, refresh_token, scope FROM google_tokens WHERE user_id = ?').bind(userId).first<TokenRow>();

/** For the app: is this admin's Gmail connected, and as which address. */
export async function gmailStatus(env: Env, userId: string): Promise<{ email: string } | null> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null; // can't send without Google set up
  const row = await getRow(env.DB, userId).catch(() => null);
  return row ? { email: row.email } : null;
}

export async function saveConnection(env: Env, userId: string, email: string, refreshToken: string, scope: string) {
  const now = nowIso();
  await env.DB.prepare(
    'INSERT INTO google_tokens (user_id, email, refresh_token, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, scope = excluded.scope, updated_at = excluded.updated_at',
  ).bind(userId, email, await encrypt(env, refreshToken), scope, now, now).run();
}

const forget = (db: D1Database, userId: string) => db.prepare('DELETE FROM google_tokens WHERE user_id = ?').bind(userId).run();

/** Deletes the connection and revokes it at Google (best effort). */
export async function disconnect(env: Env, userId: string) {
  const row = await getRow(env.DB, userId);
  if (!row) return;
  await forget(env.DB, userId);
  const token = await decrypt(env, row.refresh_token);
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }
}

/** A fresh access token, or why there isn't one. Drops the stored connection when Google says it's no longer valid. */
async function accessToken(env: Env, userId: string): Promise<{ token: string; from: string } | { status: SendStatus; reason?: string }> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return { status: 'not_connected' };
  const row = await getRow(env.DB, userId).catch(() => null);
  if (!row) return { status: 'not_connected' };
  const refresh = await decrypt(env, row.refresh_token);
  if (!refresh) {
    await forget(env.DB, userId);
    return { status: 'not_connected', reason: 'Your Gmail connection needs to be set up again.' };
  }
  let res: Response;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: 'refresh_token' }),
    });
  } catch {
    return { status: 'failed', reason: "Couldn't reach Google." };
  }
  const body = await res.json<{ access_token?: string; scope?: string; error?: string }>().catch(() => ({} as { access_token?: string; scope?: string; error?: string }));
  if (!res.ok || !body.access_token) {
    if (body.error === 'invalid_grant') {
      // Revoked, expired (e.g. a Google app still in "testing" expires them after 7 days) or the password changed.
      await forget(env.DB, userId);
      return { status: 'not_connected', reason: 'Your Gmail connection expired or was removed. Connect it again in Settings.' };
    }
    return { status: 'failed', reason: 'Google refused the request.' };
  }
  if (body.scope && !body.scope.split(' ').includes(GMAIL_SEND)) {
    await forget(env.DB, userId);
    return { status: 'not_connected', reason: "Gmail sending permission isn't granted any more. Connect it again in Settings." };
  }
  return { token: body.access_token, from: row.email };
}

/** Emails each person an invite from the admin's Gmail. Never throws. */
export async function sendInvites(
  env: Env,
  sender: { id: string; name: string },
  people: Omit<InviteInfo, 'fromName' | 'fromEmail'>[],
): Promise<SendResult> {
  if (!people.length) return { status: 'sent', sent: [], failed: [] };
  const all = people.map((p) => p.to);
  const t = await accessToken(env, sender.id).catch(() => ({ status: 'failed' as const, reason: 'Something went wrong.' }));
  if ('status' in t) return { status: t.status, sent: [], failed: all, reason: t.reason };

  const sent: string[] = [];
  const failed: string[] = [];
  let lostPermission = false;
  await Promise.all(people.map(async (p) => {
    try {
      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: inviteRaw({ ...p, fromName: sender.name, fromEmail: t.from }) }),
      });
      if (res.ok) sent.push(p.to);
      else {
        if (res.status === 401 || res.status === 403) lostPermission = true;
        failed.push(p.to);
      }
    } catch {
      failed.push(p.to);
    }
  }));
  if (lostPermission && !sent.length) {
    await forget(env.DB, sender.id);
    return { status: 'not_connected', sent, failed, reason: "Gmail didn't allow sending. Connect it again in Settings (and check the Gmail API is turned on)." };
  }
  return { status: failed.length ? 'failed' : 'sent', sent, failed, reason: failed.length ? "Gmail didn't send some of them." : undefined };
}
