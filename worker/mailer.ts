// Invite emails go out from whichever mailbox the inviting admin connected: Gmail (worker/gmail.ts) or Outlook
// (worker/outlook.ts). An admin has at most one; connecting one removes the other (worker/auth.ts).
import type { Env } from './lib';
import type { InviteInfo, SendResult } from './invite-mail';
import { disconnect as disconnectGmail, gmailStatus, sendInvites as sendGmailInvites } from './gmail';
import { msOn } from './microsoft';
import { disconnectOutlook, outlookStatus, sendOutlookInvites } from './outlook';

export type InviteMailVia = 'gmail' | 'outlook';

const googleOn = (env: Env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

/** Which mailboxes admins can connect here: each needs that provider's sign-in set up. Outlook first, when both. */
export const inviteMailOptions = (env: Env): InviteMailVia[] =>
  [msOn(env) ? 'outlook' as const : null, googleOn(env) ? 'gmail' as const : null].filter((v): v is InviteMailVia => !!v);

/** How people sign in on this instance, for "sign in with … using this address" (in the app and in invite emails). */
export const signInWith = (env: Env): string[] =>
  [googleOn(env) && 'Google', msOn(env) && 'Microsoft', !!(env.WORKOS_CLIENT_ID && env.WORKOS_API_KEY) && 'email']
    .filter((v): v is string => !!v);

/** Where this admin's invites are emailed from, or null when neither is connected. */
export async function inviteMailStatus(env: Env, userId: string): Promise<{ via: InviteMailVia; email: string } | null> {
  const [outlook, gmail] = await Promise.all([outlookStatus(env, userId), gmailStatus(env, userId)]);
  if (outlook) return { via: 'outlook', email: outlook.email };
  if (gmail) return { via: 'gmail', email: gmail.email };
  return null;
}

/** Emails each person an invite from the admin's connected mailbox. Never throws. */
export async function sendInvites(
  env: Env,
  sender: { id: string; name: string },
  people: Omit<InviteInfo, 'fromName' | 'fromEmail'>[],
): Promise<SendResult> {
  const withSignIn = people.map((p) => ({ ...p, signInWith: signInWith(env) }));
  if (await outlookStatus(env, sender.id).catch(() => null)) return sendOutlookInvites(env, sender, withSignIn);
  return sendGmailInvites(env, sender, withSignIn);
}

/** Removes the admin's invite-mail connection, whichever it is. */
export async function disconnectInviteMail(env: Env, userId: string) {
  await Promise.all([disconnectGmail(env, userId), disconnectOutlook(env, userId)]);
}
