import type { DragEvent } from 'react';
import { isFeed } from '../feeds';
import { EFFORT_TYPES, effortFor, effortLabel } from '../../shared/effort';
import { diffDays, fmt, rel } from '../../shared/dates';
import { isLate, shownOn } from '../../shared/rules';
import { describe } from '../../shared/repeat';
import type { Task } from '../../shared/types';
import { openDrawer, openPop, toggleDone } from '../actions';
import { useStore } from '../store';
import { ariaFor, clockTime, firstName, lateDays } from '../util';
import { Avatar, I, PrioTag, ProjPill } from './ui';

// to/carried/by: a person's view. proj/proj-carried: a project's week (shows whose it is). pdone/popen: a project's day.
export type RowCtx = 'to' | 'carried' | 'by' | 'ghost' | 'pdone' | 'pdone-all' | 'popen' | 'proj' | 'proj-carried';

export const LateBadge = ({ t, today }: { t: Task; today: string }) => <span className="late">{lateDays(t, today)}d late</span>;

export function openMove(ids: string[], anchor: HTMLElement, mode: 'task' | 'bulk' = 'task') {
  const s = useStore.getState();
  const t = s.tasks[ids[0]];
  const m = (t && t.dueDate > s.today ? t.dueDate : s.today).slice(0, 8) + '01';
  openPop({ type: 'move', mode, ids, month: m }, anchor);
}

export function TaskRow({ t, ctx, showProject = false }: { t: Task; ctx: RowCtx; showProject?: boolean }) {
  const { users, projects, today, flash } = useStore();
  const late = isLate(t, today);
  const done = t.status === 'done';
  const report = ctx === 'pdone' || ctx === 'pdone-all';
  const ghost = ctx === 'ghost';
  const p = projects[t.projectId];
  const cls = ['row', done && 'done', ghost && 'ghost', report && 'report', flash[t.id] && 'flash'].filter(Boolean).join(' ');

  let meta;
  if (ghost) meta = <span className="ghost-tag">→ carried to today</span>;
  else if (report)
    meta = (
      <>
        {ctx === 'pdone-all' && <ProjPill p={p} />}
        <span className="from"><Avatar user={users[t.assigneeId]} size={18} /><span className="ft">{firstName(users[t.assigneeId])}</span></span>
        <span className="due">due {rel(t.dueDate, today)}</span>
        {t.doneOn && t.doneOn > t.dueDate && <span className="late">{diffDays(t.doneOn, t.dueDate)}d late</span>}
        {t.doneBy && t.doneBy !== t.assigneeId && <span className="due">ticked by {firstName(users[t.doneBy])}</span>}
        <span className="datep tm">{clockTime(t.doneAt)}</span>
      </>
    );
  else if (ctx === 'proj' || ctx === 'proj-carried')
    meta = (
      <>
        {showProject && <ProjPill p={p} />}
        <span className="from"><Avatar user={users[t.assigneeId]} size={18} /><span className="ft">{firstName(users[t.assigneeId])}</span></span>
        {ctx === 'proj-carried' && <><span className="due">due {fmt(t.dueDate)}</span><LateBadge t={t} today={today} /></>}
      </>
    );
  else if (ctx === 'popen')
    meta = (
      <>
        <span className="from"><Avatar user={users[t.assigneeId]} size={18} /><span className="ft">{firstName(users[t.assigneeId])}</span></span>
        {late ? <LateBadge t={t} today={today} /> : <span className="datep">{rel(shownOn(t, today), today)}</span>}
      </>
    );
  else
    meta = (
      <>
        <ProjPill p={p} />
        {(ctx === 'to' || ctx === 'carried') && t.assignedBy !== t.assigneeId && (
          <span className="from"><Avatar user={users[t.assignedBy]} size={18} /><span className="ft">from {firstName(users[t.assignedBy])}</span></span>
        )}
        {ctx === 'carried' && <><span className="due">due {fmt(t.dueDate)}</span><LateBadge t={t} today={today} /></>}
        {ctx === 'by' && (late
          ? <><span className="due">due {fmt(t.dueDate)}</span><LateBadge t={t} today={today} /></>
          : <span className="datep">{rel(shownOn(t, today), today)}</span>)}
      </>
    );

  return (
    <div className={cls} data-id={t.id} data-nav={`${ghost ? 'ghost' : 'task'}:${t.id}`} tabIndex={-1} aria-label={ariaFor(t, today)}>
      <button className="chk" tabIndex={-1} data-act="toggle" title={done ? 'Mark not done' : 'Mark done'}
        onClick={() => (ghost ? openDrawer(t.id) : toggleDone(t.id))}>{I.check()}</button>
      <div className="row-main" data-act="open" onClick={() => openDrawer(t.id)}>
        {(!done || report) && <PrioTag p={t.priority} />}
        <div className="row-title">{t.title}{!done && t.series?.active && <RepeatMark t={t} />}{t.checklist.length > 0 && <CheckMark t={t} />}{t.attachments.length > 0 && <span className="clipmark" title={`${t.attachments.length} attachment${t.attachments.length > 1 ? 's' : ''}`} aria-label={`${t.attachments.length} attachments`}>{I.clip(11)}{t.attachments.length}</span>}{t.comments > 0 && <CommentMark n={t.comments} />}<EffortMark t={t} /></div>
      </div>
      <div className="meta">{meta}</div>
      {!done && !ghost && (
        <div className="acts">
          <button className="icon-btn" tabIndex={-1} data-act="move" title="Move date  (D)" onClick={(e) => openMove([t.id], e.currentTarget)}>{I.cal()}</button>
{!isFeed(t.id) && (<button className="icon-btn" tabIndex={-1} data-act="assign" title="Transfer to someone  (T)"
            onClick={(e) => openPop({ type: 'assign', mode: 'task', id: t.id }, e.currentTarget)}>{I.swap()}</button>)}
        </div>
      )}
    </div>
  );
}

// ---------- board cards (draggable) ----------
export const drag = { id: null as string | null };

export function TaskCard({ t, side, hideProject = false }: { t: Task; side: 'to' | 'by'; hideProject?: boolean }) {
  const { users, projects, today, flash } = useStore();
  const late = isLate(t, today);
  const done = t.status === 'done';
  const who = side === 'by' ? t.assigneeId : t.assignedBy !== t.assigneeId ? t.assignedBy : null;
  const p = projects[t.projectId];
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    drag.id = t.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
    const el = e.currentTarget;
    requestAnimationFrame(() => { el.classList.add('dragging'); el.closest('.board')?.classList.add('is-dragging'); });
  };
  const onDragEnd = (e: DragEvent<HTMLDivElement>) => {
    drag.id = null;
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.is-dragging,.col.over').forEach((x) => x.classList.remove('is-dragging', 'over'));
  };
  return (
    <div className={['tcard', done && 'done', late && 'is-late', flash[t.id] && 'flash'].filter(Boolean).join(' ')} data-id={t.id}
      data-nav={`task:${t.id}`} tabIndex={-1} aria-label={ariaFor(t, today)} draggable={!done} onDragStart={onDragStart} onDragEnd={onDragEnd}>
      <button className="chk" tabIndex={-1} data-act="toggle" title={done ? 'Mark not done' : 'Mark done'} onClick={() => toggleDone(t.id)}>{I.check()}</button>
      <div className="tc-body" data-act="open" onClick={() => openDrawer(t.id)}>
        <div className="tc-title">{!done && <PrioTag p={t.priority} />}{t.title}{!done && t.series?.active && <RepeatMark t={t} />}{t.checklist.length > 0 && <CheckMark t={t} />}{t.attachments.length > 0 && <span className="clipmark" title={`${t.attachments.length} attachment${t.attachments.length > 1 ? 's' : ''}`} aria-label={`${t.attachments.length} attachments`}>{I.clip(11)}{t.attachments.length}</span>}{t.comments > 0 && <CommentMark n={t.comments} />}<EffortMark t={t} /></div>
        <div className="tc-meta">
          {!hideProject && <span className="tc-proj"><i style={{ background: p?.color }} />{p?.name}</span>}
          {late && <LateBadge t={t} today={today} />}
          {who && <span title={`${side === 'by' ? 'Assigned to' : 'From'} ${users[who]?.name ?? ''}`}><Avatar user={users[who]} size={18} /></span>}
        </div>
      </div>
    </div>
  );
}

const CheckMark = ({ t }: { t: Task }) => {
  const done = t.checklist.filter((c) => c.done).length;
  const n = t.checklist.length;
  return (
    <span className={`ckmark ${done === n ? 'all' : ''}`} title={`Checklist: ${done} of ${n} done`} aria-label={`Checklist ${done} of ${n} done`}>{I.check(11)}{done}/{n}</span>
  );
};

/** The task's effort, if its project tracks it and it has one: "M", "5 pts", "1h 30m". */
function EffortMark({ t }: { t: Task }) {
  const p = useStore().projects[t.projectId];
  const v = p?.effort ? effortFor(t.effort, p.effort) : null;
  if (!p?.effort || !v) return null;
  const label = effortLabel(p.effort, v);
  return <span className="efmark" title={`${EFFORT_TYPES[p.effort].name}: ${label}`} aria-label={`Effort ${label}`}>{label}</span>;
}

const CommentMark = ({ n }: { n: number }) => (
  <span className="cmark" title={`${n} comment${n > 1 ? 's' : ''}`} aria-label={`${n} comment${n > 1 ? 's' : ''}`}>{I.chat(11)}{n}</span>
);

const RepeatMark = ({ t }: { t: Task }) => (
  <span className="rep" title={`Repeats: ${describe(t.series!.rule, t.series!.anchor)}`} aria-label="Repeating">{I.refresh(11)}</span>
);

// ---------- upcoming copies of repeating tasks (previews, not saved) ----------
const previewLabel = (t: Task, date: string) => `${t.series!.title}. Upcoming copy on ${fmt(date)}. It appears when the current one is done.`;

export function PreviewRow({ t, date }: { t: Task; date: string }) {
  const { projects } = useStore();
  return (
    <div className="row preview" data-nav={`preview:${t.id}:${date}`} tabIndex={-1} aria-label={previewLabel(t, date)} title="Upcoming copy" onClick={() => openDrawer(t.id)}>
      <span className="chk pv">{I.refresh(11)}</span>
      <div className="row-main"><div className="row-title">{t.series!.title}</div></div>
      <div className="meta"><ProjPill p={projects[t.projectId]} /><span className="ghost-tag pv-tag">upcoming</span></div>
    </div>
  );
}

export function PreviewCard({ t, date }: { t: Task; date: string }) {
  const { projects } = useStore();
  const p = projects[t.projectId];
  return (
    <div className="tcard preview" data-nav={`preview:${t.id}:${date}`} tabIndex={-1} aria-label={previewLabel(t, date)} title="Upcoming copy" onClick={() => openDrawer(t.id)}>
      <span className="chk pv">{I.refresh(11)}</span>
      <div className="tc-body">
        <div className="tc-title">{t.series!.title}</div>
        <div className="tc-meta"><span className="tc-proj"><i style={{ background: p?.color }} />{p?.name}</span><span className="pv-tag">upcoming</span></div>
      </div>
    </div>
  );
}
