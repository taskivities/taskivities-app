// Connecting instances: see the tasks you have on other Taskivities instances in your own (migration 0017).
//
// Two sides, and every instance has both:
//   • Sharing (this instance's tasks shown elsewhere): a person makes an access token here (tokenRoutes). The other
//     instance calls feedApi (/feed/v1/…) with it, as that person, and sees only the tasks assigned to them. It can
//     mark them done or not, move them, change their priority, notes and checklist, and comment: the same rules,
//     history and notifications as in the app. Everything else (handing over, projects, repeating, files) stays here.
//   • Showing (other instances' tasks here): feedRoutes keeps the other instances someone added, with their token
//     encrypted, and passes the app's requests on to them. The app mixes those tasks into the person's own views.
import { Hono } from 'hono';
import { isDate } from '../shared/dates';
import { appName, type AccessTokenInfo, type FeedInfo, type FeedPerson, type FeedTasks, TOKEN_PREFIX, PROJECT_COLORS } from '../shared/types';
import { decrypt, encrypt } from './gmail';
import {
  type AppEnv, type Env, type EventRow, type ProjectRow, type TaskRow, type Viewer,
  HttpError, TASK_COLS, bad, conflict, loadViewer, mapEvent, mapProject, mapTask, notFound, nowIso, randomToken, sha256hex, uid, validTz,
} from './lib';
import { loadSettings } from './settings';
import { currentUser } from './auth';
import { esc, page } from './oauth';
import { type Patch, addComment, changeChecklist, loadVisibleTask, updateTaskWithNext, visible } from './tasks';

const TOKEN_INFO = 'feed-token'; // encryption context for stored tokens (worker/gmail.ts)
const FEEDS_MAX = 10;

// =====================================================================================================================
// Sharing: the API other instances call, with a person's access token
// =====================================================================================================================
interface TokenRow { id: string; user_id: string; name: string; token_hash: string; created_at: string; last_used_at: string | null; revoked_at: string | null }

export const feedApi = new Hono<AppEnv>();

feedApi.use('*', async (c, next) => {
  const m = (c.req.header('authorization') || '').match(/^Bearer\s+(\S+)$/);
  if (!m || !m[1].startsWith(TOKEN_PREFIX)) return c.json({ error: 'An access token is needed.' }, 401);
  const db = c.env.DB;
  const row = await db.prepare('SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL').bind(await sha256hex(m[1])).first<TokenRow>();
  if (!row) return c.json({ error: 'That access token was revoked, or never existed here.' }, 401);
  const v = await loadViewer(c.env, row.user_id);
  if (!v) return c.json({ error: 'The person this token belongs to can no longer sign in here.' }, 401);
  // "Today" is the caller's today, as in the app.
  const tz = validTz(c.req.header('x-tz'));
  if (tz) v.tz = tz;
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 10 * 60_000)
    await db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').bind(nowIso(), row.id).run();
  c.set('viewer', v);
  await next();
});

/** Only the token holder's own tasks (assigned to them), and not archived ones. */
async function ownTask(env: Env, v: Viewer, id: string) {
  const t = await loadVisibleTask(env.DB, v, id);
  if (t.assignee_id !== v.id || t.archived_at) throw notFound("That task isn't yours on this instance any more.");
  return t;
}
const person = (r: { id: string; name: string; email: string; color: string }): FeedPerson =>
  ({ id: r.id, name: r.name || r.email.split('@')[0], email: r.email, color: r.color });

feedApi.get('/me', async (c) => {
  const v = c.get('viewer');
  const me = await c.env.DB.prepare('SELECT id, name, email, color FROM users WHERE id = ?').bind(v.id).first<FeedPerson>();
  return c.json({ instance: appName(await loadSettings(c.env.DB)), me: person(me!) });
});

/** My open tasks, and those done or due between from and to (YYYY-MM-DD), with the projects and people they mention. */
feedApi.get('/tasks', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const from = c.req.query('from') ?? '', to = c.req.query('to') ?? '';
  if (!isDate(from) || !isDate(to) || from > to) throw bad('Give from and to as YYYY-MM-DD.');
  const vis = visible(v);
  const [tasks, projects, users, settings] = await Promise.all([
    db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE assignee_id = ? AND archived_at IS NULL AND ${vis.sql}
                AND (status = 'open' OR done_on BETWEEN ? AND ? OR due_date BETWEEN ? AND ?) LIMIT 3000`)
      .bind(v.id, ...vis.binds, from, to, from, to).all<TaskRow>(),
    db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name').all<ProjectRow>(),
    db.prepare("SELECT id, name, email, color FROM users WHERE status != 'invited'").all<FeedPerson>(),
    loadSettings(db),
  ]);
  const mine = projects.results.filter((p) => v.role === 'admin' || v.projects.includes(p.id));
  const out: FeedTasks = {
    instance: appName(settings),
    me: person(users.results.find((u) => u.id === v.id)!),
    projects: mine.map(mapProject),
    users: users.results.map(person),
    tasks: tasks.results.map(mapTask),
  };
  return c.json(out);
});

feedApi.get('/tasks/:id', async (c) => c.json({ task: mapTask(await ownTask(c.env, c.get('viewer'), c.req.param('id'))) }));

feedApi.get('/tasks/:id/events', async (c) => {
  const t = await ownTask(c.env, c.get('viewer'), c.req.param('id'));
  const { results } = await c.env.DB.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, rowid').bind(t.id).all<EventRow>();
  return c.json({ events: results.map(mapEvent) });
});

/** Only these can change from another instance; anything else is done on this one. */
feedApi.patch('/tasks/:id', async (c) => {
  const v = c.get('viewer');
  const id = c.req.param('id');
  await ownTask(c.env, v, id);
  const b = await c.req.json<Patch>().catch(() => ({} as Patch));
  const allowed: Patch = { status: b.status, dueDate: b.dueDate, priority: b.priority, notes: b.notes, effort: b.effort, restore: b.restore };
  const { task, next } = await updateTaskWithNext(c.env, v, id, allowed, 'Taskivities');
  // A repeating task's next copy is shown too, if it's still theirs.
  return c.json({ task, next: next && next.assigneeId === v.id ? next : null });
});

feedApi.post('/tasks/:id/comments', async (c) => {
  const v = c.get('viewer');
  await ownTask(c.env, v, c.req.param('id'));
  const b = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  return c.json({ task: await addComment(c.env, v, c.req.param('id'), b.text, 'Taskivities') });
});
feedApi.post('/tasks/:id/checklist', async (c) => {
  const v = c.get('viewer');
  await ownTask(c.env, v, c.req.param('id'));
  const b = await c.req.json<{ text?: string }>().catch(() => ({} as { text?: string }));
  return c.json({ task: await changeChecklist(c.env, v, c.req.param('id'), { op: 'add', text: b.text ?? '' }, 'Taskivities') });
});
feedApi.patch('/tasks/:id/checklist/:item', async (c) => {
  const v = c.get('viewer');
  await ownTask(c.env, v, c.req.param('id'));
  const b = await c.req.json<{ done?: boolean; text?: string }>().catch(() => ({} as { done?: boolean; text?: string }));
  return c.json({ task: await changeChecklist(c.env, v, c.req.param('id'),
    { op: 'set', itemId: c.req.param('item'), done: typeof b.done === 'boolean' ? b.done : undefined, text: b.text }, 'Taskivities') });
});
feedApi.delete('/tasks/:id/checklist/:item', async (c) => {
  const v = c.get('viewer');
  await ownTask(c.env, v, c.req.param('id'));
  return c.json({ task: await changeChecklist(c.env, v, c.req.param('id'), { op: 'remove', itemId: c.req.param('item') }, 'Taskivities') });
});
feedApi.all('*', (c) => c.json({ error: 'Not found' }, 404));

// ---------- the person's own tokens (in the app, signed in) ----------
export const tokenRoutes = new Hono<AppEnv>();
const tokenInfo = (r: TokenRow): AccessTokenInfo => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at });

tokenRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC')
    .bind(c.get('viewer').id).all<TokenRow>();
  return c.json({ tokens: results.map(tokenInfo) });
});
/** Makes a token. The token itself is in this one answer only; just its hash is kept. */
tokenRoutes.post('/', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
  const name = (b.name ?? '').trim().slice(0, 60) || 'Another instance';
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL').bind(v.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 20) throw conflict('You have 20 access tokens. Revoke one you no longer use first.');
  const token = TOKEN_PREFIX + randomToken(32);
  const row: TokenRow = { id: uid(), user_id: v.id, name, token_hash: await sha256hex(token), created_at: nowIso(), last_used_at: null, revoked_at: null };
  await c.env.DB.prepare('INSERT INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.name, row.token_hash, row.created_at).run();
  return c.json({ token, info: tokenInfo(row) }, 201);
});
tokenRoutes.delete('/:id', async (c) => {
  await c.env.DB.prepare('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .bind(nowIso(), c.req.param('id'), c.get('viewer').id).run();
  return c.json({ ok: true });
});

// =====================================================================================================================
// Showing: other instances someone added here, and passing the app's requests on to them
// =====================================================================================================================
interface FeedRow {
  id: string; user_id: string; url: string; token: string; name: string; remote_user: string; color: string;
  created_at: string; last_ok_at: string | null; last_error: string | null;
}
const feedInfo = (r: FeedRow): FeedInfo => {
  const u = JSON.parse(r.remote_user) as FeedPerson;
  return { id: r.id, url: r.url, name: r.name, color: r.color, user: { name: u.name, email: u.email }, lastOkAt: r.last_ok_at, lastError: r.last_error };
};

/** Plain http on localhost is only for developing: when this instance runs locally too (or DEV_LOGIN is on). */
const devHere = (env: Env, self: string) => env.DEV_LOGIN === '1' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(self).hostname);
/** The other instance's origin, or an error to show. Only https, except localhost while developing. */
function cleanUrl(env: Env, raw: unknown, self: string): string {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim().replace(/^(?!https?:\/\/)/, 'https://')); } catch { throw bad("That isn't a web address."); }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (local ? !devHere(env, self) : u.protocol !== 'https:') throw bad('Use the https:// address of the other instance.');
  // No private network addresses: this server fetches it.
  if (!local && (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.startsWith('[') || !u.hostname.includes('.'))) throw bad('Use the name of the other instance, like work.example.com.');
  return u.origin;
}

/** Calls the other instance as the person who added it. Its errors come back as messages to show. */
async function call<T>(env: Env, v: Viewer, f: Pick<FeedRow, 'url' | 'name'> & { token: string }, method: string, path: string, body?: unknown, plainToken = false): Promise<T> {
  const token = plainToken ? f.token : await decrypt(env, f.token, TOKEN_INFO);
  if (!token) throw conflict(`The token for ${f.name} can't be read any more. Remove it and add it again.`);
  let res: Response;
  try {
    res = await fetch(`${f.url}/feed/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-tz': v.tz, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(502, `Couldn't reach ${f.name}.`);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (res.ok && data) return data;
  const why = data?.error;
  // Never pass a 401 on: the app would think *you* were signed out here.
  if (res.status === 401) throw conflict(`${f.name} refused the access token${why ? `: ${why}` : ''}`);
  if (res.status === 404 && !why) throw new HttpError(502, `${f.name} doesn't support connecting yet (it needs Taskivities 0.6 or later).`);
  if (res.status >= 400 && res.status < 500) throw new HttpError(res.status === 404 ? 404 : res.status === 409 ? 409 : 400, why || `${f.name} said no.`);
  throw new HttpError(502, `${f.name} had a problem${why ? `: ${why}` : '.'}`);
}

const loadFeed = async (env: Env, v: Viewer, id: string) => {
  const f = await env.DB.prepare('SELECT * FROM feeds WHERE id = ? AND user_id = ?').bind(id, v.id).first<FeedRow>();
  if (!f) throw notFound("That instance isn't connected any more.");
  return f;
};

export const feedRoutes = new Hono<AppEnv>();

feedRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM feeds WHERE user_id = ? ORDER BY created_at').bind(c.get('viewer').id).all<FeedRow>();
  return c.json({ feeds: results.map(feedInfo) });
});

/** Saves a connection to another instance (its token encrypted). */
async function saveFeed(env: Env, userId: string, url: string, token: string, who: { instance: string; me: FeedPerson }): Promise<FeedInfo> {
  const db = env.DB;
  const { results: mine } = await db.prepare('SELECT * FROM feeds WHERE user_id = ?').bind(userId).all<FeedRow>();
  if (mine.length >= FEEDS_MAX) throw conflict(`You can connect up to ${FEEDS_MAX} instances.`);
  if (mine.some((f) => f.url === url && (JSON.parse(f.remote_user) as FeedPerson).id === who.me.id)) throw conflict(`${who.instance} is already connected as ${who.me.name}.`);
  let stored: string;
  try { stored = await encrypt(env, token, TOKEN_INFO); } catch { throw conflict('This instance has no key to keep the token safe. Set TOKEN_KEY (npm run tenant -- secret <instance> TOKEN_KEY).'); }
  const used = new Set(mine.map((f) => f.color));
  const row: FeedRow = {
    id: uid(), user_id: userId, url, token: stored, name: who.instance, remote_user: JSON.stringify(who.me),
    color: PROJECT_COLORS.find((x) => !used.has(x)) ?? PROJECT_COLORS[mine.length % PROJECT_COLORS.length], created_at: nowIso(), last_ok_at: nowIso(), last_error: null,
  };
  await db.prepare('INSERT INTO feeds (id, user_id, url, token, name, remote_user, color, created_at, last_ok_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.user_id, row.url, row.token, row.name, row.remote_user, row.color, row.created_at, row.last_ok_at).run();
  return feedInfo(row);
}

/** Adds another instance with a token made there: checks it works first. */
feedRoutes.post('/', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ url?: string; token?: string }>().catch(() => ({} as { url?: string; token?: string }));
  const url = cleanUrl(c.env, b.url, c.req.url);
  if (url === new URL(c.req.url).origin) throw bad("That's this instance.");
  const token = (b.token ?? '').trim();
  if (!token.startsWith(TOKEN_PREFIX)) throw bad(`Paste the access token you made there (it starts with ${TOKEN_PREFIX}).`);
  const who = await call<{ instance: string; me: FeedPerson }>(c.env, v, { url, name: url.replace(/^https?:\/\//, ''), token }, 'GET', '/me', undefined, true);
  return c.json({ feed: await saveFeed(c.env, v.id, url, token, who) }, 201);
});

/**
 * Asks another instance for access instead: returns the address to send the browser to. You approve there, and come
 * back to /connect/done here, which finishes it (connectRoutes).
 */
feedRoutes.post('/request', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ url?: string }>().catch(() => ({} as { url?: string }));
  const url = cleanUrl(c.env, b.url, c.req.url);
  const self = new URL(c.req.url).origin;
  if (url === self) throw bad("That's this instance.");
  const db = c.env.DB;
  await db.prepare("DELETE FROM connect_states WHERE created_at < ?").bind(new Date(Date.now() - 3600_000).toISOString()).run();
  const state = randomToken(18);
  await db.prepare('INSERT INTO connect_states (state, user_id, url, created_at) VALUES (?, ?, ?, ?)').bind(state, v.id, url, nowIso()).run();
  const name = appName(await loadSettings(db));
  return c.json({ go: `${url}/connect?${new URLSearchParams({ return: self, name, state })}` });
});

feedRoutes.delete('/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM feeds WHERE id = ? AND user_id = ?').bind(c.req.param('id'), c.get('viewer').id).run();
  return c.json({ ok: true });
});

/** Every connected instance's tasks for these days, side by side. One that can't be reached says why; the rest still come. */
feedRoutes.get('/tasks', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const from = c.req.query('from') ?? '', to = c.req.query('to') ?? '';
  if (!isDate(from) || !isDate(to)) throw bad('Give from and to as YYYY-MM-DD.');
  const { results } = await db.prepare('SELECT * FROM feeds WHERE user_id = ? ORDER BY created_at').bind(v.id).all<FeedRow>();
  const out = await Promise.all(results.map(async (f) => {
    try {
      const data = await call<FeedTasks>(c.env, v, f, 'GET', `/tasks?from=${from}&to=${to}`);
      // Saved now and then (not on every poll), and whenever it recovers or its name changes.
      if (f.last_error || f.name !== data.instance || !f.last_ok_at || Date.now() - Date.parse(f.last_ok_at) > 3600_000)
        await db.prepare('UPDATE feeds SET last_ok_at = ?, last_error = NULL, name = ? WHERE id = ?').bind(nowIso(), data.instance, f.id).run();
      return { feed: { ...feedInfo(f), name: data.instance, lastError: null }, data };
    } catch (e) {
      const msg = e instanceof Error ? e.message : `Couldn't reach ${f.name}.`;
      if (f.last_error !== msg) await db.prepare('UPDATE feeds SET last_error = ? WHERE id = ?').bind(msg, f.id).run();
      return { feed: { ...feedInfo(f), lastError: msg }, data: null };
    }
  }));
  return c.json({ feeds: out });
});

/** Everything else on one of its tasks is passed on as it is: /api/feeds/<feed>/tasks/<task>[/…]. */
feedRoutes.all('/:fid/tasks/*', async (c) => {
  const v = c.get('viewer');
  const f = await loadFeed(c.env, v, c.req.param('fid'));
  const rest = c.req.path.slice(c.req.path.indexOf('/tasks/') + '/tasks'.length);
  const method = c.req.method;
  const body = method === 'GET' || method === 'DELETE' ? undefined : await c.req.json().catch(() => ({}));
  return c.json(await call(c.env, v, f, method, `/tasks${rest}`, body));
});

// =====================================================================================================================
// Request and approve: the page where you approve another instance (here), and where you come back to (there)
// =====================================================================================================================
interface CodeRow { code_hash: string; user_id: string; name: string; return_origin: string; created_at: string }
interface StateRow { state: string; user_id: string; url: string; created_at: string }
const CODE_MINUTES = 10;

export const connectRoutes = new Hono<AppEnv>();

/** Where the asking instance wants to come back to: its origin, https (or localhost while developing). */
function returnOrigin(env: Env, raw: string | undefined, self: string): string | null {
  try {
    const u = new URL(raw ?? '');
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (u.origin !== raw || (local ? !devHere(env, self) : u.protocol !== 'https:')) return null;
    return u.origin;
  } catch { return null; }
}
const back = (origin: string, q: Record<string, string>) => `${origin}/connect/done?${new URLSearchParams(q)}`;

/** The approval page: "Show your tasks from here on <that instance>?" */
connectRoutes.get('/', async (c) => {
  const ret = returnOrigin(c.env, c.req.query('return'), c.req.url);
  const state = c.req.query('state') ?? '';
  const name = (c.req.query('name') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) || 'Another Taskivities';
  if (!ret || !state) return page('Can’t connect', '<h1>Can’t connect</h1><p>This link is incomplete. Start again from the other instance.</p>', 400);
  const user = await currentUser(c);
  if (!user) { const u = new URL(c.req.url); return c.redirect(`/login?next=${encodeURIComponent(u.pathname + u.search)}`); }
  const here = appName(await loadSettings(c.env.DB));
  const host = new URL(ret).host;
  return page(`Show your tasks on ${name}?`, `<h1>Show your ${esc(here)} tasks on <b>${esc(name)}</b>?</h1>
<p>Signed in as <b>${esc(user.name || user.email)}</b> (${esc(user.email)}).</p>
<p><b>${esc(host)}</b> asks to show the tasks assigned to you here, and to let you, from there:</p>
<ul><li>mark them done or not, and move them</li><li>change their priority, effort and notes</li><li>tick checklists and comment</li></ul>
<p>It can't see anyone else's tasks, and can't hand tasks over, delete them or change projects. Its changes show in each task's history as yours.</p>
<p class="muted">You can revoke this any time: account menu → Other instances. Only approve if you just asked for it on ${esc(host)}.</p>
<form method="post">
  <input type="hidden" name="return" value="${esc(ret)}"><input type="hidden" name="state" value="${esc(state)}"><input type="hidden" name="name" value="${esc(name)}">
  <div class="row"><button name="decision" value="deny">Cancel</button><button class="primary" name="decision" value="approve">Approve</button></div>
</form>`);
});

connectRoutes.post('/', async (c) => {
  // A form on this page only: same origin.
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(c.req.url).origin) return page('Can’t connect', '<h1>Can’t connect</h1><p>Approve from this instance’s own page.</p>', 403);
  const user = await currentUser(c);
  if (!user) return page('Signed out', '<h1>You were signed out</h1><p>Start again from the other instance.</p>', 401);
  const form = await c.req.formData();
  const ret = returnOrigin(c.env, String(form.get('return') ?? ''), c.req.url);
  const state = String(form.get('state') ?? '');
  const name = String(form.get('name') ?? '').slice(0, 40) || 'Another Taskivities';
  if (!ret || !state) return page('Can’t connect', '<h1>Can’t connect</h1><p>Start again from the other instance.</p>', 400);
  if (form.get('decision') !== 'approve') return c.redirect(back(ret, { state, error: 'denied' }));
  const db = c.env.DB;
  await db.prepare('DELETE FROM connect_codes WHERE created_at < ?').bind(new Date(Date.now() - CODE_MINUTES * 60_000).toISOString()).run();
  const code = randomToken(24);
  await db.prepare('INSERT INTO connect_codes (code_hash, user_id, name, return_origin, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256hex(code), user.id, `${name} (${new URL(ret).host})`, ret, nowIso()).run();
  return c.redirect(back(ret, { state, code }));
});

/** Server to server: the asking instance swaps the code (once, within 10 minutes, from where it was sent) for a token. */
connectRoutes.post('/exchange', async (c) => {
  const b = await c.req.json<{ code?: string; return?: string }>().catch(() => ({} as { code?: string; return?: string }));
  const db = c.env.DB;
  const row = b.code ? await db.prepare('SELECT * FROM connect_codes WHERE code_hash = ?').bind(await sha256hex(b.code)).first<CodeRow>() : null;
  if (row) await db.prepare('DELETE FROM connect_codes WHERE code_hash = ?').bind(row.code_hash).run();
  if (!row || row.return_origin !== b.return || Date.now() - Date.parse(row.created_at) > CODE_MINUTES * 60_000)
    return c.json({ error: 'That approval expired or was already used. Ask again.' }, 400);
  const v = await loadViewer(c.env, row.user_id);
  if (!v) return c.json({ error: 'That person can no longer sign in here.' }, 400);
  const token = TOKEN_PREFIX + randomToken(32);
  await db.prepare('INSERT INTO access_tokens (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(uid(), v.id, row.name, await sha256hex(token), nowIso()).run();
  const me = await db.prepare('SELECT id, name, email, color FROM users WHERE id = ?').bind(v.id).first<FeedPerson>();
  return c.json({ token, instance: appName(await loadSettings(db)), me: person(me!) });
});

/** Back here after approving (or not) there: finish connecting, then open the app on the Other instances sheet. */
connectRoutes.get('/done', async (c) => {
  const user = await currentUser(c);
  if (!user) return c.redirect('/login');
  const db = c.env.DB;
  const state = c.req.query('state') ?? '';
  const row = state ? await db.prepare('SELECT * FROM connect_states WHERE state = ? AND user_id = ?').bind(state, user.id).first<StateRow>() : null;
  if (row) await db.prepare('DELETE FROM connect_states WHERE state = ?').bind(state).run();
  const done = (q: Record<string, string>) => c.redirect(`/?${new URLSearchParams(q)}`);
  if (!row || Date.now() - Date.parse(row.created_at) > 3600_000) return done({ instances: 'error', why: 'That request expired. Ask again.' });
  if (c.req.query('error')) return done({ instances: 'error', why: 'Access wasn’t approved.' });
  const self = new URL(c.req.url).origin;
  try {
    const res = await fetch(`${row.url}/connect/exchange`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: c.req.query('code') ?? '', return: self }),
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json().catch(() => null)) as { token?: string; instance?: string; me?: FeedPerson; error?: string } | null;
    if (!res.ok || !data?.token || !data.me || !data.instance) return done({ instances: 'error', why: data?.error || `${new URL(row.url).host} didn’t finish connecting.` });
    const f = await saveFeed(c.env, user.id, row.url, data.token, { instance: data.instance, me: data.me });
    return done({ instances: 'connected', name: f.name });
  } catch (e) {
    return done({ instances: 'error', why: e instanceof HttpError ? e.message : `Couldn’t reach ${new URL(row.url).host}.` });
  }
});
