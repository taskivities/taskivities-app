// Invite emails sent from the inviting admin's own Outlook (Microsoft 365) mailbox. Optional: the Microsoft twin of
// worker/gmail.ts, for instances that sign in with Microsoft.
//
// An admin connects once (Settings → Invite emails). That asks the instance's own tenant for Mail.Send, plus
// offline_access for a refresh token: send mail as them, never read it. The refresh token is stored encrypted in
// microsoft_tokens. Microsoft rotates refresh tokens, so each refresh stores the new one. Everything fails soft, as
// with Gmail: no connection, a withdrawn permission, an expired token or a Graph error all come back as a status, and
// the app falls back to "share the sign-in link yourself".
import { type Env, nowIso } from './lib';
import { type InviteInfo, type SendResult, type SendStatus, inviteText } from './invite-mail';
import { msBase, msOn } from './microsoft';
import { openToken, sealToken } from './token-crypto';

/** Asked for when connecting. User.Read is for checking the mailbox is the admin's own (Graph /me). */
export const OUTLOOK_SCOPE = 'openid email offline_access User.Read Mail.Send';
/** Microsoft lists granted scopes as URLs ("https://graph.microsoft.com/Mail.Send"); this matches either form. */
export const hasMailSend = (scope: string | undefined) =>
  (scope ?? '').split(' ').some((s) => s.toLowerCase().split('/').pop() === 'mail.send');

interface TokenRow { user_id: string; email: string; refresh_token: string; scope: string }

// ---------- encryption (worker/token-crypto.ts) ----------
// Key: TOKEN_KEY if set, otherwise derived from MS_CLIENT_SECRET. Rotating the client secret (Entra secrets expire)
// makes stored tokens unreadable: the admin is told to connect again.
const INFO = 'microsoft-refresh-token';
const material = (env: Env) => env.TOKEN_KEY || env.MS_CLIENT_SECRET;

// ---------- the stored connection ----------
const getRow = (db: D1Database, userId: string) =>
  db.prepare('SELECT user_id, email, refresh_token, scope FROM microsoft_tokens WHERE user_id = ?').bind(userId).first<TokenRow>();

/** For the app: is this admin's Outlook connected, and as which address. */
export async function outlookStatus(env: Env, userId: string): Promise<{ email: string } | null> {
  if (!msOn(env)) return null; // can't send without Microsoft sign-in set up
  const row = await getRow(env.DB, userId).catch(() => null);
  return row ? { email: row.email } : null;
}

export async function saveOutlookConnection(env: Env, userId: string, email: string, refreshToken: string, scope: string) {
  const now = nowIso();
  await env.DB.prepare(
    'INSERT INTO microsoft_tokens (user_id, email, refresh_token, scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, scope = excluded.scope, updated_at = excluded.updated_at',
  ).bind(userId, email, await sealToken(material(env), INFO, refreshToken), scope, now, now).run();
}

const forget = (db: D1Database, userId: string) => db.prepare('DELETE FROM microsoft_tokens WHERE user_id = ?').bind(userId).run();

/** Deletes the connection. Microsoft can't revoke a single refresh token from here; unused, it expires after 90 days. */
export async function disconnectOutlook(env: Env, userId: string) {
  await forget(env.DB, userId);
}

const AGAIN = 'Connect it again in Settings.';

/** A fresh access token, or why there isn't one. Drops the stored connection when Microsoft says it's no longer valid. */
async function accessToken(env: Env, userId: string): Promise<{ token: string; from: string } | { status: SendStatus; reason?: string }> {
  if (!msOn(env)) return { status: 'not_connected' };
  const row = await getRow(env.DB, userId).catch(() => null);
  if (!row) return { status: 'not_connected' };
  const refresh = await openToken(material(env), INFO, row.refresh_token);
  if (!refresh) {
    await forget(env.DB, userId);
    return { status: 'not_connected', reason: `Your Outlook connection needs to be set up again. ${AGAIN}` };
  }
  let res: Response;
  try {
    res = await fetch(`${msBase(env)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET!, refresh_token: refresh, grant_type: 'refresh_token', scope: OUTLOOK_SCOPE,
      }),
    });
  } catch {
    return { status: 'failed', reason: "Couldn't reach Microsoft." };
  }
  type TokenBody = { access_token?: string; refresh_token?: string; scope?: string; error?: string };
  const body = await res.json<TokenBody>().catch(() => ({} as TokenBody));
  if (!res.ok || !body.access_token) {
    // invalid_grant: expired (90 days unused), revoked, or the password changed. interaction_required: consent was
    // withdrawn, or a sign-in policy now wants the person present. Either way only connecting again fixes it.
    if (body.error === 'invalid_grant' || body.error === 'interaction_required') {
      await forget(env.DB, userId);
      return { status: 'not_connected', reason: `Your Outlook connection expired or was removed. ${AGAIN}` };
    }
    return { status: 'failed', reason: 'Microsoft refused the request.' };
  }
  if (body.scope && !hasMailSend(body.scope)) {
    await forget(env.DB, userId);
    return { status: 'not_connected', reason: `Outlook sending permission isn't granted any more. ${AGAIN}` };
  }
  if (body.refresh_token && body.refresh_token !== refresh) {
    await saveOutlookConnection(env, userId, row.email, body.refresh_token, body.scope ?? row.scope).catch(() => undefined);
  }
  return { token: body.access_token, from: row.email };
}

/** Emails each person an invite from the admin's Outlook (Microsoft Graph sendMail). Never throws. */
export async function sendOutlookInvites(
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
  let noMailbox = false;
  await Promise.all(people.map(async (p) => {
    const { subject, html } = inviteText({ ...p, fromName: sender.name, fromEmail: t.from });
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST',
        headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: p.to } }] },
          saveToSentItems: true,
        }),
      });
      if (res.ok) { sent.push(p.to); return; }
      if (res.status === 401 || res.status === 403) lostPermission = true;
      // An account without an Exchange Online mailbox (no licence) can sign in but can't send.
      if (res.status === 404 || /MailboxNotEnabled/i.test(await res.text().catch(() => ''))) noMailbox = true;
      failed.push(p.to);
    } catch {
      failed.push(p.to);
    }
  }));
  if (!sent.length && noMailbox) {
    return { status: 'failed', sent, failed, reason: "Your Microsoft account doesn't have an Outlook mailbox to send from." };
  }
  if (!sent.length && lostPermission) {
    await forget(env.DB, sender.id);
    return { status: 'not_connected', sent, failed, reason: `Outlook didn't allow sending. ${AGAIN}` };
  }
  return { status: failed.length ? 'failed' : 'sent', sent, failed, reason: failed.length ? "Outlook didn't send some of them." : undefined };
}
