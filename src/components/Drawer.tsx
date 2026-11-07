import { useEffect, useRef, useState, type ReactNode } from 'react';
import { feedOf, feedTaskUrl } from '../feeds';
import { EFFORT_TYPES, effortFor, effortLabel, storedEffortLabel } from '../../shared/effort';
import { addDays, fmt } from '../../shared/dates';
import { isLate, shownOn } from '../../shared/rules';
import { describe } from '../../shared/repeat';
import { CHECK_TEXT_MAX, COMMENT_MAX, PRIORITIES, type AttachmentInfo, type ChecklistItem, type Priority, type TaskEvent } from '../../shared/types';
import { setFollowing, addChecklistItems, addComment, attachmentUrl, closeDrawer, pickAttachments, removeAttachment, uploadFiles, editChecklist, editNotes, removeChecklistItem, renameChecklistItem, toggleChecklistItem, loadEvents, openPop, patchTask, skipTask, toggleDone } from '../actions';
import { set, useStore, type State } from '../store';
import { displayName, firstName, stamp } from '../util';
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
  const creator = s.users[t.createdBy];
  const p = s.projects[t.projectId];
  const eff = p?.effort ? effortFor(t.effort, p.effort) : null;
  // A task from another instance (src/feeds.ts): done, date, priority, effort, notes, checklist and comments change
  // here; the rest is shown, and changed there.
  const ext = feedOf(s, t.id);
  const B = ({ children }: { children: ReactNode }) => <b>{children}</b>;
  const showNotes = !!(t.notes || notes || s.notesOpen);
  const showList = t.checklist.length > 0 || s.checklistOpen;
  const uploading = s.uploads.filter((u) => u.taskId === t.id);
  const showFiles = !ext && s.attachmentsOn && (t.attachments.length > 0 || uploading.length > 0);
  const canAttach = !ext && s.attachmentsOn;

  return (
    <>
      <div className="backdrop" data-act="close-drawer" onClick={() => closeDrawer()} />
      <aside className="drawer" data-id={t.id} role="dialog" aria-modal="true" aria-label={`Task: ${t.title}`} tabIndex={-1}
        onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false); }}
        onDrop={(e) => { if (!canAttach) return; e.preventDefault(); setDropping(false); const f = [...e.dataTransfer.files]; if (f.length) void uploadFiles(t.id, f); }}
        onPaste={(e) => {
          // Pasting a screenshot (or files) anywhere in the task attaches it. Text pastes behave as usual.
          const f = [...e.clipboardData.files];
          if (!canAttach || !f.length || e.clipboardData.getData('text')) return;
          e.preventDefault();
          void uploadFiles(t.id, f.map((x, i) => (x.name && x.name !== 'image.png' ? x : new File([x], `Pasted image ${new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${i ? ` (${i + 1})` : ''}.${(x.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: x.type }))));
        }}>
        {dropping && <div className="dr-drop" aria-hidden="true">{I.clip(18)} Drop to attach</div>}
        <div className="dr-top">
          <ProjPill p={p} />
          <span className="spacer" />
          {ext && <a className="dr-ext" href={feedTaskUrl(ext, t.id)} target="_blank" rel="noopener" title={`This task is on ${ext.name} (${ext.url.replace(/^https?:\/\//, '')}). Handing it over, its project, repeating and files are changed there.`}>Open in {ext.name} {I.arrowUp(12)}</a>}
          {!ext && <button className="icon-btn" data-act="task-menu" title="More" aria-label="More actions" aria-haspopup="menu"
            onClick={(e) => openPop({ type: 'taskmenu', mode: 'task', id: t.id }, e.currentTarget)}>{I.dots()}</button>}
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
            <dd>{ext ? <span className="field plain"><Avatar user={s.users[t.assigneeId]} /> {displayName(s.users[t.assigneeId])}</span> : (
              <button className="field" data-act="assign" onClick={(e) => openPop({ type: 'assign', mode: 'task', id: t.id }, e.currentTarget)}>
              <Avatar user={s.users[t.assigneeId]} /> {displayName(s.users[t.assigneeId])} <span className="c">{I.chev()}</span></button>)}</dd>
            <dt>Date</dt>
            <dd><button className="field" data-act="move" onClick={(e) => openMove([t.id], e.currentTarget)}>
              {I.cal()} {fmt(t.status === 'done' ? t.dueDate : shownOn(t, s.today))}
              {late && <><span style={{ color: 'var(--muted)', fontSize: 12.5 }}>· due {fmt(t.dueDate)}</span> <LateBadge t={t} today={s.today} /></>}
              <span className="c">{I.chev()}</span></button></dd>
            {t.series && <>
              <dt>Repeats</dt>
              <dd>
                {!ext && t.status === 'open' && t.series.active ? (
                  <button className="field" data-act="repeat" title="Change or stop repeating  (R)" onClick={(e) => openPop({ type: 'repeat', mode: 'task', id: t.id }, e.currentTarget)}>
                    {I.refresh(14)} {describe(t.series.rule, t.series.anchor)}
                    <span className="c">{I.chev()}</span></button>
                ) : (
                  <span className="field plain">{I.refresh(14)} {t.series.active ? describe(t.series.rule, t.series.anchor) : 'Stopped repeating'}</span>
                )}
                {!ext && t.series.active && t.status === 'open' && (
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
            <dd>{ext ? <span className="field plain" title={p?.description}><Dot color={p?.color ?? '#A0A0AB'} />{p?.name}</span> : (
              <button className="field" data-act="proj" title={p?.description} onClick={(e) => openPop({ type: 'proj', mode: 'task', id: t.id }, e.currentTarget)}>
              <Dot color={p?.color ?? '#A0A0AB'} />{p?.name} <span className="c">{I.chev()}</span></button>)}</dd>
            <dt>Created by</dt>
            <dd className="plain"><Avatar user={creator} /> {displayName(creator)}<span style={{ color: 'var(--faint)' }}>· {stamp(t.createdAt, s.today).split(' · ')[0]}</span></dd>
            {!ext && <><dt>Followers</dt>
            <dd className="fol"><Followers t={t} s={s} /></dd></>}
            {ext && t.attachments.length > 0 && <><dt>Files</dt>
            <dd><a className="field plain" href={feedTaskUrl(ext, t.id)} target="_blank" rel="noopener">{I.clip(14)} {t.attachments.length} on {ext.name}</a></dd></>}
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
          {showList && <Checklist key={`checklist:${t.id}`} taskId={t.id} items={t.checklist} />}
          {showFiles && <Attachments taskId={t.id} files={t.attachments} uploading={uploading} s={s} />}
          {s.attachmentsOn && (
            <input id="attach-input" type="file" multiple hidden tabIndex={-1} aria-hidden="true"
              onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) void uploadFiles(t.id, f); }} />
          )}
          {(!showNotes || !showList || (canAttach && !showFiles)) && (
            // Empty notes / no checklist: just small buttons, so the history sits higher up.
            <div className="dr-adds">
              {!showNotes && <button className="notes-add" data-act="notes" title="Add notes  (⇧N)" onClick={() => editNotes(t.id)}>{I.plus(13)} Add notes</button>}
              {!showList && <button className="notes-add" data-act="checklist" title="Add a checklist  (⇧C)" onClick={() => editChecklist(t.id)}>{I.check(12)} Add checklist</button>}
              {canAttach && !showFiles && <button className="notes-add" data-act="attach" title="Attach files  (⇧A) · or drop / paste them here" onClick={() => pickAttachments(t.id)}>{I.clip(13)} Attach files</button>}
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

/** Plain text with web addresses turned into links (opened in a new tab). */
function linkify(text: string) {
  return text.split(/(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])/g).map((part, i) =>
    i % 2 ? <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a> : part,
  );
}

function CommentBox({ taskId }: { taskId: string }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await addComment(taskId, text)) setText('');
    setBusy(false);
    ref.current?.focus();
  };
  return (
    <div className="cbox">
      <textarea ref={ref} id="comment-box" data-field="comment" rows={text.includes('\n') || text.length > 60 ? 3 : 1} maxLength={COMMENT_MAX}
        placeholder="Write a comment…  (C)" aria-label="Write a comment" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
      {text.trim() && (
        <div className="cbox-f">
          <span>⌘ Enter to post · everyone on the project can see it</span>
          <button className="btn-primary sm" disabled={busy} onClick={() => void send()}>{busy ? 'Posting…' : 'Comment'}</button>
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
const OPENS = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/;

/** The task's files: images as thumbnails, other files as a list. Opening goes through the app, which checks access. */
function Attachments({ taskId, files, uploading, s }: { taskId: string; files: AttachmentInfo[]; uploading: State['uploads']; s: State }) {
  const images = files.filter((f) => isImage(f.type));
  const others = files.filter((f) => !isImage(f.type));
  const canRemove = (f: AttachmentInfo) => f.by === s.me!.id || s.me!.role === 'admin';
  const meta = (f: AttachmentInfo) => `${fileSize(f.size)} · ${firstName(s.users[f.by])} · ${stamp(f.at, s.today)}`;
  return (
    <div className="att">
      <div className="lbl">Attachments {files.length > 0 && <span className="muted">· {files.length}</span>}
        <button className="att-add" title="Attach files  (⇧A) · or drop / paste them here" onClick={() => pickAttachments(taskId)}>{I.plus(12)} Add</button>
      </div>
      {images.length > 0 && (
        <div className="att-grid">
          {images.map((f) => (
            <div key={f.id} className="att-img">
              <a href={attachmentUrl(taskId, f.id)} target="_blank" rel="noopener" title={`${f.name} · ${meta(f)}`}>
                <img src={attachmentUrl(taskId, f.id)} alt={f.name} loading="lazy" />
              </a>
              {canRemove(f) && <button className="att-x" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => void removeAttachment(taskId, f.id, f.name)}>{I.x(11)}</button>}
            </div>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <ul className="att-list">
          {others.map((f) => (
            <li key={f.id}>
              <span className="att-ic">{I.clip(14)}</span>
              <a href={attachmentUrl(taskId, f.id, !OPENS.test(f.type))} target={OPENS.test(f.type) ? '_blank' : undefined} rel="noopener" className="att-n">{f.name}</a>
              <span className="att-m">{meta(f)}</span>
              <a className="att-dl" href={attachmentUrl(taskId, f.id, true)} title="Download" aria-label={`Download ${f.name}`}>{I.download(13)}</a>
              {canRemove(f) && <button className="att-x inline" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => void removeAttachment(taskId, f.id, f.name)}>{I.x(11)}</button>}
            </li>
          ))}
        </ul>
      )}
      {uploading.map((u) => (
        <div key={u.id} className="att-up" role="status">
          <span className="att-n">{u.name}</span>
          <span className="att-bar"><i style={{ width: `${u.total ? Math.round((u.loaded / u.total) * 100) : 0}%` }} /></span>
          <span className="att-m">{u.total ? Math.round((u.loaded / u.total) * 100) : 0}%</span>
        </div>
      ))}
    </div>
  );
}
