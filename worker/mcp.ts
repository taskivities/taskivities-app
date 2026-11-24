// Remote MCP server (Streamable HTTP at /mcp). Each connected assistant acts as the person who approved it
// on /authorize: same visibility, same rules (worker/tasks.ts), and every write is logged with `via` set.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { z } from 'zod';
import { diffDays, isDate } from '../shared/dates';
import { isLate, lastDay, lateDays, shownOn } from '../shared/rules';
import { describe as describeRepeat } from '../shared/repeat';
import { EFFORT_TYPES, effortFor, effortFromInput, effortLabel, effortTotal } from '../shared/effort';
import { COMMENT_MAX, DESCRIPTION_MAX, DURATION_MAX, PRIORITIES, PROJECT_COLORS, TITLE_MAX, type Priority, type Project, type Task, type User } from '../shared/types';
import {
  type Env, type ProjectRow, type TaskRow, type UserRow, type Viewer,
  HttpError, TASK_COLS, bad, canSeeProject, loadViewer, mapProject, mapTask, mapUser, today,
} from './lib';
import type { McpProps } from './oauth';
import { attachPastedLink } from './cloud-files';
import { UPLOAD_LINK_MINUTES, addAttachmentBytes, addAttachmentFromUrl, createUploadLink, readAttachment, typeFromName } from './attachments';
import { addComment, changeChecklist, createTask, setArchived, loadVisibleTask, updateTask, updateTaskWithNext, visible } from './tasks';
import { setFollowing } from './followers';
import { setBlocker } from './dependencies';
import { blockedUntil, holdingUp } from '../shared/deps';
import { createProject, invitePeople, setProjectArchived, updateProject } from './admin';
import { withConfig } from './signin-config';
import { loadSettings } from './settings';
import { appName } from '../shared/types';

const PRIORITY_NAMES = ['urgent', 'high', 'normal', 'low'] as const;
type PriorityName = (typeof PRIORITY_NAMES)[number];
const toPriority = (p: PriorityName) => (PRIORITY_NAMES.indexOf(p) + 1) as Priority;
const priorityName = (p: Priority) => PRIORITIES[p].name.toLowerCase();

const MAX_RANGE_DAYS = 92;
const MAX_RESULTS = 300;

/** Everything the viewer may see about people and projects, for name lookups and readable output. */
interface Directory {
  projects: Project[];
  users: Map<string, User>;
  /** project id → ids of people who can be assigned there (its members plus every admin). */
  assignable: Map<string, string[]>;
}

async function loadDirectory(db: D1Database, v: Viewer): Promise<Directory> {
  const [users, members, projects] = await Promise.all([
    db.prepare("SELECT * FROM users WHERE status != 'disabled' ORDER BY name").all<UserRow>(),
    db.prepare('SELECT user_id, project_id FROM project_members').all<{ user_id: string; project_id: string }>(),
    db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY name').all<ProjectRow>(),
  ]);
  const visibleProjects = projects.results.filter((p) => canSeeProject(v, p.id)).map(mapProject);
  const visibleIds = new Set(visibleProjects.map((p) => p.id));
  const byUser = new Map<string, string[]>();
  for (const m of members.results) {
    if (!visibleIds.has(m.project_id)) continue; // members only learn about projects they can see
    byUser.set(m.user_id, [...(byUser.get(m.user_id) ?? []), m.project_id]);
  }
  const all = users.results.map((u) => mapUser(u, byUser.get(u.id) ?? []));
  const admins = all.filter((u) => u.role === 'admin').map((u) => u.id);
  const assignable = new Map<string, string[]>();
  for (const p of visibleProjects) {
    assignable.set(p.id, [...new Set([...all.filter((u) => u.projects.includes(p.id)).map((u) => u.id), ...admins])]);
  }
  return { projects: visibleProjects, users: new Map(all.map((u) => [u.id, u])), assignable };
}

const norm = (s: string) => s.trim().toLowerCase();

function findProject(dir: Directory, input: string): Project {
  const q = norm(input);
  const exact = dir.projects.filter((p) => p.id === input || norm(p.name) === q);
  const hits = exact.length ? exact : dir.projects.filter((p) => norm(p.name).includes(q));
  if (hits.length === 1) return hits[0];
  const names = dir.projects.map((p) => `"${p.name}"`).join(', ');
  if (!hits.length) throw bad(`No project matches "${input}". Your projects: ${names || 'none'}.`);
  throw bad(`"${input}" matches several projects: ${hits.map((p) => `"${p.name}"`).join(', ')}. Use the full name.`);
}

function findUser(dir: Directory, v: Viewer, input: string): User {
  const q = norm(input);
  if (q === 'me' || q === 'myself') return dir.users.get(v.id)!;
  const people = [...dir.users.values()];
  const first = (u: User) => norm(u.name).split(/\s+/)[0];
  const tiers = [
    people.filter((u) => u.id === input || norm(u.email) === q || norm(u.name) === q),
    people.filter((u) => first(u) === q),
    people.filter((u) => norm(u.name).includes(q) || norm(u.email).startsWith(q)),
  ];
  for (const hits of tiers) {
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw bad(`"${input}" matches several people: ${hits.map((u) => `${u.name} <${u.email}>`).join(', ')}. Use their email.`);
  }
  throw bad(`No one called "${input}" is on Taskivities. Use list_projects to see who is on each project.`);
}

/** What an assistant sent as effort ("1h 30m", "M", "5") for a task in `p`; "" clears it (null). */
function toEffort(p: Project, input: string): string | null {
  if (input.trim() === '') return null;
  if (!p.effort) throw bad(`${p.name} doesn't track effort.`);
  const v = effortFromInput(p.effort, input);
  if (!v) throw bad(`${p.name} tracks effort as ${EFFORT_TYPES[p.effort].name.toLowerCase()}: ${EFFORT_TYPES[p.effort].hint}. "${input}" isn't one.`);
  return v;
}
const effortArg = z.string().describe(
  'Only for projects that track effort (list_projects shows how): a time like "1h 30m" or "45m", a size like "M", or story points like "5".',
);

const durationArg = z.number().int().min(1).max(DURATION_MAX).describe(
  'How many days the task runs, starting on due_date (default 1). It only turns overdue after the last day: ' +
  'due 2026-11-01 with duration_days 2 is overdue from 2026-11-03.',
);

const userLabel = (dir: Directory, id: string | null) => (id ? (dir.users.get(id)?.name ?? 'Former member') : null);

function describeTask(t: Task, dir: Directory, t0: string) {
  const p = dir.projects.find((x) => x.id === t.projectId);
  const effort = p?.effort ? effortFor(t.effort, p.effort) : null;
  return {
    id: t.id,
    title: t.title,
    project: dir.projects.find((p) => p.id === t.projectId)?.name ?? t.projectId,
    assignee: userLabel(dir, t.assigneeId),
    priority: priorityName(t.priority),
    status: t.status,
    due_date: t.dueDate,
    ...(t.durationDays && t.durationDays > 1 ? { duration_days: t.durationDays, last_day: lastDay(t) } : {}),
    /** The day the app shows it on (open tasks past their due date roll into today). */
    shown_on: shownOn(t, t0),
    ...(isLate(t, t0) ? { days_late: lateDays(t, t0) } : {}),
    ...(t.status === 'done' ? { done_on: t.doneOn, done_by: userLabel(dir, t.doneBy) } : {}),
    ...(t.notes ? { notes: t.notes } : {}),
    ...(p?.effort ? { effort: effort ? effortLabel(p.effort, effort) : null } : {}),
    ...(t.series?.active ? { repeats: describeRepeat(t.series.rule, t.series.anchor) } : {}),
    ...(t.comments ? { comments: t.comments } : {}),
    ...(t.followers.some((f) => f !== t.assigneeId) ? { followers: t.followers.filter((f) => f !== t.assigneeId).map((f) => userLabel(dir, f)) } : {}),
    ...(t.attachments.length ? { attachments: t.attachments.map((a) => (a.link ? { id: a.id, name: a.name, type: a.type, link: a.link } : { id: a.id, name: a.name, type: a.type, size: a.size })) } : {}),
    ...(t.checklist.length ? { checklist: t.checklist.map((c) => ({ id: c.id, item: c.text, done: c.done })) } : {}),
    ...depsOf(t, t0),
  };
}

/** Dependencies, by task id (list_tasks has the titles of the ones the person can see), with what the dates mean. */
function depsOf(t: Task, t0: string) {
  const link = (l: Task['blockedBy'][number]) => ({ id: l.id, done: !l.open, due_date: l.dueDate });
  const until = blockedUntil(t, t.blockedBy, t0);
  const held = holdingUp(t, t.blocks, t0);
  return {
    ...(t.blockedBy.length ? { waits_on: t.blockedBy.map(link) } : {}),
    ...(t.blocks.length ? { blocks: t.blocks.map(link) } : {}),
    ...(until ? { blocked_until: until } : {}),
    ...(held.length ? { holding_up: held.map((l) => l.id) } : {}),
  };
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** Repeat rule as assistants send it (snake_case), mapped to shared/repeat.ts. */
const repeatArg = z.object({
  freq: z.enum(['day', 'week', 'month', 'year']),
  every: z.number().int().min(1).max(99).optional().describe('Every N days/weeks/months/years. Default 1.'),
  days: z.array(z.number().int().min(0).max(6)).optional().describe('Weekly: weekdays, 0 = Sunday … 6 = Saturday. Default: the weekday of due_date. Every weekday = [1,2,3,4,5].'),
  month_by: z.enum(['date', 'weekday']).optional().describe('Monthly: "date" = same day of the month as due_date (the 15th); "weekday" = same position (the 2nd Tuesday; a 5th weekday means "last").'),
  after_done: z.boolean().optional().describe('Count the next date from when it was finished ("7 days after done") instead of a fixed schedule.'),
  until: dateArg.optional().describe('Last possible date.'),
  count: z.number().int().min(1).max(1000).optional().describe('Total number of copies.'),
}).describe(
  'Makes this a repeating task. Only one copy is open at a time: finishing it creates the next one on the next scheduled date (never in the past). ' +
  'Missed dates are not piled up: an unfinished copy rolls over like any task. The schedule counts from due_date.',
);
const toRepeat = (r: z.infer<typeof repeatArg>) => ({
  freq: r.freq, every: r.every ?? 1, days: r.days, monthBy: r.month_by, afterDone: r.after_done, until: r.until, count: r.count,
});

/**
 * Sent to every assistant when it connects: what the priorities mean, and how to lay out a project's plan so the
 * app's Gantt chart (src/pages/Gantt.tsx, High-priority tasks only) shows it well.
 */
const INSTRUCTIONS = `Taskivities is a team's task manager. Every task has a project, a due date, an assignee and a priority. You act as the signed-in person, with their access, and every change you make is recorded in the task's history as made through you.

Priorities, and what each one is for:
- urgent: drop everything. An interruption that can't wait (an outage, a client emergency). Never use it for planned work.
- high: a step in a project's plan. The app's Gantt chart for a project shows only High tasks, so High is how a step gets on the plan.
- normal: everyday work. The default.
- low: when there is time.

Planning a project (when asked to plan, schedule or break down a project, or lay out a timeline):
1. Make each step that sets the project's pace (a phase, milestone or deliverable) a High task in that project, owned by someone on the project (list_projects shows who).
2. Set due_date to the day the step starts, and duration_days to how many days it runs. A step is overdue only after its last day.
3. Record the order with set_dependencies: a step that can't finish before another one waits on it. Dates never move by themselves; if they clash, ask before moving them.
4. Keep the smaller work under each step as Normal (or Low) tasks, or as a checklist on the High task, so the plan stays readable.
5. Don't make every task High, and don't make planned steps Urgent: a plan where everything is a priority shows nothing.
Due dates can't be in the past. When you're unsure which project or person a task belongs to, check list_projects or ask.`;

/** Which instance this is, as assistants are told: the team's name and the app's address. */
interface Instance { name: string; address?: string }

/**
 * Put before INSTRUCTIONS. Someone with several instances connects each as its own connector, and every one
 * offers the same tools, so the assistant needs to know which one it is talking to (docs/multi-instance.md).
 */
const instanceIntro = (i: Instance) =>
  `This connector is the Taskivities instance "${i.name}"${i.address ? ` at ${i.address}` : ''}. ` +
  `It only sees this instance's projects, people and tasks. The person may also have other Taskivities instances connected as separate connectors with the same tools: ` +
  `each has its own projects and people, and tasks can't be moved or linked between instances. ` +
  `When a request could belong to more than one, check list_projects on each (it names the instance) or ask, and say which instance you used.\n\n`;

const PRIORITY_HELP =
  'urgent: drop everything, never planned work · high: a step in a project\'s plan (only High tasks show on its Gantt chart; give it duration_days and dependencies) · ' +
  'normal: everyday work, the default · low: when there is time.';

export class TaskivitiesMCP extends McpAgent<Env, unknown, McpProps> {
  // Replaced in init() with one whose instructions name this instance; McpAgent reads `server` only after init().
  server = new McpServer({ name: 'Taskivities', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  private instance: Instance = { name: 'Taskivities' };

  /** "via …" in task history. */
  private get via() {
    return this.props?.clientName || 'AI assistant';
  }

  /** The person this assistant acts for, loaded fresh on every call so access changes apply at once. */
  private async viewer(): Promise<Viewer> {
    const v = this.props?.userId ? await loadViewer(this.env, this.props.userId) : null;
    if (!v) throw new HttpError(401, 'Your Taskivities access has ended. Reconnect, or ask an admin to add you back.');
    return v;
  }

  /** Runs a tool body, turning rule violations into readable tool errors. */
  private async run<T>(fn: (v: Viewer, dir: Directory, t0: string) => Promise<T>) {
    try {
      const v = await this.viewer();
      const dir = await loadDirectory(this.env.DB, v);
      return json(await fn(v, dir, today(v)));
    } catch (e) {
      if (e instanceof HttpError) return fail(e.message);
      console.error(e);
      return fail('Something went wrong. Please try again.');
    }
  }

  /** The team's name now (it can change while connected) and the address the assistant connected to. */
  private async loadInstance(): Promise<Instance> {
    const name = appName(await loadSettings(this.env.DB));
    let address: string | undefined;
    try { address = this.props?.origin ? new URL(this.props.origin).host : undefined; } catch { /* old grant without a valid origin */ }
    return { name, ...(address ? { address } : {}) };
  }

  async init() {
    try {
      this.instance = await this.loadInstance();
    } catch {
      // Keep the default name; the tools still work.
    }
    this.server = new McpServer(
      { name: 'Taskivities', title: this.instance.name === 'Taskivities' ? 'Taskivities' : `Taskivities: ${this.instance.name}`, version: '0.1.0' },
      { instructions: instanceIntro(this.instance) + INSTRUCTIONS },
    );
    let t0 = '';
    let zone = '';
    // Project descriptions say what belongs where; folding them into create_task lets the assistant pick
    // the right project without a list_projects call. Snapshot at connect time; list_projects is always current.
    let projectGuide = '';
    try {
      const v = await this.viewer();
      t0 = today(v);
      zone = v.tz;
      const dir = await loadDirectory(this.env.DB, v);
      projectGuide = dir.projects
        .map((p) => `- ${p.name}: ${p.description.slice(0, DESCRIPTION_MAX).replace(/\s+/g, ' ').trim() || '(no description)'}`)
        .join('\n');
    } catch {
      // No access: the tools themselves will say so.
    }

    this.server.registerTool(
      'list_projects',
      {
        title: 'List projects',
        description:
          'Projects you can see, with their descriptions (what belongs in each project and how tasks are named), colors, ' +
          'and the people who can be assigned tasks there. Read the descriptions to decide which project a task belongs in. ' +
          "Also returns today's date, your time zone (all dates are in your time zone) and which Taskivities instance this is.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () =>
        this.run(async (v, dir, today) => ({
          instance: await this.loadInstance(),
          today,
          time_zone: v.tz,
          you: { name: dir.users.get(v.id)?.name, email: v.email, role: v.role },
          projects: dir.projects.map((p) => ({
            name: p.name,
            description: p.description,
            color: p.color,
            ...(p.effort ? { effort: { tracks: EFFORT_TYPES[p.effort].name, values: EFFORT_TYPES[p.effort].hint, required_to_finish: p.effortRequired } } : {}),
            members: (dir.assignable.get(p.id) ?? []).map((id) => {
              const u = dir.users.get(id)!;
              return { name: u.name, email: u.email, ...(u.role === 'admin' ? { role: 'admin' } : {}), ...(u.status === 'invited' ? { status: 'invited' } : {}) };
            }),
          })),
        })),
    );

    this.server.registerTool(
      'list_tasks',
      {
        title: 'List tasks',
        description:
          'Tasks in your projects, grouped by the day the app shows them on. Rollover works as in the app: an open task ' +
          "whose due date has passed is shown on today (with days_late), and a task finished late is shown on the day it was finished. " +
          'So "what is on today" includes carried-over tasks. Dates are YYYY-MM-DD in your time zone; from defaults to today and to defaults to from ' +
          `(at most ${MAX_RANGE_DAYS} days).`,
        inputSchema: {
          user: z.string().optional().describe('Only tasks assigned to this person: name, first name, email, or "me".'),
          project: z.string().optional().describe('Only tasks in this project (name).'),
          from: dateArg.optional().describe('First day, YYYY-MM-DD. Default: today.'),
          to: dateArg.optional().describe('Last day, YYYY-MM-DD. Default: same as from.'),
          status: z.enum(['open', 'done', 'all']).optional().describe('Default: all.'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const from = args.from ?? t0;
          const to = args.to ?? from;
          if (!isDate(from) || !isDate(to)) throw bad('Dates must be real days in YYYY-MM-DD form.');
          if (to < from) throw bad('"to" must be on or after "from".');
          if (diffDays(to, from) >= MAX_RANGE_DAYS) throw bad(`Ask for at most ${MAX_RANGE_DAYS} days at a time.`);
          const vis = visible(v);
          const where = ['archived_at IS NULL', `(status = 'open' OR due_date BETWEEN ? AND ? OR done_on BETWEEN ? AND ?)`, vis.sql];
          const binds: unknown[] = [from, to, from, to, ...vis.binds];
          if (args.user) { where.push('assignee_id = ?'); binds.push(findUser(dir, v, args.user).id); }
          if (args.project) { where.push('project_id = ?'); binds.push(findProject(dir, args.project).id); }
          if (args.status && args.status !== 'all') { where.push('status = ?'); binds.push(args.status); }
          const { results } = await this.env.DB
            .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE ${where.join(' AND ')}`)
            .bind(...binds)
            .all<TaskRow>();
          const tasks = results
            .map(mapTask)
            .filter((t) => { const d = shownOn(t, t0); return d >= from && d <= to; })
            .sort((a, b) => shownOn(a, t0).localeCompare(shownOn(b, t0)) || a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
          return {
            instance: this.instance.name,
            today: t0, from, to,
            count: tasks.length,
            ...(tasks.length > MAX_RESULTS ? { truncated: true, note: `Showing the first ${MAX_RESULTS}; narrow the range or filters.` } : {}),
            tasks: tasks.slice(0, MAX_RESULTS).map((t) => describeTask(t, dir, t0)),
          };
        }),
    );

    this.server.registerTool(
      'create_task',
      {
        title: 'Create a task',
        description:
          `Create a task as the signed-in person. All five fields are required: title, project, due_date, assignee and priority. ` +
          `The assignee must be on the project (see list_projects), and the due date can't be in the past (today is ${t0} in ${zone} as of connecting). ` +
          `Use "normal" priority unless the person says otherwise, or the task is a step in a project's plan: then "high", with duration_days ` +
          `and set_dependencies (see the server instructions). Titles are at most ${TITLE_MAX} characters.\n\n` +
          `Pick the project from these descriptions (what belongs where, and how tasks are named):\n${projectGuide || '- (call list_projects)'}`,
        inputSchema: {
          title: z.string().min(1).max(TITLE_MAX),
          project: z.string().describe('Project name.'),
          due_date: dateArg.describe('YYYY-MM-DD, today or later.'),
          assignee: z.string().describe('Name, first name, email, or "me".'),
          priority: z.enum(PRIORITY_NAMES).describe(PRIORITY_HELP),
          notes: z.string().optional().describe('Optional details.'),
          repeat: repeatArg.optional(),
          effort: effortArg.optional(),
          duration_days: durationArg.optional(),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const project = findProject(dir, args.project);
          const assignee = findUser(dir, v, args.assignee);
          const task = await createTask(this.env, v, {
            title: args.title, notes: args.notes, projectId: project.id, assigneeId: assignee.id,
            dueDate: args.due_date, priority: toPriority(args.priority), repeat: args.repeat ? toRepeat(args.repeat) : undefined,
            effort: args.effort !== undefined ? toEffort(project, args.effort) : undefined,
            durationDays: args.duration_days,
          }, this.via);
          return { created: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'update_task',
      {
        title: 'Update a task',
        description:
          'Change a task: title, notes, project, due date, duration, priority, or status (use "open" to reopen a finished task). ' +
          "Only the fields you pass change. Due dates can't move into the past, and if the project changes the assignee must be on the new one. " +
          'Use transfer_task to change who it is assigned to, and complete_task to finish it. Every change is recorded in the task history.\n\n' +
          'Repeating tasks (those with "repeats"): edits to the open copy carry over to future copies. Pass repeat to change the rule, ' +
          'stop_repeating to stop for good, or skip to skip this copy (its date moves to the next scheduled one). ' +
          "A task that doesn't repeat can't be made repeating: repeating is set in create_task.",
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          title: z.string().min(1).max(TITLE_MAX).optional(),
          notes: z.string().optional().describe('Replaces the notes. Pass "" to clear them.'),
          project: z.string().optional().describe('Project name.'),
          due_date: dateArg.optional(),
          priority: z.enum(PRIORITY_NAMES).optional().describe(PRIORITY_HELP),
          status: z.enum(['open', 'done']).optional(),
          repeat: repeatArg.optional().describe('Repeating tasks only: the new rule.'),
          stop_repeating: z.boolean().optional().describe("Stop repeating for good. The current copy stays as a normal task. Can't be undone."),
          skip: z.boolean().optional().describe('Repeating tasks: skip this copy. Pass on its own.'),
          effort: effortArg.optional().describe('Effort, for projects that track it (list_projects): "1h 30m", "M" or "5". Pass "" to clear it.'),
          duration_days: durationArg.optional(),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          if (args.repeat && args.stop_repeating) throw bad('Pass repeat or stop_repeating, not both.');
          const newProject = args.project !== undefined ? findProject(dir, args.project) : null;
          const curProject = args.effort !== undefined && !newProject ? (await loadVisibleTask(this.env.DB, v, args.id)).project_id : null;
          const effortProject = args.effort === undefined ? null : newProject ?? dir.projects.find((p) => p.id === curProject) ?? null;
          if (args.effort !== undefined && !effortProject) throw bad('That task is in a project you can no longer see.');
          const { task, next } = await updateTaskWithNext(this.env, v, args.id, {
            title: args.title,
            notes: args.notes,
            projectId: newProject?.id,
            effort: effortProject ? toEffort(effortProject, args.effort!) : undefined,
            dueDate: args.due_date,
            durationDays: args.duration_days,
            priority: args.priority ? toPriority(args.priority) : undefined,
            status: args.status,
            repeat: args.stop_repeating ? null : args.repeat ? toRepeat(args.repeat) : undefined,
            skip: args.skip,
          }, this.via);
          return { updated: describeTask(task, dir, t0), ...(next ? { next_copy: describeTask(next, dir, t0) } : {}) };
        }),
    );

    this.server.registerTool(
      'list_comments',
      {
        title: 'Read comments',
        description: 'The comments on a task, oldest first: who wrote them, when, and the text. Tasks with comments show a "comments" count in list_tasks.',
        inputSchema: { id: z.string().describe('Task id from list_tasks.') },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.run(async (v, dir) => {
          const t = await loadVisibleTask(this.env.DB, v, args.id);
          const { results } = await this.env.DB
            .prepare("SELECT actor_id, via, note, at FROM task_events WHERE task_id = ? AND type = 'comment' ORDER BY at, rowid")
            .bind(t.id).all<{ actor_id: string; via: string | null; note: string; at: string }>();
          return {
            task: t.title,
            comments: results.map((c) => ({ by: userLabel(dir, c.actor_id), at: c.at, text: c.note, ...(c.via ? { via: c.via } : {}) })),
          };
        }),
    );

    this.server.registerTool(
      'add_comment',
      {
        title: 'Comment on a task',
        description:
          `Add a comment to a task, as you. Everyone on the task's project sees it in the task's history, marked as written via this assistant. ` +
          `Comments can't be edited or deleted, so only post what the user asked for. Up to ${COMMENT_MAX} characters.`,
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          text: z.string().min(1).max(COMMENT_MAX).describe('The comment. Plain text; line breaks are kept.'),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => ({ commented_on: describeTask(await addComment(this.env, v, args.id, args.text, this.via), dir, t0) })),
    );

    this.server.registerTool(
      'update_checklist',
      {
        title: 'Update a checklist',
        description:
          "Change a task's checklist (each task has at most one). Add items, check or uncheck them, or remove them. " +
          'Refer to existing items by their id or their exact text (from the task\'s "checklist"). Every change is recorded in the task history.',
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          add: z.array(z.string().min(1).max(300)).max(50).optional().describe('New items, added at the end in this order.'),
          check: z.array(z.string()).optional().describe('Items to mark done (id or exact text).'),
          uncheck: z.array(z.string()).optional().describe('Items to mark not done (id or exact text).'),
          remove: z.array(z.string()).optional().describe('Items to delete (id or exact text).'),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          let task: Task | null = null;
          const find = (list: { id: string; text: string }[], ref: string) => {
            const hit = list.find((c) => c.id === ref) ?? list.find((c) => c.text.toLowerCase() === ref.trim().toLowerCase());
            if (!hit) throw bad(`No checklist item "${ref}" on this task.`);
            return hit.id;
          };
          const current = async () => mapTask(await loadVisibleTask(this.env.DB, v, args.id)).checklist;
          for (const ref of args.check ?? []) task = await changeChecklist(this.env, v, args.id, { op: 'set', itemId: find(await current(), ref), done: true }, this.via);
          for (const ref of args.uncheck ?? []) task = await changeChecklist(this.env, v, args.id, { op: 'set', itemId: find(await current(), ref), done: false }, this.via);
          for (const ref of args.remove ?? []) task = await changeChecklist(this.env, v, args.id, { op: 'remove', itemId: find(await current(), ref) }, this.via);
          if (args.add?.length) task = await changeChecklist(this.env, v, args.id, { op: 'add', text: args.add.join('\n') }, this.via);
          if (!task) throw bad('Nothing to change: pass add, check, uncheck or remove.');
          return { updated: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'read_attachment',
      {
        title: 'Read an attached file',
        description:
          'Read a text file attached to a task (plain text, Markdown, CSV, JSON and similar, up to 200 KB). ' +
          'Tasks list their files under "attachments"; refer to one by id or exact name. Other files (images, PDFs…) and linked files (with a `link`) can only be listed.',
        inputSchema: { id: z.string().describe('Task id from list_tasks.'), file: z.string().describe('Attachment id or exact file name.') },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.run(async (v) => {
          const t = mapTask(await loadVisibleTask(this.env.DB, v, args.id));
          const a = t.attachments.find((x) => x.id === args.file) ?? t.attachments.find((x) => x.name.toLowerCase() === args.file.trim().toLowerCase());
          if (!a) throw bad(`No file "${args.file}" on this task.`);
          if (a.link) return { name: a.name, link: a.link, note: 'This is a link to a file in Google Drive or OneDrive, not a copy, so its contents can\'t be read here.' };
          const texty = /^text\//.test(a.type) || /(json|csv|xml|markdown|yaml|x-sh|javascript|typescript)/.test(a.type) || /\.(md|txt|csv|json|ya?ml|log|tsv)$/i.test(a.name);
          if (!texty) return { name: a.name, type: a.type, size: a.size, note: "This isn't a text file, so its contents can't be read here." };
          if (a.size > 200 * 1024) return { name: a.name, size: a.size, note: 'Too large to read here (over 200 KB).' };
          const { obj } = await readAttachment(this.env, v, t.id, a.id);
          return { name: a.name, type: a.type, text: await obj.text() };
        }),
    );

    this.server.registerTool(
      'attach_file',
      {
        title: 'Attach a file to a task',
        description:
          'Attach a file to a task, as you. Give exactly one of: `text` (a file you write, such as notes.md or a CSV), ' +
          '`base64` (a small binary file, up to 2 MB), or `url` (a public https link the server downloads, up to 25 MB; with `link: true`, the link itself is attached instead). ' +
          'Everyone on the project sees it, and the task history records it as attached via this assistant. ' +
          "Only attach what the user asked for. If attachments aren't set up on this instance, it says so.",
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          name: z.string().max(180).optional().describe('File name with extension, e.g. "meeting-notes.md". Required for text and base64; for a url it defaults to the file\'s own name.'),
          text: z.string().max(2_000_000).optional().describe('File contents as text (saved as UTF-8).'),
          base64: z.string().max(2_800_000).optional().describe('File contents, base64-encoded (up to 2 MB once decoded).'),
          url: z.string().url().optional().describe('A public https link to download and attach.'),
          link: z.boolean().optional().describe('With url: attach the link itself instead of downloading a copy. Use it for documents people open where they live (Google Docs, OneDrive, Figma…) and for private links the server can\'t download. Works even where file storage isn\'t set up.'),
          type: z.string().max(100).optional().describe('MIME type, e.g. "text/csv". Usually worked out from the name.'),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const given = [args.text !== undefined, args.base64 !== undefined, args.url !== undefined].filter(Boolean).length;
          if (given !== 1) throw bad('Give exactly one of text, base64 or url.');
          let task: Task;
          if (args.link && !args.url) throw bad('link needs a url.');
          if (args.url && args.link) {
            task = await attachPastedLink(this.env, v, args.id, args.url, args.name, this.via);
          } else if (args.url) {
            task = await addAttachmentFromUrl(this.env, v, args.id, args.url, args.name, args.type, this.via);
          } else {
            if (!args.name?.trim()) throw bad('Give the file a name, e.g. "notes.md".');
            let bytes: Uint8Array;
            if (args.text !== undefined) bytes = new TextEncoder().encode(args.text);
            else {
              try { bytes = Uint8Array.from(atob(args.base64!.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0)); } catch { throw bad("That base64 data couldn't be decoded."); }
              if (bytes.byteLength > 2 * 1024 * 1024) throw bad('Data passed as base64 can be at most 2 MB. Use a url for bigger files.');
            }
            task = await addAttachmentBytes(this.env, v, args.id, bytes, args.name, args.type ?? (args.text !== undefined && !/\.[a-z0-9]+$/i.test(args.name) ? 'text/plain' : undefined), this.via);
          }
          const added = task.attachments[task.attachments.length - 1];
          return { attached: added.link ? { id: added.id, name: added.name, link: added.link } : { id: added.id, name: added.name, type: added.type, size: added.size }, task: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'get_upload_url',
      {
        title: 'Get an upload link',
        description:
          `Get a one-time link for attaching a file to a task by POSTing it directly, e.g. a file from the user's computer when you can run commands ` +
          `(curl --data-binary @path). It works once, for ${UPLOAD_LINK_MINUTES} minutes, up to 25 MB, and the file is attached as the user, ` +
          'via this assistant. Prefer attach_file for text you write.',
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          name: z.string().max(180).optional().describe('File name to use, e.g. "report.pdf" (can also be given when uploading, as ?name=).'),
        },
      },
      (args) =>
        this.run(async (v) => {
          const link = await createUploadLink(this.env, v, args.id, args.name, this.via);
          const origin = this.props?.origin;
          const url = origin ? `${origin}${link.path}` : link.path;
          const type = args.name ? typeFromName(args.name) : 'application/octet-stream';
          return {
            upload_url: url,
            method: 'POST',
            expires_at: link.expiresAt,
            task: link.task.title,
            how: `curl -sS -X POST --data-binary @'<path to file>' -H 'content-type: ${type}' '${url}${args.name ? '' : '?name=<file name>'}'`,
            notes: [
              'Send the file as the raw request body (not a form). One file per link; ask again for another.',
              ...(origin ? [] : ["This connection is older, so the link is a path: put this app's address (the MCP server's, without /mcp) in front of it."]),
            ],
          };
        }),
    );

    this.server.registerTool(
      'archive_task',
      {
        title: 'Archive or restore a task',
        description:
          "Archive a task (the app's way of deleting): it disappears from every list but nothing is lost, and it can be restored. " +
          'Pass restore: true to bring an archived task back. Only archive what the user asked to remove.',
        inputSchema: { id: z.string().describe('Task id.'), restore: z.boolean().optional().describe('true to restore an archived task.') },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          const t = await setArchived(this.env, v, args.id, !args.restore, this.via);
          return { [args.restore ? 'restored' : 'archived']: describeTask(t, dir, t0) };
        }),
    );

    this.server.registerTool(
      'set_dependencies',
      {
        title: 'Set what a task waits on',
        description:
          'Say which tasks a task waits on (its blockers: it can\'t be finished before they are), or stop it waiting on some. A task can wait on ' +
          'several tasks and block several. Tasks show waits_on and blocks (ids, done, due_date); blocked_until means a blocker is due after ' +
          'the task, and holding_up lists waiting tasks due before this one. Nothing moves by itself: if dates clash, ask the person whether ' +
          'to move them (update_task with due_date).',
        inputSchema: {
          id: z.string().describe('The task that waits (task id from list_tasks).'),
          wait_on: z.array(z.string()).max(20).optional().describe('Task ids it should wait on. Any task the person can see; no circles.'),
          stop_waiting_on: z.array(z.string()).max(20).optional().describe('Task ids it should no longer wait on.'),
        },
        annotations: { idempotentHint: true },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          if (!args.wait_on?.length && !args.stop_waiting_on?.length) throw bad('Give wait_on or stop_waiting_on.');
          let task: Task | null = null;
          for (const b of args.stop_waiting_on ?? []) task = (await setBlocker(this.env, v, args.id, b, false, this.via)).task;
          for (const b of args.wait_on ?? []) task = (await setBlocker(this.env, v, args.id, b, true, this.via)).task;
          return { task: describeTask(task!, dir, t0) };
        }),
    );

    this.server.registerTool(
      'complete_task',
      {
        title: 'Complete a task',
        description:
          'Mark a task as done (today, in your time zone). For a repeating task this also creates the next copy, returned as next_copy. ' +
          'Some projects need the effort before a task is done (list_projects: effort.required_to_finish): ask the person and pass it as effort.',
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          effort: effortArg.optional().describe('The effort to record as it is finished ("1h 30m", "M" or "5"), for projects that track it.'),
        },
        annotations: { idempotentHint: true },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          let effort: string | null | undefined;
          if (args.effort !== undefined) {
            const t = await loadVisibleTask(this.env.DB, v, args.id);
            const p = dir.projects.find((x) => x.id === t.project_id);
            if (!p) throw bad('That task is in a project you can no longer see.');
            effort = toEffort(p, args.effort);
          }
          const { task, next } = await updateTaskWithNext(this.env, v, args.id, { status: 'done', effort }, this.via);
          return { completed: describeTask(task, dir, t0), ...(next ? { next_copy: describeTask(next, dir, t0) } : {}) };
        }),
    );

    this.server.registerTool(
      'transfer_task',
      {
        title: 'Transfer a task',
        description: "Assign a task to someone else, optionally with a short note they'll see in its history. The new assignee must be on the task's project.",
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          to: z.string().describe('Name, first name, email, or "me".'),
          note: z.string().max(500).optional(),
          this_only: z.boolean().optional().describe('Repeating tasks: transfer only this copy; future copies stay with the current person.'),
        },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          await loadVisibleTask(this.env.DB, v, args.id); // "not found" before "who?"
          const to = findUser(dir, v, args.to);
          const task = await updateTask(this.env, v, args.id, { assigneeId: to.id, note: args.note, thisOnly: args.this_only }, this.via);
          return { transferred: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'follow_task',
      {
        title: 'Follow a task',
        description:
          'Follow a task (or stop), so you hear about its comments, when it is done or reopened, and when it is handed to someone, ' +
          "in notifications and the app's inbox. Whoever has the task always hears about it. " +
          "Pass `person` to add or remove someone else on the task's project; that shows in the task's history and tells them.",
        inputSchema: {
          id: z.string().describe('Task id from list_tasks.'),
          follow: z.boolean().optional().describe('false to stop following. Default true.'),
          person: z.string().optional().describe('Someone else: name, first name or email. Default: you.'),
        },
        annotations: { idempotentHint: true },
      },
      (args) =>
        this.run(async (v, dir, t0) => {
          await loadVisibleTask(this.env.DB, v, args.id);
          const who = args.person ? findUser(dir, v, args.person).id : null;
          const task = await setFollowing(this.env, v, args.id, args.follow ?? true, who, this.via);
          return { [args.follow === false ? 'unfollowed' : 'following']: describeTask(task, dir, t0) };
        }),
    );

    this.server.registerTool(
      'project_day',
      {
        title: 'What got done in a project on a day',
        description:
          'Tasks finished in one project on one day, by priority, then due date. Good for "what got done on Acme yesterday?" ' +
          'Also lists what is still open for that day.',
        inputSchema: {
          project: z.string().describe('Project name.'),
          date: dateArg.describe('YYYY-MM-DD.'),
        },
        annotations: { readOnlyHint: true },
      },
      (args) =>
        this.run(async (_v, dir, t0) => {
          const project = findProject(dir, args.project);
          if (!isDate(args.date)) throw bad('Use a real day in YYYY-MM-DD form.');
          const day = args.date;
          const { results } = await this.env.DB
            .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE project_id = ? AND archived_at IS NULL AND (done_on = ? OR (status = 'open' AND due_date <= ?))`)
            .bind(project.id, day, day)
            .all<TaskRow>();
          const tasks = results.map(mapTask);
          const done = tasks
            .filter((t) => t.status === 'done' && t.doneOn === day)
            .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate) || (a.doneAt ?? '').localeCompare(b.doneAt ?? ''));
          // Same rule as the Projects page: on today, open includes carried-over tasks; other days, only tasks due that day.
          const open = tasks
            .filter((t) => t.status === 'open' && (day === t0 ? shownOn(t, t0) === t0 : t.dueDate === day))
            .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate));
          return {
            project: project.name,
            date: day,
            done: done.map((t) => describeTask(t, dir, t0)),
            ...(project.effort ? { effort_done: effortTotal(project.effort, done.map((t) => t.effort)) || null } : {}),
            still_open: open.map((t) => describeTask(t, dir, t0)),
          };
        }),
    );

    // ---------- admins: projects and people ----------
    const adminOnly = (v: Viewer, what: string) => { if (v.role !== 'admin') throw bad(`Only admins can ${what}. Ask an admin on your team.`); };
    const effortArgIn = z.enum(['none', 'time', 'tshirt', 'points']).describe(
      'How the project measures effort on its tasks: none, time (time spent, like 1h 30m), tshirt (XS–XL) or points (story points 1–21).',
    );
    const toEffortType = (e: 'none' | 'time' | 'tshirt' | 'points') => (e === 'none' ? null : e === 'points' ? 'fibo' : e);
    const colorArg = z.string().describe(`One of the project colours: ${PROJECT_COLORS.join(', ')}. Picked for you when left out.`);
    /** Members (not admins: they're on every project) from names or emails. */
    const membersFrom = (dir: Directory, v: Viewer, names: string[]) => {
      const users = names.map((n) => findUser(dir, v, n));
      const admins = users.filter((u) => u.role === 'admin');
      return { ids: users.filter((u) => u.role !== 'admin').map((u) => u.id), admins: admins.map((u) => u.name) };
    };
    const describeProject = (dir: Directory, p: Project) => ({
      name: p.name, description: p.description, color: p.color,
      effort: p.effort ? { tracks: EFFORT_TYPES[p.effort].name, required_to_finish: p.effortRequired } : null,
      members: [...dir.users.values()].filter((u) => u.role !== 'admin' && u.projects.includes(p.id)).map((u) => u.name),
    });

    this.server.registerTool(
      'create_project',
      {
        title: 'Create a project',
        description:
          'Admins only. Create a project. Write a description for it: assistants (including you) read it to decide which project a task belongs in. ' +
          'Members are people who are not admins (admins are on every project); give names or emails from list_projects or invite_people.',
        inputSchema: {
          name: z.string().min(1).max(80),
          description: z.string().max(DESCRIPTION_MAX).optional().describe('What belongs in this project, what doesn\'t, and how tasks are named.'),
          color: colorArg.optional(),
          members: z.array(z.string()).optional().describe('People to add (names or emails).'),
          effort: effortArgIn.optional(),
          effort_required: z.boolean().optional().describe('Effort must be recorded before a task is marked done.'),
        },
      },
      (args) =>
        this.run(async (v, dir) => {
          adminOnly(v, 'create projects');
          const m = membersFrom(dir, v, args.members ?? []);
          const used = new Set(dir.projects.map((p) => p.color));
          const id = await createProject(this.env, v, {
            name: args.name, description: args.description ?? '', members: m.ids,
            color: args.color ?? PROJECT_COLORS.find((c) => !used.has(c)) ?? PROJECT_COLORS[dir.projects.length % PROJECT_COLORS.length],
            effort: args.effort ? toEffortType(args.effort) : null, effortRequired: args.effort_required,
          });
          const after = await loadDirectory(this.env.DB, v);
          return {
            created: describeProject(after, after.projects.find((p) => p.id === id)!),
            ...(m.admins.length ? { note: `${m.admins.join(', ')} ${m.admins.length > 1 ? 'are admins' : 'is an admin'}, so already on every project.` } : {}),
          };
        }),
    );

    this.server.registerTool(
      'update_project',
      {
        title: 'Change a project',
        description:
          'Admins only. Rename a project, change its description, colour or effort tracking, and add or take off members. Only what you pass changes. ' +
          "Taking someone off needs them to have no open tasks there (transfer_task first) and another project to stay on.",
        inputSchema: {
          project: z.string().describe('Project name.'),
          name: z.string().min(1).max(80).optional().describe('New name.'),
          description: z.string().max(DESCRIPTION_MAX).optional(),
          color: colorArg.optional(),
          add_members: z.array(z.string()).optional().describe('Names or emails.'),
          remove_members: z.array(z.string()).optional().describe('Names or emails.'),
          effort: effortArgIn.optional(),
          effort_required: z.boolean().optional(),
        },
      },
      (args) =>
        this.run(async (v, dir) => {
          adminOnly(v, 'change projects');
          const p = findProject(dir, args.project);
          let members: string[] | undefined;
          if (args.add_members?.length || args.remove_members?.length) {
            const cur = [...dir.users.values()].filter((u) => u.role !== 'admin' && u.projects.includes(p.id)).map((u) => u.id);
            const add = membersFrom(dir, v, args.add_members ?? []).ids;
            const drop = new Set(membersFrom(dir, v, args.remove_members ?? []).ids);
            members = [...new Set([...cur, ...add])].filter((id) => !drop.has(id));
          }
          await updateProject(this.env, v, p.id, {
            name: args.name, description: args.description, color: args.color, members,
            ...(args.effort ? { effort: toEffortType(args.effort) } : {}), effortRequired: args.effort_required,
          });
          const after = await loadDirectory(this.env.DB, v);
          return { updated: describeProject(after, after.projects.find((x) => x.id === p.id)!) };
        }),
    );

    this.server.registerTool(
      'archive_project',
      {
        title: 'Archive or restore a project',
        description:
          'Admins only. Archive a project: it and all its tasks are hidden from everyone (nothing is deleted), its repeating tasks pause and its ' +
          'webhooks stop. Pass restore: true, with the archived project\'s name, to bring it back as it was.',
        inputSchema: {
          project: z.string().describe('Project name.'),
          restore: z.boolean().optional(),
        },
        annotations: { destructiveHint: true },
      },
      (args) =>
        this.run(async (v, dir) => {
          adminOnly(v, 'archive projects');
          if (!args.restore) {
            const p = findProject(dir, args.project);
            await setProjectArchived(this.env, v, p.id, true);
            return { archived: p.name, note: 'Restore it any time with archive_project and restore: true.' };
          }
          const { results } = await this.env.DB.prepare('SELECT * FROM projects WHERE archived = 1 ORDER BY archived_at DESC').all<ProjectRow>();
          const q = norm(args.project);
          const hits = results.filter((r) => norm(r.name) === q).length ? results.filter((r) => norm(r.name) === q) : results.filter((r) => norm(r.name).includes(q));
          if (!hits.length) throw bad(`No archived project matches "${args.project}". Archived: ${results.map((r) => `"${r.name}"`).join(', ') || 'none'}.`);
          if (hits.length > 1) throw bad(`"${args.project}" matches several archived projects: ${hits.map((r) => `"${r.name}"`).join(', ')}.`);
          await setProjectArchived(this.env, v, hits[0].id, false);
          return { restored: hits[0].name };
        }),
    );

    this.server.registerTool(
      'invite_people',
      {
        title: 'Invite people',
        description:
          'Admins only. Add people by email so they can sign in. Members see only the projects you give them (at least one); admins see every ' +
          "project and manage the team. If the admin connected their Gmail or Outlook, each gets an invite email; otherwise share the sign-in link returned here. " +
          'Someone disabled earlier is enabled again with the role and projects given.',
        inputSchema: {
          emails: z.array(z.string()).min(1).max(50),
          role: z.enum(['member', 'admin']).optional().describe('Default: member.'),
          projects: z.array(z.string()).optional().describe('Project names (required for members).'),
        },
      },
      (args) =>
        this.run(async (v, dir) => {
          adminOnly(v, 'invite people');
          const role = args.role ?? 'member';
          const projects = role === 'admin' ? [] : (args.projects ?? []).map((n) => findProject(dir, n).id);
          const origin = this.props?.origin ?? '';
          // With the sign-in settings saved in the app: invite emails go out through them (worker/signin-config.ts).
          const r = await invitePeople(await withConfig(this.env), v, origin, { emails: args.emails, role, projects });
          const sent = new Set(r.email.sent);
          return {
            added: r.added.map((e) => ({ email: e, invite_email: sent.has(e) ? 'sent' : 'not sent' })),
            ...(r.skipped.length ? { already_on_the_team: r.skipped } : {}),
            sign_in_link: origin ? `${origin}/login` : 'this app\'s address + /login',
            ...(r.added.some((e) => !sent.has(e)) ? { note: 'Send them the sign-in link: they sign in with the email address you added.' } : {}),
          };
        }),
    );
  }
}
