// Email the instance sends as itself (sign-in codes), through the sender set up in Settings → Sign-in. One provider for
// now, Resend (an API key and a From address on a domain verified there); sendMail() is the one place to add others.
import type { Env } from './lib';

export interface Mail { to: string; subject: string; text: string; html: string }
export type MailResult = { ok: true } | { ok: false; error: string };

/** Just the sender settings: the Worker's environment, or values being tried before they're saved. */
type MailEnv = Pick<Env, 'EMAIL_CODES' | 'RESEND_API_KEY' | 'MAIL_FROM' | 'MAIL_FROM_NAME'>;

export const mailOn = (env: MailEnv) => !!(env.RESEND_API_KEY && env.MAIL_FROM);
/** Sign-in with an emailed code is offered: turned on, with a sender to send the codes. */
export const codesOn = (env: MailEnv) => env.EMAIL_CODES === 'on' && mailOn(env);

const oneLine = (s: string) => s.replace(/[\r\n"<>]+/g, ' ').trim();

/** Sends one email from MAIL_FROM. `fromName` defaults to MAIL_FROM_NAME. Never throws. */
export async function sendMail(env: MailEnv, m: Mail, fromName = env.MAIL_FROM_NAME || ''): Promise<MailResult> {
  if (!mailOn(env)) return { ok: false, error: 'No email sender is set up.' };
  const name = oneLine(fromName);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: name ? `${name} <${env.MAIL_FROM}>` : env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (res.ok) return { ok: true };
    const body = await res.json<{ message?: string }>().catch(() => ({} as { message?: string }));
    return { ok: false, error: body.message || `Resend refused it (${res.status}).` };
  } catch {
    return { ok: false, error: "Couldn't reach Resend." };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** The sign-in code email. */
export function codeMail(to: string, app: string, code: string, minutes: number): Mail {
  const subject = `${code} is your ${app} sign-in code`;
  const text = [
    `Your code to sign in to ${app}:`,
    '',
    code,
    '',
    `It works for ${minutes} minutes, in the browser where you asked for it.`,
    "If you didn't ask for it, you can ignore this email: nobody can sign in without the code.",
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d27">
<div style="max-width:420px;margin:0 auto;background:#fff;border:1px solid #e7e7ee;border-radius:14px;padding:28px">
<p style="margin:0 0 16px;font-size:15px;line-height:1.55">Your code to sign in to <b>${esc(app)}</b>:</p>
<p style="margin:0 0 18px;font-size:30px;font-weight:700;letter-spacing:.18em;font-family:ui-monospace,Menlo,Consolas,monospace">${esc(code)}</p>
<p style="margin:0;font-size:12.5px;line-height:1.5;color:#8a8a96">It works for ${minutes} minutes, in the browser where you asked for it (${esc(to)}).
If you didn't ask for it, you can ignore this email: nobody can sign in without the code.</p>
</div></body></html>`;
  return { to, subject, text, html };
}
