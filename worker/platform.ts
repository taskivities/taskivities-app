// Running as an app on the SleekSky platform (cf-controller: docs/app-auth.md, docs/site/tenant-api.md,
// docs/site/runtime.md, docs/site/manifest.md). The controller deploys one instance per customer and sets APP_ID,
// CONTROLLER_URL (the console, for browser redirects) and the SKY service binding; without APP_ID and SKY nothing
// here applies and Taskivities behaves as a self-hosted install.
//
// Everything this app asks of the platform goes over SKY (https://sky/api/tenant/*). The binding tells the platform
// which app is calling, so no key or token is sent:
//   GET  init                  this app, its services, the allowance and storage state (cached per isolate for its ttl)
//   POST mail/signin-code      email a sign-in code from the platform's mail domain
//   POST signins/remove        someone signed in through the platform but was refused here
//
// The platform's calls into this instance (the dispatch Worker refuses outside requests to /_platform/*, so no token):
//   GET  /_health              checked after every deploy
//   POST /_platform/tick       every 30 minutes (sleeksky.json "schedules"): morning summaries instead of a Cron Trigger
//
// Sign-in through the platform (worker/auth.ts, "platform_signin" in sleeksky.json): GET /auth/platform sends the
// browser to the console's /auth, which comes back to /auth/platform/callback with a one-time code; this app swaps it
// over SKY (POST https://sky/auth/token) for who signed in. Account owners (and platform staff, for support) are admins
// here; anyone else gets in only if they're already a user.
import { Hono } from 'hono';
import { type Env, bumpDirectory } from './lib';
import { USER_COLORS } from '../shared/types';
import { morningSummaries } from './push';

type PlatformEnv = Pick<Env, 'APP_ID' | 'SKY'>;
export const onPlatform = (env: PlatformEnv) => !!(env.APP_ID && env.SKY);

/** A call to the platform over SKY (`path` like '/api/tenant/init' or '/auth/token'). Throws with the platform's message. */
export async function controllerFetch(env: PlatformEnv, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!onPlatform(env)) throw new Error("This instance isn't on the SleekSky platform.");
  const r = await env.SKY!.fetch('https://sky' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(data.error || `The platform answered ${r.status}.`));
  return data;
}

export type PlatformInfo = {
  app: { id: string; name: string; subdomain: string; product: string | null; account: string | null };
  services: string[];
  allowance: { total: number; spent: number; left: number } | null;
  storage: 'ok' | 'warn' | 'over';
};
let info: { at: number; ttl: number; data: PlatformInfo | null } | null = null;
let asking: Promise<void> | null = null;

/**
 * What the platform says about this app (GET init), cached per isolate for the ttl it gives (5 minutes). If the
 * platform can't be reached, the last copy is kept (or none) and it's asked again after a minute.
 */
export async function platformInfo(env: PlatformEnv): Promise<PlatformInfo | null> {
  if (!onPlatform(env)) return null;
  if (!info || Date.now() - info.at > info.ttl * 1000) {
    asking ??= controllerFetch(env, '/api/tenant/init')
      .then((d) => { info = { at: Date.now(), ttl: Number(d.ttl) || 300, data: d as unknown as PlatformInfo }; })
      .catch((e) => {
        console.error(`Platform init failed: ${(e as Error).message}`);
        info = info ? { ...info, at: Date.now() - info.ttl * 1000 + 60_000 } : { at: Date.now(), ttl: 60, data: null };
      })
      .finally(() => { asking = null; });
    await asking;
  }
  return info?.data ?? null;
}

// ---------- storage allowance ----------

export const STORAGE_FULL = 'This workspace has used all of its storage. Remove some files, or upgrade in the SleekSite console, to attach more.';
/** Over the plan's storage allowance (the platform measures it daily; this app learns it from init). */
export async function storageFull(env: Env) {
  return (await platformInfo(env))?.storage === 'over';
}

// ---------- the platform's calls ----------

export const platformRoutes = new Hono<{ Bindings: Env }>();

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

platformRoutes.post('/tick', async (c) => {
  await morningSummaries(c.env);
  return c.json({ ok: true });
});
