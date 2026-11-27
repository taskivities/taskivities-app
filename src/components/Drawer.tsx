import { useEffect, useRef, useState, type ReactNode } from 'react';
import { appName } from '../../shared/types';
import { linkSite, linkWhere } from '../../shared/links';
import { attachmentBlob, isFeed, remoteTaskUrl, sourceOf } from '../sources';
import { EFFORT_TYPES, effortFor, effortLabel, storedEffortLabel } from '../../shared/effort';
import { addDays, fmt, rel } from '../../shared/dates';
import { blockedUntil, expectedOn, holdingUp, openBlockers } from '../../shared/deps';
import { isLate, lastDay, shownOn } from '../../shared/rules';
import { describe } from '../../shared/repeat';
import { CHECK_TEXT_MAX, COMMENT_MAX, PRIORITIES, type AttachmentInfo, type ChecklistItem, type Priority, type Task, type TaskEvent, type TaskLink } from '../../shared/types';
import { setFollowing, addChecklistItems, addComment, attachmentUrl, closeDrawer, removeAttachment, uploadFiles, attachMenu, editChecklist, editNotes, removeChecklistItem, renameChecklistItem, toggleChecklistItem, loadEvents, moveTasks, openDrawer, openPop, patchTask, setBlocker, skipTask, toggleDone } from '../actions';
import { set, useStore, type State } from '../store';
import { daysLabel, displayName, dueRange, firstName, lateDays, linksOf, stamp } from '../util';
import { openMove, LateBadge } from './rows';
import { type HistoryEntry, type HistoryLine, andList, groupHistory } from '../history';
import { Avatar, Dot, I, PrioIcon, ProjPill } from './ui';

export function Drawer() {
  const s = useStore();
  const t = s.drawer ? s.tasks[s.drawer] : undefined;
  const events = t ? s.events[t.id] : undefined;
  const [notes, setNotes] = useState(t?.notes ?? '');
  const [dropping, setDropping] = useState(false);

  useEffect(() => { setNotes(t?.notes ?? ''); }, [t?.id, t?.notes]);
  useEffect(() => { if (t && !events) void loadEvents(t.id); }, [t?.id, t?.version, events]);

  if (!s.drawer) return null;
  if (!t) return <><div className="backdrop" onClick={() => closeDrawer()} /><aside className="drawer" tabIndex={-1}><div className="dr-body">This task is no longer available.</div></aside></>;

  const late = isLate(t, s.today);
  const multi = lastDay(t) !== t.dueDate; // lasts several days
  const creator = s.users[t.createdBy];
  const p = s.projects[t.projectId];
  const eff = p?.effort ? effortFor(t.effort, p.effort) : null;
  const ext = sourceOf(s, t.id); // a task on another instance (src/sources.ts)
  const B = ({ children }: { children: ReactNode }) => <b>{children}</b>;
  const showNotes = !!(t.notes || notes || s.notesOpen);
  const showList = t.checklist.length > 0 || s.checklistOpen;
  const uploading = s.uploads.filter((u) => u.taskId === t.id);
  const showFiles = t.attachments.length > 0 || uploading.length > 0;
  const showDeps = (t.blockedBy?.length ?? 0) + (t.blocks?.length ?? 0) > 0;

  return (
    <>
      <div className="backdrop" data-act="close-drawer" onClick={() => closeDrawer()} />
      <aside className="drawer" data-id={t.id} role="dialog" aria-modal="true" aria-label={`Task: ${t.title}`} tabIndex={-1}
        onDragOver={(e) => { if (s.attachmentsOn && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
        onDrop={(e) => { if (!s.attachmentsOn) return; e.preventDefault(); setDropping(false); const f = [...e.dataTransfer.files]; if (f.length) void uploadFiles(t.id, f); }}
        onPaste={(e) => {
          // Pasting a screenshot (or files) anywhere in the task attaches it. Text pastes behave as usual.
          const f = [...e.clipboardData.files];
          if (!s.attachmentsOn || !f.length || e.clipboardData.getData('text')) return;
          e.preventDefault();
          void uploadFiles(t.id, f.map((x, i) => (x.name && x.name !== 'image.png' ? x : new File([x], `Pasted image ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${i ? ` (${i + 1})` : ''}.${(x.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: x.type }))));
        }}>
        {dropping && <div className="dr-drop" aria-hidden="true">{I.clip(18)} Drop to attach</div>}
        <div className="dr-top">
          <ProjPill p={p} />
          <span className="spacer" />
          {/* With other instances connected, every task says where it lives: this one too. */}
          {!ext && s.sources.length > 0 && <span className="dr-ext home" title="This task is on this instance">{appName(s.settings)}</span>}
          {ext && <a className="dr-ext" href={remoteTaskUrl(ext, t.id)} target="_blank" rel="noopener" title={`This task is on ${ext.name} (${ext.origin.replace(/^https?:\/\//, '')})`}>{ext.name} {I.arrowUp(12)}</a>}
          <button className="icon-btn" data-act="task-menu" title="More" aria-label="More actions" aria-haspopup="menu"
            onClick={(e) => openPop({ type: 'taskmenu', mode: 'task', id: t.id }, e.currentTarget)}>{I.dots()}</button>
          <button className="icon-btn" data-act="close-drawer" title="Close  Esc" aria-label="Close" onClick={() => closeDrawer()}>{I.x()}</button>
        </div>
        <div className="dr-body">
          <div className="dr-title" contentEditable suppressContentEditableWarning spellCheck={false} data-field="title" key={t.id + t.title}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); (document.querySelector('.drawer') as HTMLElement | null)?.focus(); } }}
            onBlur={(e) => {
              const v = e.currentTarget.innerText.trim();
              if (v && v !== t.title) void patchTask(t.id, { title: v });
              else if (!v) e.currentTarget.innerText = t.title;
            }}>{t.title}</div>
          <button className={`done-btn ${t.status === 'done' ? 'on' : ''}`} data-act="toggle" onClick={() => toggleDone(t.id)}>
            <span className="chk">{I.check()}</span>{t.status === 'done' ? 'Done' : 'Mark done'}
          </button>
          <dl className="fields">
            <dt>Assignee</dt>
            <dd><button className="field" data-act="assign" onClick={(e) => openPop({ type: 'assign', mode: 'task', id: t.id }, e.currentTarget)}>
              <Avatar user={s.users[t.assigneeId]} /> {displayName(s.users[t.assigneeId])} <span className="c">{I.chev()}</span></button></dd>
            <dt>Date</dt>
            <dd><button className="field" data-act="move" onClick={(e) => openMove([t.id], e.currentTarget)}>
              {I.cal()} {multi && !late ? dueRange(t) : fmt(t.status === 'done' ? t.dueDate : shownOn(t, s.today))}
              {late && <><span style={{ color: 'var(--muted)', fontSize: 12.5 }}>· due {dueRange(t)}</span> <LateBadge t={t} today={s.today} /></>}
              <span className="c">{I.chev()}</span></button></dd>
            {t.series && <>
              <dt>Repeats</dt>
              <dd>
                {t.status === 'open' && t.series.active ? (
                  <button className="field" data-act="repeat" title="Change or stop repeating  (R)" onClick={(e) => openPop({ type: 'repeat', mode: 'task', id: t.id }, e.currentTarget)}>
                    {I.refresh(14)} {describe(t.series.rule, t.series.anchor)}
                    <span className="c">{I.chev()}</span></button>
                ) : (
                  <span className="field plain">{I.refresh(14)} {t.series.active ? describe(t.series.rule, t.series.anchor) : 'Stopped repeating'}</span>
                )}
                {t.series.active && t.status === 'open' && (
                  <button className="skip-btn" data-act="skip" title="Move this copy to the next scheduled date" onClick={() => void skipTask(t.id)}>Skip this one</button>
                )}
              </dd>
            </>}
            <dt>Priority</dt>
            <dd><button className="field" data-act="prio" onClick={(e) => openPop({ type: 'prio', mode: 'task', id: t.id }, e.currentTarget)}>
              <PrioIcon p={t.priority} s={15} /> {PRIORITIES[t.priority].name} <span className="c">{I.chev()}</span></button></dd>
            {p?.effort && <>
              <dt>Effort</dt>
              <dd><button className="field" data-act="effort" title={EFFORT_TYPES[p.effort].hint} onClick={(e) => openPop({ type: 'effort', mode: 'task', id: t.id }, e.currentTarget)}>
                {I.gauge(15)} {eff ? effortLabel(p.effort, eff) : <span className="ph">{p.effortRequired && t.status === 'open' ? 'Needed to finish' : 'Add'}</span>}
                <span className="c">{I.chev()}</span></button></dd>
            </>}
            <dt>Project</dt>
            <dd><button className="field" data-act="proj" title={p?.description} onClick={(e) => openPop({ type: 'proj', mode: 'task', id: t.id }, e.currentTarget)}>
              <Dot color={p?.color ?? '#A0A0AB'} />{p?.name} <span className="c">{I.chev()}</span></button></dd>
            <dt>Created by</dt>
            <dd className="plain"><Avatar user={creator} /> {displayName(creator)}<span style={{ color: 'var(--faint)' }}
              title={`Added ${new Date(t.createdAt).toLocaleString()}${t.updatedAt !== t.createdAt ? ` · last changed ${new Date(t.updatedAt).toLocaleString()}` : ''}`}>
              · {stamp(t.createdAt, s.today)}</span></dd>
            <dt>Followers</dt>
            <dd className="fol"><Followers t={t} s={s} /></dd>
          </dl>
          {t.series?.active && t.status === 'open' && <div className="dr-hint">Changes to this copy carry over to future ones.</div>}
          {showNotes && (
            <>
              <div className="lbl">Notes</div>
              <textarea data-field="notes" placeholder="Add details or links…" value={notes} onChange={(e) => setNotes(e.target.value)}
                onBlur={() => {
                  if (notes.trim() !== t.notes) void patchTask(t.id, { notes });
                  if (!notes.trim()) set({ notesOpen: false }); // still empty: fold it away again
                }} />
            </>
          )}
          {showDeps && <Dependencies t={t} s={s} />}
          {showList && <Checklist key={`checklist:${t.id}`} taskId={t.id} items={t.checklist} />}
          {showFiles && <Attachments taskId={t.id} files={t.attachments} uploading={uploading} s={s} />}
          {s.attachmentsOn && (
            <input id="attach-input" type="file" multiple hidden tabIndex={-1} aria-hidden="true"
              onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void uploadFiles(t.id, f); }} />
          )}
          {(!showNotes || !showList || !showDeps || !showFiles) && (
            // Empty notes / no checklist: just small buttons, so the history sits higher up.
            <div className="dr-adds">
              {!showNotes && <button className="notes-add" data-act="notes" title="Add notes  (⇧N)" onClick={() => editNotes(t.id)}>{I.plus(13)} Add notes</button>}
              {!showList && <button className="notes-add" data-act="checklist" title="Add a checklist  (⇧C)" onClick={() => editChecklist(t.id)}>{I.check(12)} Add checklist</button>}
              {!showDeps && <button className="notes-add" data-act="deps" title="Tasks this one waits on, or that wait on it"
                onClick={(e) => openPop({ type: 'deps', mode: 'task', id: t.id, side: 'blockedBy' }, e.currentTarget)}>{I.link(13)} Add dependency</button>}
              {!showFiles && <button className="notes-add" data-act="attach" title={s.attachmentsOn ? 'Attach files or links  (⇧A) · or drop / paste files here' : 'Attach links to files  (⇧A)'} onClick={(e) => attachMenu(t.id, e.currentTarget)}>{I.clip(13)} {s.attachmentsOn ? 'Attach files' : 'Attach a link'}</button>}
            </div>
          )}
          <div className="lbl">Comments &amp; history <span className="muted">· permanently recorded</span></div>
          <CommentBox key={`comment:${t.id}`} taskId={t.id} />
          {!events ? <div className="trail-loading">Loading history…</div> : (
            <ol className="trail">
              {late && (
                <li className="sys"><span className="av" style={{ '--s': '22px' } as React.CSSProperties}>{I.refresh()}</span>
                  <div><div className="tx">Rolling over each day since <B>{fmt(addDays(t.dueDate, 1))}</B> (shown, not logged)</div></div></li>
              )}
              {groupHistory(events).map((g) => g.kind === 'comment' ? (
                <li key={g.key} className="cmt">
                  <Avatar user={s.users[g.event.actorId]} />
                  <div>
                    <div className="tx">
                      <b>{firstName(s.users[g.event.actorId])}</b>
                      {g.event.via && <> <span className="via" title={`Written by an AI assistant acting as ${displayName(s.users[g.event.actorId])}`}>via {g.event.via}</span></>}
                      <span className="tm"> · {stamp(g.event.at, s.today)}</span>
                    </div>
                    <div className="bubble">{linkify(g.event.note ?? '')}</div>
                  </div>
                </li>
              ) : (
                <ChangesEntry key={g.key} g={g} s={s} />
              ))}
            </ol>
          )}
        </div>
      </aside>
    </>
  );
}

/** Who follows the task (not counting whoever has it), and Follow / Unfollow for me. */
function Followers({ t, s }: { t: NonNullable<State['tasks'][string]>; s: State }) {
  const me = s.me!.id;
  const ids = t.followers.filter((id) => id !== t.assigneeId && s.users[id] && s.users[id].status !== 'disabled')
    .sort((a, b) => (a === me ? -1 : b === me ? 1 : 0));
  const names = ids.map((id) => (id === me ? 'You' : firstName(s.users[id])));
  const label = !names.length ? 'No one else' : names.length <= 3 ? andList(names).join('') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  const following = t.followers.includes(me);
  return (
    <>
      <button className="field" data-act="followers" title="Who hears about this task  (F follows it)" aria-haspopup="dialog"
        onClick={(e) => openPop({ type: 'followers', mode: 'task', id: t.id }, e.currentTarget)}>
        {ids.length > 0 && <span className="av-stack">{ids.slice(0, 4).map((id) => <Avatar key={id} user={s.users[id]} size={20} />)}</span>}
        {label} <span className="c">{I.chev()}</span>
      </button>
      {t.assigneeId !== me && (
        <button className={`follow-btn${following ? ' on' : ''}`} data-act="follow" aria-pressed={following} onClick={() => void setFollowing(t.id, !following)}>
          {following ? 'Following' : 'Follow'}
        </button>
      )}
    </>
  );
}

function EventText({ e, s }: { e: TaskEvent; s: State }) {
  const name = (id: string | null) => (id ? firstName(s.users[id]) : 'someone');
  const proj = (id: string | null) => (id && s.projects[id]?.name) || 'another project';
  const other = (id: string | null) => (id && s.tasks[id] ? `“${s.tasks[id].title}”` : 'another task');
  switch (e.type) {
    case 'created': {
      let v: { assignee?: string; due?: string; priority?: number; repeat?: boolean } = {};
      try { v = JSON.parse(e.toValue || '{}'); } catch { /* ignore */ }
      if (v.repeat) return <>finished the previous copy, which created this one{v.assignee && v.assignee !== e.actorId && <> for <b>{name(v.assignee)}</b></>}{v.due && <> · due {fmt(v.due)}</>}</>;
      return <>created this task{v.assignee && v.assignee !== e.actorId && <> for <b>{name(v.assignee)}</b></>}{v.due && <> · due {fmt(v.due)}</>}{v.priority && v.priority !== 3 && <> · {PRIORITIES[v.priority as Priority].name} priority</>}</>;
    }
    case 'transferred': return <>transferred from <b>{name(e.fromValue)}</b> to <b>{name(e.toValue)}</b></>;
    case 'date_moved': return <>moved date <b>{e.fromValue ? fmt(e.fromValue) : '?'}</b> → <b>{e.toValue ? fmt(e.toValue) : '?'}</b></>;
    case 'effort_set': return e.toValue
      ? (e.fromValue ? <>changed effort <b>{storedEffortLabel(e.fromValue)}</b> → <b>{storedEffortLabel(e.toValue)}</b></> : <>set effort to <b>{storedEffortLabel(e.toValue)}</b></>)
      : <>cleared effort (was <b>{storedEffortLabel(e.fromValue)}</b>)</>;
    case 'duration_set': return <>set it to last <b>{daysLabel(Number(e.toValue) || 1)}</b>{e.fromValue && <> (was {daysLabel(Number(e.fromValue))})</>}</>;
    case 'priority_changed': return <>changed priority <b>{PRIORITIES[Number(e.fromValue) as Priority]?.name}</b> → <b>{PRIORITIES[Number(e.toValue) as Priority]?.name}</b></>;
    case 'project_changed': return <>moved to <b>{proj(e.toValue)}</b> from <b>{proj(e.fromValue)}</b></>;
    case 'renamed': return <>renamed to “{e.toValue}”</>;
    case 'notes_edited': return <>edited notes</>;
    case 'done': return <>marked this done</>;
    case 'reopened': return <>reopened this task</>;
    case 'repeat_set': return <>set it to repeat: <b>{e.toValue}</b></>;
    case 'repeat_changed': return <>changed the repeat to <b>{e.toValue}</b></>;
    case 'repeat_stopped': return <>stopped repeating</>;
    case 'check_added': return <>added <b>{e.toValue}</b> to the checklist</>;
    case 'check_done': return <>checked <b>{e.toValue}</b></>;
    case 'check_undone': return <>unchecked <b>{e.toValue}</b></>;
    case 'check_renamed': return <>renamed checklist item “{e.fromValue}” to <b>{e.toValue}</b></>;
    case 'check_removed': return <>removed <b>{e.toValue}</b> from the checklist</>;
    case 'blocker_added': return <>made this wait on <b>{other(e.toValue)}</b></>;
    case 'blocker_removed': return <>stopped this waiting on <b>{other(e.toValue)}</b></>;
    case 'dependent_added': return <>made <b>{other(e.toValue)}</b> wait on this</>;
    case 'dependent_removed': return <>stopped <b>{other(e.toValue)}</b> waiting on this</>;
    case 'archived': return <>archived this task</>;
    case 'restored': return <>restored this task</>;
    case 'follower_added': return <>added <b>{name(e.toValue)}</b> as a follower</>;
    case 'follower_removed': return <>stopped <b>{name(e.toValue)}</b> following this</>;
    case 'attached': return <>attached <b>{e.toValue}</b></>;
    case 'detached': return <>removed the file <b>{e.toValue}</b></>;
    case 'skipped': return <>skipped <b>{e.fromValue ? fmt(e.fromValue) : '?'}</b> · next one <b>{e.toValue ? fmt(e.toValue) : '?'}</b></>;
    default: return <>{e.type}</>;
  }
}

/**
 * Dependencies: what this task waits on and what waits on it, with a one-click fix when the dates don't work
 * (nothing moves by itself). Rules: shared/deps.ts.
 */
function Dependencies({ t, s }: { t: Task; s: State }) {
  const late = isLate(t, s.today);
  const by = linksOf(s, t, 'blockedBy'), bl = linksOf(s, t, 'blocks');
  const until = blockedUntil(t, by, s.today);
  const waiting = openBlockers(t, by);
  const target = expectedOn(t.dueDate, s.today);
  // Only tasks I can see can be moved.
  const held = holdingUp(t, bl, s.today).filter((l) => s.tasks[l.id]);
  const heldHidden = holdingUp(t, bl, s.today).length - held.length;
  const add = (side: 'blockedBy' | 'blocks', el: HTMLElement) => openPop({ type: 'deps', mode: 'task', id: t.id, side }, el);
  return (
    <div className="deps" aria-label="Dependencies">
      <div className="lbl">Dependencies
        <button className="att-add" data-act="deps" title="Add a task this one waits on, or one that waits on it" onClick={(e) => add('blockedBy', e.currentTarget)}>{I.plus(12)} Add</button>
      </div>
      {by.length > 0 && (
        <>
          <div className="deps-h">Waits on{waiting.length > 0 && waiting.length < by.length && <span className="muted"> · {waiting.length} still open</span>}</div>
          <ul className="deps-list">{by.map((l) => <DepItem key={l.id} l={l} t={t} s={s} side="blockedBy" />)}</ul>
          {until ? (
            <div className="deps-warn">
              <span>{waiting.length > 1 ? 'What it waits on is' : 'It waits on a task'} due {fmt(until)}, after this one{late ? ' (already late)' : ''}.</span>
              <button className="btn-ghost sm" data-act="deps-move" onClick={() => void moveTasks([t.id], until)}>Move this to {fmt(until)}</button>
            </div>
          ) : waiting.length > 0 && late && (
            <div className="deps-warn"><span>Late, and still waiting on {waiting.length > 1 ? `${waiting.length} tasks` : 'a task'}.</span></div>
          )}
        </>
      )}
      {bl.length > 0 && (
        <>
          <div className="deps-h">Blocks</div>
          <ul className="deps-list">{bl.map((l) => <DepItem key={l.id} l={l} t={t} s={s} side="blocks" />)}</ul>
          {(held.length > 0 || heldHidden > 0) && (
            <div className="deps-warn">
              <span>
                {held.length + heldHidden > 1 ? `${held.length + heldHidden} tasks waiting on this are` : 'A task waiting on this is'} due before it
                {late ? ', and this one is late' : ''}.
                {late ? ' Finish this, or move it to when it will be done.' : heldHidden > 0 && held.length === 0 && ' Whoever has it can move it.'}
              </span>
              {/* This one late too: they all roll into today, so moving them changes nothing. Finish or move this first. */}
              {held.length > 0 && t.dueDate >= s.today && (
                <button className="btn-ghost sm" data-act="deps-push" onClick={() => void moveTasks(held.map((l) => l.id), target)}>
                  Move {held.length > 1 ? `${held.length}` : 'it'} to {fmt(target)}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DepItem({ l, t, s, side }: { l: TaskLink; t: Task; s: State; side: 'blockedBy' | 'blocks' }) {
  const o = s.tasks[l.id];
  // A linked task only carries its due date; one that's loaded also says how many days it lasts.
  const lk = { dueDate: l.dueDate, durationDays: o?.durationDays };
  const late = l.open && lastDay(lk) < s.today;
  // Open and not loaded: it's in a project I'm not on (every open task I can see is loaded).
  const label = o ? o.title : l.open ? 'A task in a project you’re not on' : 'A finished task';
  // Taking a link off goes through the task that waits, which I need to be able to see.
  const canRemove = side === 'blockedBy' || !!o;
  return (
    <li className={l.open ? '' : 'on'}>
      <span className="dep-st" aria-label={l.open ? 'Open' : 'Done'}>{l.open ? <i /> : I.check(11)}</span>
      {o ? <button className="dep-t" title="Open this task" onClick={() => openDrawer(l.id)}>{label}</button> : <span className="dep-t dim">{label}</span>}
      {o && <span title={displayName(s.users[o.assigneeId])}><Avatar user={s.users[o.assigneeId]} size={18} /></span>}
      <span className="dep-d">
        {!l.open ? 'Done' : late ? <>due {fmt(l.dueDate)} <span className="late">{lateDays(lk, s.today)}d late</span></> : `due ${rel(l.dueDate, s.today)}`}
      </span>
      {canRemove && (
        <button className="ck-x" title={side === 'blockedBy' ? 'Stop waiting on it' : 'Stop it waiting on this'} aria-label={`Remove the dependency on ${label}`}
          onClick={() => void setBlocker(t.id, l.id, side, false)}>{I.x(12)}</button>
      )}
    </li>
  );
}

/** Plain text with web addresses turned into links (opened in a new tab). */
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])/g).map((part, i) =>
    i % 2 ? <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part,
  );
}

function CommentBox({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // Shows in the history at once; if it couldn't be saved, the text comes back (unless something new was typed).
  const send = () => {
    const value = text;
    if (!value.trim()) return;
    setText('');
    ref.current?.focus();
    void addComment(taskId, value).then((ok) => { if (!ok) setText((cur) => cur || value); });
  };
  return (
    <div className="cbox">
      <textarea ref={ref} id="comment-box" data-field="comment" rows={text.includes('\n') || text.length > 60 ? 3 : 1} maxLength={COMMENT_MAX}
        placeholder="Write a comment…  (C)" aria-label="Write a comment" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }} />
      {text.trim() && (
        <div className="cbox-f">
          <span>⌘ Enter to post · everyone on the project can see it</span>
          <button className="btn-primary sm" onClick={send}>Comment</button>
        </div>
      )}
    </div>
  );
}

/** The task's checklist: tick items, click one to rename it, × to remove it, and "Add an item" (Enter keeps going; pasting several lines adds them all). */
function Checklist({ taskId, items }: { taskId: string; items: ChecklistItem[] }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const addRef = useRef<HTMLInputElement>(null);
  const done = items.filter((c) => c.done).length;
  const add = async (value: string) => {
    if (!value.trim()) return;
    setText('');
    if (!(await addChecklistItems(taskId, value))) setText(value);
    addRef.current?.focus();
  };
  const saveEdit = (c: ChecklistItem) => {
    setEditing(null);
    const v = draft.replace(/\s+/g, ' ').trim();
    if (v && v !== c.text) void renameChecklistItem(taskId, c.id, v);
  };
  return (
    <div className="ck" aria-label="Checklist">
      <div className="lbl">Checklist {items.length > 0 && <span className="muted">· {done}/{items.length}</span>}</div>
      {items.length > 0 && <div className="ck-bar" aria-hidden="true"><i style={{ width: `${(done / items.length) * 100}%` }} /></div>}
      <ul className="ck-list">
        {items.map((c) => (
          <li key={c.id} className={c.done ? 'on' : ''}>
            <input type="checkbox" checked={c.done} aria-label={c.text} onChange={(e) => void toggleChecklistItem(taskId, c.id, e.target.checked)} />
            {editing === c.id ? (
              <input className="ck-edit" autoFocus onFocus={(e) => e.currentTarget.select()} value={draft} maxLength={CHECK_TEXT_MAX} aria-label="Edit item"
                onChange={(e) => setDraft(e.target.value)} onBlur={() => saveEdit(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                }} />
            ) : (
              <button className="ck-t" title="Click to rename" onClick={() => { setEditing(c.id); setDraft(c.text); }}>{c.text}</button>
            )}
            <button className="ck-x" title="Remove" aria-label={`Remove ${c.text}`} onClick={() => void removeChecklistItem(taskId, c.id)}>{I.x(12)}</button>
          </li>
        ))}
      </ul>
      <div className="ck-add">
        {I.plus(13)}
        <input id="ck-add" ref={addRef} placeholder={items.length ? 'Add an item…' : 'Add the first item… (paste a list to add several)'} value={text} maxLength={CHECK_TEXT_MAX * 20}
          aria-label="Add a checklist item" onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text');
            if (pasted.includes('\n')) { e.preventDefault(); void add(text + pasted); }
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(text); } }}
          onBlur={() => { if (!items.length && !text.trim()) set({ checklistOpen: false }); }} />
      </div>
    </div>
  );
}

/** Lines shown before "Show N more" in a grouped entry. */
const GROUP_SHOWN = 3;

/** One person's burst of changes: a single line reads as before; several become a short list. */
function ChangesEntry({ g, s }: { g: Extract<HistoryEntry, { kind: 'changes' }>; s: State }) {
  const [open, setOpen] = useState(false);
  const who = s.users[g.actorId];
  const via = g.via && (
    <> <span className="via" title={g.via.endsWith(' webhook') ? `Created automatically by a webhook set up by ${displayName(who)}` : `Made by an AI assistant acting as ${displayName(who)}`}>via {g.via}</span></>
  );
  const single = g.lines.length === 1;
  const shown = open || g.lines.length <= GROUP_SHOWN + 1 ? g.lines : g.lines.slice(0, GROUP_SHOWN);
  const time = stamp(g.last, s.today);
  return (
    <li className={single ? '' : 'grp'}>
      <Avatar user={who} />
      <div>
        {single ? (
          <div className="tx"><b>{firstName(who)}</b>{via}{' '}<LineText line={g.lines[0]} s={s} /></div>
        ) : (
          <>
            <div className="tx"><b>{firstName(who)}</b>{via} made {g.lines.length} changes</div>
            <ul className="grp-lines">
              {shown.map((l) => <li key={l.key}><LineText line={l} s={s} /></li>)}
            </ul>
            {shown.length < g.lines.length && (
              <button className="grp-more" onClick={() => setOpen(true)}>Show {g.lines.length - shown.length} more</button>
            )}
          </>
        )}
        <div className="tm">{time}</div>
      </div>
    </li>
  );
}

/** One line: a single change (with its note), or a merged run of checklist changes. */
function LineText({ line, s }: { line: HistoryLine; s: State }) {
  const [e] = line.events;
  if (line.events.length > 1) {
    const items = andList(line.events.map((x) => <b key={x.id}>{x.toValue}</b>));
    switch (e.type) {
      case 'check_added': return <>added {items} to the checklist</>;
      case 'check_done': return <>checked {items}</>;
      case 'check_undone': return <>unchecked {items}</>;
      case 'check_removed': return <>removed {items} from the checklist</>;
      case 'attached': return <>attached {items}</>;
      case 'detached': return <>removed the files {items}</>;
    }
  }
  return <><EventText e={e} s={s} />{e.note && <span className="note">“{e.note}”</span>}</>;
}

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`);
const isImage = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type);
const DRIVES: Record<string, string> = { google: 'Google Drive', microsoft: 'OneDrive' };
const OPENS = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/;

/** The task's files: images as thumbnails, other files as a list. Opening goes through the app, which checks access. */
/**
 * A file on a task. On this instance, its address; on another, fetched with the token there and shown from memory
 * (an address can't carry the token).
 */
function FileLink({ taskId, f, img, download, className, title, children }: {
  taskId: string; f: AttachmentInfo; img?: boolean; download?: boolean; className?: string; title?: string; children?: ReactNode;
}) {
  const remote = isFeed(taskId);
  const [blob, setBlob] = useState<string | null>(null);
  useEffect(() => { if (remote) void attachmentBlob(taskId, f.id).then(setBlob).catch(() => {}); }, [remote, taskId, f.id]);
  const href = remote ? blob ?? undefined : attachmentUrl(taskId, f.id, !!download && !img);
  const inner = img ? (href ? <img src={href} alt={f.name} loading="lazy" /> : <span className="att-wait" />) : children ?? f.name;
  return (
    <a href={href} className={className} title={title} aria-label={download && children ? `Download ${f.name}` : undefined}
      {...(download && remote ? { download: f.name } : {})} target={!download ? '_blank' : undefined} rel="noopener">{inner}</a>
  );
}

function Attachments({ taskId, files, uploading, s }: { taskId: string; files: AttachmentInfo[]; uploading: State['uploads']; s: State }) {
  // Linked files have no copy here to show as a thumbnail.
  const images = files.filter((f) => isImage(f.type) && !f.link);
  const others = files.filter((f) => !isImage(f.type) || f.link);
  const canRemove = (f: AttachmentInfo) => f.by === s.me!.id || s.me!.role === 'admin';
  const meta = (f: AttachmentInfo) => `${f.link ? `Link · ${linkWhere(f.link)}` : `${fileSize(f.size)}${f.from ? ` · from ${DRIVES[f.from] ?? ''}` : ''}`} · ${firstName(s.users[f.by])} · ${stamp(f.at, s.today)}`;
  return (
    <div className="att">
      <div className="lbl">Attachments {files.length > 0 && <span className="muted">· {files.length}</span>}
        <button className="att-add" title={s.attachmentsOn ? 'Attach files or links  (⇧A) · or drop / paste files here' : 'Attach links to files  (⇧A)'} onClick={(e) => attachMenu(taskId, e.currentTarget)}>{I.plus(12)} Add</button>
      </div>
      {images.length > 0 && (
        <div className="att-grid">
          {images.map((f) => (
            <div key={f.id} className="att-img">
              <FileLink taskId={taskId} f={f} title={`${f.name} · ${meta(f)}`} img />
              {canRemove(f) && <button className="att-x" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => void removeAttachment(taskId, f.id, f.name)}>{I.x(11)}</button>}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="att-list">
          {others.map((f) => (
            <li key={f.id}>
              <span className="att-ic">{f.link ? I.link(14) : I.clip(14)}</span>
              {f.link
                ? <a href={f.link} className="att-n" target="_blank" rel="noopener noreferrer" title={`Open in ${linkSite(f.link) ?? 'a new tab'} · ${f.link}`}>{f.name}</a>
                : <FileLink taskId={taskId} f={f} className="att-n" download={!OPENS.test(f.type)} />}
              <span className="att-m">{meta(f)}</span>
              {!f.link && <FileLink taskId={taskId} f={f} className="att-dl" download title="Download">{I.download(13)}</FileLink>}
              {canRemove(f) && <button className="att-x inline" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => void removeAttachment(taskId, f.id, f.name)}>{I.x(11)}</button>}
            </li>
          ))}
        </ul>
      )}
      {uploading.map((u) => (
        <div key={u.id} className="att-up" role="status">
          <span className="att-n">{u.name}</span>
          <span className={`att-bar${u.note ? ' busy' : ''}`}><i style={{ width: `${u.total ? Math.round((u.loaded / u.total) * 100) : 0}%` }} /></span>
          <span className="att-m">{u.note ?? `${u.total ? Math.round((u.loaded / u.total) * 100) : 0}%`}</span>
        </div>
      ))}
    </div>
  );
}
