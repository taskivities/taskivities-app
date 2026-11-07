import { Hono } from 'hono';
import { addDays, isDate } from '../shared/dates';
import type { Bootstrap, SyncResponse } from '../shared/types';
import {
  type AppEnv, type EventRow, type ProjectRow, type TaskRow, type UserRow,
  TASK_COLS, bad, canSeeProject, notFound, mapEvent, mapProject, mapTask, mapUser, today,
} from './lib';
import { inviteMailOptions, inviteMailStatus, signInWith } from './mailer';
import { loadSettings } from './settings';
import { prefsOf, pushKeys } from './push';
import { inboxUnread } from './inbox';
import { type ChecklistChange, type Patch, addComment, applyPatch, changeChecklist, setArchived, commit, createTask, loadVisibleTask, updateTaskWithNext, visible } from './tasks';

export const api = new Hono<AppEnv>();

async function getMeta(db: D1Database) {
  const { results } = await db.prepare('SELECT key, value FROM meta').all<{ key: string; value: number }>();
  const m = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return { version: m.version ?? 0, directoryVersion: m.directory_version ?? 0 };
}

/** Where new releases are announced (UPDATE_REPO: "owner/repo", or "off"). Only admins are told: only they deploy. */
const updateRepo = (raw: string | undefined) => {
  const r = (raw ?? '').trim();
  if (/^(off|false|no|0)$/i.test(r)) return null;
  return { repo: /^[\w.-]+\/[\w.-]+$/.test(r) ? r : 'taskivities/taskivities-app' };
};

// ---------- bootstrap: me, people, projects ----------
api.get('/bootstrap', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const [users, members, projects, meta, settings, inviteMail] = await Promise.all([
    db.prepare('SELECT * FROM users ORDER BY name').all<UserRow>(),
    db.prepare('SELECT user_id, project_id FROM project_members').all<{ user_id: string; project_id: string }>(),
    db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name').all<ProjectRow>(),
    getMeta(db),
    loadSettings(db),
    v.role === 'admin' ? inviteMailStatus(c.env, v.id) : null,
  ]);
  const visibleProjects = projects.results.filter((p) => canSeeProject(v, p.id));
  const visibleIds = new Set(visibleProjects.map((p) => p.id));
  const byUser = new Map<string, string[]>();
  for (const m of members.results) {
    // Members only learn about memberships in projects they can see.
    if (!visibleIds.has(m.project_id)) continue;
    byUser.set(m.user_id, [...(byUser.get(m.user_id) ?? []), m.project_id]);
  }
  const all = users.results.map((u) => mapUser(u, byUser.get(u.id) ?? []));
  const me = all.find((u) => u.id === v.id)!;
  // Disabled people stay in the list (history still names them); only admins see their email.
  const list = all.map((u) => (u.status === 'disabled' && v.role !== 'admin' ? { ...u, email: '' } : u));
  const keys = pushKeys(c.env);
  const myRow = users.results.find((u) => u.id === v.id);
  const body: Bootstrap = {
    me, users: list, projects: visibleProjects.map(mapProject), today: today(v), tz: v.tz, ...meta, settings, attachments: !!c.env.FILES,
    inviteMail, inviteMailOptions: v.role === 'admin' ? inviteMailOptions(c.env) : [], signInWith: signInWith(c.env),
    push: keys ? { publicKey: keys.publicKey } : null, notify: prefsOf(myRow?.notify),
    updates: v.role === 'admin' ? updateRepo(c.env.UPDATE_REPO) : null,
    inboxUnread: await inboxUnread(db, v, myRow?.inbox_read_at ?? null),
  };
  return c.json(body);
});

// ---------- tasks in a window (plus every open task) ----------
api.get('/tasks', async (c) => {
  const v = c.get('viewer');
  const t0 = today(v);
  const from = isDate(c.req.query('from')) ? c.req.query('from')! : addDays(t0, -60);
  const to = isDate(c.req.query('to')) ? c.req.query('to')! : addDays(t0, 365);
  const vis = visible(v);
  const { results } = await c.env.DB
    .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE archived_at IS NULL AND (status = 'open' OR due_date BETWEEN ? AND ? OR done_on BETWEEN ? AND ?) AND ${vis.sql}`)
    .bind(from, to, from, to, ...vis.binds)
    .all<TaskRow>();
  return c.json({ from, to, tasks: results.map(mapTask), ...(await getMeta(c.env.DB)) });
});

// ---------- polling ----------
api.get('/sync', async (c) => {
  const v = c.get('viewer');
  const since = Number(c.req.query('since') ?? 0);
  const meta = await getMeta(c.env.DB);
  const base = { version: meta.version, directoryVersion: meta.directoryVersion, today: today(v) };
  if (meta.version <= since) return c.json({ changed: false, ...base } satisfies SyncResponse);
  const { results } = await c.env.DB.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE version > ?`).bind(since).all<TaskRow>();
  // Archived tasks leave everyone's lists like tasks they can't see (restoring brings them back with a new version).
  const shown = (r: TaskRow) => canSeeProject(v, r.project_id) && !r.archived_at;
  const tasks = results.filter(shown).map(mapTask);
  const gone = results.filter((r) => !shown(r)).map((r) => r.id);
  // Every change moves the version on, so the inbox count only needs checking when something changed.
  return c.json({ changed: true, ...base, tasks, gone, inboxUnread: await inboxUnread(c.env.DB, v) } satisfies SyncResponse);
});

// ---------- create ----------
api.post('/tasks', async (c) => {
  const v = c.get('viewer');
  const b = await c.req.json<{ title?: string; notes?: string; projectId?: string; assigneeId?: string; dueDate?: string; priority?: number; repeat?: unknown; effort?: string | null }>();
  // The app's defaults: assigned to me, due today, Normal priority.
  const task = await createTask(c.env, v, {
    title: b.title ?? '',
    notes: b.notes,
    projectId: b.projectId ?? '',
    assigneeId: b.assigneeId || v.id,
    dueDate: b.dueDate ?? today(v),
    priority: b.priority ?? 3,
    repeat: b.repeat,
    effort: b.effort,
  });
  return c.json({ task }, 201);
});

// ---------- edit (every change is logged) ----------
api.patch('/tasks/:id', async (c) => {
  // `next`: the new copy, when this finished a repeating task.
  return c.json(await updateTaskWithNext(c.env, c.get('viewer'), c.req.param('id'), await c.req.json<Patch>()));
});

/** Move several tasks to one date (the "Move all" for carried-over tasks). */
api.post('/tasks/move', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const b = await c.req.json<{ ids?: string[]; dueDate?: string }>();
  if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 200) throw bad('Pick between 1 and 200 tasks.');
  const all: D1PreparedStatement[] = [];
  for (const id of b.ids) all.push(...(await applyPatch(c.env, v, id, { dueDate: b.dueDate })).stmts);
  await commit(c.env, all);
  const placeholders = b.ids.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id IN (${placeholders})`).bind(...b.ids).all<TaskRow>();
  return c.json({ tasks: results.map(mapTask) });
});

// ---------- archive (instead of delete) ----------
api.post('/tasks/:id/archive', async (c) => c.json({ task: await setArchived(c.env, c.get('viewer'), c.req.param('id'), true) }));
api.post('/tasks/:id/restore', async (c) => c.json({ task: await setArchived(c.env, c.get('viewer'), c.req.param('id'), false) }));
/** Archived tasks in one project (or all the viewer can see), newest first. Only the Projects page asks for these. */
api.get('/archived', async (c) => {
  const v = c.get('viewer');
  const project = c.req.query('project');
  const vis = visible(v);
  const where = ['archived_at IS NOT NULL', vis.sql];
  const binds: unknown[] = [...vis.binds];
  if (project && project !== 'all') { where.push('project_id = ?'); binds.push(project); }
  const { results } = await c.env.DB.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE ${where.join(' AND ')} ORDER BY archived_at DESC LIMIT 500`)
    .bind(...binds).all<TaskRow>();
  return c.json({ tasks: results.map(mapTask) });
});

api.post('/tasks/:id/comments', async (c) => {
  const b = await c.req.json<{ text?: string }>();
  return c.json({ task: await addComment(c.env, c.get('viewer'), c.req.param('id'), b.text) });
});

// ---------- checklist ----------
api.post('/tasks/:id/checklist', async (c) => {
  const b = await c.req.json<{ text?: string }>();
  return c.json({ task: await changeChecklist(c.env, c.get('viewer'), c.req.param('id'), { op: 'add', text: b.text ?? '' }) });
});
api.patch('/tasks/:id/checklist/:item', async (c) => {
  const b = await c.req.json<{ done?: boolean; text?: string }>();
  const ch: ChecklistChange = { op: 'set', itemId: c.req.param('item'), done: typeof b.done === 'boolean' ? b.done : undefined, text: b.text };
  return c.json({ task: await changeChecklist(c.env, c.get('viewer'), c.req.param('id'), ch) });
});
api.delete('/tasks/:id/checklist/:item', async (c) =>
  c.json({ task: await changeChecklist(c.env, c.get('viewer'), c.req.param('id'), { op: 'remove', itemId: c.req.param('item') }) }));

/** One task (a notification opens a task the app may not have loaded, e.g. a finished one from weeks ago). */
api.get('/tasks/:id', async (c) => {
  const t = await loadVisibleTask(c.env.DB, c.get('viewer'), c.req.param('id'));
  if (t.archived_at) throw notFound('That task is archived.');
  return c.json({ task: mapTask(t) });
});

api.get('/tasks/:id/events', async (c) => {
  const v = c.get('viewer');
  const t = await loadVisibleTask(c.env.DB, v, c.req.param('id'));
  const { results } = await c.env.DB.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at, rowid').bind(t.id).all<EventRow>();
  return c.json({ events: results.map(mapEvent) });
});
