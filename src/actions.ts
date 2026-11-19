// Everything that changes data. Edits are applied on screen first, then sent; on failure they're rolled back.
import { addDays, fmt, rel, weekStart } from '../shared/dates';
import { type Repeat, describe, firstDate } from '../shared/repeat';
import { onProject } from '../shared/rules';
import { applyUrl, startRouter } from './router';
import { applyFeedDir, clientFor, connectingOrigin, feedParts, finishConnect, isFeed, nsId, srcCall, loadSources, localUsers, moveOnSources, sourcesRange, syncSources, taskFromSource, uploadTarget } from './sources';
import { isDropped, liveId, newTemp, realId, tempOf } from './tempIds';
import { type EffortType, effortFor, storedEffortLabel } from '../shared/effort';
import { ATTACH_MAX_BYTES } from '../shared/types';
import type { AppSettings, ArchivedProject, Bootstrap, InviteEmailResult, MailboxVia, WebhookInfo, WebhookRequestInfo, Priority, Project, Role, SyncResponse, Task, TaskEvent, TaskLink, User } from '../shared/types';
import { PRIORITIES, type CloudProvider } from '../shared/types';
import { PickCancelled, pickFiles } from './cloudFiles';
import { api, ApiError } from './api';
import { applyBrand } from './brand';
import { activeSelector, focusLater, selFor } from './focus';
import { BOARD_WEEKS_MAX, type ManageTab, type MultiSel, type Page, type Pop, type PopType, type State, S, emptyDraft, set } from './store';
import { syncPush } from './push';
import { checkForUpdate } from './updates';
import { loadInbox } from './inbox';
import { daysLabel, displayName, draftEffective, firstName, linksOf, myProjects, sharesWith } from './util';
import { expectedOn } from '../shared/deps';

const pending = new Set<string>(); // tasks with an edit in flight (ignore sync for them)
let creating = 0; // tasks being added here (shown already, under a temporary id)
const held = new Map<string, Task>(); // new tasks of mine that sync brought while adding: likely the ones being added
/** Sync leaves these alone: an edit is in flight, or it's a task of mine that's probably still showing under its temporary id. */
function skipSync(t: Task) {
  const tmp = tempOf(t.id);
  if (pending.has(t.id) || (tmp && pending.has(tmp))) return true;
  if (creating > 0 && !S().tasks[t.id]) {
    const s = S();
    const meThere = isFeed(t.id) ? s.feedDir.me[feedParts(t.id).src]?.id : undefined;
    if (t.createdBy === s.me?.id || (meThere && t.createdBy === meThere)) { held.set(t.id, t); return true; }
  }
  return false;
}
const mine = new Map<string, number>(); // tasks I changed recently (don't flash my own edits)
const byId = <T extends { id: string }>(arr: T[]) => Object.fromEntries(arr.map((x) => [x.id, x]));
const nowIso = () => new Date().toISOString();
const lowerFirst = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);

// ---------- toasts + flash ----------
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, undo?: () => void, error = false, action?: { label: string; run: () => void }) {
  const id = ++toastSeq;
  toastShown = id;
  set({ toast: { id, text, undo, error, action } });
  clearTimeout(toastTimer);
  // Toasts with something to click stay a little longer.
  toastTimer = setTimeout(() => S().toast?.id === id && set({ toast: null }), error || action ? 8000 : 4500);
  return id;
}
let toastShown = 0;
/** Still showing that toast (nothing newer replaced it). */
const showing = (id: number) => toastShown === id && S().toast?.id === id;
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
  // Someone on another instance stays (their people aren't in this directory).
  const viewUser = s.viewUser && (isFeed(s.viewUser) || (users[s.viewUser] && users[s.viewUser].status === 'active')) ? s.viewUser : b.me.id;
  let page = s.page;
  if ((page === 'team' || page === 'settings') && b.me.role !== 'admin') page = 'tasks';
  applyBrand(b.settings);
  return {
    me: b.me, users, projects, today: b.today, tz: b.tz, dirVersion: b.directoryVersion, settings: b.settings,
    mailbox: b.mailbox, mailboxOptions: b.mailboxOptions ?? [], signInWith: b.signInWith ?? [], attachmentsOn: b.attachments, cloud: b.cloud ?? { google: null, microsoft: null }, viewUser, page,
    pushKey: b.push?.publicKey ?? null, notify: b.notify, updateRepo: b.updates?.repo ?? null, inboxUnread: b.inboxUnread ?? 0,
    // Another instance's project stays (its projects aren't in this directory).
    projSel: s.projSel === 'all' || s.projSel === 'multi' || isFeed(s.projSel) || projects[s.projSel] ? s.projSel : 'all',
    projDay: s.projDay || b.today,
  };
}

export async function boot() {
  try {
    const b = await api.get<Bootstrap>('/api/bootstrap');
    const t = await api.get<{ from: string; to: string; tasks: Task[]; version: number }>('/api/tasks');
    set({ ...applyDirectory(b), tasks: byId(t.tasks), version: t.version, range: { from: t.from, to: t.to }, ready: true, lastSync: Date.now() });
    mailboxReturn(); // reads its ?mailbox= result before the router tidies the address
    signinTestReturn(); // likewise ?signin= (Settings → Sign-in, src/components/SigninSettings.tsx)
    // Other instances connected on this device (src/sources.ts), then the address: what to show (src/router.ts).
    const sourcesReady = loadSources();
    if (location.pathname === '/oauth/done') {
      // The sheet opens at once, showing the connection being finished.
      set({ instancesOpen: true, connecting: connectingOrigin() ?? '' });
      void finishConnect().then((r) => { set({ connecting: null }); toast(r.message, undefined, !r.ok); });
    } else applyUrl(location, sourcesReady, (id) => void openTask(id), true);
    startRouter(sourcesReady, (id) => void openTask(id));
    const last = localStorage.getItem('tv:lastProject');
    set((s) => ({ draft: { ...s.draft, projectId: last && myProjects(s).some((p) => p.id === last) ? last : myProjects(s)[0]?.id ?? null } }));
    void syncPush();
    void checkForUpdate();
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
        if (skipSync(t)) continue;
        const prev = tasks[t.id];
        if (prev && prev.version >= t.version) continue;
        tasks[t.id] = t;
        delete events[t.id];
        // A task linked to one that changed comes back with a new version but the same updated_at: no flash for it.
        if ((mine.get(t.id) ?? 0) < Date.now() - 15000 && (!prev || prev.updatedAt !== t.updatedAt)) flashIds.push(t.id);
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
    void syncSources((_id, t) => skipSync(t)); // other instances keep up on the same timer
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
  void sourcesRange(nf, nt);
}

export async function loadEvents(id: string) {
  try {
    const { events } = await clientFor(id).get<{ events: TaskEvent[] }>('/events');
    set((s) => ({ events: { ...s.events, [id]: events } }));
  } catch (e) {
    toastError(e);
  }
}

// ---------- task edits ----------
type Changes = Partial<Pick<Task, 'title' | 'notes' | 'projectId' | 'assigneeId' | 'dueDate' | 'durationDays' | 'priority' | 'status' | 'effort'>>;

const putTask = (t0: Task) => {
  if (isDropped(t0.id)) return; // added here, but the server refused it: it's gone
  const id = liveId(t0.id); // a rollback to how it was while it was being added: it has its real id now
  const t = id === t0.id ? t0 : { ...t0, id };
  set((s) => ({ tasks: { ...s.tasks, [id]: t }, events: { ...s.events, [id]: undefined } }));
};

function optimistic(prev: Task, c: Changes): Task {
  const s = S();
  const next: Task = { ...prev, ...c };
  if (c.status === 'done' && prev.status !== 'done') Object.assign(next, { doneAt: nowIso(), doneOn: s.today, doneBy: s.me!.id });
  if (c.status === 'open' && prev.status !== 'open') Object.assign(next, { doneAt: null, doneOn: null, doneBy: null });
  if (c.assigneeId && c.assigneeId !== prev.assigneeId) next.assignedBy = s.me!.id;
  return next;
}

interface PatchOpts { note?: string; restore?: boolean; toast?: string; noUndo?: boolean; thisOnly?: boolean }

export async function patchTask(taskId: string, c: Changes, opts: PatchOpts = {}) {
  const id = liveId(taskId); // e.g. an Undo for a task that was still being added
  const prev = S().tasks[id];
  if (!prev) return;
  putTask(optimistic(prev, c));
  pending.add(id);
  mine.set(id, Date.now());
  flash([id]);
  const undoIt = opts.noUndo ? undefined : () => undo(prev, c);
  const shown = opts.toast ? toast(opts.toast, undoIt) : 0;
  try {
    const { task, next } = await clientFor(id).patch<{ task: Task; next: Task | null }>('', { ...c, note: opts.note, restore: opts.restore, thisOnly: opts.thisOnly });
    putTask(task);
    if (next) {
      mine.set(next.id, Date.now());
      putTask(next);
      // A repeating task's next copy: say when, if the toast is still up.
      if (shown && showing(shown)) toast(`${opts.toast} · next one ${rel(next.dueDate, S().today)}`, undoIt);
    }
  } catch (e) {
    putTask(prev);
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

function undo(prev: Task, c: Changes) {
  const back: Changes = {};
  for (const k of Object.keys(c) as (keyof Changes)[]) (back as Record<string, unknown>)[k] = prev[k] ?? null; // none: 1 day
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
/** Sets how many days a task lasts (1: just its due date). */
export const setDuration = (id: string, days: number) => {
  const t = S().tasks[id];
  if (!t || (t.durationDays ?? 1) === days) return;
  void patchTask(id, { durationDays: days > 1 ? days : null }, { toast: days > 1 ? `Lasts ${daysLabel(days)}: overdue after ${fmt(addDays(t.dueDate, days - 1))}` : 'Lasts 1 day' });
};

/** Sets a task's effort (stored form, or null), and marks it done too when `thenDone`. */
export const setEffort = (id: string, effort: string | null, thenDone = false) => {
  const t = S().tasks[id];
  if (!t) return;
  void patchTask(id, thenDone ? { effort, status: 'done' } : { effort },
    { toast: thenDone ? `Done: ${t.title}` : effort ? `Effort: ${storedEffortLabel(effort)}` : 'Effort cleared' });
};
export const transfer = (id: string, to: string, note?: string, thisOnly?: boolean) =>
  patchTask(id, { assigneeId: to }, { note, thisOnly, toast: `Transferred to ${firstName(S().users[to])}${thisOnly ? ' (just this one)' : ''}` });

/** Repeating tasks: change the rule (a Repeat), or stop repeating for good (null). Not optimistic: the server decides dates. */
export async function setRepeat(id: string, rule: Repeat | null) {
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await clientFor(id).patch<{ task: Task }>('', { repeat: rule });
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
  const t = S().tasks[id];
  if (!t) return;
  pending.add(id);
  mine.set(id, Date.now());
  try {
    const { task } = await clientFor(id).patch<{ task: Task }>('', { skip: true });
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
export const setProject = (id: string, p: string) => patchTask(id, { projectId: p }, { toast: `Moved to ${S().projects[p]?.name}` });

export async function moveTasks(ids: string[], dueDate: string) {
  const s = S();
  const prevs = ids.map((i) => s.tasks[liveId(i)]).filter((t): t is Task => !!t && t.dueDate !== dueDate);
  if (!prevs.length) return;
  prevs.forEach((t) => { putTask({ ...t, dueDate }); pending.add(t.id); mine.set(t.id, Date.now()); });
  flash(prevs.map((t) => t.id));
  const base = prevs.length > 1 ? `Moved ${prevs.length} tasks to ${rel(dueDate, s.today)}` : `Moved to ${rel(dueDate, s.today)}`;
  const undoMove = () => {
    set({ toast: null });
    prevs.forEach((t) => void patchTask(t.id, { dueDate: t.dueDate }, { restore: true }));
  };
  // Dependencies: tasks waiting on these that are now due before them can be moved too (never by themselves).
  const after = S();
  const moved = new Set(prevs.map((t) => t.id));
  const target = expectedOn(dueDate, after.today);
  const heldIds = [...new Set(prevs.flatMap((t) => linksOf(after, t, 'blocks'))
    .filter((l) => l.open && !moved.has(l.id) && after.tasks[l.id] && after.tasks[l.id].dueDate < target).map((l) => l.id))];
  // And moving a waiting task before what it waits on: say so.
  const one = prevs.length === 1 ? after.tasks[prevs[0].id] : null;
  const waits = one ? linksOf(after, one, 'blockedBy').filter((l) => l.open && expectedOn(l.dueDate, after.today) > target) : [];
  if (heldIds.length) {
    const n = heldIds.length;
    const first = after.tasks[heldIds[0]];
    const it = prevs.length > 1 ? 'them' : 'it';
    toast(`${base} · ${n > 1 ? `${n} tasks due earlier wait on ${it}` : `“${first.title}” waits on ${it}`}`,
      undoMove, false, { label: n > 1 ? `Move ${n} too` : 'Move it too', run: () => { set({ toast: null }); void moveTasks(heldIds, dueDate); } });
  } else if (waits.length) {
    const latest = waits.reduce((a, b) => (expectedOn(b.dueDate, after.today) > expectedOn(a.dueDate, after.today) ? b : a));
    const bt = after.tasks[latest.id];
    toast(`${base} · it waits on ${bt ? `“${bt.title}”` : 'a task'}, due ${rel(expectedOn(latest.dueDate, after.today), after.today)}`, undoMove);
  } else toast(base, undoMove);
  try {
    if (prevs.length === 1) {
      const { task } = await clientFor(prevs[0].id).patch<{ task: Task }>('', { dueDate });
      putTask(task);
    } else {
      // Each instance moves its own (this one's in one go; others' through their /v1).
      const real = await Promise.all(prevs.map((t) => realId(t.id))); // some may still be being added
      const here = real.filter((i) => !isFeed(i)), there = real.filter((i) => isFeed(i));
      const moved = await Promise.all([
        here.length ? api.post<{ tasks: Task[] }>('/api/tasks/move', { ids: here, dueDate }).then((r) => r.tasks) : [],
        there.length ? moveOnSources(there, dueDate) : [],
      ]);
      moved.flat().forEach(putTask);
    }
  } catch (e) {
    prevs.forEach(putTask);
    toastError(e);
  } finally {
    prevs.forEach((t) => pending.delete(t.id));
  }
}

/** Fields that edits made while a task was being added can change (kept when its real copy arrives). */
const LOCAL_KEYS = ['title', 'notes', 'projectId', 'assigneeId', 'assignedBy', 'dueDate', 'durationDays', 'priority', 'status', 'doneAt', 'doneOn', 'doneBy',
  'effort', 'checklist', 'followers', 'attachments', 'blockedBy', 'blocks', 'comments'] as const satisfies readonly (keyof Task)[];

/**
 * Adds the draft as a task. It shows at once (under a temporary id) and the box clears; the server makes it in the
 * background. If that fails, the task goes away again and the draft comes back.
 */
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
  const picked = d.dueDate || defaultDraftDate(s);
  const rule = d.repeat ?? null;
  const due = rule ? firstDate(rule, picked) : picked;
  const durationDays = d.durationDays && d.durationDays > 1 ? d.durationDays : null;
  const me = s.me!.id;
  const notes = d.notes.trim();
  // On another instance's project the task is made there (src/sources.ts), so its id is in that instance's form.
  const tmp = newTemp(isFeed(projectId) ? nsId(feedParts(projectId).src, '') : '');
  const now = nowIso();
  const shown: Task = {
    id: tmp.id, title, notes, projectId, assigneeId, createdBy: me, assignedBy: me, dueDate: due, durationDays, priority, status: 'open',
    doneAt: null, doneOn: null, doneBy: null, createdAt: now, updatedAt: now, version: 0,
    series: rule ? { id: tmp.id, rule, anchor: due, active: true, made: 1, assigneeId, title } : null,
    comments: 0, checklist: [], attachments: [], archivedAt: null, archivedBy: null,
    followers: [me], effort: null, blockedBy: [], blocks: [],
  };
  creating++;
  mine.set(tmp.id, Date.now());
  localStorage.setItem('tv:lastProject', projectId);
  set((st) => ({ tasks: { ...st.tasks, [tmp.id]: shown }, events: { ...st.events, [tmp.id]: [] }, draft: { ...emptyDraft(projectId), open: true } }));
  flash([tmp.id]);
  toast(`Added for ${assigneeId === me ? 'you' : firstName(s.users[assigneeId])} · ${rel(due, s.today)}${rule ? ` · ${lowerFirst(describe(rule, due))}` : ''}`);
  void (async () => {
    try {
      const body = { title, notes, projectId, assigneeId, dueDate: picked, durationDays: durationDays ?? undefined, priority, repeat: rule ?? undefined };
      const { task } = isFeed(projectId)
        ? await srcCall<{ task: Task }>(feedParts(projectId).src, 'POST', '/tasks', body)
        : await api.post<{ task: Task }>('/api/tasks', body);
      mine.set(task.id, Date.now());
      held.delete(task.id);
      // Swap in the real task, keeping anything changed on it meanwhile (those edits are on their way too).
      set((st) => {
        const tasks = { ...st.tasks };
        const cur = tasks[tmp.id];
        delete tasks[tmp.id];
        if (cur) {
          const merged: Task = { ...task };
          for (const k of LOCAL_KEYS) if (cur[k] !== shown[k]) (merged as unknown as Record<string, unknown>)[k] = cur[k];
          tasks[task.id] = merged;
        } // gone meanwhile: archived (that's on its way too)
        const events = { ...st.events };
        delete events[tmp.id];
        const swap = (x: string) => (x === tmp.id ? task.id : x);
        const pop = st.pop && (st.pop.id === tmp.id || st.pop.ids?.includes(tmp.id)) ? { ...st.pop, id: st.pop.id && swap(st.pop.id), ids: st.pop.ids?.map(swap) } : st.pop;
        return { tasks, events, drawer: st.drawer && swap(st.drawer), pop };
      });
      tmp.done(task.id);
    } catch (e) {
      tmp.fail(e);
      set((st) => {
        const tasks = { ...st.tasks };
        delete tasks[tmp.id];
        // Give the words back, unless something else is being typed already.
        const back = !st.draft.title.trim() && !st.draft.notes.trim();
        return { tasks, drawer: st.drawer === tmp.id ? null : st.drawer, ...(back ? { draft: { ...d, open: true } } : {}) };
      });
      toast(`“${title}” wasn't added. ${e instanceof Error ? e.message : 'Something went wrong.'}`, undefined, true);
    } finally {
      if (--creating === 0 && held.size) {
        // Tasks sync held back that weren't the ones being added (made in another tab, say).
        const extra = [...held.values()];
        held.clear();
        set((st) => ({ tasks: { ...st.tasks, ...Object.fromEntries(extra.filter((t) => !st.tasks[t.id]).map((t) => [t.id, t])) } }));
      }
    }
  })();
  return true;
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
      const { task } = await clientFor(id).get<{ task: Task }>();
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

let focusReturn: string | null = null;
/** Focus mode: everything but my tasks for today goes away until I leave it (Esc, ⇧F, Exit or Back). It's ?focus in the URL. */
export function enterFocus() {
  if (S().focusMode) return;
  focusReturn = activeSelector();
  set({ focusMode: true, pop: null, help: false });
  focusLater('.focus [data-nav]');
}
export function exitFocus() {
  set({ focusMode: false, pop: null });
  focusLater(focusReturn ?? '[data-act="focus"]');
  focusReturn = null;
}

/** The People & projects page's tab. */
export function setManageTab(tab: ManageTab) {
  set({ manageTab: tab });
}
export function setPage(page: Page) {
  const s = S();
  if ((page === 'team' || page === 'settings') && s.me?.role !== 'admin') return;
  set({ page, drawer: null, pop: null, invite: null, projDay: s.projDay || s.today });
}
export function viewPerson(userId: string) {
  set({ viewUser: userId, page: 'tasks', drawer: null, pop: null, draft: { ...S().draft, assigneeId: null } });
}
/** Home: your own week (the logo and G T). */
export const goHome = () => viewPerson(S().me!.id);
/** A project's view (or 'all'), keeping the same Today / Week / Board choice. Remembered, for G P and the next visit. */
export function viewProject(projectId: string) {
  const s = S();
  set({ projSel: projectId, page: 'projects', drawer: null, pop: null, projDay: s.projDay || s.today });
  localStorage.setItem('tv:proj', projectId);
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
    return;
  }
  const projSel = !m.people.length && m.projects.length <= 1 ? (m.projects[0] ?? 'all') : 'multi';
  set({ ...common, projSel, page: 'projects', ...(projSel === 'multi' ? { multi: m } : {}) });
  localStorage.setItem('tv:proj', projSel);
  if (projSel === 'multi') localStorage.setItem('tv:multi', JSON.stringify(m));
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

/** "sign in with Google or Microsoft", or plain "sign in". */
export const signInHow = (via: string[]) =>
  via.length ? `sign in with ${via.length > 1 ? `${via.slice(0, -1).join(', ')} or ${via[via.length - 1]}` : via[0]}` : 'sign in';
/** The sign-in page people are invited to. */
export const inviteLink = () => `${location.origin}/login`;
const copyLinkAction = { label: 'Copy link', run: () => void copyInviteLink() };
export async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(inviteLink());
    toast(`Sign-in link copied. They ${signInHow(S().signInWith)} using the address you added.`);
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
    // Was connected, but it no longer works (expired, revoked, a send error): say so, and offer the link.
    void refreshMailbox();
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

// ---------- the mailbox invite emails go out from (Gmail or Outlook) ----------
/** The two providers, as admins see them. */
export const MAILBOX: Record<MailboxVia, { name: string; company: string }> = {
  gmail: { name: 'Gmail', company: 'Google' },
  outlook: { name: 'Outlook', company: 'Microsoft' },
};
async function refreshMailbox() {
  const b = await api.get<Bootstrap>('/api/bootstrap').catch(() => null);
  if (b) set({ mailbox: b.mailbox, mailboxOptions: b.mailboxOptions ?? [] });
}
/** Leaves the app for the provider's consent screen; comes back to `back` with ?mailbox=<result>&via=<via>. */
export function connectMailbox(via: MailboxVia, back = location.pathname) {
  location.href = `/auth/${via}?next=${encodeURIComponent(back)}`;
}
export async function disconnectMailbox() {
  const name = MAILBOX[S().mailbox?.via ?? 'gmail'].name;
  try {
    await api.del('/api/admin/mailbox');
    set({ mailbox: null });
    toast(`${name} disconnected. Invites won't be emailed until you connect a mailbox again.`);
  } catch (e) {
    toastError(e);
  }
}
const MAILBOX_RESULTS: Record<string, (m: { name: string; company: string }) => [string, boolean]> = {
  connected: (m) => [`${m.name} connected. Invites will be emailed from your address.`, false],
  cancelled: (m) => [`${m.name} wasn't connected.`, false],
  no_permission: (m) => [`${m.name} wasn't connected: the permission to send email as you wasn't allowed.`, true],
  wrong_account: (m) => [`Choose the ${m.company} account you sign in to Taskivities with.`, true],
  unavailable: (m) => [`${m.company} sign-in isn't set up on this instance, so ${m.name} can't be connected.`, true],
  expired: (m) => [`That took too long. Try connecting ${m.name} again.`, true],
  failed: (m) => [`${m.company} didn't finish connecting ${m.name}. Try again.`, true],
  forbidden: (m) => [`Only admins can connect ${m.name}.`, true],
};
/** After coming back from Google or Microsoft: say what happened, and tidy the address bar. */
function mailboxReturn() {
  const q = new URLSearchParams(location.search);
  const r = q.get('mailbox');
  if (!r) return;
  const via = q.get('via') === 'outlook' ? 'outlook' : 'gmail';
  q.delete('mailbox');
  q.delete('via');
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  const [text, error] = (MAILBOX_RESULTS[r] ?? MAILBOX_RESULTS.failed)(MAILBOX[via]);
  toast(text, undefined, error);
}
const SIGNIN_RESULTS: Record<string, string> = {
  ok: 'Signed in as {as}: it works, and it’s saved.',
  cancelled: 'The test sign-in was cancelled, so nothing was saved.',
  failed: 'The test sign-in didn’t work, so nothing was saved. Check the ID, the secret and the redirect URI.',
  unverified: 'That account’s email isn’t verified, so it can’t prove the settings work. Nothing was saved: try another account.',
  expired: 'The test took too long, so nothing was saved. Save and test again.',
  forbidden: 'Only admins can change how people sign in.',
};
const SIGNIN_NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft 365', workos: 'WorkOS' };

// ---------- back from testing new sign-in settings ----------
/** Back from a test sign-in (?signin=<provider>&result=…): say how it went, and tidy the address bar. */
function signinTestReturn() {
  const q = new URLSearchParams(location.search);
  const provider = q.get('signin');
  if (!provider) return;
  const result = q.get('result') ?? 'failed';
  const text = (SIGNIN_RESULTS[result] ?? SIGNIN_RESULTS.failed).replace('{as}', q.get('as') ?? 'you');
  for (const k of ['signin', 'result', 'as']) q.delete(k);
  history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}`);
  toast(`${SIGNIN_NAMES[provider] ?? 'Sign-in'}: ${text}`, undefined, result !== 'ok');
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
/** On another instance's project: its people on that project, and me if I am (as I am there). */
function sourcePeople(s: State, projectId: string): User[] {
  const src = projectId.split('~')[1];
  const meThere = s.feedDir.me[src];
  const them = Object.values(s.users).filter((u) => u.id.startsWith(`f~${src}~`) && u.status !== 'disabled' && onProject(u, projectId));
  return meThere && onProject(meThere, projectId) ? [s.me!, ...them] : them;
}
export const assignable = (s: State, projectId: string): User[] =>
  isFeed(projectId) ? sourcePeople(s, projectId) : localUsers(s).filter((u) => u.status !== 'disabled' && onProject(u, projectId));
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
// ---------- dependencies ----------
/**
 * Links two tasks, or unlinks them. side 'blockedBy': `taskId` waits on `otherId`; 'blocks': `otherId` waits on `taskId`.
 * Both tasks come back from the server (the other one only if I can see it).
 */
export async function setBlocker(taskId: string, otherId: string, side: 'blockedBy' | 'blocks', add: boolean, quiet = false) {
  const [waiter, blocker] = (side === 'blockedBy' ? [taskId, otherId] : [otherId, taskId]).map(liveId);
  const s = S();
  const wt = s.tasks[waiter], bt = s.tasks[blocker];
  [waiter, blocker].forEach((id) => { pending.add(id); mine.set(id, Date.now()); });
  // Show the link (or its removal) at once; the server's answer fills in the rest.
  const link = (t: Task): TaskLink => ({ id: t.id, open: t.status !== 'done', dueDate: t.dueDate });
  set((st) => {
    const tasks = { ...st.tasks };
    const w = tasks[waiter], b = tasks[blocker];
    if (w) tasks[waiter] = { ...w, blockedBy: add ? (w.blockedBy.some((l) => l.id === blocker) || !b ? w.blockedBy : [...w.blockedBy, link(b)]) : w.blockedBy.filter((l) => l.id !== blocker) };
    if (b) tasks[blocker] = { ...b, blocks: add ? (b.blocks.some((l) => l.id === waiter) || !w ? b.blocks : [...b.blocks, link(w)]) : b.blocks.filter((l) => l.id !== waiter) };
    return { tasks };
  });
  flash([waiter, blocker]);
  if (!quiet) {
    const w = wt ? `“${wt.title}”` : 'That task', b = bt ? `“${bt.title}”` : 'a task you can’t see';
    toast(add ? `${w} now waits on ${b}` : `${w} no longer waits on ${b}`, () => { set({ toast: null }); void setBlocker(taskId, otherId, side, !add, true); });
  }
  try {
    const [rw, rb] = await Promise.all([realId(waiter), realId(blocker)]); // either may still be being added
    const r = add
      ? await clientFor(rw).post<{ task: Task; tasks: Task[] }>('/blockers', { blockerId: rb })
      : await clientFor(rw).del<{ task: Task; tasks: Task[] }>(`/blockers/${encodeURIComponent(isFeed(rb) ? feedParts(rb).rid : rb)}`);
    putTask(r.task);
    (r.tasks ?? []).forEach(putTask);
    return true;
  } catch (e) {
    [wt, bt].forEach((t) => t && putTask(t));
    toastError(e);
    return false;
  } finally {
    [waiter, blocker].forEach((id) => pending.delete(id));
  }
}

async function openCreated(taskId: string) {
  await sync();
  if (S().tasks[taskId]) openDrawer(taskId);
}

// ---------- comments ----------
/** Posts a comment. It shows in the history at once; returns false if it couldn't be saved (so the box can get it back). */
export async function addComment(taskId: string, text: string): Promise<boolean> {
  const id = liveId(taskId);
  const prev = S().tasks[id];
  const me = S().me!.id;
  if (!prev) return false;
  pending.add(id);
  mine.set(id, Date.now());
  const ev: TaskEvent = { id: `tmp-${crypto.randomUUID()}`, taskId: id, actorId: me, via: null, type: 'comment', fromValue: null, toValue: null, note: text.trim(), at: nowIso() };
  set((s) => ({
    tasks: { ...s.tasks, [id]: { ...prev, comments: prev.comments + 1, followers: prev.followers.includes(me) ? prev.followers : [...prev.followers, me] } },
    events: s.events[id] ? { ...s.events, [id]: [...s.events[id]!, ev] } : s.events,
  }));
  try {
    const { task } = await clientFor(id).post<{ task: Task }>('/comments', { text });
    putTask(task); // drops the cached history, so the drawer reloads it with the saved comment
    return true;
  } catch (e) {
    putTask(prev);
    toastError(e);
    return false;
  } finally {
    pending.delete(id);
  }
}

/** Follow or stop following a task: me, or (`userId`) someone else on its project. */
export async function setFollowing(taskId: string, follow: boolean, userId?: string) {
  const id = liveId(taskId);
  const prev = S().tasks[id];
  if (!prev) return;
  const me = S().me!.id;
  const who = userId ?? me;
  if (!follow && who === prev.assigneeId) return;
  pending.add(id);
  mine.set(id, Date.now());
  const followers = follow ? [...new Set([...prev.followers, who])] : prev.followers.filter((f) => f !== who);
  set((s) => ({ tasks: { ...s.tasks, [id]: { ...prev, followers } } }));
  if (who === me) toast(follow ? `Following “${prev.title}”` : `Stopped following “${prev.title}”`, () => { set({ toast: null }); void setFollowing(id, !follow); });
  try {
    const { task } = await clientFor(id).post<{ task: Task }>('/follow', { follow, ...(who !== me ? { userId: who } : {}) });
    putTask(task);
  } catch (e) {
    putTask(prev);
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

// Checklist changes to one task are sent one after another (an item just added may be ticked before the server has
// given it its id). Each shows at once; the server's copy is put back only when the last one is answered.
const ckChain = new Map<string, Promise<unknown>>();
const ckLeft = new Map<string, number>();
const ckReal = new Map<string, string>(); // temporary item id → the server's
const itemRef = (itemId: string) => encodeURIComponent(ckReal.get(itemId) ?? itemId);

function checklistCall(taskId: string, call: (id: string) => Promise<{ task: Task }>, optimistic: (t: Task) => Task, answered?: (t: Task) => void): Promise<boolean> {
  const id = liveId(taskId);
  const before = S().tasks[id];
  if (!before) return Promise.resolve(false);
  pending.add(id);
  mine.set(id, Date.now());
  ckLeft.set(id, (ckLeft.get(id) ?? 0) + 1);
  set((s) => { const t = s.tasks[liveId(id)]; return t ? { tasks: { ...s.tasks, [t.id]: optimistic(t) } } : {}; });
  const run = (ckChain.get(id) ?? Promise.resolve()).then(async () => {
    const last = () => ckLeft.get(id) === 1;
    try {
      const { task } = await call(id);
      answered?.(task);
      if (last()) putTask(task); // otherwise later changes are still on their way: keep showing them
      return true;
    } catch (e) {
      if (last()) putTask(before);
      toastError(e);
      return false;
    } finally {
      const n = (ckLeft.get(id) ?? 1) - 1;
      if (n) ckLeft.set(id, n);
      else { ckLeft.delete(id); ckChain.delete(id); pending.delete(id); }
    }
  });
  ckChain.set(id, run);
  return run;
}
/** Adds one item, or several (one per line, e.g. pasted). */
export const addChecklistItems = (id: string, text: string) => {
  // Split like the server does (worker/tasks.ts changeChecklist).
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]\s*)?(?:\[[ xX]?\]\s*)?/, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return Promise.resolve(false);
  const temps = lines.map(() => `tmp-${crypto.randomUUID()}`);
  return checklistCall(id, (rid) => clientFor(rid).post('/checklist', { text }),
    (t) => ({ ...t, checklist: [...t.checklist, ...lines.map((l, i) => ({ id: temps[i], text: l, done: false }))] }),
    // New items go at the end, in order.
    (t) => temps.forEach((x, i) => { const it = t.checklist[t.checklist.length - temps.length + i]; if (it) ckReal.set(x, it.id); }));
};
export const toggleChecklistItem = (id: string, itemId: string, done: boolean) =>
  checklistCall(id, (rid) => clientFor(rid).patch(`/checklist/${itemRef(itemId)}`, { done }),
    (t) => ({ ...t, checklist: t.checklist.map((c) => (c.id === itemId ? { ...c, done } : c)) }));
export const renameChecklistItem = (id: string, itemId: string, text: string) =>
  checklistCall(id, (rid) => clientFor(rid).patch(`/checklist/${itemRef(itemId)}`, { text }),
    (t) => ({ ...t, checklist: t.checklist.map((c) => (c.id === itemId ? { ...c, text } : c)) }));
export const removeChecklistItem = (id: string, itemId: string) =>
  checklistCall(id, (rid) => clientFor(rid).del(`/checklist/${itemRef(itemId)}`),
    (t) => ({ ...t, checklist: t.checklist.filter((c) => c.id !== itemId) }));

// ---------- attachments ----------
export const attachmentUrl = (taskId: string, id: string, download = false) => `/api/tasks/${taskId}/attachments/${id}${download ? '?download' : ''}`;

/** Uploads files to a task, one after another, with progress. Uses XHR because fetch can't report upload progress. */
export async function uploadFiles(taskId: string, files: File[]) {
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
      const target = await uploadTarget(taskId); // this instance, or the task's own (with a token)
      const task = await new Promise<Task>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', target.url);
        for (const [k, v] of Object.entries(target.headers)) x.setRequestHeader(k, v);
        x.setRequestHeader('x-file-name', encodeURIComponent(name));
        x.setRequestHeader('content-type', f.type || 'application/octet-stream');
        x.upload.onprogress = (e) => patch({ loaded: e.loaded });
        x.onload = () => {
          let body: { task?: Task; error?: string } = {};
          try { body = JSON.parse(x.responseText); } catch { /* not JSON */ }
          if (x.status >= 200 && x.status < 300 && body.task) resolve(taskFromSource(taskId, body.task));
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

export async function removeAttachment(id: string, aid: string, name: string) {
  const taskId = liveId(id);
  const prev = S().tasks[taskId];
  if (!prev) return;
  pending.add(taskId);
  mine.set(taskId, Date.now());
  set((s) => ({ tasks: { ...s.tasks, [taskId]: { ...prev, attachments: prev.attachments.filter((a) => a.id !== aid) } } }));
  toast(`Removed ${name}`);
  try {
    const { task } = await clientFor(taskId).del<{ task: Task }>(`/attachments/${aid}`);
    putTask(task);
  } catch (e) {
    putTask(prev);
    toastError(e);
  } finally {
    pending.delete(taskId);
  }
}

/** "Attach files": a menu of where from (this device, drives that are set up, or a pasted link, which always works). */
export function attachMenu(id: string, anchor: HTMLElement | Pop['rect']) {
  const p = { type: 'attach' as const, mode: 'task' as const, id };
  if (anchor instanceof HTMLElement) openPop(p, anchor);
  else set({ pop: { ...p, rect: anchor, returnSel: `.drawer[data-id="${id}"]` } });
}

/** ⇧A: opens the task (if needed) and its file picker (or, without uploads here, the attach menu). */
export function pickAttachments(id: string) {
  const s = S();
  const wasOpen = s.drawer === id;
  if (!wasOpen) openDrawer(id);
  // The picker input is in the drawer; give it a moment to render when the drawer was just opened.
  setTimeout(() => {
    if (s.attachmentsOn) { document.querySelector<HTMLInputElement>('#attach-input')?.click(); return; }
    const a = document.querySelector<HTMLElement>('.drawer [data-act="attach"], .drawer .att-add');
    if (a) attachMenu(id, a);
  }, wasOpen ? 0 : 60);
}

/** Attaches a pasted link (never fetched; its sharing decides who can open it). False if it didn't work. */
export async function attachLink(id: string, url: string, name: string) {
  const taskId = liveId(id);
  pending.add(taskId);
  mine.set(taskId, Date.now());
  try {
    const { task } = await clientFor(taskId).post<{ task: Task }>('/attachments/link', { url, ...(name.trim() ? { name: name.trim() } : {}) });
    putTask(task);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  } finally {
    pending.delete(taskId);
  }
}

/**
 * Picks files from Google Drive or OneDrive and attaches copies (stored here) or links. Call it straight from a click:
 * the provider's sign-in opens in a popup.
 */
export async function attachFromDrive(id: string, provider: CloudProvider, mode: 'copy' | 'link') {
  const where = provider === 'google' ? 'Google Drive' : 'OneDrive';
  let picked;
  try {
    picked = await pickFiles(S().cloud, provider, S().me?.email);
  } catch (e) {
    if (!(e instanceof PickCancelled)) toastError(e);
    return;
  }
  if (!picked.files.length) return;
  const taskId = liveId(id);
  const ups = picked.files.map((f) => ({ id: crypto.randomUUID(), taskId, name: f.name, loaded: 0, total: 0, note: mode === 'copy' ? `Copying from ${where}…` : 'Linking…' }));
  set((s) => ({ uploads: [...s.uploads, ...ups] }));
  pending.add(taskId);
  mine.set(taskId, Date.now());
  try {
    const { task } = await clientFor(taskId).post<{ task: Task }>('/attachments/cloud', {
      provider, mode, token: picked.token, files: picked.files.map((f) => ({ id: f.id, ...(f.driveId ? { driveId: f.driveId } : {}) })),
    });
    putTask(task);
  } catch (e) {
    toastError(e);
    // Some may have made it before one failed: show what's there now.
    void clientFor(taskId).get<{ task: Task }>().then((r) => putTask(r.task)).catch(() => undefined);
  } finally {
    pending.delete(taskId);
    const gone = new Set<string>(ups.map((u) => u.id));
    set((s) => ({ uploads: s.uploads.filter((u) => !gone.has(u.id)) }));
  }
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
export async function archiveTask(taskId: string) {
  const id = liveId(taskId);
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
  toast(`Archived “${t.title}”`, () => { set({ toast: null }); void restoreTask(id, t); });
  try {
    await clientFor(id).post('/archive');
    if (S().archived) void loadArchived(S().archived!.project);
  } catch (e) {
    putTask(t);
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

/** Brings an archived task back (from the project's Archived section, or Undo with the task as it was). */
export async function restoreTask(taskId: string, was?: Task) {
  const id = liveId(taskId);
  const arch = S().archived;
  const t = was ?? arch?.tasks.find((x) => x.id === id);
  pending.add(id);
  mine.set(id, Date.now());
  if (t) {
    set((s) => ({
      tasks: { ...s.tasks, [id]: { ...t, id, archivedAt: null, archivedBy: null } },
      ...(s.archived ? { archived: { ...s.archived, tasks: s.archived.tasks.filter((x) => x.id !== id) } } : {}),
    }));
    flash([id]);
    if (!was) toast(`Restored “${t.title}”`, undefined, false, { label: 'Open', run: () => openDrawer(id) });
  }
  try {
    const { task } = await clientFor(id).post<{ task: Task }>('/restore');
    putTask(task);
    set((s) => (s.archived ? { archived: { ...s.archived, tasks: s.archived.tasks.filter((x) => x.id !== id) } } : {}));
    if (!t) toast(`Restored “${task.title}”`, undefined, false, { label: 'Open', run: () => openDrawer(id) });
  } catch (e) {
    // Back to the Archived section.
    set((s) => {
      const tasks = { ...s.tasks };
      delete tasks[id];
      const back = arch && t && s.archived?.project === arch.project && !s.archived.tasks.some((x) => x.id === id);
      return { tasks, ...(back ? { archived: { ...s.archived!, tasks: [...s.archived!.tasks, t] } } : {}) };
    });
    toastError(e);
  } finally {
    pending.delete(id);
  }
}

/** A project view's Archived section ('all' = every project you can see). */
export async function loadArchived(project: string) {
  try {
    const { tasks } = isFeed(project)
      ? await srcCall<{ tasks: Task[] }>(feedParts(project).src, 'GET', `/archived?project=${encodeURIComponent(feedParts(project).rid)}`)
      : await api.get<{ tasks: Task[] }>(`/api/archived?project=${encodeURIComponent(project)}`);
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
