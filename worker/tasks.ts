// Task rules shared by the REST API (worker/api.ts) and the MCP tools (worker/mcp.ts).
// Every check about who may see or change a task lives here, so the two can't drift apart.
import { addDays, dayIn, diffDays, isDate } from '../shared/dates';
import { EFFORT_TYPES, TIME_MAX_MIN, type EffortType, effortFor, effortValue, isEffortType } from '../shared/effort';
import { type Repeat, cleanRepeat, describe, firstDate, nextDate, sameRule } from '../shared/repeat';
import { CHECK_ITEMS_MAX, CHECK_TEXT_MAX, COMMENT_MAX, DURATION_MAX, NOTES_MAX, TITLE_MAX, type Priority, type Task } from '../shared/types';
import {
  type Env, type EventRow, type TaskRow, type Viewer,
  CURRENT_VERSION, TASK_COLS, bad, bumpVersion, canSeeProject, eventStmt, forbidden, mapTask, notFound, nowIso, today, uid,
  userOnProject,
} from './lib';
import { type Notice, WATCHERS, notify } from './push';
import { followStmt } from './followers';
import { touchLinked, unblockedBy } from './dependencies';

/** SQL fragment limiting tasks to the projects the viewer can see (never an archived project's). */
export const visible = (v: Viewer, alias = '') =>
  v.role === 'admin'
    ? { sql: `${alias}project_id IN (SELECT id FROM projects WHERE archived = 0)`, binds: [] as unknown[] }
    : {
        sql: `${alias}project_id IN (SELECT m.project_id FROM project_members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ? AND p.archived = 0)`,
        binds: [v.id] as unknown[],
      };

export async function loadTask(db: D1Database, id: string) {
  return db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).bind(id).first<TaskRow>();
}

/** A task the viewer can see, or 404 (never 403: hidden tasks don't exist for them). */
export async function loadVisibleTask(db: D1Database, v: Viewer, id: string) {
  const t = await loadTask(db, id);
  if (!t || !canSeeProject(v, t.project_id)) throw notFound('Task not found.');
  return t;
}

/** Like loadVisibleTask, for changes: an archived task has to be restored before it can be changed. */
export async function loadEditableTask(db: D1Database, v: Viewer, id: string) {
  const t = await loadVisibleTask(db, v, id);
  if (t.archived_at) throw bad('This task is archived. Restore it from its project first.');
  return t;
}

const isPriority = (p: unknown): p is Priority => p === 1 || p === 2 || p === 3 || p === 4;

// ---------- repeating tasks ----------
interface SeriesRow {
  id: string; rule: string; starts_on: string; title: string; notes: string; project_id: string; assignee_id: string;
  priority: number; made: number; active: number;
}
const loadSeries = (db: D1Database, id: string | null) =>
  id ? db.prepare('SELECT * FROM series WHERE id = ?').bind(id).first<SeriesRow>() : Promise.resolve(null);

function parseRule(raw: unknown): Repeat {
  const r = cleanRepeat(raw);
  if (typeof r === 'string') throw bad(r);
  return r;
}

/** Statements that insert a series. */
const insertSeries = (db: D1Database, id: string, rule: Repeat, startsOn: string, t: { title: string; notes: string; projectId: string; assigneeId: string; priority: number }, by: string, now: string) =>
  db.prepare(
    `INSERT INTO series (id, rule, starts_on, title, notes, project_id, assignee_id, priority, made, active, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?)`,
  ).bind(id, JSON.stringify(rule), startsOn, t.title, t.notes, t.projectId, t.assigneeId, t.priority, by, now, now);

// ---------- create ----------
export interface NewTask {
  title: string;
  notes?: string;
  projectId: string;
  assigneeId: string;
  dueDate: string;
  priority: number;
  /** Makes it a repeating task (see shared/repeat.ts). The first copy lands on the first scheduled date on or after dueDate. */
  repeat?: unknown;
  /** Effort, stored form ('tshirt:M'; shared/effort.ts), if the project tracks it. */
  effort?: string | null;
  /** Estimate, stored like effort, if the project asks for one. */
  estimate?: string | null;
  /** How many days it runs, from dueDate (1 or null: just that day). */
  durationDays?: number | null;
}

/** A duration in days: null for 1 day (or none given), else a whole number up to DURATION_MAX. */
function checkDuration(d: unknown): number | null {
  if (d === null || d === undefined || d === '') return null;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > DURATION_MAX) throw bad(`A task can last 1 to ${DURATION_MAX} days.`);
  return d === 1 ? null : d;
}

/** How a project tracks effort (type null: it doesn't). */
export async function projectEffort(db: D1Database, projectId: string): Promise<{ type: EffortType | null; required: boolean; estimate: boolean; timer: boolean }> {
  const r = await db.prepare('SELECT effort, effort_required, estimate, timer FROM projects WHERE id = ?').bind(projectId)
    .first<{ effort: string | null; effort_required: number; estimate: number; timer: number }>();
  const type = isEffortType(r?.effort) ? r.effort : null;
  return { type, required: !!type && !!r?.effort_required, estimate: !!type && !!r?.estimate, timer: type === 'time' && !!r?.timer };
}

/** Checks a stored effort value ('<type>:<value>') against the project's type. null / '' clear it. */
function checkEffort(type: EffortType | null, stored: unknown, what = 'effort'): string | null {
  if (stored === null || stored === '') return null;
  if (!type) throw bad(what === 'effort' ? "This task's project doesn't track effort." : "This task's project doesn't ask for estimates.");
  if (typeof stored !== 'string') throw bad(`Invalid ${what}.`);
  const i = stored.indexOf(':');
  if (stored.slice(0, i) !== type) throw bad(`This project tracks effort as ${EFFORT_TYPES[type].name.toLowerCase()}.`);
  const v = effortValue(type, stored.slice(i + 1));
  if (!v) throw bad(`That isn't a valid ${EFFORT_TYPES[type].name.toLowerCase()} (${EFFORT_TYPES[type].hint}).`);
  return v;
}
/** Checks an estimate: the project must ask for one, and it's in the project's effort measure. */
const checkEstimate = (pe: { type: EffortType | null; estimate: boolean }, stored: unknown) =>
  checkEffort(pe.estimate ? pe.type : null, stored, 'estimate');
const effortMissing = (type: EffortType) =>
  bad(`This project needs the effort (${EFFORT_TYPES[type].name.toLowerCase()}) before a task is marked done.`);

/**
 * Validates and inserts a task as `v`. `via` names the AI assistant that made it (null from the app).
 * Callers fill in their own defaults first: the app defaults to "me, today, Normal"; MCP requires all of them.
 */
export async function createTask(env: Env, v: Viewer, b: NewTask, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const title = (b.title ?? '').trim();
  const notes = (b.notes ?? '').trim();
  const t0 = today(v);
  if (!title) throw bad('A task needs a title.');
  if (title.length > TITLE_MAX) throw bad(`Titles can be at most ${TITLE_MAX} characters.`);
  if (notes.length > NOTES_MAX) throw bad('Notes are too long.');
  if (!b.projectId || !canSeeProject(v, b.projectId)) throw bad('Pick one of your projects.');
  const project = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(b.projectId).first();
  if (!project) throw bad('That project no longer exists.');
  if (!b.assigneeId || !(await userOnProject(db, b.assigneeId, b.projectId))) throw bad("That person isn't on this project.");
  if (!isDate(b.dueDate)) throw bad('Invalid date.');
  if (b.dueDate < t0) throw bad("Tasks can't be due in the past.");
  if (!isPriority(b.priority)) throw bad('Invalid priority.');
  const rule = b.repeat != null ? parseRule(b.repeat) : null;
  const due = rule ? firstDate(rule, b.dueDate) : b.dueDate;
  if (rule?.until && rule.until < due) throw bad('The repeat ends before the first date.');
  const effort = b.effort != null && b.effort !== '' ? checkEffort((await projectEffort(db, b.projectId)).type, b.effort) : null;
  const estimate = b.estimate != null && b.estimate !== '' ? checkEstimate(await projectEffort(db, b.projectId), b.estimate) : null;
  const duration = checkDuration(b.durationDays);

  const id = uid();
  const seriesId = rule ? uid() : null;
  const now = nowIso();
  const stmts = [bumpVersion(db)];
  if (rule) stmts.push(insertSeries(db, seriesId!, rule, due, { title, notes, projectId: b.projectId, assigneeId: b.assigneeId, priority: b.priority }, v.id, now));
  stmts.push(
    db.prepare(
      `INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, created_at, updated_at, version, series_id, effort, estimate, duration_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ${CURRENT_VERSION}, ?, ?, ?, ?)`,
    ).bind(id, title, notes, b.projectId, b.assigneeId, v.id, v.id, due, b.priority, now, now, seriesId, effort, estimate, duration),
    eventStmt(db, {
      taskId: id, actorId: v.id, via, type: 'created', at: now,
      to: JSON.stringify({ assignee: b.assigneeId, due, priority: b.priority, project: b.projectId }),
    }),
  );
  if (rule) stmts.push(eventStmt(db, { taskId: id, actorId: v.id, via, type: 'repeat_set', to: describe(rule, due), at: now }));
  if (effort) stmts.push(eventStmt(db, { taskId: id, actorId: v.id, via, type: 'effort_set', to: effort, at: now }));
  if (estimate) stmts.push(eventStmt(db, { taskId: id, actorId: v.id, via, type: 'estimate_set', to: estimate, at: now }));
  if (duration) stmts.push(eventStmt(db, { taskId: id, actorId: v.id, via, type: 'duration_set', to: String(duration), at: now }));
  await db.batch(stmts);
  notify(env, [{ to: b.assigneeId, kind: 'assigned', actorId: v.id, via, taskId: id, isNew: true }]);
  return mapTask((await loadTask(db, id))!);
}

// ---------- edit (every change is logged) ----------
export interface Patch {
  title?: string; notes?: string; projectId?: string; assigneeId?: string; dueDate?: string; priority?: number;
  status?: 'open' | 'done';
  /** Effort, stored form ('time:90', 'tshirt:M'; shared/effort.ts), or null to clear it. */
  effort?: string | null;
  /** Estimate, stored like effort, or null to clear it. Only for projects that ask for one. */
  estimate?: string | null;
  /** How many days it runs from its due date; 1 or null: just that day. */
  durationDays?: number | null;
  /**
   * Active time tracking: start the task's timer, or stop it (adding the whole minutes it ran to the time spent, and
   * widening the task's span to cover the days it ran). Marking a task done stops a running timer too.
   */
  timer?: 'start' | 'stop';
  /** Optional message attached to a transfer. */
  note?: string;
  /** Undo of your own last date move: allows putting a past due date back. */
  restore?: boolean;
  /** Repeating tasks: start, change (a rule) or stop (null) repeating. Undefined leaves it alone. */
  repeat?: unknown;
  /** Repeating tasks: skip this copy, moving it to the next scheduled date. */
  skip?: boolean;
  /** Repeating tasks: change only this copy. By default edits to the open copy also apply to future copies. */
  thisOnly?: boolean;
}

/**
 * Validates a change and returns the statements that make it (task update + one history event per field).
 * Nothing is written; run the statements with `commit()` (or batch several patches together).
 */
export async function applyPatch(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null) {
  const db = env.DB;
  const t = await loadEditableTask(db, v, id);
  const t0 = today(v);
  const now = nowIso();
  const sets: string[] = [];
  const binds: unknown[] = [];
  const events: Parameters<typeof eventStmt>[1][] = [];
  let undidSkip = false;
  const notices: Notice[] = []; // sent after the change is saved (see commit callers)
  const set = (col: string, val: unknown) => { sets.push(`${col} = ?`); binds.push(val); };
  const ev = (e: Omit<Parameters<typeof eventStmt>[1], 'taskId' | 'actorId' | 'via' | 'at'>) =>
    events.push({ ...e, taskId: id, actorId: v.id, via, at: now });

  if (b.title !== undefined) {
    const title = b.title.trim();
    if (!title) throw bad('A task needs a title.');
    if (title.length > TITLE_MAX) throw bad(`Titles can be at most ${TITLE_MAX} characters.`);
    if (title !== t.title) { set('title', title); ev({ type: 'renamed', from: t.title, to: title }); }
  }
  if (b.notes !== undefined) {
    const notes = b.notes.trim();
    if (notes.length > NOTES_MAX) throw bad('Notes are too long.');
    if (notes !== t.notes) { set('notes', notes); ev({ type: 'notes_edited' }); }
  }
  if (b.priority !== undefined && b.priority !== t.priority) {
    if (!isPriority(b.priority)) throw bad('Invalid priority.');
    set('priority', b.priority);
    ev({ type: 'priority_changed', from: String(t.priority), to: String(b.priority) });
  }
  const project = b.projectId ?? t.project_id;
  const assignee = b.assigneeId ?? t.assignee_id;
  if (project !== t.project_id) {
    if (!canSeeProject(v, project)) throw forbidden("You're not on that project.");
    const p = await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(project).first();
    if (!p) throw bad('That project no longer exists.');
    set('project_id', project);
    ev({ type: 'project_changed', from: t.project_id, to: project });
  }
  if (project !== t.project_id || assignee !== t.assignee_id) {
    // The assignee must always be able to see the task.
    if (!(await userOnProject(db, assignee, project))) throw bad("That person isn't on this task's project.");
  }
  if (assignee !== t.assignee_id) {
    set('assignee_id', assignee);
    set('assigned_by', v.id);
    const note = (b.note ?? '').trim().slice(0, 500) || null;
    ev({ type: 'transferred', from: t.assignee_id, to: assignee, note });
    notices.push({ to: assignee, kind: 'assigned', actorId: v.id, via, taskId: id, text: note });
    // Followers hear who has it now, and so does whoever had it (if someone else moved it).
    notices.push({ to: WATCHERS, kind: 'handed', actorId: v.id, via, taskId: id, target: assignee });
    if (t.assignee_id !== v.id) notices.push({ to: t.assignee_id, kind: 'handed', actorId: v.id, via, taskId: id, target: assignee });
  }
  if (b.dueDate !== undefined && b.dueDate !== t.due_date) {
    if (!isDate(b.dueDate)) throw bad('Invalid date.');
    // Undo of your own last move or skip can put the old date back, even if it's in the past.
    const last = b.restore ? await db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').bind(id).first<EventRow>() : null;
    const isUndo = !!last && (last.type === 'date_moved' || last.type === 'skipped') && last.actor_id === v.id && last.from_value === b.dueDate;
    if (b.dueDate < t0 && !isUndo) throw bad("Tasks can't be moved into the past.");
    undidSkip = isUndo && last!.type === 'skipped';
    set('due_date', b.dueDate);
    ev({ type: 'date_moved', from: t.due_date, to: b.dueDate });
  }
  let durationNow = t.duration_days ?? null; // the next copy of a repeating task lasts as long
  if (b.durationDays !== undefined) {
    const d = checkDuration(b.durationDays);
    if (d !== durationNow) {
      set('duration_days', d);
      ev({ type: 'duration_set', from: durationNow ? String(durationNow) : null, to: d ? String(d) : null });
    }
    durationNow = d;
  }
  // Effort is checked against the project the task ends up in.
  let pe: Awaited<ReturnType<typeof projectEffort>> | null = null;
  const effortOf = async () => (pe ??= await projectEffort(db, project));
  let effortNow = t.effort ?? null;
  if (b.effort !== undefined) {
    const val = checkEffort((await effortOf()).type, b.effort);
    if (val !== effortNow) { set('effort', val); ev({ type: 'effort_set', from: effortNow, to: val }); }
    effortNow = val;
  }
  if (b.estimate !== undefined) {
    const val = checkEstimate(await effortOf(), b.estimate);
    const was = t.estimate ?? null;
    if (val !== was) { set('estimate', val); ev({ type: 'estimate_set', from: was, to: val }); }
  }
  // ----- timer (active time tracking) -----
  const running = t.timer_started_at ?? null;
  if (b.timer !== undefined && b.timer !== 'start' && b.timer !== 'stop') throw bad('Invalid timer action.');
  if (b.timer && (b.dueDate !== undefined || b.durationDays !== undefined || b.effort !== undefined)) throw bad('Start or stop the timer on its own.');
  if (b.timer === 'start') {
    if (!(await effortOf()).timer) throw bad("This task's project doesn't use the timer.");
    if (t.status !== 'open' || b.status === 'done') throw bad('Only an open task can be timed.');
    if (running) throw bad('The timer is already running on this task.');
    set('timer_started_at', now); set('timer_by', v.id);
    ev({ type: 'timer_started' });
  } else if (running && (b.timer === 'stop' || (b.status === 'done' && t.status !== 'done'))) {
    set('timer_started_at', null); set('timer_by', null);
    // Whole minutes, never seconds. Marking done with the time typed in (b.effort) overrides what the timer counted.
    const mins = b.effort !== undefined ? 0 : Math.max(0, Math.round((Date.parse(now) - Date.parse(running)) / 60000));
    ev({ type: 'timer_stopped', to: String(mins) });
    if (mins > 0 && (await effortOf()).type === 'time') {
      const had = Number(effortFor(effortNow, 'time') ?? 0);
      const val = `time:${Math.min(TIME_MAX_MIN, had + mins)}`;
      if (val !== effortNow) { set('effort', val); ev({ type: 'effort_set', from: effortNow, to: val }); }
      effortNow = val;
      // The span grows to cover the days the time was spent (never shrinks). Left alone if this change moves dates itself.
      if (b.dueDate === undefined && b.durationDays === undefined) {
        const from = dayIn(v.tz, running);
        const start = from < t.due_date ? from : t.due_date;
        const end0 = durationNow && durationNow > 1 ? addDays(t.due_date, durationNow - 1) : t.due_date;
        const end = t0 > end0 ? t0 : end0;
        const days = Math.min(DURATION_MAX, diffDays(end, start) + 1);
        if (start !== t.due_date) { set('due_date', start); ev({ type: 'date_moved', from: t.due_date, to: start }); }
        const d = days > 1 ? days : null;
        // (durationNow is left as it was: a repeating task's next copy keeps the planned length, not the widened one.)
        if (d !== durationNow) { set('duration_days', d); ev({ type: 'duration_set', from: durationNow ? String(durationNow) : null, to: d ? String(d) : null }); }
      }
    }
  } else if (b.timer === 'stop') throw bad("The timer isn't running on this task.");
  if (b.status === 'done' && t.status !== 'done') {
    const { type, required } = await effortOf();
    if (required && type && !effortFor(effortNow, type)) throw effortMissing(type);
  }
  if (b.status !== undefined && b.status !== t.status) {
    if (b.status === 'done') {
      set('status', 'done'); set('done_at', now); set('done_on', t0); set('done_by', v.id);
      ev({ type: 'done' });
      notices.push({ to: WATCHERS, kind: 'done', actorId: v.id, via, taskId: id });
      // Tasks that were only waiting on this one can start: whoever has each hears so.
      notices.push(...(await unblockedBy(db, id, v.id, via)));
    } else if (b.status === 'open') {
      set('status', 'open'); set('done_at', null); set('done_on', null); set('done_by', null);
      ev({ type: 'reopened' });
      notices.push({ to: WATCHERS, kind: 'reopened', actorId: v.id, via, taskId: id });
    } else throw bad('Invalid status.');
  }
  // ----- repeating tasks -----
  const after: D1PreparedStatement[] = []; // run after the task update
  let nextId: string | null = null;
  let series = await loadSeries(db, t.series_id);
  const isOpen = t.status === 'open';
  const final = {
    title: b.title !== undefined ? b.title.trim() : t.title,
    notes: b.notes !== undefined ? b.notes.trim() : t.notes,
    priority: b.priority ?? t.priority,
    projectId: project,
    assigneeId: assignee,
    due: b.dueDate ?? t.due_date,
  };

  if (b.repeat !== undefined) {
    if (b.repeat === null) {
      if (series?.active) {
        after.push(db.prepare('UPDATE series SET active = 0, updated_at = ? WHERE id = ?').bind(now, series.id));
        ev({ type: 'repeat_stopped' });
        series = { ...series, active: 0 };
      }
    } else {
      // A task can only become repeating when it's created; after that the rule can be changed or stopped, not started.
      if (!series?.active) throw bad('Repeating is set when a task is created. Create a new repeating task instead.');
      if (!isOpen && b.status !== 'open') throw bad('Only an open task can repeat.');
      const rule = parseRule(b.repeat);
      if (rule.until && rule.until < final.due) throw bad('The repeat ends before this task is due.');
      if (!sameRule(JSON.parse(series.rule), rule)) {
        after.push(db.prepare('UPDATE series SET rule = ?, starts_on = ?, made = 1, active = 1, updated_at = ? WHERE id = ?')
          .bind(JSON.stringify(rule), final.due, now, series.id));
        ev({ type: 'repeat_changed', to: describe(rule, final.due) });
        series = { ...series, rule: JSON.stringify(rule), starts_on: final.due, made: 1, active: 1 };
      }
    }
  }

  const live = series?.active ? series : null;
  if (live && (isOpen || b.status === 'open') && !b.thisOnly) {
    // Edits to the open copy carry forward to future copies (only the fields this change touches,
    // so an earlier "just this one" transfer isn't undone by a later edit).
    const ts: string[] = [];
    const tb: unknown[] = [];
    const tset = (col: keyof SeriesRow, val: unknown, given: boolean) => {
      if (given && val !== live[col]) { ts.push(`${col} = ?`); tb.push(val); (live as unknown as Record<string, unknown>)[col] = val; }
    };
    tset('title', final.title, b.title !== undefined);
    tset('notes', final.notes, b.notes !== undefined);
    tset('priority', final.priority, b.priority !== undefined);
    tset('project_id', final.projectId, b.projectId !== undefined);
    tset('assignee_id', final.assigneeId, b.assigneeId !== undefined);
    if (ts.length) after.push(db.prepare(`UPDATE series SET ${ts.join(', ')}, updated_at = ? WHERE id = ?`).bind(...tb, now, live.id));
  }

  if (undidSkip && live) after.push(db.prepare('UPDATE series SET made = MAX(1, made - 1), updated_at = ? WHERE id = ?').bind(now, live.id));

  if (b.skip) {
    if (!live || !isOpen) throw bad("Only the open copy of a repeating task can be skipped.");
    if (b.dueDate !== undefined || b.status !== undefined) throw bad('Skip on its own.');
    const rule = JSON.parse(live.rule) as Repeat;
    const next = nextDate(rule, live.starts_on, t.due_date, t0, live.made, t0);
    if (!next) throw bad("That's the last one. Mark it done, or stop repeating.");
    set('due_date', next);
    ev({ type: 'skipped', from: t.due_date, to: next });
    after.push(db.prepare('UPDATE series SET made = made + 1, updated_at = ? WHERE id = ?').bind(now, live.id));
  }

  if (live && b.status === 'done' && isOpen) {
    const rule = JSON.parse(live.rule) as Repeat;
    // Finished late? The next copy still lands after today: missed dates are skipped, never piled up.
    const next = nextDate(rule, live.starts_on, final.due, addDays(t0, 1), live.made, t0);
    const proj = next ? await db.prepare('SELECT id FROM projects WHERE id = ? AND archived = 0').bind(live.project_id).first() : null;
    if (next && proj) {
      // The template's person may have left the project: fall back to whoever had this copy, then to whoever finished it.
      let who = live.assignee_id;
      if (!(await userOnProject(db, who, live.project_id))) who = (await userOnProject(db, final.assigneeId, live.project_id)) ? final.assigneeId : v.id;
      nextId = uid();
      // Guarded so that two people finishing it at once can't create two copies.
      after.push(
        db.prepare(
          `INSERT INTO tasks (id, title, notes, project_id, assignee_id, created_by, assigned_by, due_date, priority, status, created_at, updated_at, version, series_id, duration_days)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ${CURRENT_VERSION}, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE series_id = ? AND status = 'open')`,
        ).bind(nextId, live.title, live.notes, live.project_id, who, v.id, v.id, next, live.priority, now, now, live.id, durationNow, live.id),
        db.prepare(
          `INSERT INTO task_events (id, task_id, actor_id, via, type, from_value, to_value, note, at)
           SELECT ?, ?, ?, ?, 'created', ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ?)`,
        ).bind(uid(), nextId, v.id, via, id, JSON.stringify({ assignee: who, due: next, priority: live.priority, project: live.project_id, repeat: true }), now, nextId),
        db.prepare('UPDATE series SET made = made + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)').bind(now, live.id, nextId),
        // The next copy gets the same checklist, unchecked (only if the copy was actually created).
        db.prepare(
          `INSERT INTO checklist_items (id, task_id, text, done, position, created_by, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), ?, text, 0, position, ?, ?, ? FROM checklist_items
           WHERE task_id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)`,
        ).bind(nextId, v.id, now, now, id, nextId),
        // And the same followers: this copy's creator (unless they stopped) and everyone else following it.
        db.prepare(
          `INSERT OR IGNORE INTO task_followers (task_id, user_id, following, added_by, at)
           SELECT ?, user_id, following, added_by, ? FROM task_followers WHERE task_id = ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)`,
        ).bind(nextId, now, id, nextId),
        db.prepare(
          `INSERT OR IGNORE INTO task_followers (task_id, user_id, following, added_by, at)
           SELECT ?, ?, 1, ?, ? WHERE ? != ? AND EXISTS (SELECT 1 FROM tasks WHERE id = ?)
             AND NOT EXISTS (SELECT 1 FROM task_followers WHERE task_id = ? AND user_id = ? AND following = 0)`,
        ).bind(nextId, t.created_by, t.created_by, now, t.created_by, v.id, nextId, id, t.created_by),
      );
    } else {
      after.push(db.prepare('UPDATE series SET active = 0, updated_at = ? WHERE id = ?').bind(now, live.id));
    }
  }

  // Linked tasks show this one's status and date (shared/types.ts → TaskLink): their apps reload them.
  if (sets.some((x) => x.startsWith('status ') || x.startsWith('due_date '))) after.push(touchLinked(db, id));

  if (!events.length) return { stmts: [] as D1PreparedStatement[], changed: false, nextId: null, notices };
  const stmts = [
    // Even with no column changes (e.g. only the repeat changed) the task is touched, so everyone's view syncs.
    db.prepare(`UPDATE tasks SET ${[...sets, 'updated_at = ?', `version = ${CURRENT_VERSION}`].join(', ')} WHERE id = ?`).bind(...binds, now, id),
    ...events.map((e) => eventStmt(db, e)),
    ...after,
  ];
  return { stmts, changed: true, nextId, notices };
}

/** Writes the statements from one or more patches in a single batch (one version bump). */
export async function commit(env: Env, stmts: D1PreparedStatement[]) {
  if (stmts.length) await env.DB.batch([bumpVersion(env.DB), ...stmts]);
}

/** Validate, write and return the updated task, plus the next copy if finishing a repeating task created one. */
export async function updateTaskWithNext(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null): Promise<{ task: Task; next: Task | null }> {
  const { stmts, nextId, notices } = await applyPatch(env, v, id, b, via);
  await commit(env, stmts);
  notify(env, notices);
  const task = mapTask((await loadTask(env.DB, id))!);
  const n = nextId ? await loadTask(env.DB, nextId) : null;
  return { task, next: n ? mapTask(n) : null };
}

/** Validate, write and return the updated task. */
export async function updateTask(env: Env, v: Viewer, id: string, b: Patch, via: string | null = null): Promise<Task> {
  return (await updateTaskWithNext(env, v, id, b, via)).task;
}

// ---------- comments ----------
/**
 * Adds a comment to a task's history. Anyone who can see the task can comment, on open or done tasks.
 * Comments are history entries, so like the rest of the history they can't be edited or deleted.
 * The task's version moves on too, so everyone's open copy reloads its history on the next poll.
 */
export async function addComment(env: Env, v: Viewer, id: string, text: unknown, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const t = await loadEditableTask(db, v, id);
  const body = typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
  if (!body) throw bad('Write something first.');
  if (body.length > COMMENT_MAX) throw bad(`Comments can be at most ${COMMENT_MAX} characters.`);
  const now = nowIso();
  await db.batch([
    bumpVersion(db),
    db.prepare(`UPDATE tasks SET updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(now, t.id),
    eventStmt(db, { taskId: t.id, actorId: v.id, via, type: 'comment', note: body, at: now }),
    // Commenting follows the task, so you hear the replies.
    followStmt(db, t.id, v.id, v.id, now),
  ]);
  // Whoever has the task and everyone following it.
  notify(env, [{ to: WATCHERS, kind: 'comment', actorId: v.id, via, taskId: t.id, text: body }]);
  return mapTask((await loadTask(db, t.id))!);
}

// ---------- checklist (one per task) ----------
export type ChecklistChange =
  | { op: 'add'; text: string }
  | { op: 'set'; itemId: string; done?: boolean; text?: string }
  | { op: 'remove'; itemId: string };

const cleanItem = (raw: unknown) => {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw bad('Checklist items need some text.');
  if (text.length > CHECK_TEXT_MAX) throw bad(`Checklist items can be at most ${CHECK_TEXT_MAX} characters.`);
  return text;
};

/**
 * Changes a task's checklist: add items (several at once: one per line), tick/untick, rename or remove one.
 * Anyone who can see the task can do this. Each change is logged in the task's history and moves the task's
 * version on, so everyone's app picks it up.
 */
export async function changeChecklist(env: Env, v: Viewer, id: string, ch: ChecklistChange, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const t = await loadEditableTask(db, v, id);
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  const ev = (type: 'check_added' | 'check_done' | 'check_undone' | 'check_renamed' | 'check_removed', to: string, from?: string) =>
    stmts.push(eventStmt(db, { taskId: t.id, actorId: v.id, via, type, from: from ?? null, to, at: now }));

  if (ch.op === 'add') {
    const lines = String(ch.text ?? '').split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]\s*)?(?:\[[ xX]?\]\s*)?/, '')).filter((l) => l.trim());
    if (!lines.length) throw bad('Checklist items need some text.');
    const texts = lines.map(cleanItem);
    const { n, last } = (await db.prepare('SELECT COUNT(*) AS n, MAX(position) AS last FROM checklist_items WHERE task_id = ?').bind(t.id).first<{ n: number; last: number | null }>())!;
    if (n + texts.length > CHECK_ITEMS_MAX) throw bad(`A checklist can have at most ${CHECK_ITEMS_MAX} items.`);
    texts.forEach((text, i) => {
      stmts.push(db.prepare('INSERT INTO checklist_items (id, task_id, text, done, position, created_by, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
        .bind(uid(), t.id, text, (last ?? 0) + i + 1, v.id, now, now));
      ev('check_added', text);
    });
  } else {
    const item = await db.prepare('SELECT id, text, done FROM checklist_items WHERE id = ? AND task_id = ?').bind(ch.itemId, t.id).first<{ id: string; text: string; done: number }>();
    if (!item) throw notFound('That checklist item is gone.');
    if (ch.op === 'remove') {
      stmts.push(db.prepare('DELETE FROM checklist_items WHERE id = ?').bind(item.id));
      ev('check_removed', item.text);
    } else {
      if (ch.text !== undefined) {
        const text = cleanItem(ch.text);
        if (text !== item.text) {
          stmts.push(db.prepare('UPDATE checklist_items SET text = ?, updated_at = ? WHERE id = ?').bind(text, now, item.id));
          ev('check_renamed', text, item.text);
        }
      }
      if (ch.done !== undefined && ch.done !== !!item.done) {
        stmts.push(db.prepare('UPDATE checklist_items SET done = ?, done_by = ?, done_at = ?, updated_at = ? WHERE id = ?')
          .bind(ch.done ? 1 : 0, ch.done ? v.id : null, ch.done ? now : null, now, item.id));
        ev(ch.done ? 'check_done' : 'check_undone', ch.text !== undefined ? cleanItem(ch.text) : item.text);
      }
    }
  }
  if (stmts.length) {
    await db.batch([
      bumpVersion(db),
      db.prepare(`UPDATE tasks SET updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`).bind(now, t.id),
      ...stmts,
    ]);
  }
  return mapTask((await loadTask(db, t.id))!);
}

// ---------- archive / restore ----------
/**
 * Archives a task (or restores it). Nothing is deleted: the task just leaves every list, count and search,
 * and its history notes who archived it. Anyone who can see the task can do either.
 * A repeating task's series is paused while its open copy is archived (it can't make the next copy), and resumes on restore.
 */
export async function setArchived(env: Env, v: Viewer, id: string, archive: boolean, via: string | null = null): Promise<Task> {
  const db = env.DB;
  const t = await loadVisibleTask(db, v, id);
  if (!!t.archived_at === archive) return mapTask(t);
  const now = nowIso();
  await db.batch([
    bumpVersion(db),
    db.prepare(`UPDATE tasks SET archived_at = ?, archived_by = ?, updated_at = ?, version = ${CURRENT_VERSION} WHERE id = ?`)
      .bind(archive ? now : null, archive ? v.id : null, now, t.id),
    eventStmt(db, { taskId: t.id, actorId: v.id, via, type: archive ? 'archived' : 'restored', at: now }),
    // Tasks linked to it stop (or start again) showing it as a dependency.
    touchLinked(db, t.id),
  ]);
  return mapTask((await loadTask(db, t.id))!);
}
