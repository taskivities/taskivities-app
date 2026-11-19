// Settings → Sign-in (admins): how people sign in here, the email sender for sign-in codes, and the drive pickers' keys.
// Saved encrypted by worker/signin-config.ts. Secret values never come back to the browser: only whether each is set,
// and its last four characters.
//
// Mounted on /api only, not /v1 (an exception to docs/multi-instance.md rule 2, on purpose): /v1 accepts the OAuth
// tokens AI assistants and other instances' apps use, and those shouldn't be able to change how people sign in.
import { Hono } from 'hono';
import { EMAIL_RE } from '../shared/rules';
import type { SigninField, SigninProvider, SigninSettings } from '../shared/types';
import { type AppEnv, type Ctx, auditStmt, bad, conflict, forbidden, randomToken } from './lib';
import { codeMail, codesOn, mailOn, sendMail } from './mailer';
import { msTenant } from './microsoft';
import { loadSettings } from './settings';
import { startOver, tokenKeyOk } from './secrets';
import {
  type ConfigKey, type ConfigValues, CONFIG_KEYS, SECRET_KEYS, configState, forgetConfig, saveConfig, savePending,
} from './signin-config';
import { appName } from '../shared/types';

export const signinAdmin = new Hono<AppEnv>();

signinAdmin.use('*', async (c, next) => {
  if (c.get('viewer').role !== 'admin') throw forbidden('Only admins can do that.');
  await next();
});

/** Which settings each part of the page saves. */
const FIELDS: Record<SigninProvider, ConfigKey[]> = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  microsoft: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID'],
  workos: ['WORKOS_CLIENT_ID', 'WORKOS_API_KEY'],
  email: ['EMAIL_CODES', 'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME'],
  files: ['GOOGLE_PICKER_API_KEY', 'GOOGLE_APP_ID', 'MS_FILES'],
};

/** Which ways in each set of values turns on (the email sender alone doesn't, until codes are on too). */
const methodsOn = (v: ConfigValues) => ({
  google: !!(v.GOOGLE_CLIENT_ID && v.GOOGLE_CLIENT_SECRET),
  microsoft: !!(v.MS_CLIENT_ID && v.MS_CLIENT_SECRET && msTenant(v)),
  workos: !!(v.WORKOS_CLIENT_ID && v.WORKOS_API_KEY),
  code: codesOn(v),
});

async function describe(c: Ctx): Promise<SigninSettings> {
  const st = await configState(c.env, true);
  const origin = new URL(c.req.url).origin;
  const fields = Object.fromEntries(CONFIG_KEYS.map((k): [ConfigKey, SigninField] => {
    const v = st.values[k];
    if (!v) return [k, { set: false }];
    return [k, SECRET_KEYS.includes(k) ? { set: true, hint: v.slice(-4) } : { set: true, value: v }];
  })) as Record<ConfigKey, SigninField>;
  return {
    status: st.status === 'no_key' && c.env.TOKEN_KEY ? 'short_key' : st.status,
    fields,
    on: methodsOn(st.values),
    defaultFromName: appName(await loadSettings(c.env.DB)),
    redirects: {
      google: `${origin}/auth/callback`,
      microsoft: `${origin}/auth/microsoft/callback`,
      workos: `${origin}/auth/workos/callback`,
      workosSignin: `${origin}/auth/workos`,
      pickerOrigin: origin,
      onedrive: `${origin}/picker-signin.html`,
    },
  };
}

signinAdmin.get('/', async (c) => c.json(await describe(c)));

/** One line of text, trimmed; '' clears it. */
function clean(k: ConfigKey, raw: unknown): string {
  if (typeof raw !== 'string') throw bad(`${k} must be text.`);
  const v = raw.trim();
  if (/[\r\n]/.test(v) || v.length > 2000) throw bad('That value is too long, or has line breaks in it.');
  if (k === 'MS_TENANT_ID' && v && !msTenant({ MS_TENANT_ID: v }))
    throw bad('The tenant must be your organization’s tenant ID (a GUID) or one of its domains, never “common”, “organizations” or “consumers”.');
  if (k === 'MAIL_FROM' && v && !EMAIL_RE.test(v)) throw bad('The From address must be an email address, like tasks@yourcompany.com.');
  if ((k === 'EMAIL_CODES' || k === 'MS_FILES') && v && v !== 'on') throw bad(`${k} is "on" or empty.`);
  if (k === 'MAIL_FROM_NAME' && /["<>]/.test(v)) throw bad('The From name can’t contain quotes or angle brackets.');
  return v;
}

/**
 * Saves one part of the page. Values given replace the saved ones ('' clears one); ones left out stay as they are.
 * New Google, Microsoft or WorkOS credentials aren't saved yet: the answer is a `test` address, a real sign-in that
 * saves them once it works (worker/auth.ts). New email settings are saved once a test email to the admin is accepted.
 */
signinAdmin.put('/:provider{google|microsoft|workos|email|files}', async (c) => {
  const provider = c.req.param('provider') as SigninProvider;
  const v = c.get('viewer');
  if (!tokenKeyOk(c.env)) throw conflict('Sign-in settings are set by the deployment on this instance. Add TOKEN_KEY to its tenants file and deploy to manage them here.');
  const st = await configState(c.env, true);
  if (st.status !== 'ok') throw conflict('The saved settings can’t be read with this TOKEN_KEY. Start over below, or deploy with the old key as TOKEN_KEY_OLD.');
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const changes: ConfigValues = {};
  for (const k of FIELDS[provider]) if (k in body) changes[k] = clean(k, body[k]);
  if (!Object.keys(changes).length) throw bad('Nothing to save.');
  const merged: ConfigValues = { ...st.values, ...changes };
  for (const k of Object.keys(merged) as ConfigKey[]) if (!merged[k]) delete merged[k];
  const part = Object.fromEntries(FIELDS[provider].map((k) => [k, merged[k] ?? ''])) as ConfigValues;

  // Never leave the instance with no way in.
  const after = methodsOn(merged);
  if (!Object.values(after).some(Boolean) && Object.values(methodsOn(st.values)).some(Boolean))
    throw bad('That would leave no way to sign in. Set up another way first.');

  if (provider === 'google' || provider === 'microsoft' || provider === 'workos') {
    const filled = FIELDS[provider].filter((k) => part[k]);
    if (filled.length && filled.length < FIELDS[provider].length) throw bad('Fill in every field, or turn it off.');
    if (filled.length) {
      // Only a change to the credentials themselves needs a test.
      const nonce = randomToken(18);
      await savePending(c.env, { nonce, provider, values: part, at: Date.now(), by: v.id });
      return c.json({ test: `/auth/test/${provider}?nonce=${nonce}` });
    }
  }

  if (provider === 'email' && merged.EMAIL_CODES === 'on') {
    if (!mailOn(merged)) throw bad('Codes need a Resend API key and a From address.');
    const app = appName(await loadSettings(c.env.DB));
    const changedSender = (['RESEND_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME', 'EMAIL_CODES'] as const).some((k) => k in changes && changes[k] !== st.values[k]);
    if (changedSender) {
      const mail = codeMail(v.email, app, '123456', 10);
      mail.subject = `Test: sign-in codes for ${app} are on`;
      const r = await sendMail(part, mail, part.MAIL_FROM_NAME || app);
      if (!r.ok) throw bad(`The test email to ${v.email} wasn't sent: ${r.error}`);
    }
  }

  await saveConfig(c.env, v.id, changes);
  await auditStmt(c.env.DB, v.id, 'signin_settings_changed', null, { provider, keys: Object.keys(changes) }).run();
  return c.json(await describe(c));
});

/** After TOKEN_KEY changed without TOKEN_KEY_OLD: forget what can't be read, and start again with this key. */
signinAdmin.post('/start-over', async (c) => {
  const v = c.get('viewer');
  const st = await configState(c.env, true);
  if (st.status !== 'key_changed') throw conflict('The saved settings can be read: there’s nothing to start over.');
  await startOver(c.env);
  forgetConfig();
  await auditStmt(c.env.DB, v.id, 'signin_settings_reset', null, null).run();
  return c.json(await describe(c));
});
