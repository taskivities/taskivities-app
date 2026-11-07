// Other instances: the tasks you have on other Taskivities instances, shown with your own (worker/feed.ts).
//
// Their tasks, projects and people live in the same store as this instance's, under ids that can't clash:
// "f~<feed>~<their id>". Your own account there becomes you here, so their tasks are simply yours: My day, My week,
// the Board, Copy. Their projects and people carry `feed`, so this instance's lists (the switcher, menus, People &
// projects) leave them out; see localProjects / localUsers.
//
// Requests about one of their tasks go through forTask(id), which sends them via this instance (/api/feeds/…) and
// turns the answer's ids back into ours.
import type { AccessTokenInfo, FeedInfo, FeedPerson, FeedTasks, Project, Task, TaskEvent, User } from '../shared/types';
import { api } from './api';
import { S, set, type State } from './store';

const SEP = '~';
export const isFeed = (id: string | null | undefined) => !!id && id.startsWith(`f${SEP}`);
const fid = (feed: string, id: string) => `f${SEP}${feed}${SEP}${id}`;
/** "f~<feed>~<their id>" → its parts. */
export const feedParts = (id: string) => { const [, feed, ...rest] = id.split(SEP); return { feed, rid: rest.join(SEP) }; };
export const feedOf = (s: State, id: string) => (isFeed(id) ? s.feeds.find((f) => f.id === feedParts(id).feed) ?? null : null);
/** Opens one of their tasks on its own instance. */
export const feedTaskUrl = (f: FeedInfo, id: string) => `${f.url}/?task=${encodeURIComponent(feedParts(id).rid)}`;

/** This instance's own projects and people, without other instances'. */
export const localProjects = (s: State): Project[] => Object.values(s.projects).filter((p) => !p.feed);
export const localUsers = (s: State): User[] => Object.values(s.users).filter((u) => !u.feed);

// ---------- their ids ↔ ours ----------
interface Ctx { feed: string; theirMe: string; me: string }
const u = (c: Ctx, id: string | null) => (id === null ? null : id === c.theirMe ? c.me : fid(c.feed, id));
const ctxFor = (feed: string): Ctx | null => {
  const s = S();
  const m = s.feedDir.users[`me${SEP}${feed}`];
  return m && s.me ? { feed, theirMe: m.id, me: s.me.id } : null;
};
function taskIn(c: Ctx, t: Task): Task {
  return {
    ...t,
    id: fid(c.feed, t.id), projectId: fid(c.feed, t.projectId),
    assigneeId: u(c, t.assigneeId)!, createdBy: u(c, t.createdBy)!, assignedBy: u(c, t.assignedBy)!, doneBy: u(c, t.doneBy),
    archivedBy: u(c, t.archivedBy), followers: t.followers.map((x) => u(c, x)!),
    series: t.series ? { ...t.series, assigneeId: u(c, t.series.assigneeId)! } : null,
  };
}
function eventIn(c: Ctx, e: TaskEvent): TaskEvent {
  const ids = e.type === 'transferred' || e.type === 'follower_added' || e.type === 'follower_removed';
  return {
    ...e, id: fid(c.feed, e.id), taskId: fid(c.feed, e.taskId), actorId: u(c, e.actorId)!,
    fromValue: ids ? u(c, e.fromValue) : e.type === 'project_changed' && e.fromValue ? fid(c.feed, e.fromValue) : e.fromValue,
    toValue: ids ? u(c, e.toValue) : e.type === 'project_changed' && e.toValue ? fid(c.feed, e.toValue) : e.toValue,
  };
}
/** An answer about one of their tasks, with our ids. */
function answerIn<T>(feed: string, r: T): T {
  const c = ctxFor(feed);
  if (!c || !r || typeof r !== 'object') return r;
  const o = r as { task?: Task; next?: Task | null; events?: TaskEvent[] };
  return {
    ...r,
    ...(o.task ? { task: taskIn(c, o.task) } : {}),
    ...(o.next ? { next: taskIn(c, o.next) } : {}),
    ...(o.events ? { events: o.events.map((e) => eventIn(c, e)) } : {}),
  };
}

/** Requests about a task, wherever it lives: /api/tasks/<id>… here, or via this instance to its own. */
export function forTask(id: string) {
  const call = async <T>(method: 'get' | 'post' | 'patch' | 'del', rest: string, body?: unknown): Promise<T> => {
    if (!isFeed(id)) return method === 'get' || method === 'del' ? api[method]<T>(`/api/tasks/${id}${rest}`) : api[method]<T>(`/api/tasks/${id}${rest}`, body);
    const { feed, rid } = feedParts(id);
    const url = `/api/feeds/${feed}/tasks/${encodeURIComponent(rid)}${rest}`;
    const r = method === 'get' || method === 'del' ? await api[method]<T>(url) : await api[method]<T>(url, body);
    return answerIn(feed, r);
  };
  return {
    get: <T>(rest = '') => call<T>('get', rest),
    post: <T>(rest: string, body?: unknown) => call<T>('post', rest, body ?? {}),
    patch: <T>(rest: string, body: unknown) => call<T>('patch', rest, body),
    del: <T>(rest: string) => call<T>('del', rest),
  };
}

// ---------- loading ----------
const asUser = (feed: string, p: FeedPerson, name: string): User => ({
  id: fid(feed, p.id), email: p.email, name: p.name, avatarUrl: null, color: p.color, role: 'member', status: 'active',
  projects: [], addedAt: '', timeZone: null, disabledAt: null, disabledBy: null, feed: name,
});

/** Puts other instances' projects and people next to ours (again: loading this instance's directory replaces them). */
export function applyFeedDir() {
  set((s) => {
    const users = Object.fromEntries(Object.entries(s.users).filter(([, x]) => !x.feed));
    const projects = Object.fromEntries(Object.entries(s.projects).filter(([, x]) => !x.feed));
    const fu = Object.fromEntries(Object.entries(s.feedDir.users).filter(([k]) => !k.startsWith(`me${SEP}`)));
    return { users: { ...users, ...fu }, projects: { ...projects, ...s.feedDir.projects } };
  });
}

let loading: Promise<void> | null = null;
let lastLoad = 0;
/** Fetches my tasks from every connected instance, for the days this window has loaded (at most every 45 s unless forced). */
export function loadFeeds(force = false): Promise<void> {
  const s = S();
  if (!s.me || !s.range) return Promise.resolve();
  if (!force && (loading || Date.now() - lastLoad < 45_000)) return loading ?? Promise.resolve();
  loading = (async () => {
    try {
      const { range } = S();
      const r = await api.get<{ feeds: { feed: FeedInfo; data: FeedTasks | null }[] }>(`/api/feeds/tasks?from=${range!.from}&to=${range!.to}`);
      lastLoad = Date.now();
      const st = S();
      const dirUsers: Record<string, User> = {};
      const dirProjects: Record<string, Project> = {};
      const fresh: Record<string, Task> = {};
      const okFeeds = new Set<string>();
      for (const { feed, data } of r.feeds) {
        if (!data) {
          // Unreachable for now: keep what we had from it.
          for (const [k, v] of Object.entries(st.feedDir.users)) if (k === `me${SEP}${feed.id}` || k.startsWith(`f${SEP}${feed.id}${SEP}`)) dirUsers[k] = v;
          for (const [k, v] of Object.entries(st.feedDir.projects)) if (k.startsWith(`f${SEP}${feed.id}${SEP}`)) dirProjects[k] = v;
          continue;
        }
        okFeeds.add(feed.id);
        dirUsers[`me${SEP}${feed.id}`] = { ...asUser(feed.id, data.me, feed.name), id: data.me.id };
        for (const p of data.users) if (p.id !== data.me.id) dirUsers[fid(feed.id, p.id)] = asUser(feed.id, p, feed.name);
        for (const p of data.projects) dirProjects[fid(feed.id, p.id)] = { ...p, id: fid(feed.id, p.id), name: `${feed.name} · ${p.name}`, feed: feed.name };
        const c: Ctx = { feed: feed.id, theirMe: data.me.id, me: st.me!.id };
        for (const t of data.tasks) { const m = taskIn(c, t); fresh[m.id] = m; }
      }
      set((x) => {
        // Replace the tasks of every instance that answered; keep the rest (and anything being edited right now).
        const kept = Object.fromEntries(Object.entries(x.tasks).filter(([id]) => !isFeed(id) || !okFeeds.has(feedParts(id).feed)));
        return { feeds: r.feeds.map((f) => f.feed), feedDir: { users: dirUsers, projects: dirProjects }, tasks: { ...kept, ...fresh } };
      });
      applyFeedDir();
    } catch {
      // Connecting other instances is extra: never get in the way of this one.
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ---------- managing connections and tokens (the "Other instances" sheet) ----------
export const listFeeds = () => api.get<{ feeds: FeedInfo[] }>('/api/feeds').then((r) => r.feeds);
export async function addFeed(url: string, token: string): Promise<FeedInfo> {
  const { feed } = await api.post<{ feed: FeedInfo }>('/api/feeds', { url, token });
  await loadFeeds(true);
  return feed;
}
export async function removeFeed(id: string) {
  await api.del(`/api/feeds/${id}`);
  set((s) => ({
    feeds: s.feeds.filter((f) => f.id !== id),
    tasks: Object.fromEntries(Object.entries(s.tasks).filter(([k]) => !(isFeed(k) && feedParts(k).feed === id))),
    feedDir: {
      users: Object.fromEntries(Object.entries(s.feedDir.users).filter(([k]) => k !== `me${SEP}${id}` && !k.startsWith(`f${SEP}${id}${SEP}`))),
      projects: Object.fromEntries(Object.entries(s.feedDir.projects).filter(([k]) => !k.startsWith(`f${SEP}${id}${SEP}`))),
    },
  }));
  applyFeedDir();
}
/** Asks another instance for access: the browser goes there to approve, then comes back (worker/feed.ts). */
export async function requestAccess(url: string) {
  const { go } = await api.post<{ go: string }>('/api/feeds/request', { url });
  location.href = go;
}
export const listTokens = () => api.get<{ tokens: AccessTokenInfo[] }>('/api/tokens').then((r) => r.tokens);
export const createToken = (name: string) => api.post<{ token: string; info: AccessTokenInfo }>('/api/tokens', { name });
export const revokeToken = (id: string) => api.del(`/api/tokens/${id}`);
