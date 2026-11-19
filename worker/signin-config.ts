// Sign-in settings (Google, Microsoft 365, WorkOS, email codes) and the drive pickers' keys, saved by admins in the app
// (Settings → Sign-in, worker/signin-settings.ts) and kept encrypted in `settings` (row `signin`) with the data key
// (worker/secrets.ts).
//
// The rest of the Worker keeps reading them as env values (env.GOOGLE_CLIENT_ID, …): withConfig() lays the saved values
// over the environment at the start of every request. Deploy-time variables only fill in a setting the first time the
// instance sees it (`seeded`), so existing instances move over with nothing to re-enter, and from then on the app's
// value is the one used: changing or removing the variable later does nothing.
//
// Without a usable TOKEN_KEY (an instance not yet deployed with one) or when it can't be read, the environment is used
// as it is, exactly as before; Settings shows the values but can't change them.
import { type Env, nowIso } from './lib';
import { type KeyStatus, dataKey } from './secrets';
import { openToken, sealToken } from './token-crypto';

export const CONFIG_KEYS = [
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_PICKER_API_KEY', 'GOOGLE_APP_ID',
  'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_FILES',
  'WORKOS_CLIENT_ID', 'WORKOS_API_KEY',
  'EMAIL_CODES', 'RESEND_API_KEY', 'MAIL_FROM', 'MAIL_FROM_NAME',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export type ConfigValues = Partial<Record<ConfigKey, string>>;
/** Never sent back to the browser, only "set" and their last four characters. */
export const SECRET_KEYS: readonly ConfigKey[] = ['GOOGLE_CLIENT_SECRET', 'GOOGLE_PICKER_API_KEY', 'MS_CLIENT_SECRET', 'WORKOS_API_KEY', 'RESEND_API_KEY'];

const INFO = 'signin-config';
const PENDING_INFO = 'signin-pending';
interface Stored { values: ConfigValues; seeded: ConfigKey[] }
export interface ConfigState { status: KeyStatus; values: ConfigValues }

const fromEnv = (env: Env): ConfigValues => Object.fromEntries(CONFIG_KEYS.filter((k) => env[k]).map((k) => [k, env[k]!]));
const readSetting = (db: D1Database, key: string) => db.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
const putSetting = (db: D1Database, key: string, value: string, actorId: string | null) =>
  db.prepare(
    'INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
  ).bind(key, value, actorId, nowIso());

// Kept briefly per isolate: one D1 read every few seconds rather than on every request. A save here clears it; other
// isolates catch up within TTL.
const TTL = 10_000;
let cache: { at: number; tokenKey: string; state: ConfigState } | null = null;
export const forgetConfig = () => { cache = null; };

/** The saved settings (seeding any not seen before from the environment), or the environment's when they can't be used. */
export async function configState(env: Env, fresh = false): Promise<ConfigState> {
  if (!fresh && cache && cache.tokenKey === env.TOKEN_KEY && Date.now() - cache.at < TTL) return cache.state;
  const state = await load(env);
  cache = { at: Date.now(), tokenKey: env.TOKEN_KEY ?? '', state };
  return state;
}

async function load(env: Env): Promise<ConfigState> {
  const k = await dataKey(env);
  if (k.status !== 'ok') return { status: k.status, values: fromEnv(env) };
  const row = await readSetting(env.DB, 'signin');
  let stored: Stored = { values: {}, seeded: [] };
  if (row?.value) {
    const plain = await openToken(k.material, INFO, row.value);
    if (!plain) return { status: 'key_changed', values: fromEnv(env) };
    stored = JSON.parse(plain) as Stored;
  }
  const unseen = CONFIG_KEYS.filter((key) => !stored.seeded.includes(key));
  if (unseen.length) {
    for (const key of unseen) if (env[key] && stored.values[key] === undefined) stored.values[key] = env[key];
    stored.seeded = [...stored.seeded, ...unseen];
    await putSetting(env.DB, 'signin', await sealToken(k.material, INFO, JSON.stringify(stored)), null).run();
  }
  return { status: 'ok', values: stored.values };
}

/** The environment with the saved settings laid over it: what every route reads. */
export async function withConfig(env: Env): Promise<Env> {
  const st = await configState(env);
  if (st.status !== 'ok') return env;
  return { ...env, ...Object.fromEntries(CONFIG_KEYS.map((key) => [key, st.values[key] || undefined])) };
}

/** Saves changes (an empty string clears a setting). Throws when the settings can't be saved here (no usable key). */
export async function saveConfig(env: Env, actorId: string, changes: ConfigValues): Promise<ConfigValues> {
  const k = await dataKey(env);
  if (k.status !== 'ok') throw new Error('Settings can’t be saved without a working TOKEN_KEY.');
  const st = await configState(env, true);
  const values: ConfigValues = { ...st.values };
  for (const [key, v] of Object.entries(changes) as [ConfigKey, string][]) {
    if (v) values[key] = v;
    else delete values[key];
  }
  const stored: Stored = { values, seeded: [...CONFIG_KEYS] };
  await putSetting(env.DB, 'signin', await sealToken(k.material, INFO, JSON.stringify(stored)), actorId).run();
  forgetConfig();
  return values;
}

// ---------- a sign-in waiting to be tested (Settings → "Save and test") ----------
// New Google, Microsoft or WorkOS credentials are only saved once a real sign-in with them has worked, so a typo can't
// lock everyone out. Until then they wait here, one at a time, for 15 minutes.
export type TestProvider = 'google' | 'microsoft' | 'workos';
export interface Pending { nonce: string; provider: TestProvider; values: ConfigValues; at: number; by: string }
const PENDING_MS = 15 * 60_000;

export async function savePending(env: Env, p: Pending) {
  const k = await dataKey(env);
  if (k.status !== 'ok') throw new Error('Settings can’t be saved without a working TOKEN_KEY.');
  await putSetting(env.DB, 'signin_pending', await sealToken(k.material, PENDING_INFO, JSON.stringify(p)), p.by).run();
}

/** The waiting test with this nonce, if it's still fresh. */
export async function loadPending(env: Env, nonce: string, provider: TestProvider): Promise<Pending | null> {
  const k = await dataKey(env);
  if (k.status !== 'ok') return null;
  const row = await readSetting(env.DB, 'signin_pending');
  const plain = row?.value ? await openToken(k.material, PENDING_INFO, row.value) : null;
  const p = plain ? (JSON.parse(plain) as Pending) : null;
  return p && p.nonce === nonce && p.provider === provider && Date.now() - p.at < PENDING_MS ? p : null;
}

export const clearPending = (env: Env) => env.DB.prepare("DELETE FROM settings WHERE key = 'signin_pending'").run();
