// Admin-only: people, roles, project access, projects, app settings.
import { Hono } from 'hono';
import { EMAIL_RE } from '../shared/rules';
import { isEffortType } from '../shared/effort';
import { DESCRIPTION_MAX, PROJECT_COLORS, USER_COLORS, type Role } from '../shared/types';
import type { SendResult } from './invite-mail';
import { disconnectInviteMail, sendInvites } from './mailer';
import { checkIcons, checkName, checkSvg, loadSettings, saveIcons, saveLogo, saveName, saveWordmark } from './settings';
import { webhookAdmin } from './webhooks';
import { notify } from './push';
import {
  type AppEnv, type Ctx, type ProjectRow, type UserRow, CURRENT_VERSION, auditStmt, bad, bumpDirectory, bumpVersion, conflict, eventStmt,
  forbidden, getUser, mapProject, memberProjects, notFound, nowIso, uid,
} from './lib';

export const admin = new Hono<AppEnv>();

admin.use('*', async (c, next) => {
  if (c.get('viewer').role !== 'admin') throw forbidden('Only admins can do that.');
  await next();
});

admin.route('/webhooks', webhookAdmin);

const activeAdmins = async (db: D1Database) =>
  (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status != 'disabled'").first<{ n: number }>())!.n;
const openTasksIn = async (db: D1Database, userId: string, projectId?: string) =>
  (await db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee_id = ? AND status = 'open' AND archived_at IS NULL${projectId ? ' AND project_id = ?' : ''}`)
    .bind(...(projectId ? [userId, projectId] : [userId]))
    .first<{ n: number }>())!.n;
/** Enabling someone again: active if they've signed in before, otherwise still invited. */
const ENABLED_STATUS = "CASE WHEN last_seen_at IS NULL THEN 'invited' ELSE 'active' END";
const existingProjects = async (db: D1Database) =>
  new Set((await db.prepare('SELECT id FROM projects WHERE archived = 0').all<{ id: string }>()).results.map((r) => r.id));

// ---------- people ----------
admin.post('/users', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const b = await c.req.json<{ emails?: string[]; role?: Role; projects?: string[] }>();
  const emails = [...new Set((b.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) throw bad('Enter at least one email address.');
  const invalid = emails.filter((e) => !EMAIL_RE.test(e));
  if (invalid.length) throw bad(`Not a valid email: ${invalid.join(', ')}`);
  const role: Role = b.role === 'admin' ? 'admin' : 'member';
  const known = await existingProjects(db);
  const projects = role === 'admin' ? [] : [...new Set(b.projects ?? [])].filter((p) => known.has(p));
  if (role === 'member' && !projects.length) throw bad('Pick at least one project for a member.');

  const stmts: D1PreparedStatement[] = [];
  const added: string[] = [];
  const skipped: string[] = [];
  const now = nowIso();
  for (const email of emails) {
    const existing = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRow>();
    if (existing && existing.status !== 'disabled') { skipped.push(email); continue; }
    const id = existing?.id ?? uid();
    if (existing) {
      // Someone disabled earlier is enabled again, with the role and projects chosen here.
      stmts.push(db.prepare(`UPDATE users SET role = ?, status = ${ENABLED_STATUS}, disabled_at = NULL, disabled_by = NULL WHERE id = ?`).bind(role, id));
      stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ?').bind(id));
    } else {
      stmts.push(
        db.prepare("INSERT INTO users (id, email, name, color, role, status, added_by, added_at) VALUES (?, ?, '', ?, ?, 'invited', ?, ?)")
          .bind(id, email, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)], role, v.id, now),
      );
    }
    for (const p of projects) stmts.push(db.prepare('INSERT OR IGNORE INTO project_members (user_id, project_id) VALUES (?, ?)').bind(id, p));
    stmts.push(auditStmt(db, v.id, 'user_added', id, { email, role, projects }));
    added.push(email);
  }
  if (stmts.length) await db.batch([...stmts, bumpDirectory(db)]);
  // Email them from the admin's Gmail or Outlook if one is connected. Never fails the add: the app falls back to the link.
  const names = await projectNames(db, projects);
  const email = await emailInvites(c, added.map((to) => ({ to, role, projects: names })));
  return c.json({ added, skipped, email });
});

const projectNames = async (db: D1Database, ids: string[]) => {
  if (!ids.length) return [];
  const { results } = await db.prepare(`SELECT name FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`).bind(...ids).all<{ name: string }>();
  return results.map((r) => r.name);
};

async function emailInvites(c: Ctx, people: { to: string; role: Role; projects: string[] }[]): Promise<SendResult> {
  const v = c.get('viewer');
  const link = `${new URL(c.req.url).origin}/login`;
  const app = (await loadSettings(c.env.DB)).name;
  const r = await sendInvites(c.env, { id: v.id, name: v.name }, people.map((p) => ({ ...p, link, app })));
  if (r.sent.length) await auditStmt(c.env.DB, v.id, 'invite_emailed', null, { to: r.sent }).run();
  return r;
}

/** Sends the invite email again to someone who hasn't signed in yet. */
admin.post('/users/:id/invite', async (c) => {
  const db = c.env.DB;
  const u = await getUser(db, c.req.param('id'));
  if (!u || u.status !== 'invited') throw bad('Only people who haven\'t signed in yet can be sent an invite.');
  const names = u.role === 'admin' ? [] : await projectNames(db, await memberProjects(db, u.id));
  return c.json({ email: await emailInvites(c, [{ to: u.email, role: u.role, projects: names }]) });
});

admin.patch('/users/:id', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const u = await getUser(db, id);
  if (!u || u.status === 'disabled') throw notFound('Person not found.');
  const b = await c.req.json<{ role?: Role; projects?: string[] }>();
  const stmts: D1PreparedStatement[] = [];
  let role = u.role;

  if (b.role && b.role !== u.role) {
    if (id === v.id) throw forbidden("You can't change your own role.");
    if (u.role === 'admin' && (await activeAdmins(db)) <= 1) throw conflict("Can't demote the last admin.");
    role = b.role;
    stmts.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, id));
    stmts.push(auditStmt(db, v.id, 'role_changed', id, { from: u.role, to: role }));
  }

  if (role === 'member' && (b.projects || u.role === 'admin')) {
    const known = await existingProjects(db);
    const current = await memberProjects(db, id);
    let wanted = b.projects ? [...new Set(b.projects)].filter((p) => known.has(p)) : current;
    if (u.role === 'admin' && !b.projects) {
      // Demoted admins keep access to wherever they still have open work.
      const { results } = await db.prepare("SELECT DISTINCT project_id FROM tasks WHERE assignee_id = ? AND status = 'open' AND archived_at IS NULL").bind(id).all<{ project_id: string }>();
      wanted = [...new Set([...current, ...results.map((r) => r.project_id)])];
    }
    if (!wanted.length) throw bad('A member needs at least one project.');
    for (const p of current.filter((p) => !wanted.includes(p))) {
      const n = await openTasksIn(db, id, p);
      if (n) throw conflict(`${u.name || u.email} still has ${n} open task${n > 1 ? 's' : ''} in that project. Transfer them first.`);
      stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id = ?').bind(id, p));
    }
    for (const p of wanted.filter((p) => !current.includes(p))) {
      stmts.push(db.prepare('INSERT OR IGNORE INTO project_members (user_id, project_id) VALUES (?, ?)').bind(id, p));
    }
    stmts.push(auditStmt(db, v.id, 'projects_changed', id, { from: current, to: wanted }));
  }
  if (stmts.length) await db.batch([...stmts, bumpDirectory(db)]);
  return c.json({ ok: true });
});

/**
 * Disable someone. Nothing about them is deleted: they can't sign in (their sessions, assistant connections and Gmail
 * connection end), but they stay on the People & projects page, in every task's history, and on their projects, ready to be enabled again.
 * Their open tasks go to `transferTo` first, in the same batch, each transfer logged; their repeating tasks go with them.
 */
admin.post('/users/:id/disable', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const u = await getUser(db, id);
  if (!u) throw notFound('Person not found.');
  if (u.status === 'disabled') return c.json({ ok: true, transferred: 0 });
  if (id === v.id) throw forbidden("You can't disable yourself.");
  if (u.role === 'admin' && (await activeAdmins(db)) <= 1) throw conflict("Can't disable the last admin.");
  // Open tasks in archived projects stay with them: they're hidden, and can be handed on once the project is restored.
  const { results: open } = await db.prepare(
    "SELECT id, project_id FROM tasks WHERE assignee_id = ? AND status = 'open' AND project_id IN (SELECT id FROM projects WHERE archived = 0)",
  ).bind(id).all<{ id: string; project_id: string }>();
  const to = c.req.query('transferTo');
  const stmts: D1PreparedStatement[] = [];
  const now = nowIso();
  if (open.length) {
    if (!to) throw bad(`They have ${open.length} open tasks. Choose who gets them.`);
    const target = await getUser(db, to);
    if (!target || target.status !== 'active' || to === id) throw bad('Choose an active person.');
    if (target.role !== 'admin') {
      const theirs = new Set(await memberProjects(db, to));
      if (open.some((t) => !theirs.has(t.project_id))) throw bad(`${target.name || target.email} isn't on all of those projects.`);
    }
    stmts.push(bumpVersion(db));
    // Their repeating tasks keep going, with the same person.
    stmts.push(db.prepare('UPDATE series SET assignee_id = ?, updated_at = ? WHERE assignee_id = ? AND active = 1').bind(to, now, id));
    for (const t of open) {
      stmts.push(db.prepare(`UPDATE tasks SET assignee_id = ?, assigned_by = ?, updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(to, v.id, now, t.id));
      stmts.push(eventStmt(db, { taskId: t.id, actorId: v.id, type: 'transferred', from: id, to, note: `${u.name || u.email} was disabled`, at: now }));
    }
  }
  stmts.push(db.prepare("UPDATE users SET status = 'disabled', disabled_at = ?, disabled_by = ? WHERE id = ?").bind(now, v.id, id));
  stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  stmts.push(db.prepare('DELETE FROM google_tokens WHERE user_id = ?').bind(id)); // and their Gmail connection
  stmts.push(db.prepare('DELETE FROM microsoft_tokens WHERE user_id = ?').bind(id)); // or their Outlook one
  stmts.push(db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(id)); // and their devices' notifications
  stmts.push(auditStmt(db, v.id, 'user_disabled', id, { transferred: open.length, to: to ?? null }));
  stmts.push(bumpDirectory(db));
  await db.batch(stmts);
  if (open.length && to) notify(c.env, [{ to, kind: 'assigned', actorId: v.id, via: null, count: open.length, fromName: u.name || u.email }]);
  return c.json({ ok: true, transferred: open.length });
});

/** Enable someone again, with the role and projects they had (members can be given `projects` instead). */
admin.post('/users/:id/enable', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const u = await getUser(db, id);
  if (!u) throw notFound('Person not found.');
  if (u.status !== 'disabled') return c.json({ ok: true });
  const b = await c.req.json<{ projects?: string[] }>().catch(() => ({} as { projects?: string[] }));
  const known = await existingProjects(db);
  const stmts: D1PreparedStatement[] = [];
  if (u.role === 'member') {
    const current = await memberProjects(db, id);
    const wanted = b.projects ? [...new Set(b.projects)].filter((p) => known.has(p)) : current.filter((p) => known.has(p));
    if (!wanted.length) throw bad('Pick at least one project for them.');
    if (b.projects) {
      // Archived projects they were on are kept, so restoring one brings them back to it.
      for (const p of current.filter((p) => known.has(p) && !wanted.includes(p))) stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id = ?').bind(id, p));
      for (const p of wanted.filter((p) => !current.includes(p))) stmts.push(db.prepare('INSERT OR IGNORE INTO project_members (user_id, project_id) VALUES (?, ?)').bind(id, p));
    }
  }
  stmts.push(db.prepare(`UPDATE users SET status = ${ENABLED_STATUS}, disabled_at = NULL, disabled_by = NULL WHERE id = ?`).bind(id));
  stmts.push(auditStmt(db, v.id, 'user_enabled', id, b.projects ? { projects: b.projects } : null));
  stmts.push(bumpDirectory(db));
  await db.batch(stmts);
  return c.json({ ok: true });
});

// ---------- projects ----------
interface ProjectBody { name?: string; color?: string; description?: string; members?: string[]; effort?: string | null; effortRequired?: boolean }

async function validateProject(db: D1Database, b: ProjectBody, selfId?: string) {
  const name = (b.name ?? '').trim();
  if (!name) throw bad('Give the project a name.');
  if (name.length > 80) throw bad('Project names can be at most 80 characters.');
  const dup = await db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND archived = 0 AND id != ?').bind(name, selfId ?? '').first();
  if (dup) throw conflict('Another project already has that name.');
  const color = b.color && PROJECT_COLORS.includes(b.color) ? b.color : PROJECT_COLORS[0];
  const description = (b.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX) throw bad(`Descriptions can be at most ${DESCRIPTION_MAX} characters.`);
  if (b.effort != null && !isEffortType(b.effort)) throw bad('Unknown way of tracking effort.');
  const effort = b.effort ?? null;
  const effortRequired = !!effort && !!b.effortRequired;
  return { name, color, description, effort, effortRequired };
}

admin.post('/projects', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const b = await c.req.json<ProjectBody>();
  const p = await validateProject(db, b);
  const id = uid();
  const stmts = [
    db.prepare('INSERT INTO projects (id, name, color, description, effort, effort_required, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
      .bind(id, p.name, p.color, p.description, p.effort, p.effortRequired ? 1 : 0, nowIso()),
    ...(b.members ?? []).map((u) => db.prepare("INSERT OR IGNORE INTO project_members (user_id, project_id) SELECT id, ? FROM users WHERE id = ? AND role = 'member' AND status != 'disabled'").bind(id, u)),
    auditStmt(db, v.id, 'project_created', id, p),
    bumpDirectory(db),
  ];
  await db.batch(stmts);
  return c.json({ id }, 201);
});

admin.patch('/projects/:id', async (c) => {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id');
  const cur = await db.prepare('SELECT * FROM projects WHERE id = ? AND archived = 0').bind(id).first<ProjectRow>();
  if (!cur) throw notFound('Project not found.');
  const b = await c.req.json<ProjectBody>();
  const p = await validateProject(db, {
    name: b.name ?? cur.name, color: b.color ?? cur.color, description: b.description ?? cur.description,
    effort: b.effort !== undefined ? b.effort : cur.effort, effortRequired: b.effortRequired ?? !!cur.effort_required,
  }, id);
  const stmts: D1PreparedStatement[] = [
    db.prepare('UPDATE projects SET name = ?, color = ?, description = ?, effort = ?, effort_required = ? WHERE id = ?')
      .bind(p.name, p.color, p.description, p.effort, p.effortRequired ? 1 : 0, id),
  ];
  if (b.members) {
    // Disabled people keep their place on the project (for when they're enabled again); the editor doesn't list them.
    const { results } = await db.prepare(
      "SELECT m.user_id FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? AND u.status != 'disabled'",
    ).bind(id).all<{ user_id: string }>();
    const current = results.map((r) => r.user_id);
    for (const u of current.filter((u) => !b.members!.includes(u))) {
      const n = await openTasksIn(db, u, id);
      const user = await getUser(db, u);
      if (n) throw conflict(`${user?.name || user?.email} still has ${n} open task${n > 1 ? 's' : ''} here. Transfer them first.`);
      if ((await memberProjects(db, u)).length <= 1) throw conflict(`${user?.name || user?.email} needs at least one project.`);
      stmts.push(db.prepare('DELETE FROM project_members WHERE user_id = ? AND project_id = ?').bind(u, id));
    }
    for (const u of b.members.filter((u) => !current.includes(u))) {
      stmts.push(db.prepare("INSERT OR IGNORE INTO project_members (user_id, project_id) SELECT id, ? FROM users WHERE id = ? AND role = 'member' AND status != 'disabled'").bind(id, u));
    }
  }
  stmts.push(auditStmt(db, v.id, 'project_updated', id, p), bumpDirectory(db));
  await db.batch(stmts);
  return c.json({ ok: true });
});

/**
 * Archive a project (or restore it). Nothing is deleted: the project and all its tasks, open or done, disappear from
 * every list, count, search and assistant until it's restored, and then come back as they were. Its incoming webhooks
 * stop making tasks, and its repeating tasks pause. Members keep their place on it.
 */
async function setProjectArchived(c: Ctx, archive: boolean) {
  const v = c.get('viewer');
  const db = c.env.DB;
  const id = c.req.param('id')!;
  const cur = await db.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first<ProjectRow>();
  if (!cur) throw notFound('Project not found.');
  if (!!cur.archived === archive) return c.json({ ok: true });
  if (!archive) {
    const dup = await db.prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND archived = 0').bind(cur.name).first();
    if (dup) throw conflict(`Another project is already called ${cur.name}. Rename that one first.`);
  }
  const now = nowIso();
  await db.batch([
    bumpVersion(db),
    db.prepare('UPDATE projects SET archived = ?, archived_at = ?, archived_by = ? WHERE id = ?').bind(archive ? 1 : 0, archive ? now : null, archive ? v.id : null, id),
    // Every task in it changes version, so open apps drop them (or get them back) on their next sync.
    db.prepare(`UPDATE tasks SET version = ${CURRENT_VERSION} WHERE project_id = ?`).bind(id),
    auditStmt(db, v.id, archive ? 'project_archived' : 'project_restored', id, { name: cur.name }),
    bumpDirectory(db),
  ]);
  return c.json({ ok: true });
}
admin.post('/projects/:id/archive', (c) => setProjectArchived(c, true));
admin.post('/projects/:id/restore', (c) => setProjectArchived(c, false));

/** Archived projects, newest first, with how much is in each. Only the People & projects page asks for these. */
admin.get('/projects/archived', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived_at IS NULL AND t.status = 'open') AS open_count,
       (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived_at IS NULL AND t.status = 'done') AS done_count
     FROM projects p WHERE p.archived = 1 ORDER BY p.archived_at DESC, p.name`,
  ).all<ProjectRow & { open_count: number; done_count: number }>();
  return c.json({
    projects: results.map((r) => ({ ...mapProject(r), archivedAt: r.archived_at, archivedBy: r.archived_by, open: r.open_count, done: r.done_count })),
  });
});

// ---------- app settings ----------
admin.put('/settings/logo', async (c) => {
  const b = await c.req.json<{ svg?: unknown }>();
  return c.json({ settings: await saveLogo(c.env.DB, c.get('viewer').id, checkSvg(b.svg)) });
});

admin.put('/settings/icon', async (c) => {
  const b = await c.req.json<{ icons?: unknown }>();
  return c.json({ settings: await saveIcons(c.env.DB, c.get('viewer').id, checkIcons(b.icons)) });
});
admin.delete('/settings/icon', async (c) => c.json({ settings: await saveIcons(c.env.DB, c.get('viewer').id, null) }));

admin.delete('/settings/logo', async (c) => c.json({ settings: await saveLogo(c.env.DB, c.get('viewer').id, null) }));

/** The team's name in place of "Taskivities" (an empty name goes back to it). */
admin.put('/settings/name', async (c) => {
  const b = await c.req.json<{ name?: unknown }>();
  return c.json({ settings: await saveName(c.env.DB, c.get('viewer').id, checkName(b.name ?? '')) });
});

/** A wordmark (SVG) shown in the top bar and on the sign-in page instead of the name. */
admin.put('/settings/wordmark', async (c) => {
  const b = await c.req.json<{ svg?: unknown }>();
  return c.json({ settings: await saveWordmark(c.env.DB, c.get('viewer').id, checkSvg(b.svg, 'wordmark')) });
});
admin.delete('/settings/wordmark', async (c) => c.json({ settings: await saveWordmark(c.env.DB, c.get('viewer').id, null) }));

// ---------- Gmail or Outlook for invite emails (connecting is a redirect: GET /auth/gmail or /auth/outlook) ----------
admin.delete('/invite-mail', async (c) => {
  const v = c.get('viewer');
  await disconnectInviteMail(c.env, v.id);
  await auditStmt(c.env.DB, v.id, 'invite_mail_disconnected', v.id, null).run();
  return c.json({ ok: true });
});
