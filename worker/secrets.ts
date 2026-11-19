// Secrets admins save in the app (sign-in settings, invite-mailbox tokens) are encrypted with a *data key*: a random key
// made on first use and kept in `settings` (row `data_key`), itself encrypted with TOKEN_KEY, the one secret each
// instance is deployed with (tenants/<name>.env).
//
// Changing TOKEN_KEY only re-encrypts the data key: deploy with the new key in TOKEN_KEY and the old one in
// TOKEN_KEY_OLD, and the first request re-wraps it; nothing has to be entered again. Without the old key the data key
// can't be opened, and what was sealed with it is gone: Settings says so and offers to start over (startOver()).
import { type Env, nowIso } from './lib';
import { openToken, sealToken } from './token-crypto';

/** Shorter keys aren't used (encryption, or setting up the instance): `npm run tenant` makes 43-character ones. */
export const TOKEN_KEY_MIN = 32;
export type KeyStatus = 'ok' | 'no_key' | 'key_changed';

const WRAP = 'data-key';
export const tokenKeyOk = (env: Env) => (env.TOKEN_KEY ?? '').length >= TOKEN_KEY_MIN;

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const readRow = (db: D1Database) => db.prepare("SELECT value FROM settings WHERE key = 'data_key'").first<{ value: string }>();

/** Per isolate, so the data key is unwrapped once rather than on every request. */
let cached: { tokenKey: string; material: string } | null = null;

/** The data key (as key material for sealToken / openToken), or why there isn't one. */
export async function dataKey(env: Env): Promise<{ status: 'ok'; material: string } | { status: Exclude<KeyStatus, 'ok'> }> {
  if (!tokenKeyOk(env)) return { status: 'no_key' };
  const tk = env.TOKEN_KEY!;
  if (cached?.tokenKey === tk) return { status: 'ok', material: cached.material };
  const db = env.DB;
  let row = await readRow(db);
  if (!row?.value) {
    // First use: make one. If two requests race, the first insert wins and both read it back.
    const fresh = b64(crypto.getRandomValues(new Uint8Array(32)));
    await db.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('data_key', ?, NULL, ?) ON CONFLICT (key) DO NOTHING")
      .bind(await sealToken(tk, WRAP, fresh), nowIso()).run();
    row = await readRow(db);
    if (!row?.value) return { status: 'key_changed' };
  }
  let material = await openToken(tk, WRAP, row.value);
  if (!material && env.TOKEN_KEY_OLD) {
    material = await openToken(env.TOKEN_KEY_OLD, WRAP, row.value);
    if (material) {
      await db.prepare("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'data_key' AND value = ?")
        .bind(await sealToken(tk, WRAP, material), nowIso(), row.value).run();
      console.log('TOKEN_KEY changed: the data key now uses the new key. TOKEN_KEY_OLD can be removed.');
    }
  }
  if (!material) return { status: 'key_changed' };
  cached = { tokenKey: tk, material };
  return { status: 'ok', material };
}

/** Encrypts with the data key (`info` keeps each kind of secret's key apart). Null when there's no usable data key. */
export async function seal(env: Env, info: string, plain: string): Promise<string | null> {
  const k = await dataKey(env);
  return k.status === 'ok' ? sealToken(k.material, info, plain) : null;
}

/** Decrypts what seal() made; null when it can't be read. */
export async function open(env: Env, info: string, stored: string): Promise<string | null> {
  const k = await dataKey(env);
  return k.status === 'ok' ? openToken(k.material, info, stored) : null;
}

/**
 * After TOKEN_KEY changed without TOKEN_KEY_OLD: forgets the unreadable data key and everything sealed with it (the
 * saved sign-in settings and the invite mailboxes), so a new data key is made. Admins then enter the settings again.
 */
export async function startOver(env: Env) {
  cached = null;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM settings WHERE key IN ('data_key', 'signin', 'signin_pending')"),
    env.DB.prepare('DELETE FROM mailboxes'),
  ]);
}
