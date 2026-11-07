// The invite email itself (no Worker imports, so it can be tested on its own).

export interface InviteInfo {
  to: string;
  fromName: string;
  fromEmail: string;
  role: 'admin' | 'member';
  projects: string[];
  /** Where to sign in, e.g. https://tasks.acme.com/login */
  link: string;
  /** The app's name (Settings → Name); "Taskivities" when none is set. */
  app?: string;
  /** How people sign in on this instance, e.g. ['Microsoft'] or ['Google', 'Microsoft']. Empty: just "sign in". */
  signInWith?: string[];
}

/** What happened when invites were emailed (worker/gmail.ts, worker/outlook.ts). */
export type SendStatus = 'sent' | 'not_connected' | 'failed';
export interface SendResult {
  status: SendStatus;
  sent: string[];
  failed: string[];
  /** Why it fell back, for the admin (e.g. the connection expired). */
  reason?: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
/** RFC 2047 for headers that may hold non-ASCII (names, subject). */
const word = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
/** Header injection guard: no line breaks in anything that goes into a header. */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

const list = (xs: string[], and = 'and') => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`);
/** "Sign in with Microsoft", "Sign in with Google or Microsoft", or plain "Sign in". */
const signInVerb = (i: InviteInfo) => (i.signInWith?.length ? `Sign in with ${list(i.signInWith.map(oneLine), 'or')}` : 'Sign in');

export function inviteText(i: InviteInfo) {
  const who = i.fromName || i.fromEmail;
  const app = oneLine(i.app || '') || 'Taskivities';
  const what = i.role === 'admin'
    ? "You're an admin: you can see every project and manage the team."
    : `You're on ${i.projects.length === 1 ? 'the project' : 'these projects'}: ${list(i.projects)}.`;
  const subject = `${who} invited you to ${app}`;
  const text = [
    'Hi,',
    '',
    `${who} added you to ${app}, where the team keeps track of who's doing what and when.`,
    what,
    '',
    `${signInVerb(i)} using this address (${i.to}):`,
    i.link,
    '',
    `— ${who}`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d27">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e7e7ee;border-radius:14px;padding:28px">
<p style="margin:0 0 14px;font-size:15px;line-height:1.55"><b>${esc(who)}</b> added you to <b>${esc(app)}</b>, where the team keeps track of who's doing what and when.</p>
<p style="margin:0 0 22px;font-size:14px;line-height:1.55;color:#55555f">${esc(what)}</p>
<a href="${esc(i.link)}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 20px;border-radius:9px">Sign in to ${esc(app)}</a>
<p style="margin:22px 0 0;font-size:12.5px;line-height:1.5;color:#8a8a96">${esc(signInVerb(i))} using <b>${esc(i.to)}</b>. Other addresses won't have access.<br>Or open: <a href="${esc(i.link)}" style="color:#4f46e5">${esc(i.link)}</a></p>
</div></body></html>`;
  return { subject, text, html };
}

/** A complete MIME message (text + HTML), base64url-encoded for the Gmail API's `raw` field. */
export function inviteRaw(i: InviteInfo, boundary = `tv_${crypto.randomUUID()}`) {
  const { subject, text, html } = inviteText(i);
  const from = `${word(oneLine(i.fromName || i.fromEmail))} <${oneLine(i.fromEmail)}>`;
  const msg = [
    `From: ${from}`,
    `To: ${oneLine(i.to)}`,
    `Subject: ${word(oneLine(subject))}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap(b64(html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return b64(msg).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
