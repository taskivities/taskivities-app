import { useEffect } from 'react';
import { localProjects, localUsers } from '../feeds';
import { DOW, addDays, fmt, parseDate } from '../../shared/dates';
import { isAdmin, isLate } from '../../shared/rules';
import { PRIORITIES, type Task } from '../../shared/types';
import { type EffortType, effortFor, effortLabel, effortTotal } from '../../shared/effort';
import { ensureRange, loadArchived, openPop, restoreTask, toast } from '../actions';
import { QuickAdd } from '../components/QuickAdd';
import { TaskRow } from '../components/rows';
import { Avatar, I, ProjBadge } from '../components/ui';
import { set, useStore, type State } from '../store';
import { displayName, firstName, shownOn, byPrioThenOldest, inRange, previewsWhere, weekInfo } from '../util';
import { CopyDone, Day, ViewSeg, WeekBoard, WeekControls } from './TasksPage';
import { copyDone } from '../copyDone';

/** Names as a short list: "Priya", "Priya and Arjun", "Priya, Arjun and Tom", "Priya, Arjun and 3 more". */
const listNames = (xs: string[]) =>
  xs.length <= 1 ? xs.join('') : xs.length <= 3 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`;

/**
 * What a project view shows: one project, all of yours, or (the switcher's "Select several") the tasks of some people
 * in some projects. `project` is set when it's a single project (its settings apply: effort, the quick-add's project).
 */
export function projectView(s: State) {
  const all = isAdmin(s.me!) ? 'All projects' : 'All my projects';
  const seen = (t: Task) => !!s.projects[t.projectId] && !s.projects[t.projectId].feed; // this instance's projects only
  if (s.projSel === 'multi') {
    const projects = s.multi.projects.filter((id) => s.projects[id]);
    const people = s.multi.people.filter((id) => s.users[id]);
    const project = projects.length === 1 ? s.projects[projects[0]] : null;
    const who = listNames(people.map((id) => (id === s.me!.id ? 'Me' : firstName(s.users[id]))));
    const what = listNames(projects.map((id) => s.projects[id].name));
    // Effort totals when every project in view measures it the same way.
    const types = new Set((projects.length ? projects : localProjects(s).map((p) => p.id)).map((id) => s.projects[id]?.effort ?? null));
    return {
      key: 'multi', multi: true as const, people, projects, project, showProject: !project,
      name: (who && what ? `${who} in ${what}` : who || what) || all,
      effort: types.size === 1 ? [...types][0] : null,
      inP: (t: Task) => seen(t) && (!projects.length || projects.includes(t.projectId)) && (!people.length || people.includes(t.assigneeId)),
    };
  }
  const pid = s.projSel !== 'all' && s.projects[s.projSel] ? s.projSel : 'all';
  const project = pid === 'all' ? null : s.projects[pid];
  return {
    key: pid, multi: false as const, people: [] as string[], projects: project ? [pid] : [], project, showProject: !project,
    name: project ? project.name : all, effort: project?.effort ?? null,
    inP: (t: Task) => (project ? t.projectId === pid : seen(t)),
  };
}

export function projectDayData(s: State, inP: (t: Task) => boolean, day: string) {
  const all = Object.values(s.tasks);
  // Finished that day, by priority, then due date, then finish time.
  const done = all
    .filter((t) => inP(t) && t.status === 'done' && t.doneOn === day)
    .sort((a, b) => a.priority - b.priority || a.dueDate.localeCompare(b.dueDate) || (a.doneAt || '').localeCompare(b.doneAt || ''));
  const open = all
    .filter((t) => inP(t) && t.status === 'open' && (day === s.today ? shownOn(t, s.today) === s.today : t.dueDate === day))
    .sort(byPrioThenOldest);
  return { done, open };
}

export function ProjectsPage() {
  const s = useStore();
  const pv = projectView(s);
  const pid = pv.key;
  const day = s.projDay || s.today;
  const all = pv.showProject; // rows say which project each task is in
  const project = pv.project;
  const mode = s.view; // Today (this page's day report) · Week · Board, shared with people's views
  const w = weekInfo(s);
  useEffect(() => { if (mode === 'today') void ensureRange(day, day); else void ensureRange(w.ws, w.we); }, [mode, day, w.ws, w.we]);
  // New tasks from here go in this project (you can still pick another).
  useEffect(() => { if (project) set((st) => ({ draft: { ...st.draft, projectId: project.id } })); }, [project?.id]);

  const inP = pv.inP;
  const { done, open } = projectDayData(s, inP, day);
  const name = pv.name;
  // Effort (projects that all measure it the same way): the day's total, and each task's in the copied summary.
  const et = pv.effort;
  const doneEffort = et ? effortTotal(et, done.map((t) => t.effort)) : '';
  const effortOf = (t: Task) => { const v = et ? effortFor(t.effort, et) : null; return et && v ? ` · ${effortLabel(et, v)}` : ''; };
  const goDay = (n: number) => set({ projDay: n === 0 ? s.today : addDays(day, n) > s.today ? s.today : addDays(day, n) });

  const copy = async () => {
    const lines = [
      `${name}: done on ${fmt(day)} (${done.length}${doneEffort ? ` · ${doneEffort}` : ''})`,
      ...done.map((t) => `• ${t.priority !== 3 ? `[${PRIORITIES[t.priority].name}] ` : ''}${t.title}: ${displayName(s.users[t.assigneeId])}${all ? ` (${s.projects[t.projectId]?.name})` : ''}${effortOf(t)}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast(`Copied ${done.length} tasks as text`);
    } catch {
      toast('Copy failed. Select and copy manually.', undefined, true);
    }
  };

  return (
    <>
      <div className="phead">
        <button className="who" data-act="proj-pick" title={`${project?.description ? `${project.description}\n\n` : ''}Switch to another project or person  (P)`} onClick={(e) => openPop({ type: 'projpick' }, e.currentTarget)}>
          {pv.multi ? <MultiBadge s={s} people={pv.people} projects={pv.projects} /> : <ProjBadge project={project ?? 'all'} />}
          <span>
            <span className="h1">{name} {I.chev()}</span>
            <span className="sub">{mode === 'today' ? <>{done.length} done{doneEffort && ` · ${doneEffort}`}{open.length > 0 && ` · ${open.length} not finished`}</> : <WeekSub s={s} w={w} inP={inP} et={et} />}</span>
          </span>
        </button>
        <div className="weeknav">
          <ViewSeg s={s} />
          {mode !== 'today' ? <>
            <WeekControls s={s} w={w} />
            <CopyDone onClick={() => void copyDone(s, { title: name, span: w.span, tasks: Object.values(s.tasks).filter(inP), from: w.ws, to: w.we, who: true, project: all })} />
          </> : <>
          <button className="icon-btn" data-act="pday" data-dir="-1" title="Previous day  [" aria-label="Previous day" onClick={() => goDay(-1)}>{I.left()}</button>
          <div className="wk">
            <b>{day === s.today ? 'Today' : day === addDays(s.today, -1) ? 'Yesterday' : DOW[parseDate(day).getDay()]}</b>
            <span>{fmt(day)}</span>
          </div>
          <button className="icon-btn" data-act="pday" data-dir="1" title="Next day  ]" aria-label="Next day" disabled={day >= s.today} onClick={() => goDay(1)}>{I.right()}</button>
          <button className="btn-ghost" data-act="pday" data-dir="0" disabled={day === s.today} onClick={() => goDay(0)}>Today</button>
          <button className="btn-ghost" data-act="copy-day" disabled={!done.length} title="Copy a plain-text summary for chat or email" onClick={() => void copy()}>Copy summary</button>
          </>}
        </div>
      </div>
      {mode !== 'today' && <QuickAdd />}
      {mode === 'list' && <ProjectWeek s={s} w={w} pid={pid} name={name} inP={inP} all={all} />}
      {mode === 'board' && (
        <WeekBoard s={s} w={w} pool={Object.values(s.tasks).filter(inP)} side="by" hideProject={!all}
          previews={previewsWhere(s, inP, w.ws, w.we)} />
      )}
      {mode === 'today' && <>
      <section className="sec">
        <div className="sec-h"><h2>Done</h2><span className="cnt">by priority, then due date</span></div>
        {done.length
          ? <div className="card">{done.map((t) => <TaskRow key={t.id} t={t} ctx={all ? 'pdone-all' : 'pdone'} />)}</div>
          : <div className="empty-sec">Nothing was finished in {name} {day === s.today ? 'yet today' : `on ${fmt(day)}`}.</div>}
      </section>
      {open.length > 0 && (
        <section className="sec">
          <button className="collapsed" data-act="proj-open" data-nav="popen" tabIndex={-1} aria-expanded={s.projOpen} onClick={() => set({ projOpen: !s.projOpen })}>
            <span className="dn">Not finished</span> {day === s.today ? 'planned for today' : 'planned for this day'}
            <span className="sum">{open.length} task{open.length > 1 ? 's' : ''} {!s.projOpen && I.chev()}</span>
          </button>
          {s.projOpen && <div className="card" style={{ marginTop: 8 }}>{open.map((t) => <TaskRow key={t.id} t={t} ctx="popen" />)}</div>}
        </section>
      )}
      </>}
      {!pv.multi && <ArchivedSection s={s} pid={pid} all={all} />}
    </>
  );
}

/** "12 open this week · 3 carried over" for a project's week and board. */
function WeekSub({ s, w, inP, et }: { s: State; w: ReturnType<typeof weekInfo>; inP: (t: Task) => boolean; et: EffortType | null }) {
  const tasks = Object.values(s.tasks).filter(inP);
  const openTasks = tasks.filter((t) => t.status === 'open' && inRange(shownOn(t, s.today), w.ws, w.we));
  const span = w.weeks > 1 ? 'shown' : s.weekOffset === 0 ? 'this week' : 'that week';
  // Effort: what got done in these days, and for estimates (sizes, points) what's still planned.
  const doneE = et ? effortTotal(et, tasks.filter((t) => t.status === 'done' && t.doneOn && inRange(t.doneOn, w.ws, w.we)).map((t) => t.effort)) : '';
  const openE = et && et !== 'time' ? effortTotal(et, openTasks.map((t) => t.effort)) : '';
  return (
    <>
      {openTasks.length} open {span}
      {doneE && <> · <span title="Effort of tasks done in these days">{doneE} done</span></>}
      {openE && <> · <span title="Effort of open tasks in these days">{openE} planned</span></>}
    </>
  );
}

/** A project's week: every day, everyone's tasks in it (each row says whose it is). */
function ProjectWeek({ s, w, pid, name, inP, all }: {
  s: State; w: ReturnType<typeof weekInfo>; pid: string; name: string; inP: (t: Task) => boolean; all: boolean;
}) {
  const pool = Object.values(s.tasks).filter(inP);
  const carried = pool.filter((t) => isLate(t, s.today)).sort(byPrioThenOldest);
  const previews = previewsWhere(s, inP, w.ws, w.we);
  const openN = pool.filter((t) => t.status === 'open' && inRange(shownOn(t, s.today), w.ws, w.we)).length;
  return (
    <section className="sec">
      <div className="sec-h"><h2>{name}</h2><span className="cnt">{openN} open this week · everyone's tasks</span></div>
      {w.days.map((d) => (
        <Day key={d} s={s} d={d} k={`p:${pid}`} pool={pool} carried={carried} TD={false} ctx="proj" showProject={all}
          previews={previews.filter((x) => x.date === d)} />
      ))}
      <div className="empty-sec empty-week">Nothing in these days.</div>
    </section>
  );
}

/** Archived tasks of this project: collapsed by default; each can be restored (it reappears where it was). */
function ArchivedSection({ s, pid, all }: { s: State; pid: string; all: boolean }) {
  useEffect(() => { void loadArchived(pid); }, [pid]);
  const list = s.archived?.project === pid ? s.archived.tasks : null;
  if (!list?.length) return null;
  return (
    <section className="sec">
      <button className="collapsed" data-act="proj-archived" aria-expanded={s.archOpen} onClick={() => set({ archOpen: !s.archOpen })}>
        <span className="dn">Archived</span> hidden from every list
        <span className="sum">{list.length} task{list.length > 1 ? 's' : ''} {!s.archOpen && I.chev()}</span>
      </button>
      {s.archOpen && (
        <div className="card arch-list" style={{ marginTop: 8 }}>
          {list.map((t) => (
            <div key={t.id} className="arch-row">
              <span className={`st ${t.status === 'done' ? 'ok' : 'inv'}`}>{t.status === 'done' ? 'Done' : 'Open'}</span>
              <div className="arch-main">
                <b className={t.status === 'done' ? 'dn' : ''}>{t.title}</b>
                <span>
                  {all && <>{s.projects[t.projectId]?.name} · </>}
                  {displayName(s.users[t.assigneeId])} · due {fmt(t.dueDate)} · archived by {displayName(s.users[t.archivedBy ?? ''])}, {fmt(t.archivedAt!.slice(0, 10))}
                </span>
              </div>
              <button className="btn-ghost sm" data-act="restore" onClick={() => void restoreTask(t.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Several people and/or projects: their avatars and colours, overlapping, in the space of one badge. */
function MultiBadge({ s, people, projects }: { s: State; people: string[]; projects: string[] }) {
  const shown = [...people.map((id) => ({ k: id, u: s.users[id] })), ...projects.map((id) => ({ k: id, p: s.projects[id] }))].slice(0, 3);
  return (
    <span className="mbadge" aria-hidden="true">
      {shown.map((x) => (
        <span key={x.k} className="mb-i">{'u' in x && x.u ? <Avatar user={x.u} size={24} /> : 'p' in x && x.p ? <span className="mb-p" style={{ background: x.p.color }} /> : null}</span>
      ))}
    </span>
  );
}
