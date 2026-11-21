// Sign-in (Google, Microsoft 365, WorkOS AuthKit and codes sent by email, each set up by admins in Settings → Sign-in)
// and cookie sessions. Each only proves an email address: whoever it is gets in through admit(), which lets in only emails
// that exist in `users` (added by an admin). ADMIN_EMAILS (optional) names extra addresses that are always let in as admins.
//
// A brand-new instance has nobody to sign in yet: its sign-in page asks for an email and the instance's setup key
// (TOKEN_KEY, in tenants/<name>.env), and that person becomes the admin (POST /auth/setup). An instance without a
// TOKEN_KEY keeps the old rule instead: the first person to sign in becomes the admin.
import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { USER_COLORS, appName } from '../shared/types';
import { EMAIL_RE } from '../shared/rules';
import { loadSettings } from './settings';
import { codeMail, codesOn, sendMail } from './mailer';
import { tokenKeyOk } from './secrets';
import { controllerFetch, controllerToken, ensurePerson, onPlatform } from './platform';
import { type TestProvider, clearPending, loadPending, saveConfig } from './signin-config';
import { mailboxProvider, saveMailbox } from './mailbox';
import { GRAPH_ME, type GraphMe, emailOf, msBase as msBaseOf, msOn as msOnOf, msTenant as msTenantOf } from './microsoft';
import {
  type AppEnv, type Ctx, type Env, type UserRow, auditStmt, b64url, bumpDirectory, defaultTz, nowIso, randomToken, sha256, sha256hex, toViewer, uid, validTz,
} from './lib';

const SESSION_COOKIE = 'tv_session';
const SESSION_DAYS = 30;
const isLocal = (c: Ctx) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(c.req.url).hostname);
const cookieBase = (c: Ctx) => ({ httpOnly: true, secure: !isLocal(c) || new URL(c.req.url).protocol === 'https:', sameSite: 'Lax' as const, path: '/' });
const redirectUri = (c: Ctx) => `${new URL(c.req.url).origin}/auth/callback`;
/** Where to go after sign-in: only same-site paths (e.g. back to /authorize for an MCP client). */
const safeNext = (next: string | undefined | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/');
const NEXT_COOKIE = 'tv_next';

// ---------- The parts every provider's sign-in shares ----------
/**
 * Starts a sign-in with a provider: remembers a fresh state and PKCE verifier (and `mode`, if any) in `cookie` for
 * 10 minutes, and where to go afterwards. Returns the parameters to add to the provider's authorize URL.
 */
async function beginOAuth(c: Ctx, cookie: string, next: string, mode?: string) {
  const state = randomToken(16);
  const verifier = randomToken(32);
  setCookie(c, cookie, [state, verifier, mode].filter(Boolean).join('.'), { ...cookieBase(c), path: '/auth', maxAge: 600 });
  if (next !== '/') setCookie(c, NEXT_COOKIE, next, { ...cookieBase(c), path: '/auth', maxAge: 600 });
  else deleteCookie(c, NEXT_COOKIE, { path: '/auth' });
  return { state, code_challenge: b64url(await sha256(verifier)), code_challenge_method: 'S256' };
}

/** Reads back (and clears) what beginOAuth saved. `state` is empty when the cookie is gone (expired, or another browser). */
function endOAuth(c: Ctx, cookie: string) {
  const saved = getCookie(c, cookie);
  const next = safeNext(getCookie(c, NEXT_COOKIE));
  deleteCookie(c, cookie, { path: '/auth' });
  deleteCookie(c, NEXT_COOKIE, { path: '/auth' });
  const [state = '', verifier = '', mode = ''] = (saved ?? '').split('.');
  return { state, verifier, mode, next };
}

/** Trades an authorization code for tokens at a provider's token endpoint; null if it refused or couldn't be reached. */
async function redeemCode<T>(url: string, params: Record<string, string>): Promise<T | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', ...params }),
  }).catch(() => null);
  return res?.ok ? res.json<T>().catch(() => null) : null;
}

/** GETs a provider's JSON API with an access token; null on any failure. */
const getJson = <T>(url: string, token: string): Promise<T | null> =>
  fetch(url, { headers: { authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json<T>() : null)).catch(() => null);

/** Who a provider says signed in, or why it didn't work out. */
type Identity = { email: string; name: string; picture: string | null } | { error: 'unverified' | 'failed' };

/** Same-site requests from our own pages only (a custom header forces a CORS preflight): for the POSTs below. */
function fromOurPage(c: Ctx) {
  const origin = c.req.header('origin');
  if (origin && new URL(origin).host !== new URL(c.req.url).host) return false;
  return c.req.header('x-taskivities') === '1';
}

/** Compares two secrets without the time it takes saying how much of them matched. */
async function sameSecret(a: string, b: string) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const bootstrapAdmins = (env: Env) => (env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,;]+/).filter(Boolean);
const hasUsers = async (db: D1Database) => !!(await db.prepare('SELECT 1 AS x FROM users LIMIT 1').first());

export const authRoutes = new Hono<AppEnv>();

// ---------- Google ----------
const GOOGLE_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';
const googleOn = (c: Ctx) => !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);

/** How people sign in here, for "sign in with … using this address" (in the app and in invite emails). */
export const signInWith = (env: Env): string[] => [
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? 'Google' : '',
  msOnOf(env) ? 'Microsoft' : '',
  (env.WORKOS_CLIENT_ID && env.WORKOS_API_KEY) || codesOn(env) ? 'email' : '',
].filter(Boolean);

/** Google: trade the code for a token, then ask who it is (only a verified address counts). */
async function googleIdentity(env: Env, code: string, verifier: string, redirect: string): Promise<Identity> {
  const t = await redeemCode<{ access_token?: string }>(GOOGLE_TOKEN, {
    code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!, redirect_uri: redirect, code_verifier: verifier,
  });
  if (!t?.access_token) return { error: 'failed' };
  const info = await getJson<{ email?: string; email_verified?: boolean; name?: string; picture?: string }>(GOOGLE_USERINFO, t.access_token);
  if (!info) return { error: 'failed' };
  if (!info.email || !info.email_verified) return { error: 'unverified' };
  return { email: info.email, name: info.name ?? '', picture: info.picture ?? null };
}

authRoutes.get('/login', async (c) => {
  if (!googleOn(c)) return c.text('Google sign-in is not configured yet: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.', 500);
  const pkce = await beginOAuth(c, 'tv_oauth', safeNext(c.req.query('next')));
  const u = new URL(GOOGLE_AUTHORIZE);
  u.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(c),
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    ...pkce,
  }).toString();
  return c.redirect(u.toString());
});

// ---------- an invite mailbox: Gmail or Outlook (admins, optional; see worker/mailbox.ts) ----------
// Each connects through the instance's own Google or Microsoft sign-in app and callback (the `mailbox:<via>` mode in
// the PKCE cookie tells the callback it isn't a sign-in), so there's no extra redirect URI to register. Only the
// "send" permission is asked for, and it has to be the account they sign in to the app with.
/** Adds ?mailbox=<result>&via=<gmail|outlook> to the page we go back to, so the app can say what happened. */
const withMailbox = (path: string, via: string, result: string) =>
  `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams({ mailbox: result, via })}`;
const MAILBOX_FLOW = {
  gmail: {
    cookie: 'tv_oauth', authorize: () => GOOGLE_AUTHORIZE, redirect: (c: Ctx) => redirectUri(c),
    // A refresh token, so invites can be sent later: Google only returns one on a fresh consent.
    extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' } as Record<string, string>,
    whoami: async (token: string) => (await getJson<{ email?: string }>(GOOGLE_USERINFO, token))?.email ?? null,
  },
  outlook: {
    cookie: 'tv_ms', authorize: (c: Ctx) => `${msBase(c)}/authorize`, redirect: (c: Ctx) => msRedirect(c),
    extra: {} as Record<string, string>,
    whoami: async (token: string) => { const me = await getJson<GraphMe>(GRAPH_ME, token); return me ? emailOf(me) : null; },
  },
} as const;

authRoutes.get('/:via{gmail|outlook}', async (c) => {
  const via = c.req.param('via') as 'gmail' | 'outlook';
  const p = mailboxProvider(via), flow = MAILBOX_FLOW[via];
  const back = safeNext(c.req.query('next') || '/settings');
  const user = await currentUser(c);
  if (!user) return c.redirect(`/login?next=${encodeURIComponent(back)}`);
  if (user.role !== 'admin') return c.redirect(withMailbox(back, via, 'forbidden'));
  if (!p.on(c.env)) return c.redirect(withMailbox(back, via, 'unavailable'));
  const pkce = await beginOAuth(c, flow.cookie, back, `mailbox:${via}`);
  const u = new URL(flow.authorize(c));
  u.search = new URLSearchParams({
    client_id: p.client(c.env).client_id, redirect_uri: flow.redirect(c), response_type: 'code', scope: p.scope,
    login_hint: user.email, ...flow.extra, ...pkce,
  }).toString();
  return c.redirect(u.toString());
});

/** Back from the consent screen: check it's their own account and sending was allowed, then keep the connection. */
async function mailboxCallback(c: Ctx, via: 'gmail' | 'outlook', code: string | undefined, error: string | undefined, verifier: string, back: string) {
  const p = mailboxProvider(via), flow = MAILBOX_FLOW[via];
  const user = await currentUser(c);
  if (!user) return c.redirect('/login');
  if (user.role !== 'admin') return c.redirect(withMailbox(back, via, 'forbidden'));
  if (!p.on(c.env)) return c.redirect(withMailbox(back, via, 'unavailable'));
  // consent_required: their organization doesn't let people allow this themselves (an admin has to grant it).
  if (error || !code) return c.redirect(withMailbox(back, via, error === 'consent_required' ? 'no_permission' : 'cancelled'));
  const t = await redeemCode<{ access_token?: string; refresh_token?: string; scope?: string }>(p.tokenUrl(c.env), {
    code, ...p.client(c.env), redirect_uri: flow.redirect(c), code_verifier: verifier, ...(via === 'outlook' ? { scope: p.scope } : {}),
  });
  if (!t?.access_token) return c.redirect(withMailbox(back, via, 'failed'));
  const drop = () => p.revoke?.(t.refresh_token || t.access_token!);
  // People can untick individual permissions: without "send email" there's nothing to keep.
  if (!p.canSend(t.scope ?? '')) { await drop(); return c.redirect(withMailbox(back, via, 'no_permission')); }
  // Invites go out from the address they sign in with, so it must be that same account.
  const email = await flow.whoami(t.access_token);
  if (!email || email.toLowerCase() !== user.email.toLowerCase()) { await drop(); return c.redirect(withMailbox(back, via, 'wrong_account')); }
  if (!t.refresh_token) return c.redirect(withMailbox(back, via, 'failed'));
  await saveMailbox(c.env, user.id, via, user.email, t.refresh_token, t.scope ?? p.scope);
  await auditStmt(c.env.DB, user.id, 'mailbox_connected', user.id, { via }).run();
  return c.redirect(withMailbox(back, via, 'connected'));
}

authRoutes.get('/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const saved = endOAuth(c, 'tv_oauth');
  if (saved.mode === 'mailbox:gmail') {
    if (saved.state !== state) return c.redirect(withMailbox(saved.next, 'gmail', 'expired'));
    return mailboxCallback(c, 'gmail', code, error, saved.verifier, saved.next);
  }
  if (saved.mode.startsWith('test:')) return testCallback(c, 'google', { code, state, error }, saved);
  if (error || !code || !saved.state) return c.redirect('/login?error=cancelled');
  if (saved.state !== state) return c.redirect('/login?error=expired');
  const id = await googleIdentity(c.env, code, saved.verifier, redirectUri(c));
  if ('error' in id) return c.redirect(`/login?error=${id.error === 'unverified' ? 'unverified' : 'google'}`);
  return signIn(c, id.email, id.name, id.picture, saved.next);
});

// ---------- WorkOS AuthKit (optional; on when WORKOS_CLIENT_ID and WORKOS_API_KEY are set) ----------
// For people without a Google account. AuthKit's hosted page offers whatever is enabled in the WorkOS dashboard
// (emailed codes, Microsoft, passkeys, …) and hands back a verified email. Taskivities keeps its own session, so the
// WorkOS session is ended right away: signing out here really signs out, and the next sign-in asks again.
const WORKOS = 'https://api.workos.com/user_management';
const workosOn = (c: Ctx) => !!(c.env.WORKOS_CLIENT_ID && c.env.WORKOS_API_KEY);
const workosRedirect = (c: Ctx) => `${new URL(c.req.url).origin}/auth/workos/callback`;

/**
 * What the sign-in page needs: which buttons to show, whether the instance still has to be set up (nobody in it yet,
 * and a setup key to do it with), and the team's name and wordmark.
 */
authRoutes.get('/methods', async (c) => {
  const st = await loadSettings(c.env.DB);
  if (c.env.MS_CLIENT_ID && !msTenant(c)) console.warn(MS_TENANT_HELP);
  // On the SleekSite platform the account's owners are added by the platform, so there's nothing to set up here.
  const setup = !onPlatform(c.env) && tokenKeyOk(c.env) && !(await hasUsers(c.env.DB));
  return c.json({
    google: googleOn(c), microsoft: msOn(c), workos: workosOn(c), code: codesOn(c.env), setup,
    name: appName(st), wordmark: st.customWordmark ? st.wordmarkVersion : null,
  });
});

authRoutes.get('/workos', async (c) => {
  if (!workosOn(c)) return c.text('Email sign-in is not configured: set WORKOS_CLIENT_ID and WORKOS_API_KEY.', 500);
  // AuthKit is used without PKCE (the API key authenticates the exchange), so only the state goes along.
  const { state } = await beginOAuth(c, 'tv_workos', safeNext(c.req.query('next')));
  const u = new URL(`${WORKOS}/authorize`);
  u.search = new URLSearchParams({
    client_id: c.env.WORKOS_CLIENT_ID!, redirect_uri: workosRedirect(c), response_type: 'code', provider: 'authkit', state,
  }).toString();
  return c.redirect(u.toString());
});

authRoutes.get('/workos/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const saved = endOAuth(c, 'tv_workos');
  if (saved.mode.startsWith('test:')) return testCallback(c, 'workos', { code, state, error }, saved);
  if (!workosOn(c)) return c.redirect('/login');
  if (error || !code) return c.redirect(`/login?error=${error === 'access_denied' || !error ? 'cancelled' : 'workos'}`);
  if (!saved.state || saved.state !== state) return c.redirect('/login?error=expired');
  const id = await workosIdentity(c, c.env, code);
  if ('error' in id) return c.redirect(`/login?error=${id.error === 'unverified' ? 'unverified' : 'workos'}`);
  return signIn(c, id.email, id.name, id.picture, saved.next);
});

/** WorkOS: trade the code for the user, and end the WorkOS session at once (Taskivities keeps its own). */
async function workosIdentity(c: Ctx, env: Env, code: string): Promise<Identity> {
  const res = await fetch(`${WORKOS}/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID, client_secret: env.WORKOS_API_KEY, grant_type: 'authorization_code', code,
      ip_address: c.req.header('cf-connecting-ip'), user_agent: c.req.header('user-agent'),
    }),
  }).catch(() => null);
  if (!res?.ok) return { error: 'failed' };
  const r = await res.json<{
    user?: { email?: string; email_verified?: boolean; first_name?: string | null; last_name?: string | null; profile_picture_url?: string | null };
    access_token?: string;
  }>();
  const sid = sessionIdOf(r.access_token);
  if (sid) {
    c.executionCtx.waitUntil(fetch(`${WORKOS}/sessions/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.WORKOS_API_KEY}` },
      body: JSON.stringify({ session_id: sid }),
    }).catch(() => undefined));
  }
  const u = r.user;
  if (!u?.email || u.email_verified === false) return { error: 'unverified' };
  return { email: u.email, name: [u.first_name, u.last_name].filter(Boolean).join(' '), picture: u.profile_picture_url || null };
}

/** The WorkOS session id ("sid") inside its access token. The token came straight from WorkOS, so it isn't re-verified. */
function sessionIdOf(token: string | undefined): string | null {
  try {
    const part = token?.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const sid = (JSON.parse(json) as { sid?: unknown }).sid;
    return typeof sid === 'string' ? sid : null;
  } catch {
    return null;
  }
}

// ---------- Microsoft 365 / Entra ID (optional; on when MS_CLIENT_ID, MS_CLIENT_SECRET and MS_TENANT_ID are set) ----------
// Locked to one organization's tenant: the authorize and token endpoints are tenant-specific, so only that tenant's
// people (and guests it invited) can sign in. The email comes from Microsoft Graph (/me), not from a token claim another
// tenant's admin could set to anything (the "nOAuth" problem). That makes this tenant's admins trusted to say who's who:
// they can set an account's `mail` to any address. A multi-tenant authority would extend that trust to every tenant in the
// world, so msTenant() refuses anything but one organization's GUID or domain, and the button stays off until it's right.
const MS_SCOPE = 'openid profile email User.Read';
const MS_TENANT_HELP = 'Microsoft sign-in is off: MS_TENANT_ID must be your organization\'s tenant ID (a GUID) or one of its domains, never "common", "organizations" or "consumers".';
// The tenant checks live in worker/microsoft.ts, shared with Outlook invite emails.
const msTenant = (c: Ctx) => msTenantOf(c.env);
const msOn = (c: Ctx) => msOnOf(c.env);
const msBase = (c: Ctx) => msBaseOf(c.env);
const msRedirect = (c: Ctx) => `${new URL(c.req.url).origin}/auth/microsoft/callback`;

authRoutes.get('/microsoft', async (c) => {
  if (!c.env.MS_CLIENT_ID || !c.env.MS_CLIENT_SECRET || !c.env.MS_TENANT_ID) {
    return c.text('Microsoft sign-in is not configured: set MS_CLIENT_ID, MS_CLIENT_SECRET and MS_TENANT_ID.', 500);
  }
  if (!msOn(c)) return c.text(MS_TENANT_HELP, 500);
  const pkce = await beginOAuth(c, 'tv_ms', safeNext(c.req.query('next')));
  const u = new URL(`${msBase(c)}/authorize`);
  u.search = new URLSearchParams({
    client_id: c.env.MS_CLIENT_ID,
    redirect_uri: msRedirect(c),
    response_type: 'code',
    scope: MS_SCOPE,
    prompt: 'select_account',
    ...pkce,
  }).toString();
  return c.redirect(u.toString());
});

authRoutes.get('/microsoft/callback', async (c) => {
  const { code, state, error } = c.req.query();
  const saved = endOAuth(c, 'tv_ms');
  if (saved.mode === 'mailbox:outlook') {
    if (saved.state !== state) return c.redirect(withMailbox(saved.next, 'outlook', 'expired'));
    return mailboxCallback(c, 'outlook', code, error, saved.verifier, saved.next);
  }
  if (saved.mode.startsWith('test:')) return testCallback(c, 'microsoft', { code, state, error }, saved);
  if (!msOn(c)) return c.redirect('/login');
  if (error || !code || !saved.state) return c.redirect(`/login?error=${error === 'access_denied' || !error ? 'cancelled' : 'microsoft'}`);
  if (saved.state !== state) return c.redirect('/login?error=expired');
  const id = await msIdentity(c.env, code, saved.verifier, msRedirect(c));
  if ('error' in id) return c.redirect(`/login?error=${id.error === 'unverified' ? 'unverified' : 'microsoft'}`);
  return signIn(c, id.email, id.name, id.picture, saved.next);
});

/** Microsoft: trade the code for a token at the tenant, then ask Graph who it is (see above for why Graph). */
async function msIdentity(env: Env, code: string, verifier: string, redirect: string): Promise<Identity> {
  const t = await redeemCode<{ access_token?: string }>(`${msBaseOf(env)}/token`, {
    code, client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET!, redirect_uri: redirect, code_verifier: verifier, scope: MS_SCOPE,
  });
  if (!t?.access_token) return { error: 'failed' };
  const me = await getJson<GraphMe>(GRAPH_ME, t.access_token);
  if (!me) return { error: 'failed' };
  const email = emailOf(me);
  return email ? { email, name: me.displayName ?? '', picture: null } : { error: 'unverified' };
}

// ---------- trying new credentials before they're saved (Settings → Sign-in → "Save and test") ----------
// The admin's browser goes through a real sign-in with the waiting credentials (worker/signin-config.ts), on the usual
// callback (the `test:<nonce>` mode in the PKCE cookie tells it apart), so there's no extra redirect URI. Any verified
// account proves they work, not just the admin's own; nobody is signed in by it. Only then are they saved.
const testDone = (provider: TestProvider, result: string, as?: string) =>
  `/settings?${new URLSearchParams({ signin: provider, result, ...(as ? { as } : {}) })}`;

authRoutes.get('/test/:provider{google|microsoft|workos}', async (c) => {
  const provider = c.req.param('provider') as TestProvider;
  const nonce = c.req.query('nonce') ?? '';
  const user = await currentUser(c);
  if (!user) return c.redirect('/login?next=/settings');
  if (user.role !== 'admin') return c.redirect(testDone(provider, 'forbidden'));
  const p = await loadPending(c.env, nonce, provider);
  if (!p) return c.redirect(testDone(provider, 'expired'));
  const env: Env = { ...c.env, ...p.values };
  const mode = `test:${nonce}`;
  if (provider === 'workos') {
    const { state } = await beginOAuth(c, 'tv_workos', '/settings', mode);
    const u = new URL(`${WORKOS}/authorize`);
    u.search = new URLSearchParams({ client_id: env.WORKOS_CLIENT_ID!, redirect_uri: workosRedirect(c), response_type: 'code', provider: 'authkit', state }).toString();
    return c.redirect(u.toString());
  }
  const google = provider === 'google';
  const pkce = await beginOAuth(c, google ? 'tv_oauth' : 'tv_ms', '/settings', mode);
  const u = new URL(google ? GOOGLE_AUTHORIZE : `${msBaseOf(env)}/authorize`);
  u.search = new URLSearchParams({
    client_id: (google ? env.GOOGLE_CLIENT_ID : env.MS_CLIENT_ID)!, redirect_uri: google ? redirectUri(c) : msRedirect(c),
    response_type: 'code', scope: google ? 'openid email profile' : MS_SCOPE, prompt: 'select_account', ...pkce,
  }).toString();
  return c.redirect(u.toString());
});

async function testCallback(
  c: Ctx, provider: TestProvider, q: { code?: string; state?: string; error?: string }, saved: { state: string; verifier: string; mode: string },
) {
  const user = await currentUser(c);
  if (!user || user.role !== 'admin') return c.redirect(testDone(provider, 'forbidden'));
  const p = await loadPending(c.env, saved.mode.slice('test:'.length), provider);
  if (!p || !saved.state || saved.state !== q.state) return c.redirect(testDone(provider, 'expired'));
  await clearPending(c.env);
  if (q.error || !q.code) return c.redirect(testDone(provider, 'cancelled'));
  const env: Env = { ...c.env, ...p.values };
  const id = provider === 'google' ? await googleIdentity(env, q.code, saved.verifier, redirectUri(c))
    : provider === 'microsoft' ? await msIdentity(env, q.code, saved.verifier, msRedirect(c))
    : await workosIdentity(c, env, q.code);
  if ('error' in id) return c.redirect(testDone(provider, id.error));
  await saveConfig(c.env, user.id, p.values);
  await auditStmt(c.env.DB, user.id, 'signin_settings_changed', null, { provider, keys: Object.keys(p.values), tested_with: id.email }).run();
  return c.redirect(testDone(provider, 'ok', id.email));
}

// ---------- setting up a new instance: the first admin, with the setup key ----------
authRoutes.post('/setup', async (c) => {
  if (!fromOurPage(c)) return c.json({ error: 'Bad origin' }, 403);
  if (onPlatform(c.env)) return c.json({ error: 'Sign in from the SleekSite console.' }, 409);
  if (!tokenKeyOk(c.env)) return c.json({ error: 'This instance has no setup key. Add TOKEN_KEY to its tenants/<instance>.env file and deploy again.' }, 409);
  const b = await c.req.json<{ email?: unknown; name?: unknown; key?: unknown; next?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  const name = typeof b.name === 'string' ? b.name.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  const key = typeof b.key === 'string' ? b.key.trim() : '';
  if (!EMAIL_RE.test(email)) return c.json({ error: 'Enter your email address.' }, 400);
  const db = c.env.DB;
  if (await hasUsers(db)) return c.json({ error: 'This instance is already set up. Sign in instead.' }, 409);
  if (!key || !(await sameSecret(key, c.env.TOKEN_KEY!))) {
    return c.json({ error: "That isn't this instance's setup key. It's the TOKEN_KEY line in tenants/<instance>.env." }, 403);
  }
  const id = uid(), now = nowIso();
  // One conditional INSERT, so if two people race, only one becomes the admin.
  await db.prepare(
    `INSERT INTO users (id, email, name, color, role, status, added_by, added_at, last_seen_at)
     SELECT ?, ?, ?, ?, 'admin', 'active', NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
  ).bind(id, email, name, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], now, now).run();
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  if (!user) return c.json({ error: 'This instance is already set up. Sign in instead.' }, 409);
  await createSession(c, user.id, [bumpDirectory(db), auditStmt(db, user.id, 'instance_set_up', user.id, { email })]);
  return c.json({ next: safeNext(typeof b.next === 'string' ? b.next : null) });
});

// ---------- codes sent by email (on when set up in Settings → Sign-in; worker/mailer.ts sends them) ----------
// Asking always answers the same, whether or not the address has access, and every ask is counted for the limits;
// only addresses with access are emailed. A code is 6 digits, lasts CODE_MINUTES, allows CODE_TRIES guesses, works
// once, and only in the browser that asked (the row id is in its cookie).
const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODE_COOKIE = 'tv_code';

authRoutes.post('/code', async (c) => {
  if (!fromOurPage(c)) return c.json({ error: 'Bad origin' }, 403);
  if (!codesOn(c.env)) return c.json({ error: "Email codes aren't set up on this instance." }, 404);
  const b = await c.req.json<{ email?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) return c.json({ error: 'Enter your email address.' }, 400);
  const db = c.env.DB;
  const ip = c.req.header('cf-connecting-ip') ?? '';
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const n = (await db.prepare(
    `SELECT (SELECT COUNT(*) FROM login_codes WHERE email = ?1 AND created_at > ?2) AS minute,
            (SELECT COUNT(*) FROM login_codes WHERE email = ?1 AND created_at > ?3) AS hour,
            (SELECT COUNT(*) FROM login_codes WHERE ip = ?4 AND ?4 != '' AND created_at > ?3) AS ip`,
  ).bind(email, ago(60_000), ago(3_600_000), ip).first<{ minute: number; hour: number; ip: number }>())!;
  if (n.minute > 0) return c.json({ error: 'A code was just sent. Wait a minute before asking for another.' }, 429);
  if (n.hour >= 5 || n.ip >= 20) return c.json({ error: 'Too many codes were asked for. Try again in an hour.' }, 429);

  const id = randomToken(18);
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
  const [user, st] = await Promise.all([
    db.prepare('SELECT status FROM users WHERE email = ?').bind(email).first<{ status: string }>(),
    loadSettings(db),
    db.batch([
      db.prepare('INSERT INTO login_codes (id, email, code_hash, ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(id, email, await sha256hex(`${id}:${code}`), ip || null, nowIso(), new Date(now + CODE_MINUTES * 60_000).toISOString()),
      db.prepare('DELETE FROM login_codes WHERE created_at < ?').bind(ago(86_400_000)),
    ]),
  ]);
  setCookie(c, CODE_COOKIE, id, { ...cookieBase(c), path: '/auth', maxAge: CODE_MINUTES * 60 });
  if ((user && user.status !== 'disabled') || bootstrapAdmins(c.env).includes(email)) {
    const app = appName(st);
    // Sent after answering, so how long the answer takes doesn't say whether the address has access.
    // On the SleekSite platform the code goes out from the platform's mail domain (rate-limited there too).
    c.executionCtx.waitUntil(onPlatform(c.env)
      ? controllerFetch(c.env, '/api/tenant/mail/signin-code', { email, code, siteName: app }).catch((e) => console.error(`Sign-in code not sent: ${(e as Error).message}`))
      : sendMail(c.env, codeMail(email, app, code, CODE_MINUTES), c.env.MAIL_FROM_NAME || app).then((r) => {
        if (!r.ok) console.error(`Sign-in code not sent: ${r.error}`);
      }));
  }
  return c.json({ ok: true });
});

authRoutes.post('/code/verify', async (c) => {
  if (!fromOurPage(c)) return c.json({ error: 'Bad origin' }, 403);
  if (!codesOn(c.env)) return c.json({ error: "Email codes aren't set up on this instance." }, 404);
  const b = await c.req.json<{ code?: unknown; next?: unknown }>().catch(() => ({} as Record<string, unknown>));
  const code = String(b.code ?? '').replace(/\D/g, '');
  const id = getCookie(c, CODE_COOKIE);
  const expired = (why = 'That code has expired.') => {
    deleteCookie(c, CODE_COOKIE, { path: '/auth' });
    return c.json({ error: `${why} Ask for a new one.`, expired: true }, 400);
  };
  if (!id) return expired();
  const db = c.env.DB;
  // Counts the try first, so guesses can't race past the limit.
  const row = await db.prepare(
    'UPDATE login_codes SET attempts = attempts + 1 WHERE id = ? AND used_at IS NULL AND attempts < ? AND expires_at > ? RETURNING email, code_hash, attempts',
  ).bind(id, CODE_TRIES, nowIso()).first<{ email: string; code_hash: string; attempts: number }>();
  if (!row) return expired();
  if (code.length !== 6 || !(await sameSecret(await sha256hex(`${id}:${code}`), row.code_hash))) {
    const left = CODE_TRIES - row.attempts;
    if (left <= 0) return expired('That code was tried too many times.');
    return c.json({ error: `That code isn't right. ${left} ${left === 1 ? 'try' : 'tries'} left.` }, 400);
  }
  await db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').bind(nowIso(), id).run();
  deleteCookie(c, CODE_COOKIE, { path: '/auth' });
  const user = await admit(c, row.email, '', null);
  if (!user) return c.json({ error: `${row.email} doesn't have access. Ask an admin to add this address (or enable it again).` }, 403);
  return c.json({ next: safeNext(typeof b.next === 'string' ? b.next : null) });
});

/** Local development only: sign in as any existing user without Google. */
authRoutes.get('/dev-login', async (c) => {
  if (c.env.DEV_LOGIN !== '1' || !isLocal(c)) return c.notFound();
  const email = c.req.query('email');
  if (!email) return c.text('Add ?email=someone@example.com', 400);
  return signIn(c, email, '', null, safeNext(c.req.query('next')));
});

authRoutes.post('/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256hex(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.body(null, 204);
});

/** Signs the person in and goes on to `next`, or back to the sign-in page saying which address has no access. */
async function signIn(c: Ctx, rawEmail: string, name: string, picture: string | null, next = '/') {
  if (await admit(c, rawEmail, name, picture)) return c.redirect(next);
  // Shown on the sign-in page so people know which address was refused.
  setCookie(c, 'tv_denied', rawEmail.trim().toLowerCase(), { secure: cookieBase(c).secure, sameSite: 'Lax', path: '/', maxAge: 300 });
  return c.redirect('/login?error=no_access');
}

/** Lets in an address that has access: brings their name and picture up to date and starts a session. Null if it hasn't. */
async function admit(c: Ctx, rawEmail: string, name: string, picture: string | null): Promise<UserRow | null> {
  const db = c.env.DB;
  const email = rawEmail.trim().toLowerCase();
  const now = nowIso();
  let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();

  if ((!user || user.status === 'disabled') && bootstrapAdmins(c.env).includes(email)) {
    if (user) {
      await db.batch([
        db.prepare("UPDATE users SET role = 'admin', status = 'active', disabled_at = NULL, disabled_by = NULL, name = ?, avatar_url = ?, last_seen_at = ? WHERE id = ?")
          .bind(name || user.name, picture, now, user.id),
        bumpDirectory(db),
      ]);
    } else {
      const id = uid();
      await db.batch([
        db.prepare("INSERT INTO users (id, email, name, avatar_url, color, role, status, added_by, added_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 'admin', 'active', NULL, ?, ?)")
          .bind(id, email, name, picture, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], now, now),
        bumpDirectory(db),
      ]);
    }
    user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
  }

  if (!user && !tokenKeyOk(c.env)) {
    // Brand-new install without a setup key: the very first person to sign in becomes the admin. (With TOKEN_KEY, the
    // first admin is whoever sets the instance up with it: POST /auth/setup.)
    // One conditional INSERT, so if two people race, only one can win.
    await db
      .prepare(
        `INSERT INTO users (id, email, name, avatar_url, color, role, status, added_by, added_at, last_seen_at)
         SELECT ?, ?, ?, ?, ?, 'admin', 'active', NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
      )
      .bind(uid(), email, name, picture, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], now, now)
      .run();
    // If the insert won, this person now exists (as the admin); otherwise someone else was first.
    user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
    if (user) await bumpDirectory(db).run();
  }

  if (!user || user.status === 'disabled') return null;

  const changed = user.status !== 'active' || (name && name !== user.name) || (picture && picture !== user.avatar_url);
  const stmts = [
    db.prepare("UPDATE users SET status = 'active', name = COALESCE(NULLIF(?, ''), name), avatar_url = COALESCE(?, avatar_url), last_seen_at = ? WHERE id = ?")
      .bind(name, picture, now, user.id),
  ];
  if (changed) stmts.push(bumpDirectory(db));
  await createSession(c, user.id, stmts);
  return user;
}

async function createSession(c: Ctx, userId: string, extra: D1PreparedStatement[] = []) {
  const db = c.env.DB;
  const token = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await db.batch([
    ...extra,
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(await sha256hex(token), userId, nowIso(), expires),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso()),
  ]);
  setCookie(c, SESSION_COOKIE, token, { ...cookieBase(c), maxAge: SESSION_DAYS * 86400 });
}

/**
 * The signed-in user for this request's session cookie, or null. Sessions slide forward when they're half used up.
 * Clears a stale cookie.
 */
export async function currentUser(c: Ctx): Promise<UserRow | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const db = c.env.DB;
  const id = await sha256hex(token);
  const row = await db
    .prepare("SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.status = 'active'")
    .bind(id)
    .first<UserRow & { expires_at: string }>();
  if (!row || row.expires_at < nowIso()) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return null;
  }
  if (new Date(row.expires_at).getTime() - Date.now() < (SESSION_DAYS / 2) * 864e5) {
    const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').bind(expires, id).run();
    setCookie(c, SESSION_COOKIE, token, { ...cookieBase(c), maxAge: SESSION_DAYS * 86400 });
  }
  return row;
}

/** Loads the signed-in viewer, or answers 401. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const row = await currentUser(c);
  if (!row) return c.json({ error: 'Signed out' }, 401);
  // The app sends the browser's time zone on every request, so "today" follows people when they travel.
  const sent = validTz(c.req.header('x-tz'));
  // Saved for AI assistants (which don't send one) and the People & projects page. No directory bump: two open devices
  // in different zones would otherwise make everyone reload the team list on every poll.
  if (sent && sent !== row.time_zone) await c.env.DB.prepare('UPDATE users SET time_zone = ? WHERE id = ?').bind(sent, row.id).run();
  c.set('viewer', await toViewer(c.env, row, sent || validTz(row.time_zone) || defaultTz(c.env)));
  await next();
};

/** Writes must come from our own pages: same origin plus a custom header (which forces a CORS preflight). */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const origin = c.req.header('origin');
    if (origin && new URL(origin).host !== new URL(c.req.url).host) return c.json({ error: 'Bad origin' }, 403);
    if (c.req.header('x-taskivities') !== '1') return c.json({ error: 'Missing header' }, 403);
  }
  await next();
};

// ---------- "Open" from the SleekSite console (worker/platform.ts) ----------

/**
 * GET /_admin/auth/sso?token=…&next=/path: the console sends an account's owner (or platform staff, for support) here
 * with a 60-second token signed with this instance's key. Owners are admins here; staff come in as admins too, and
 * it's recorded in the audit log.
 */
export async function ssoSignIn(c: Ctx) {
  const claims = await controllerToken(c.env, c.req.query('token') || '', 'sso');
  if (!claims?.sub || !EMAIL_RE.test(claims.sub)) return c.text('That sign-in link has expired. Open the app again from the SleekSite console.', 401);
  const email = claims.sub.toLowerCase();
  const user = await ensurePerson(c.env, email, (claims.name || '').slice(0, 80), !!(claims.owner || claims.staff));
  if (!user) return c.text('Could not sign you in.', 500);
  const extra = claims.staff && !claims.owner ? [auditStmt(c.env.DB, user.id, 'platform_staff_signed_in', user.id, { email })] : [];
  await createSession(c, user.id, extra);
  return c.redirect(safeNext(c.req.query('next')));
}
