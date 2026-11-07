// Everything that changes data. Edits are applied on screen first, then sent; on failure they're rolled back.
import { addDays, rel, weekStart } from '../shared/dates';
import { type Repeat, describe } from '../shared/repeat';
import { onProject } from '../shared/rules';
import { applyFeedDir, feedOf, feedTaskUrl, forTask, isFeed, loadFeeds, localUsers } from './feeds';
import { type EffortType, effortFor, storedEffortLabel } from '../shared/effort';
import { ATTACH_MAX_BYTES } from '../shared/types';
import type { AppSettings, ArchivedProject, Bootstrap, InviteEmailResult, WebhookInfo, WebhookRequestInfo, Priority, Project, Role, SyncResponse, Task, TaskEvent, User } from '../shared/types';
import { PRIORITIES } from '../shared/types';
import { api, ApiError } from './api';
import { applyBrand } from './brand';
import { activeSelector, focusLater, selFor } from './focus';
import { BOARD_WEEKS_MAX, type ManageTab, type MultiSel, type Page, type Pop, type PopType, type State, S, emptyDraft, set } from './store';
import { syncPush } from './push';
import { checkForUpdate } from './updates';
import { loadInbox } from './inbox';
import { displayName, draftEffective, firstName, myProjects, sharesWith } from './util';

const pending = new Set<string>(); // tasks with an edit in flight (ignore sync for them)
const mine = new Map<string, number>(); // tasks I changed recently (don't flash my own edits)
const byId = <T extends { id: string }>(arr: T[]) => Object.fromEntries(arr.map((x) => [x.id, x]));
const nowIso = () => new Date().toISOString();
const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

// ---------- toasts + flash ----------
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, undo?: () => void, error = false, action?: { label: string; run: () => void }) {
  const id = ++toastSeq;
  set({ toast: { id, text, undo, error, action } });
  clearTimeout(toastTimer);
  // Toasts with something to click stay a little longer.
  toastTimer = setTimeout(() => S().toast?.id === id && set({ toast: null }), error || action ? 8000 : 4500);
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong.', undefined, true);
export function flash(ids: string[]) {
  const now = Date.now();
  set((s) => ({ flash: { ...s.flash, ...Object.fromEntries(ids.map((i) => [i, now])) } }));
  setTimeout(() => set((s) => {
    const f = { ...s.flash };
    ids.forEach((i) => f[i] === now && delete f[i]);
    return { flash: f };
  }), 2700);
}

// ---------- loading + sync ----------
function applyDirectory(b: Bootstrap): Partial<State> {
  const s = S();
  const users = byId(b.users);
  const projects = byId(b.projects);
  const viewUser = s.viewUser && users[s.viewUser] && users[s.viewUser].status === 'active' ? s.viewUser : b.me.id;
  let page = s.page;
  if ((page === 'team' || page === 'settings') && b.me.role !== 'admin') {
    page = 'tasks';
    history.replaceState(null, '', '/');
  }
  applyBrand(b.settings);
  return {
    me: b.me, users, projects, today: b.today, tz: b.tz, dirVersion: b.directoryVersion, settings: b.settings, gmail: b.gmail, attachmentsOn: b.attachments, viewUser, page,
    pushKey: b.push?.publicKey ?? null, notify: b.notify, updateRepo: b.updates?.repo ?? null, inboxUnread: b.inboxUnread ?? 0,
    projSel: s.projSel === 'all' || s.projSel === 'multi' || projects[s.projSel] ? s.projSel : 'all',
    projDay: s.projDay || b.today,
  };
}

export async function boot() {
  try {
    const b = await api.get<Bootstrap>('/api/bootstrap');
    const t = await api.get<{ from: string; to: string; tasks: Task[]; version: number }>('/api/tasks');
    set({ ...applyDirectory(b), tasks: byId(t.tasks), version: t.version, range: { from: t.from, to: t.to }, ready: true, lastSync: Date.now() });
    void loadFeeds(true); // tasks from other instances, if any are connected
    const last = localStorage.getItem('tv:lastProject');
    set((s) => ({ draft: { ...s.draft, projectId: last && myProjects(s).some((p) => p.id === last) ? last : myProjects(s)[0]?.id ?? null } }));
    gmailReturn();
    void syncPush();
    void checkForUpdate();
    // Opened from a notification (a new window): /?task=<id>.
    const q = new URLSearchParams(location.search);
    // Back from approving access on another instance (worker/feed.ts → /connect/done).
    const inst = q.get('instances');
    if (inst) {
      const why = q.get('why'), name = q.get('name');
      ['instances', 'why', 'name'].forEach((k) => q.delete(k));
      history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
      set({ instancesOpen: true });
      toast(inst === 'connected' ? `Connected ${name}. Your tasks there now show with yours.` : why || 'Couldn’t connect.', undefined, inst !== 'connected');
    }
    const task = q.get('task');
    if (task) {
      q.delete('task');
      history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
      void openTask(task);
    }
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) set({ bootError: e instanceof Error ? e.message : 'Could not load.' });
  }
}

/** People, projects or access changed: reload them and the tasks we can now see. */
async function reloadDirectory() {
  const s = S();
  const b = await api.get<Bootstrap>('/api/bootstrap');
  const r = s.range;
  const t = await api.get<{ from: string; to: string; tasks: Task[]; version: number }>(`/api/tasks${r ? `?from=${r.from}&to=${r.to}` : ''}`);
  // Other instances' tasks aren't this instance's to reload: keep them, and their projects and people.
  const theirs = Object.fromEntries(Object.entries(S().tasks).filter(([id]) => isFeed(id)));
  set({ ...applyDirectory(b), tasks: { ...theirs, ...byId(t.tasks) }, version: t.version, range: { from: t.from, to: t.to }, lastSync: Date.now() });
  applyFeedDir();
}

let syncing = false;
export async function sync() {
  if (syncing || !S().ready) return;
  syncing = true;
  try {
    const s = S();
    const r = await api.get<SyncResponse>(`/api/sync?since=${s.version}`);
    if (r.directoryVersion !== s.dirVersion) {
      await reloadDirectory();
      return;
    }
    const patch: Partial<State> = { lastSync: Date.now(), offline: false };
    if (r.today !== s.today) patch.today = r.today;
    if (r.inboxUnread !== undefined && r.inboxUnread !== s.inboxUnread) {
      patch.inboxUnread = r.inboxUnread;
      // Something new while the inbox is open: show it (and it's seen).
      if (r.inboxUnread > 0 && s.pop?.type === 'inbox') setTimeout(() => void loadInbox(), 0);
    }
    if (r.changed && r.tasks) {
      const tasks = { ...S().tasks };
      const events = { ...S().events };
      const flashIds: string[] = [];
      const me = s.me!.id;
      for (const t of r.tasks) {
        if (pending.has(t.id)) continue;
        const prev = tasks[t.id];
        if (prev && prev.version >= t.version) continue;
        tasks[t.id] = t;
        delete events[t.id];
        if ((mine.get(t.id) ?? 0) < Date.now() - 15000) flashIds.push(t.id);
        if (!prev && t.assigneeId === me && t.createdBy !== me) {
          toast(`${firstName(s.users[t.createdBy])} assigned you “${t.title}”`);
        } else if (prev && t.comments > prev.comments && (t.assigneeId === me || t.createdBy === me) && (mine.get(t.id) ?? 0) < Date.now() - 15000) {
          // Someone else commented on a task that's mine (assigned to me or created by me).
          toast(`New comment on “${t.title}”`, undefined, false, { label: 'Open', run: () => openDrawer(t.id) });
        }
      }
      for (const id of r.gone ?? []) delete tasks[id];
      Object.assign(patch, { tasks, events, version: r.version });
      if (flashIds.length) setTimeout(() => flash(flashIds), 0);
    } else patch.version = r.version;
    set(patch);
    void loadFeeds(); // other instances: at most every 45 seconds
  } catch (e) {
    if (e instanceof ApiError && e.status === 0) set({ offline: true });
  } finally {
    syncing = false;
  }
}

/** Make sure tasks for this date range are loaded (older weeks or days). */
export async function ensureRange(from: string, to: string) {
  const r = S().range;
  if (!r || (from >= r.from && to <= r.to)) return;
  const nf = from < r.from ? from : r.from;
  const nt = to > r.to ? to : r.to;
  const t = await api.get<{ tasks: Task[] }>(`/api/tasks?from=${nf}&to=${nt}`);
  set((s) => ({ tasks: { ...s.tasks, ...byId(t.tasks) }, range: { from: nf, to: nt } }));
  void loadFeeds(true);
}

export async function loadEvents(id: string) {
  try {
    const { events } = await forTask(id).get<{ events: TaskEvent[] }>('/events');
    set((s) => ({ events: { ...s.events, [id]: events } }));
  } catch (e) {
    toastError(e);
  }
}

// ---------- task edits ----------
type Changes = Partial<Pick<Task, 'title' | 'notes' | 'projectId' | 'assigneeId' | 'dueDate' | 'priority' | 'status' | 'effort'>>;

/**
 * A task from another instance (src/feeds.ts): only done, date, priority, notes, checklist and comments change from
 * here. For anything else, say so and offer to open it there. Returns true when it's one of those.
 */
export function elsewhere(id: string): boolean {
  const f = feedOf(S(), id);
  if (!f) return false;
  toast(`Do that on ${f.name}.`, undefined, false, { label: `Open ${f.name}`, run: () => window.open(feedTaskUrl(f, id), '_blank', 'noopener') });
  return true;
}
const putTask = (t: Task) => set((s) => ({ tasks: { ...s.tasks, [t.id]: t }, events: { ...s.events, [t.id]: undefined } }));

function optimistic(prev: Task, c: Changes): Task {
  const s = S();
  const next: Task = { ...prev, ...c };
  if (c.status === 'done' && prev.status !== 'done') Object.assign(next, { doneAt: nowIso(), doneOn: s.today, doneBy: s.me!.id });
  if (c.status === 'open' && prev.status !== 'open') Object.assign(next, { doneAt: null, doneOn: null, doneBy: null });
  if (c.assigneeId && c.assigneeId !== prev.assigneeId) next.assignedBy = s.me!.id;
  return next;
}

interface PatchOpts { note?: string; restore?: boolean; toast?: string; noUndo?: boolean; thisOnly?: boolean }

export async function patchTask(id: string, c: Changes, opts: PatchOpts = {}) {
  const prev = S().tasks[id];
  if (!prev) return;
  putTask(optimistic(prev, c));
  pending.add(id);
  mine.set(id, Date.now());
  flash([id]);
  try {
    const { task, next } = await forTask(id).patch<{ task: Task; next: Task | null }>('', { ...c, note: opts.note, restore: opts.restore, thisOnly: opts.thisOnly });
    putTask(task);
    if (next) { mine.set(next.id, Date.now()); putTask(next); }
    const text = opts.toast && next ? `${opts.toast} · next one ${rel(next.dueDate, S().today)}` : opts.toast;
    if (text) toast(text, opts.noUndo ? undefined : () => undo(prev, c));
  } catch (e) {
    putTask(prev);
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

function undo(prev: Task, c: Changes) {
  const back: Changes = {};
  for (const k of Object.keys(c) as (keyof Changes)[]) (back as Record<string, unknown>)[k] = prev[k];
  set({ toast: null });
  void patchTask(prev.id, back, { restore: true });
}

/** Ticks a task done (or not). If its project needs the effort first and it has none, asks for it (then ticks it). */
export const toggleDone = (id: string, anchor?: HTMLElement | null) => {
  const s = S();
  const t = s.tasks[id];
  if (!t) return;
  const done = t.status !== 'done';
  const p = s.projects[t.projectId];
  if (done && p?.effort && p.effortRequired && !effortFor(t.effort, p.effort)) {
    const a = anchor ?? (s.drawer === id ? document.querySelector<HTMLElement>('.drawer [data-act="toggle"]') : null)
      ?? document.querySelector<HTMLElement>(`[data-nav="task:${id}"] [data-act="toggle"]`) ?? document.querySelector<HTMLElement>(`[data-nav="task:${id}"]`);
    if (a) { openPop({ type: 'effort', id, thenDone: true }, a); return; }
  }
  void patchTask(id, { status: done ? 'done' : 'open' }, done ? { toast: `Done: ${t.title}` } : {});
};
/** Sets a task's effort (stored form, or null), and marks it done too when `thenDone`. */
export const setEffort = (id: string, effort: string | null, thenDone = false) => {
  const t = S().tasks[id];
  if (!t) return;
  void patchTask(id, thenDone ? { effort, status: 'done' } : { effort },
    { toast: thenDone ? `Done: ${t.title}` : effort ? `Effort: ${storedEffortLabel(effort)}` : 'Effort cleared' });
};
export const transfer = (id: string, to: string, note?: string, thisOnly?: boolean) =>
  elsewhere(id) ? Promise.resolve() : patchTask(id, { assigneeId: to }, { note, thisOnly, toast: `Transferred to ${firstName(S().users[to])}${thisOnly ? ' (just this one)' : ''}` });

/** Repeating tasks: change the rule (a Repeat), or stop repeating for good (null). Not optimistic: the server decides dates. */
export async function setRepeat(id: string, rule: Repeat | null) {
  if (elsewhere(id)) return;
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await api.patch<{ task: Task }>(`/api/tasks/${id}`, { repeat: rule });
    putTask(task);
    flash([id]);
    // Stopping can't be undone: a task can only start repeating when it's created.
    const old = t.series?.active ? t.series.rule : null;
    if (!rule) toast('Stopped repeating. This task is now a normal task.');
    else toast(`Repeats: ${describe(rule, task.series?.anchor ?? task.dueDate)}`, old ? () => { set({ toast: null }); void setRepeat(id, old); } : undefined);
  } catch (e) {
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

/** Repeating tasks: skip this copy; its date moves to the next scheduled one. */
export async function skipTask(id: string) {
  if (elsewhere(id)) return;
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await api.patch<{ task: Task }>(`/api/tasks/${id}`, { skip: true });
    putTask(task);
    flash([id]);
    toast(`Skipped · next one ${rel(task.dueDate, S().today)}`, () => {
      set({ toast: null });
      void patchTask(id, { dueDate: t.dueDate }, { restore: true });
    });
  } catch (e) {
    toastError(e);
  } finally {
    pending.delete(id);
  }
}
export const setPriority = (id: string, p: Priority) => patchTask(id, { priority: p }, { toast: `Priority set to ${PRIORITIES[p].name}` });
export const setProject = (id: string, p: string) => elsewhere(id) ? Promise.resolve() : patchTask(id, { projectId: p }, { toast: `Moved to ${S().projects[p]?.name}` });

export async function moveTasks(ids: string[], dueDate: string) {
  const s = S();
  const prevs = ids.map((i) => s.tasks[i]).filter((t): t is Task => !!t && t.dueDate !== dueDate);
  if (!prevs.length) return;
  prevs.forEach((t) => { putTask({ ...t, dueDate }); pending.add(t.id); mine.set(t.id, Date.now()); });
  flash(prevs.map((t) => t.id));
  try {
    if (prevs.length === 1) {
      const { task } = await forTask(prevs[0].id).patch<{ task: Task }>('', { dueDate });
      putTask(task);
    } else {
      // Tasks from other instances move one by one, through their own instance.
      const here = prevs.filter((t) => !isFeed(t.id)), there = prevs.filter((t) => isFeed(t.id));
      const moved = await Promise.all([
        here.length ? api.post<{ tasks: Task[] }>('/api/tasks/move', { ids: here.map((t) => t.id), dueDate }).then((r) => r.tasks) : [],
        ...there.map((t) => forTask(t.id).patch<{ task: Task }>('', { dueDate }).then((r) => [r.task])),
      ]);
      moved.flat().forEach(putTask);
    }
    toast(prevs.length > 1 ? `Moved ${prevs.length} tasks to ${rel(dueDate, s.today)}` : `Moved to ${rel(dueDate, s.today)}`, () => {
      set({ toast: null });
      prevs.forEach((t) => void patchTask(t.id, { dueDate: t.dueDate }, { restore: true }));
    });
  } catch (e) {
    prevs.forEach(putTask);
    toastError(e);
  } finally {
    prevs.forEach((t) => pending.delete(t.id));
  }
}

export async function createTask(): Promise<boolean> {
  const s = S();
  const d = s.draft;
  let title = d.title.trim();
  if (!title) return false;
  let priority = d.priority;
  const bang = title.match(/^(!{1,2})\s*/); // "!Fix bug" → High, "!!Prod down" → Urgent
  if (bang) { priority = bang[1].length === 2 ? 1 : 2; title = title.slice(bang[0].length) || title; }
  const { projectId, assigneeId } = draftEffective(s);
  if (!projectId) { toast("You're not on any project yet. Ask an admin to add you to one.", undefined, true); return false; }
  const due = d.dueDate || defaultDraftDate(s);
  try {
    const { task } = await api.post<{ task: Task }>('/api/tasks', { title, notes: d.notes, projectId, assigneeId, dueDate: due, priority, repeat: d.repeat ?? undefined });
    mine.set(task.id, Date.now());
    localStorage.setItem('tv:lastProject', projectId);
    set((st) => ({ tasks: { ...st.tasks, [task.id]: task }, draft: { ...emptyDraft(projectId), open: true } }));
    flash([task.id]);
    toast(`Added for ${assigneeId === s.me!.id ? 'you' : firstName(s.users[assigneeId])} · ${rel(task.dueDate, s.today)}${task.series ? ` · ${lowerFirst(describe(task.series.rule, task.series.anchor))}` : ''}`);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export function defaultDraftDate(s: State) {
  // Current week, Today view or other pages: today. A future week: its Monday.
  if (s.view === 'today' || s.page !== 'tasks' || s.weekOffset <= 0) return s.today;
  return addDays(weekStart(s.today), s.weekOffset * 7);
}

// ---------- UI helpers ----------
export function openPop(p: Omit<Pop, 'rect' | 'returnSel'> & { returnSel?: string | null }, anchor: HTMLElement) {
  const r = anchor.getBoundingClientRect();
  set({ pop: { ...p, rect: { l: r.left, t: r.top, b: r.bottom, r: r.right }, returnSel: p.returnSel ?? selFor(anchor) } });
}
export function closePop(restore: boolean) {
  const p = S().pop;
  set({ pop: null });
  if (restore && p?.returnSel) focusLater(p.returnSel);
}
export const popIs = (t: PopType) => S().pop?.type === t;

export function openDrawer(id: string, editTitle = false) {
  set({ drawer: id, pop: null, ...(S().drawer !== id ? { notesOpen: false, checklistOpen: false } : {}) });
  focusLater(editTitle ? '.dr-title' : '.drawer');
}
/** Opens a task by id, loading it first if this window doesn't have it (e.g. from a notification). */
export async function openTask(id: string) {
  if (!S().tasks[id]) {
    try {
      const { task } = await forTask(id).get<{ task: Task }>();
      set((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
    } catch {
      toast("That task isn't available anymore.", undefined, true);
      return;
    }
  }
  openDrawer(id);
}
export function closeDrawer(restore = true) {
  const id = S().drawer;
  set({ drawer: null });
  if (restore && id) focusLater(`[data-nav="task:${id}"]`);
}

let connectReturn: string | null = null;
export function openConnect() {
  connectReturn = activeSelector();
  set({ connect: true, pop: null, help: false });
  focusLater('[data-act="copy-mcp"]');
}
export function closeConnect() {
  set({ connect: false });
  focusLater(connectReturn || '[data-act="account"]');
}

let helpReturn: string | null = null;
export function openHelp() {
  helpReturn = activeSelector();
  set({ help: true, pop: null });
  focusLater('.help-close');
}
export function closeHelp() {
  set({ help: false });
  focusLater(helpReturn);
}

const manageUrl = (tab: ManageTab) => (tab === 'projects' ? '/manage/projects' : '/manage');
/** The People & projects page's tab. */
export function setManageTab(tab: ManageTab) {
  set({ manageTab: tab });
  if (S().page === 'team') history.replaceState(null, '', manageUrl(tab));
}
export function setPage(page: Page) {
  const s = S();
  if ((page === 'team' || page === 'settings') && s.me?.role !== 'admin') return;
  set({ page, drawer: null, pop: null, invite: null, projDay: s.projDay || s.today });
  history.replaceState(null, '', page === 'tasks' ? '/' : page === 'team' ? manageUrl(s.manageTab) : `/${page}`);
}
export function viewPerson(userId: string) {
  set({ viewUser: userId, page: 'tasks', drawer: null, pop: null, draft: { ...S().draft, assigneeId: null } });
  history.replaceState(null, '', '/');
}
/** Home: your own week (the logo and G T). */
export const goHome = () => viewPerson(S().me!.id);
/** A project's view (or 'all'), keeping the same Today / Week / Board choice. Remembered, for G P and the next visit. */
export function viewProject(projectId: string) {
  const s = S();
  set({ projSel: projectId, page: 'projects', drawer: null, pop: null, projDay: s.projDay || s.today });
  localStorage.setItem('tv:proj', projectId);
  history.replaceState(null, '', '/projects');
}
/**
 * Shows several people and/or projects at once (the switcher's "Select several"). One person or one project alone is
 * their usual view; nothing picked is All projects. Keeps any open menu open, so you can keep picking.
 */
export function viewMulti(sel: MultiSel) {
  const s = S();
  const m: MultiSel = { people: [...new Set(sel.people)], projects: [...new Set(sel.projects)] };
  const common = { drawer: null, projDay: s.projDay || s.today };
  if (m.people.length === 1 && !m.projects.length) {
    set({ ...common, viewUser: m.people[0], page: 'tasks', draft: { ...s.draft, assigneeId: null } });
    history.replaceState(null, '', '/');
    return;
  }
  const projSel = !m.people.length && m.projects.length <= 1 ? (m.projects[0] ?? 'all') : 'multi';
  set({ ...common, projSel, page: 'projects', ...(projSel === 'multi' ? { multi: m } : {}) });
  localStorage.setItem('tv:proj', projSel);
  if (projSel === 'multi') localStorage.setItem('tv:multi', JSON.stringify(m));
  history.replaceState(null, '', '/projects');
}
export function setMultiPick(on: boolean) {
  set({ multiPick: on });
  localStorage.setItem('tv:multiPick', on ? '1' : '0');
}
/** What the switcher's "Select several" starts from: whoever or whatever is on screen now. */
export function currentSel(s: State): MultiSel {
  if (s.page === 'tasks') return { people: [s.viewUser || s.me!.id], projects: [] };
  if (s.page === 'projects') {
    if (s.projSel === 'multi') return s.multi;
    if (s.projSel !== 'all' && s.projects[s.projSel]) return { people: [], projects: [s.projSel] };
  }
  return { people: [], projects: [] };
}
/** How many weeks the Board shows (1 to BOARD_WEEKS_MAX). */
export function setBoardWeeks(n: number) {
  const v = Math.min(BOARD_WEEKS_MAX, Math.max(1, Math.round(n)));
  set({ boardWeeks: v });
  localStorage.setItem('tv:boardWeeks', String(v));
}
export function setView(view: State['view']) {
  set({ view, ...(view === 'today' ? { weekOffset: 0 } : {}) });
  localStorage.setItem('tv:view', view);
}

export async function signOut() {
  await api.post('/auth/logout').catch(() => {});
  location.href = '/login';
}

// ---------- admin ----------
export async function addPeople(emails: string[], role: Role, projects: string[]) {
  const r = await api.post<{ added: string[]; skipped: string[]; email?: InviteEmailResult }>('/api/admin/users', { emails, role, projects });
  await reloadDirectory();
  if (!r.added.length) { toast('Everyone there is already on the team'); return; }
  const added = `Added ${r.added.length} ${r.added.length > 1 ? 'people' : 'person'}${r.skipped.length ? ` · ${r.skipped.length} already on the team` : ''}`;
  inviteToast(added, r.added.length, r.email);
}

/** The sign-in page people are invited to. */
export const inviteLink = () => `${location.origin}/login`;
const copyLinkAction = { label: 'Copy link', run: () => void copyInviteLink() };
export async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast('Sign-in link copied. They sign in with Google using the address you added.');
  } catch {
    toast(`Copy this link: ${inviteLink()}`, undefined, true);
  }
}

/** Says whether the invite emails went out; otherwise offers the link to share by hand. */
function inviteToast(prefix: string, count: number, e: InviteEmailResult | undefined) {
  if (e?.status === 'sent') { toast(`${prefix} · invite${count > 1 ? 's' : ''} emailed`); return; }
  if (e?.status === 'failed' && e.sent.length) {
    toast(`${prefix} · emailed ${e.sent.length}, couldn't email ${e.failed.join(', ')}`, undefined, true, copyLinkAction);
    return;
  }
  if (e?.reason) {
    // Was connected, but it no longer works (expired, revoked, Gmail error): say so, and offer the link.
    void refreshGmail();
    toast(`${prefix}, but the invite wasn't emailed. ${e.reason}`, undefined, true, copyLinkAction);
    return;
  }
  toast(`${prefix}. Send them the sign-in link so they can join.`, undefined, false, copyLinkAction);
}

/** Emails the invite again to someone who hasn't signed in yet. */
export async function resendInvite(userId: string) {
  const u = S().users[userId];
  try {
    const r = await api.post<{ email: InviteEmailResult }>(`/api/admin/users/${userId}/invite`);
    inviteToast(r.email.status === 'sent' ? `Invite sent to ${u?.email}` : `Invite to ${u?.email}`, 1, r.email);
  } catch (e) {
    toastError(e);
  }
}

// ---------- Gmail for invite emails ----------
async function refreshGmail() {
  const b = await api.get<Bootstrap>('/api/bootstrap').catch(() => null);
  if (b) set({ gmail: b.gmail });
}
/** Leaves the app for Google's consent screen; comes back to `back` with ?gmail=<result>. */
export function connectGmail(back = location.pathname) {
  location.href = `/auth/gmail?next=${encodeURIComponent(back)}`;
}
export async function disconnectGmail() {
  try {
    await api.del('/api/admin/gmail');
    set({ gmail: null });
    toast("Gmail disconnected. Invites won't be emailed until you connect it again.");
  } catch (e) {
    toastError(e);
  }
}
const GMAIL_RESULTS: Record<string, [string, boolean]> = {
  connected: ['Gmail connected. Invites will be emailed from your address.', false],
  cancelled: ["Gmail wasn't connected.", false],
  no_permission: ["Gmail wasn't connected: the \"send email on your behalf\" permission wasn't allowed.", true],
  wrong_account: ['Choose the Google account you sign in to Taskivities with.', true],
  unavailable: ["Google sign-in isn't set up on this instance, so Gmail can't be connected.", true],
  expired: ['That took too long. Try connecting Gmail again.', true],
  failed: ["Google didn't finish connecting Gmail. Try again.", true],
  forbidden: ['Only admins can connect Gmail.', true],
};
/** After coming back from Google: say what happened, and tidy the address bar. */
function gmailReturn() {
  const q = new URLSearchParams(location.search);
  const r = q.get('gmail');
  if (!r) return;
  q.delete('gmail');
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  const [text, error] = GMAIL_RESULTS[r] ?? GMAIL_RESULTS.failed;
  toast(text, undefined, error);
}
export async function updateUser(id: string, body: { role?: Role; projects?: string[] }, message?: string) {
  try {
    await api.patch(`/api/admin/users/${id}`, body);
    await reloadDirectory();
    if (message) toast(message);
    flash(['u:' + id]);
  } catch (e) {
    toastError(e);
  }
}
/** Disables someone (after giving their open tasks to `transferTo`). They stay on the People & projects page and can be enabled again. */
export async function disableUser(id: string, transferTo?: string) {
  const u = S().users[id];
  try {
    const r = await api.post<{ transferred: number }>(`/api/admin/users/${id}/disable${transferTo ? `?transferTo=${transferTo}` : ''}`);
    await reloadDirectory();
    toast(`Disabled ${displayName(u)}${r.transferred ? ` · ${r.transferred} task${r.transferred > 1 ? 's' : ''} moved to ${firstName(S().users[transferTo!])}` : ''}`,
      () => { set({ toast: null }); void enableUser(id); });
  } catch (e) {
    toastError(e);
  }
}
/** Enables someone again: members get `projects` (or the projects they had). */
export async function enableUser(id: string, projects?: string[]) {
  try {
    await api.post(`/api/admin/users/${id}/enable`, projects ? { projects } : {});
    await reloadDirectory();
    const u = S().users[id];
    toast(`${displayName(u)} can sign in again`);
    flash(['u:' + id]);
  } catch (e) {
    toastError(e);
  }
}
/** Creates or saves a project. Returns an error message to show in the editor, or the project's id. */
export async function saveProject(p: { id: string | null; name: string; color: string; description: string; members: string[]; effort: EffortType | null; effortRequired: boolean }): Promise<{ error: string } | { id: string }> {
  const body = { name: p.name, color: p.color, description: p.description, members: p.members, effort: p.effort, effortRequired: p.effortRequired };
  try {
    let id = p.id;
    if (id) await api.patch(`/api/admin/projects/${id}`, body);
    else id = (await api.post<{ id: string }>('/api/admin/projects', body)).id;
    await reloadDirectory();
    toast(p.id ? `Saved ${p.name}` : `Created ${p.name}`);
    flash(['p:' + id]);
    return { id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not save.' };
  }
}

// ---------- access-aware lookups used by menus ----------
export const assignable = (s: State, projectId: string): User[] =>
  localUsers(s).filter((u) => u.status !== 'disabled' && onProject(u, projectId));
export const switchablePeople = (s: State): User[] =>
  localUsers(s).filter((u) => u.status === 'active' && (u.id === s.me!.id || sharesWith(s, u)));
export const projectList = (s: State): Project[] => myProjects(s);

// ---------- app settings (admins) ----------
function putSettings(settings: AppSettings) {
  set({ settings });
  applyBrand(settings);
}

/** Uploads an SVG logo. Returns an error message to show next to the button, or null. */
export async function uploadLogo(svg: string): Promise<string | null> {
  try {
    const r = await api.put<{ settings: AppSettings }>('/api/admin/settings/logo', { svg });
    putSettings(r.settings);
    toast('Logo updated');
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Upload failed.';
  }
}

/** Saves the team's name ('' goes back to "Taskivities"). Returns an error message to show, or null. */
export async function saveAppName(name: string): Promise<string | null> {
  try {
    const r = await api.put<{ settings: AppSettings }>('/api/admin/settings/name', { name });
    putSettings(r.settings);
    toast(name ? `The app is now called ${name}` : 'Back to Taskivities');
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Could not save.';
  }
}

export async function uploadWordmark(svg: string): Promise<string | null> {
  try {
    const r = await api.put<{ settings: AppSettings }>('/api/admin/settings/wordmark', { svg });
    putSettings(r.settings);
    toast('Wordmark updated');
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Upload failed.';
  }
}

export async function resetWordmark() {
  try {
    const r = await api.del<{ settings: AppSettings }>('/api/admin/settings/wordmark');
    putSettings(r.settings);
    toast(r.settings.name ? `Showing ${r.settings.name} as text` : 'Back to the built-in name');
  } catch (e) {
    toastError(e);
  }
}

export async function resetLogo() {
  try {
    const r = await api.del<{ settings: AppSettings }>('/api/admin/settings/logo');
    putSettings(r.settings);
    toast('Back to the built-in logo');
  } catch (e) {
    toastError(e);
  }
}

// ---------- webhooks (admins) ----------
export async function loadHooks() {
  try {
    const r = await api.get<{ webhooks: WebhookInfo[] }>('/api/admin/webhooks');
    set({ hooks: r.webhooks });
  } catch (e) {
    toastError(e);
  }
}
const putHook = (h: WebhookInfo) => set((s) => ({ hooks: (s.hooks ?? []).some((x) => x.id === h.id) ? s.hooks!.map((x) => (x.id === h.id ? h : x)) : [...(s.hooks ?? []), h] }));

let hookReturn: string | null = null;
export function openHook(id: string) {
  hookReturn = activeSelector();
  set({ hookEdit: id, pop: null });
}
export function closeHook() {
  set({ hookEdit: null });
  void loadHooks(); // last-request times and status may have changed while it was open
  focusLater(hookReturn || '[data-act="hook-new"]');
}
export async function createHook(name: string) {
  const r = await api.post<{ webhook: WebhookInfo }>('/api/admin/webhooks', { name });
  putHook(r.webhook);
  openHook(r.webhook.id);
}
/** Rename, pause/resume, or set the mapping (null = back to capturing). Throws with the server's message. */
export async function saveHook(id: string, patch: { name?: string; active?: boolean; mapping?: unknown }) {
  const r = await api.patch<{ webhook: WebhookInfo }>(`/api/admin/webhooks/${id}`, patch);
  putHook(r.webhook);
  return r.webhook;
}
export async function rotateHook(id: string) {
  try {
    const r = await api.post<{ webhook: WebhookInfo }>(`/api/admin/webhooks/${id}/rotate`);
    putHook(r.webhook);
    toast('New address created. The old one no longer works: update it in the other service.');
  } catch (e) {
    toastError(e);
  }
}
export async function deleteHook(id: string) {
  try {
    await api.del(`/api/admin/webhooks/${id}`);
    set((s) => ({ hooks: (s.hooks ?? []).filter((h) => h.id !== id), hookEdit: null }));
    toast('Webhook deleted');
    focusLater('[data-act="hook-new"]');
  } catch (e) {
    toastError(e);
  }
}
export const hookRequests = (id: string) => api.get<{ requests: WebhookRequestInfo[] }>(`/api/admin/webhooks/${id}/requests`).then((r) => r.requests);
export async function replayHookRequest(id: string, rid: string) {
  try {
    const r = await api.post<{ result: WebhookRequestInfo['result']; detail?: string; taskId?: string }>(`/api/admin/webhooks/${id}/requests/${rid}/replay`);
    if (r.result === 'created') {
      toast(r.detail ? `Task created. ${r.detail}` : 'Task created', undefined, false, { label: 'Open', run: () => { closeHook(); void openCreated(r.taskId!); } });
    } else toast(r.detail || `Not created (${r.result})`, undefined, r.result === 'error');
  } catch (e) {
    toastError(e);
  }
}
async function openCreated(taskId: string) {
  await sync();
  if (S().tasks[taskId]) openDrawer(taskId);
}

// ---------- comments ----------
/** Posts a comment. Returns true when it was saved (so the box can clear). */
export async function addComment(id: string, text: string): Promise<boolean> {
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await forTask(id).post<{ task: Task }>('/comments', { text });
    putTask(task); // drops the cached history, so the drawer reloads it with the comment
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    pending.delete(id);
  }
}

/** Follow or stop following a task: me, or (`userId`) someone else on its project. */
export async function setFollowing(id: string, follow: boolean, userId?: string) {
  if (elsewhere(id)) return;
  const prev = S().tasks[id];
  if (!prev) return;
  const me = S().me!.id;
  const who = userId ?? me;
  if (!follow && who === prev.assigneeId) return;
  pending.add(id);
  mine.set(id, Date.now());
  const followers = follow ? [...new Set([...prev.followers, who])] : prev.followers.filter((f) => f !== who);
  set((s) => ({ tasks: { ...s.tasks, [id]: { ...prev, followers } } }));
  try {
    const { task } = await api.post<{ task: Task }>(`/api/tasks/${id}/follow`, { follow, ...(who !== me ? { userId: who } : {}) });
    putTask(task);
    if (who === me) toast(follow ? `Following “${prev.title}”` : `Stopped following “${prev.title}”`, () => { set({ toast: null }); void setFollowing(id, !follow); });
  } catch (e) {
    set((s) => ({ tasks: { ...s.tasks, [id]: prev } }));
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

/** Opens the task (if needed) and puts the cursor in its notes, expanding them when empty. */
export function editNotes(id: string) {
  // Ask for the focus first: the state change below can render right away, and the focus is applied after a render.
  focusLater('[data-field="notes"]');
  set({ drawer: id, pop: null, notesOpen: true, ...(S().drawer !== id ? { checklistOpen: false } : {}) });
}

// ---------- checklist ----------
/** Opens the task (if needed) and puts the cursor in "Add an item", expanding an empty checklist. */
export function editChecklist(id: string) {
  focusLater('#ck-add');
  set({ drawer: id, pop: null, checklistOpen: true, ...(S().drawer !== id ? { notesOpen: false } : {}) });
}

async function checklistCall(id: string, call: () => Promise<{ task: Task }>, optimistic?: (t: Task) => Task) {
  const before = S().tasks[id];
  pending.add(id);
  mine.set(id, Date.now());
  if (before && optimistic) set((s) => ({ tasks: { ...s.tasks, [id]: optimistic(before) } }));
  try {
    const { task } = await call();
    putTask(task);
    return true;
  } catch (e) {
    if (before && optimistic) set((s) => ({ tasks: { ...s.tasks, [id]: before } }));
    toastError(e);
    return false;
  } finally {
    pending.delete(id);
  }
}
/** Adds one item, or several (one per line, e.g. pasted). */
export const addChecklistItems = (id: string, text: string) => checklistCall(id, () => forTask(id).post('/checklist', { text }));
export const toggleChecklistItem = (id: string, itemId: string, done: boolean) =>
  checklistCall(id, () => forTask(id).patch(`/checklist/${itemId}`, { done }),
    (t) => ({ ...t, checklist: t.checklist.map((c) => (c.id === itemId ? { ...c, done } : c)) }));
export const renameChecklistItem = (id: string, itemId: string, text: string) =>
  checklistCall(id, () => forTask(id).patch(`/checklist/${itemId}`, { text }),
    (t) => ({ ...t, checklist: t.checklist.map((c) => (c.id === itemId ? { ...c, text } : c)) }));
export const removeChecklistItem = (id: string, itemId: string) =>
  checklistCall(id, () => forTask(id).del(`/checklist/${itemId}`),
    (t) => ({ ...t, checklist: t.checklist.filter((c) => c.id !== itemId) }));

// ---------- attachments ----------
export const attachmentUrl = (taskId: string, id: string, download = false) => `/api/tasks/${taskId}/attachments/${id}${download ? '?download' : ''}`;

/** Uploads files to a task, one after another, with progress. Uses XHR because fetch can't report upload progress. */
export async function uploadFiles(taskId: string, files: File[]) {
  if (elsewhere(taskId)) return;
  const ok = files.filter((f) => f.size > 0 && f.size <= ATTACH_MAX_BYTES);
  const tooBig = files.filter((f) => f.size > ATTACH_MAX_BYTES);
  if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(', ')}: files can be at most ${ATTACH_MAX_BYTES / 1024 / 1024} MB.`, undefined, true);
  for (const f of ok) {
    const id = crypto.randomUUID();
    const name = f.name || 'pasted image.png';
    const patch = (p: Partial<{ loaded: number }>) => set((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...p } : u)) }));
    set((s) => ({ uploads: [...s.uploads, { id, taskId, name, loaded: 0, total: f.size }] }));
    pending.add(taskId);
    mine.set(taskId, Date.now());
    try {
      const task = await new Promise<Task>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', `/api/tasks/${taskId}/attachments`);
        x.setRequestHeader('x-taskivities', '1');
        x.setRequestHeader('x-file-name', encodeURIComponent(name));
        x.setRequestHeader('content-type', f.type || 'application/octet-stream');
        x.upload.onprogress = (e) => patch({ loaded: e.loaded });
        x.onload = () => {
          let body: { task?: Task; error?: string } = {};
          try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
          if (x.status >= 200 && x.status < 300 && body.task) resolve(body.task);
          else reject(new Error(body.error || `Couldn't attach ${name}.`));
        };
        x.onerror = () => reject(new Error(`Couldn't attach ${name}. Check your connection.`));
        x.send(f);
      });
      putTask(task);
    } catch (e) {
      toastError(e);
    } finally {
      pending.delete(taskId);
      set((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
    }
  }
}

export async function removeAttachment(taskId: string, id: string, name: string) {
  pending.add(taskId);
  mine.set(taskId, Date.now());
  try {
    const { task } = await api.del<{ task: Task }>(`/api/tasks/${taskId}/attachments/${id}`);
    putTask(task);
    toast(`Removed ${name}`);
  } catch (e) {
    toastError(e);
  } finally {
    pending.delete(taskId);
  }
}

/** ⇧A: opens the task (if needed) and its file picker. */
export function pickAttachments(id: string) {
  if (elsewhere(id)) return;
  if (!S().attachmentsOn) { toast("Attachments aren't set up on this instance."); return; }
  const wasOpen = S().drawer === id;
  if (!wasOpen) openDrawer(id);
  // The picker input is in the drawer; give it a moment to render when the drawer was just opened.
  setTimeout(() => document.querySelector<HTMLInputElement>('#attach-input')?.click(), wasOpen ? 0 : 60);
}

// ---------- home-screen icon (admins) ----------
export async function uploadIcon(icons: Record<number, string>): Promise<string | null> {
  try {
    const r = await api.put<{ settings: AppSettings }>('/api/admin/settings/icon', { icons });
    set({ settings: r.settings });
    toast('App icon updated. Phones pick it up the next time the app is added to the home screen.');
    return null;
  } catch (e) {
    return e instanceof ApiError ? e.message : 'Upload failed.';
  }
}
export async function resetIcon() {
  try {
    const r = await api.del<{ settings: AppSettings }>('/api/admin/settings/icon');
    set({ settings: r.settings });
    toast('Back to the built-in app icon');
  } catch (e) {
    toastError(e);
  }
}

// ---------- archive (instead of delete) ----------
/** Archives a task: it leaves every list at once (Undo brings it back). Restoring is in the project's view. */
export async function archiveTask(id: string) {
  if (elsewhere(id)) return;
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  // Gone from the lists right away.
  set((s) => {
    const tasks = { ...s.tasks };
    delete tasks[id];
    return { tasks, drawer: s.drawer === id ? null : s.drawer };
  });
  try {
    await api.post(`/api/tasks/${id}/archive`);
    toast(`Archived “${t.title}”`, () => { set({ toast: null }); void restoreTask(id); });
    if (S().archived) void loadArchived(S().archived!.project);
  } catch (e) {
    set((s) => ({ tasks: { ...s.tasks, [id]: t } }));
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

export async function restoreTask(id: string) {
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await api.post<{ task: Task }>(`/api/tasks/${id}/restore`);
    putTask(task);
    set((s) => (s.archived ? { archived: { ...s.archived, tasks: s.archived.tasks.filter((x) => x.id !== id) } } : {}));
    toast(`Restored “${task.title}”`, undefined, false, { label: 'Open', run: () => openDrawer(id) });
  } catch (e) {
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

/** A project view's Archived section ('all' = every project you can see). */
export async function loadArchived(project: string) {
  try {
    const { tasks } = await api.get<{ tasks: Task[] }>(`/api/archived?project=${encodeURIComponent(project)}`);
    set({ archived: { project, tasks } });
  } catch (e) {
    toastError(e);
  }
}

// ---------- archived projects (admins, People & projects page) ----------
export async function loadArchivedProjects() {
  try {
    const { projects } = await api.get<{ projects: ArchivedProject[] }>('/api/admin/projects/archived');
    set({ archivedProjects: projects });
  } catch (e) {
    toastError(e);
  }
}
/** Archives a project: it and its tasks leave every list for everyone (Undo brings them back). */
export async function archiveProject(id: string) {
  const p = S().projects[id];
  try {
    await api.post(`/api/admin/projects/${id}/archive`);
    set((s) => ({ projEdit: null, ...(s.projSel === id ? { projSel: 'all' } : {}) }));
    await reloadDirectory();
    void loadArchivedProjects();
    toast(`Archived ${p?.name ?? 'the project'}`, () => { set({ toast: null }); void restoreProject(id); });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Could not archive.';
  }
}
export async function restoreProject(id: string) {
  try {
    await api.post(`/api/admin/projects/${id}/restore`);
    await reloadDirectory();
    set((s) => ({ archivedProjects: s.archivedProjects?.filter((p) => p.id !== id) ?? null }));
    toast(`Restored ${S().projects[id]?.name ?? 'the project'}`);
    flash(['p:' + id]);
  } catch (e) {
    toastError(e);
  }
}
