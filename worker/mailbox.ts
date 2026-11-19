// Invite emails sent from the inviting admin's own mailbox: their Gmail or their Outlook (Microsoft 365). Optional:
// without one, the app offers the sign-in link to share instead.
//
// One shape for both providers. An admin connects once (Settings → Invite emails): the provider's consent screen asks
// to *send* mail as them (never read it), plus offline access for a refresh token. Connecting reuses the instance's
// own sign-in app and callback (worker/auth.ts), so there's no extra redirect URI to register, and it has to be the
// same account they sign in with. The refresh token is kept encrypted in `mailboxes` (migration 0018), one row per
// admin, so connecting one provider replaces the other. It's sealed with the instance's data key (worker/secrets.ts);
// connections made before there was one (sealed with TOKEN_KEY or the client secret) are still read, and re-sealed.
//
// Everything fails soft: no connection, a withdrawn permission, an expired or unreadable token, or a send error all
// come back as a status (and a dead connection is dropped). The person is still added; the admin gets the link.
import { type Env, nowIso } from './lib';
import { type InviteInfo, inviteRaw, inviteText } from './invite-mail';
import { msBase, msOn } from './microsoft';
import { openToken, sealToken } from './token-crypto';
import { open, seal } from './secrets';
import type { MailboxVia } from '../shared/types';

export type SendStatus = 'sent' | 'not_connected' | 'failed';
export interface SendResult {
  status: SendStatus;
  sent: string[];
  failed: string[];
  /** Why it fell back, for the admin (e.g. the connection expired). */
  reason?: string;
}

// ---------- the two providers ----------
interface Provider {
  name: string;
  /** Usable here: that provider's sign-in is set up. */
  on(env: Env): boolean;
  /** Encryption before the data key (and without a TOKEN_KEY): key material, newest first, and a per-provider label. */
  legacy(env: Env): string[];
  info: string;
  /** Asked for when connecting (send only). */
  scope: string;
  /** Does a granted scope string include sending? */
  canSend(scope: string): boolean;
  tokenUrl(env: Env): string;
  client(env: Env): { client_id: string; client_secret: string };
  /** Extra fields on refresh (Microsoft wants the scope again). */
  refreshExtra?: Record<string, string>;
  /** Sends one invite. */
  send(token: string, from: string, mail: InviteInfo): Promise<Response>;
  /** Best effort; Microsoft has no endpoint to revoke one token (an unused one expires after 90 days). */
  revoke?(token: string): Promise<void>;
}

export const GMAIL_SEND = 'https://www.googleapis.com/auth/gmail.send';
const googleOn = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const PROVIDERS: Record<MailboxVia, Provider> = {
  gmail: {
    name: 'Gmail',
    on: googleOn,
    legacy: (env) => [env.TOKEN_KEY, env.GOOGLE_CLIENT_SECRET].filter((m): m is string => !!m),
    info: 'google-refresh-token',
    scope: `openid email ${GMAIL_SEND}`,
    canSend: (scope) => scope.split(' ').includes(GMAIL_SEND),
    tokenUrl: () => 'https://oauth2.googleapis.com/token',
    client: (env) => ({ client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! }),
    send: (token, from, mail) => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: inviteRaw({ ...mail, fromEmail: from }) }),
    }),
    revoke: async (token) => {
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }),
      }).catch(() => undefined);
    },
  },
  outlook: {
    name: 'Outlook',
    on: msOn,
    legacy: (env) => [env.TOKEN_KEY, env.MS_CLIENT_SECRET].filter((m): m is string => !!m),
    info: 'microsoft-refresh-token',
    // User.Read checks the mailbox is the admin's own (Graph /me). Never Mail.Read.
    scope: 'openid email offline_access User.Read Mail.Send',
    // Microsoft lists granted scopes as URLs ("https://graph.microsoft.com/Mail.Send"): match either form.
    canSend: (scope) => scope.split(' ').some((s) => s.toLowerCase().split('/').pop() === 'mail.send'),
    tokenUrl: (env) => `${msBase(env)}/token`,
    client: (env) => ({ client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET! }),
    refreshExtra: { scope: 'openid email offline_access User.Read Mail.Send' },
    send: (token, from, mail) => {
      const { subject, html } = inviteText({ ...mail, fromEmail: from });
      return fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: mail.to } }] }, saveToSentItems: true }),
      });
    },
  },
};
export const mailboxProvider = (via: MailboxVia) => PROVIDERS[via];
export const isMailboxVia = (x: unknown): x is MailboxVia => x === 'gmail' || x === 'outlook';

/** Which mailboxes admins can connect here (each needs its provider's sign-in). Outlook first: Microsoft-only teams. */
export const mailboxOptions = (env: Env): MailboxVia[] => (['outlook', 'gmail'] as const).filter((v) => PROVIDERS[v].on(env));

// ---------- the stored connection ----------
interface Row { user_id: string; via: MailboxVia; email: string; refresh_token: string; scope: string }
const getRow = (db: D1Database, userId: string) =>
  db.prepare('SELECT user_id, via, email, refresh_token, scope FROM mailboxes WHERE user_id = ?').bind(userId).first<Row>();
const forget = (db: D1Database, userId: string) => db.prepare('DELETE FROM mailboxes WHERE user_id = ?').bind(userId).run();

/** Sealed with the data key; the old way only while the instance has no usable TOKEN_KEY. */
const sealRefresh = async (env: Env, p: Provider, plain: string) => (await seal(env, p.info, plain)) ?? sealToken(p.legacy(env)[0], p.info, plain);

/** The stored refresh token, or null. One sealed the old way is moved to the data key once it's read. */
async function openRefresh(env: Env, p: Provider, row: Row): Promise<string | null> {
  const plain = await open(env, p.info, row.refresh_token);
  if (plain) return plain;
  for (const material of p.legacy(env)) {
    const old = await openToken(material, p.info, row.refresh_token);
    if (!old) continue;
    const again = await seal(env, p.info, old);
    if (again) {
      await env.DB.prepare('UPDATE mailboxes SET refresh_token = ? WHERE user_id = ? AND refresh_token = ?')
        .bind(again, row.user_id, row.refresh_token).run().catch(() => undefined);
    }
    return old;
  }
  return null;
}

/** For the app: where this admin's invites are emailed from, or null. */
export async function mailboxStatus(env: Env, userId: string): Promise<{ via: MailboxVia; email: string } | null> {
  const row = await getRow(env.DB, userId).catch(() => null);
  return row && PROVIDERS[row.via]?.on(env) ? { via: row.via, email: row.email } : null;
}

/** Saves (or replaces) an admin's mailbox. Replacing another provider's revokes that one (best effort). */
export async function saveMailbox(env: Env, userId: string, via: MailboxVia, email: string, refreshToken: string, scope: string) {
  const p = PROVIDERS[via];
  const old = await getRow(env.DB, userId).catch(() => null);
  const now = nowIso();
  await env.DB.prepare(
    'INSERT INTO mailboxes (user_id, via, email, refresh_token, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (user_id) DO UPDATE SET via = excluded.via, email = excluded.email, refresh_token = excluded.refresh_token, scope = excluded.scope, updated_at = excluded.updated_at',
  ).bind(userId, via, email, await sealRefresh(env, p, refreshToken), scope, now, now).run();
  if (old && old.via !== via) await revokeRow(env, old);
}

async function revokeRow(env: Env, row: Row) {
  const p = PROVIDERS[row.via];
  if (!p?.revoke) return;
  const token = await openRefresh(env, p, row);
  if (token) await p.revoke(token);
}

/** Deletes the connection, and revokes it where the provider allows. */
export async function disconnectMailbox(env: Env, userId: string) {
  const row = await getRow(env.DB, userId).catch(() => null);
  if (!row) return;
  await forget(env.DB, userId);
  await revokeRow(env, row);
}

const AGAIN = 'Connect it again in Settings.';

/** A fresh access token, or why there isn't one. Drops the stored connection when the provider says it's no good. */
async function accessToken(env: Env, userId: string): Promise<{ row: Row; token: string } | { status: SendStatus; reason?: string }> {
  const row = await getRow(env.DB, userId).catch(() => null);
  if (!row) return { status: 'not_connected' };
  const p = PROVIDERS[row.via];
  if (!p?.on(env)) return { status: 'not_connected' };
  const refresh = await openRefresh(env, p, row);
  if (!refresh) {
    await forget(env.DB, userId);
    return { status: 'not_connected', reason: `Your ${p.name} connection needs to be set up again. ${AGAIN}` };
  }
  let res: Response;
  try {
    res = await fetch(p.tokenUrl(env), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...p.client(env), refresh_token: refresh, grant_type: 'refresh_token', ...p.refreshExtra }),
    });
  } catch {
    return { status: 'failed', reason: `Couldn't reach ${row.via === 'gmail' ? 'Google' : 'Microsoft'}.` };
  }
  type Body = { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  const body = await res.json<Body>().catch(() => ({} as Body));
  if (!res.ok || !body.access_token) {
    // invalid_grant: revoked, expired, or the password changed. interaction_required (Microsoft): consent withdrawn,
    // or a sign-in policy wants the person present. Only connecting again fixes either.
    if (body.error === 'invalid_grant' || body.error === 'interaction_required') {
      await forget(env.DB, userId);
      return { status: 'not_connected', reason: `Your ${p.name} connection expired or was removed. ${AGAIN}` };
    }
    return { status: 'failed', reason: `${row.via === 'gmail' ? 'Google' : 'Microsoft'} refused the request.` };
  }
  if (body.scope && !p.canSend(body.scope)) {
    await forget(env.DB, userId);
    return { status: 'not_connected', reason: `${p.name} sending permission isn't granted any more. ${AGAIN}` };
  }
  // Microsoft rotates refresh tokens: keep the new one.
  if (body.refresh_token && body.refresh_token !== refresh) {
    await saveMailbox(env, userId, row.via, row.email, body.refresh_token, body.scope ?? row.scope).catch(() => undefined);
  }
  return { row, token: body.access_token };
}

/** Emails each person an invite from the admin's mailbox. Never throws. */
export async function sendInvites(env: Env, sender: { id: string; name: string }, people: Omit<InviteInfo, 'fromName' | 'fromEmail'>[]): Promise<SendResult> {
  if (!people.length) return { status: 'sent', sent: [], failed: [] };
  const all = people.map((p) => p.to);
  const t = await accessToken(env, sender.id).catch(() => ({ status: 'failed' as const, reason: 'Something went wrong.' }));
  if ('status' in t) return { status: t.status, sent: [], failed: all, reason: t.reason };
  const p = PROVIDERS[t.row.via];

  const sent: string[] = [];
  const failed: string[] = [];
  let lostPermission = false;
  let noMailbox = false;
  await Promise.all(people.map(async (person) => {
    try {
      const res = await p.send(t.token, t.row.email, { ...person, fromName: sender.name, fromEmail: t.row.email });
      if (res.ok) { sent.push(person.to); return; }
      if (res.status === 401 || res.status === 403) lostPermission = true;
      // A Microsoft account without an Exchange Online mailbox (no licence) can sign in but can't send.
      if (t.row.via === 'outlook' && (res.status === 404 || /MailboxNotEnabled/i.test(await res.text().catch(() => '')))) noMailbox = true;
      failed.push(person.to);
    } catch {
      failed.push(person.to);
    }
  }));
  if (!sent.length && noMailbox) return { status: 'failed', sent, failed, reason: "Your Microsoft account doesn't have an Outlook mailbox to send from." };
  if (!sent.length && lostPermission) {
    await forget(env.DB, sender.id);
    const hint = t.row.via === 'gmail' ? ' (and check the Gmail API is turned on)' : '';
    return { status: 'not_connected', sent, failed, reason: `${p.name} didn't allow sending. ${AGAIN.replace('.', '')}${hint}.` };
  }
  return { status: failed.length ? 'failed' : 'sent', sent, failed, reason: failed.length ? `${p.name} didn't send some of them.` : undefined };
}
