// Running as an app on the SleekSite platform (cf-controller, docs/app-spec.md). The controller deploys one instance
// per customer and sets WORKSPACE_ID, CONTROLLER_URL and CONTROLLER_KEY; without them nothing here applies and
// Taskivities behaves as a self-hosted install.
//
//   GET  /_health                  the controller checks it after every deploy
//   GET  /_admin/auth/sso          "Open" from the SleekSite console: a 60-second token → a session here
//   PUT  /_platform/owners         the account's owners: kept as admins here
//   POST /_platform/tick           scheduled work (morning summaries) instead of a Cron Trigger
//   PUT  /_platform/quota          storage against the plan's allowance; "over" pauses new attachments
//
// Tokens are HS256 JWTs signed with CONTROLLER_KEY (this instance's own key), valid 60 seconds, each used once.
import { Hono } from 'hono';
import { type Env, bumpDirectory } from './lib';
import { USER_COLORS } from '../shared/types';
import { morningSummaries } from './push';

type PlatformEnv = Pick<Env, 'WORKSPACE_ID' | 'CONTROLLER_KEY' | 'CONTROLLER_URL'>;
export const onPlatform = (env: PlatformEnv) => !!(env.WORKSPACE_ID && env.CONTROLLER_KEY);

// ---------- JWT (same format as the controller) ----------

const enc = new TextEncoder();
const b64u = (b: Uint8Array | string) => btoa(typeof b === 'string' ? b : String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
const hmacKey = (secret: string) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function signJwt(claims: object, secret: string) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), body = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(new Uint8Array(sig))}`;
}

export async function verifyJwt<T = Record<string, unknown>>(token: string, secret: string, now = Date.now()): Promise<T | null> {
  const [head, body, sig] = String(token || '').split('.');
  if (!head || !body || !sig) return null;
  try {
    if (JSON.parse(new TextDecoder().decode(fromB64u(head))).alg !== 'HS256') return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64u(sig), enc.encode(`${head}.${body}`)))) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    return typeof c.exp === 'number' && c.exp * 1000 + 30_000 > now ? (c as T) : null;
  } catch {
    return null;
  }
}

type Claims = { iss: string; typ: string; aud: string; sub?: string; name?: string; owner?: boolean; staff?: boolean; iat: number; exp: number; jti: string };

/** A controller token for this instance: signature, issuer, type, audience, a short lifetime, and never used before. */
export async function controllerToken(env: Env, token: string, typ: 'sso' | 'api'): Promise<Claims | null> {
  if (!onPlatform(env)) return null;
  const c = await verifyJwt<Claims>(token, env.CONTROLLER_KEY!);
  if (!c || c.iss !== 'sleeksite-controller' || c.typ !== typ || c.aud !== env.WORKSPACE_ID || !c.jti || c.exp - c.iat > 300) return null;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM platform_jti WHERE exp < ?').bind(now - 60).run();
  const fresh = await env.DB.prepare('INSERT INTO platform_jti (jti, exp) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING jti').bind(c.jti, c.exp).first();
  return fresh ? c : null;
}

/** A signed call to the controller's tenant API (/api/tenant/*). Throws with the controller's message. */
export async function controllerFetch(env: Env, path: string, body?: unknown) {
  const iat = Math.floor(Date.now() / 1000);
  const token = await signJwt({ iss: 'sleeksite-tenant', typ: 'tenant', aud: 'sleeksite-controller', sub: env.WORKSPACE_ID, iat, exp: iat + 60, jti: crypto.randomUUID() }, env.CONTROLLER_KEY!);
  const r = await fetch(env.CONTROLLER_URL!.replace(/\/$/, '') + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error || `The platform answered ${r.status}.`);
  return data;
}

// ---------- storage allowance ----------

export const STORAGE_FULL = 'This workspace has used all of its storage. Remove some files, or upgrade in the SleekSite console, to attach more.';
/** Over the plan's storage allowance (the controller measures it daily and says so with PUT /_platform/quota). */
export async function storageFull(env: Env) {
  if (!onPlatform(env)) return false;
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'platform_storage'").first<{ value: string }>())?.value === 'over';
}

// ---------- the controller's calls ----------

export const platformRoutes = new Hono<{ Bindings: Env }>();

platformRoutes.use('*', async (c, next) => {
  const token = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!(await controllerToken(c.env, token, 'api'))) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Make sure someone exists here and can sign in: owners are admins; a removed or invited person is made active. */
export async function ensurePerson(env: Env, email: string, name: string, admin: boolean) {
  const db = env.DB;
  const now = new Date().toISOString();
  const role = admin ? 'admin' : 'member';
  const color = USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
  await db.batch([
    db.prepare(
      `INSERT INTO users (id, email, name, color, role, status, added_by, added_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, 'active', NULL, ?6, NULL)
       ON CONFLICT(email) DO UPDATE SET status = 'active', role = CASE WHEN ?5 = 'admin' THEN 'admin' ELSE users.role END,
         name = CASE WHEN users.name = '' THEN ?3 ELSE users.name END`,
    ).bind(crypto.randomUUID(), email, name, color, role, now),
    bumpDirectory(db),
  ]);
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<{ id: string; email: string }>();
}

platformRoutes.put('/owners', async (c) => {
  const b = await c.req.json<{ owners?: unknown[] }>().catch(() => ({} as { owners?: unknown[] }));
  const owners = (b.owners || []).map((e) => String(e).trim().toLowerCase()).filter((e) => EMAIL_RE.test(e));
  if (!owners.length) return c.json({ error: 'An account needs at least one owner.' }, 400);
  // Owners become admins. Former owners stay as they are; the admins here decide about them.
  for (const e of owners) await ensurePerson(c.env, e, '', true);
  return c.json({ ok: true });
});

platformRoutes.post('/tick', async (c) => {
  await morningSummaries(c.env);
  return c.json({ ok: true });
});

platformRoutes.put('/quota', async (c) => {
  const b = await c.req.json<{ storage?: string }>().catch(() => ({} as { storage?: string }));
  const state = b.storage === 'over' || b.storage === 'warn' ? b.storage : 'ok';
  await c.env.DB.prepare("INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('platform_storage', ?, NULL, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(state, new Date().toISOString()).run();
  return c.json({ ok: true, storage: state });
});
