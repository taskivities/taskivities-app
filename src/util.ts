import { addDays, fmt, rel, weekStart, MONS } from '../shared/dates';
import { localProjects, localUsers } from './feeds';
import { isLate, onProject, shownOn } from '../shared/rules';
import { NORMAL, PRIORITIES, type Project, type Task, type User } from '../shared/types';
import { upcoming } from '../shared/repeat';
import type { State } from './store';

export const displayName = (u: User | undefined) => (!u ? 'Someone' : u.status === 'invited' || !u.name ? u.email || 'Someone' : u.name);
export const firstName = (u: User | undefined) => (!u ? 'Someone' : u.name ? u.name.split(' ')[0] : (u.email || 'Someone').split('@')[0]);

export const myProjects = (s: State): Project[] =>
  !s.me ? [] : localProjects(s).filter((p) => onProject(s.me!, p.id)).sort((a, b) => a.name.localeCompare(b.name));
export const people = (s: State): User[] =>
  localUsers(s).filter((u) => u.status !== 'disabled').sort((a, b) => displayName(a).localeCompare(displayName(b)));
/** Someone whose work I can see at least some of. */
export const sharesWith = (s: State, u: User) => myProjects(s).some((p) => onProject(u, p.id));

/** Quick-add defaults that respect access: a project I'm on, and an assignee who is on that project. */
export const draftEffective = (s: State) => {
  const mine = myProjects(s);
  const projectId = s.draft.projectId && s.projects[s.draft.projectId] && onProject(s.me!, s.draft.projectId) ? s.draft.projectId : mine[0]?.id ?? null;
  // A person's view adds for that person; a project's view adds for me.
  let assigneeId = s.draft.assigneeId || (s.page === 'tasks' ? s.viewUser : null) || s.me!.id;
  const a = s.users[assigneeId];
  if (!a || !projectId || !onProject(a, projectId) || a.status === 'disabled') assigneeId = s.me!.id;
  return { projectId, assigneeId };
};

export const sortRows = (arr: Task[]) =>
  arr.sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1) || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
export const byPrioThenOldest = (a: Task, b: Task) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate);

/** The days in view: a week, or on the Board as many weeks as it's set to show (starting with the week picked). */
export const weekInfo = (s: State) => {
  const ws = addDays(weekStart(s.today), s.weekOffset * 7);
  const weeks = s.view === 'board' ? s.boardWeeks : 1;
  const days = [...Array(7 * weeks)].map((_, i) => addDays(ws, i));
  const we = days[days.length - 1];
  const [a, b] = [ws, we].map((d) => new Date(d + 'T00:00'));
  const span = a.getMonth() === b.getMonth()
    ? `${MONS[a.getMonth()]} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`
    : `${MONS[a.getMonth()]} ${a.getDate()} – ${MONS[b.getMonth()]} ${b.getDate()}`;
  const range = weeks > 1 ? `${weeks} weeks · ${span}` : span;
  const o = s.weekOffset;
  const label = o === 0 ? 'This week' : o === 1 ? 'Next week' : o === -1 ? 'Last week' : o > 0 ? `In ${o} weeks` : `${-o} weeks ago`;
  return { ws, we, days, weeks, range, span, label };
};
export const inRange = (d: string, from: string, to: string) => d >= from && d <= to;

/** An upcoming copy of a repeating task: calculated from the rule for the week views, never saved. */
export interface Preview { task: Task; date: string }
/** Upcoming copies of `u`'s repeating tasks between `from` and `to`, after each open copy. */
export const previewsFor = (s: State, u: string, from: string, to: string) => previewsWhere(s, (t) => t.series!.assigneeId === u, from, to);

/** Upcoming copies of the repeating tasks that `keep` picks (e.g. one project's). */
export function previewsWhere(s: State, keep: (t: Task) => boolean, from: string, to: string): Preview[] {
  const out: Preview[] = [];
  for (const t of Object.values(s.tasks)) {
    if (t.status !== 'open' || !t.series?.active || !keep(t)) continue;
    for (const date of upcoming(t.series, shownOn(t, s.today), to)) if (date >= from) out.push({ task: t, date });
  }
  return out.sort((a, b) => a.task.priority - b.task.priority);
}

export const ariaFor = (t: Task, today: string) =>
  `${t.title}. ${t.priority !== NORMAL ? PRIORITIES[t.priority].name + ' priority. ' : ''}${t.status === 'done' ? 'Done. ' : ''}${
    isLate(t, today) ? lateDays(t, today) + ' days late. ' : ''}${t.status === 'done' ? '' : 'Due ' + rel(shownOn(t, today), today) + '.'}`;
export const lateDays = (t: Task, today: string) => Math.round((new Date(today + 'T00:00').getTime() - new Date(t.dueDate + 'T00:00').getTime()) / 864e5);

export const clockTime = (iso: string | null) => {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};
export const stamp = (iso: string, today: string) => {
  const d = new Date(iso);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${day === today ? 'Today' : `${MONS[d.getMonth()]} ${d.getDate()}`} · ${clockTime(iso)}`;
};

export { fmt, rel, isLate, shownOn };
