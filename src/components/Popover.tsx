import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { localProjects, localUsers } from '../feeds';
import { DOW, MONL, addDays, fmt, parseDate, toDate, weekStart } from '../../shared/dates';
import { type Freq, type Repeat, cleanRepeat, describe, presets, sameRule } from '../../shared/repeat';
import { isAdmin, onProject } from '../../shared/rules';
import { PRIORITIES, type NotifyPrefs, type Priority, type Task } from '../../shared/types';
import {
  assignable, closePop, defaultDraftDate, moveTasks, openConnect, openPop, viewProject, disableUser, enableUser, setPage, setPriority, setProject, setRepeat, signOut, switchablePeople, transfer,
  updateUser, viewPerson, editNotes, editChecklist, pickAttachments, archiveTask, setFollowing, setEffort, currentSel, setMultiPick, viewMulti,
} from '../actions';
import { focusLater } from '../focus';
import { EFFORT_TYPES, effortFor, effortFromInput, fmtTime } from '../../shared/effort';
import { type ThemePref, setThemePref } from '../theme';
import { installApp, isInstalled, isIOS } from '../install';
import { setNotifyPrefs, testPush, turnOffPush, turnOnPush } from '../push';
import { APP_COMMIT, APP_VERSION, checkForUpdate, markUpdateSeen } from '../updates';
import { S, set, useStore, type Pop, type State } from '../store';
import { displayName, draftEffective, firstName, isLate, myProjects, shownOn } from '../util';
import { projectDayData } from '../pages/ProjectsPage';
import { openProjEdit } from '../pages/TeamPage';
import { Avatar, Dot, I, PrioIcon, ProjBadge } from './ui';
import { InboxPop } from './InboxPop';

const setDraft = (p: Partial<State['draft']>) => set((s) => ({ draft: { ...s.draft, ...p } }));
const updatePop = (p: Partial<Pop>) => set((s) => (s.pop ? { pop: { ...s.pop, ...p } } : {}));
/** Phones and tablets: focusing a search box there opens the on-screen keyboard, so popovers don't do it on open. */
const isTouch = () => matchMedia('(hover: none) and (pointer: coarse)').matches;
/** The height you can see: on phones, the window above the on-screen keyboard. */
const viewH = () => window.visualViewport?.height ?? innerHeight;

export function Popover() {
  const s = useStore();
  const p = s.pop;
  const ref = useRef<HTMLDivElement>(null);
  const opened = useRef<Pop | null>(null);
  // Fit again when the visible height changes (the on-screen keyboard opening or closing).
  const [, refit] = useState(0);
  useEffect(() => {
    if (!p) return;
    const vv = window.visualViewport;
    const on = () => refit((n) => n + 1);
    vv?.addEventListener('resize', on);
    window.addEventListener('resize', on);
    return () => { vv?.removeEventListener('resize', on); window.removeEventListener('resize', on); };
  }, [!!p]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!p || !el) { opened.current = null; return; }
    // Position first (synchronously), then focus: hidden elements can't take focus.
    const W = el.offsetWidth, H = el.offsetHeight, r = p.rect;
    let top = r.b + 6;
    if (top + H > viewH() - 12) top = Math.max(12, r.t - H - 6);
    el.style.left = `${Math.max(12, Math.min(r.l, innerWidth - W - 12))}px`;
    el.style.top = `${top}px`;
    el.style.visibility = 'visible';
    const isNew = !opened.current || opened.current.rect !== p.rect || opened.current.type !== p.type;
    opened.current = p;
    if (isNew) {
      const first = (isTouch() ? null : el.querySelector<HTMLElement>('#pop-q')) || el.querySelector<HTMLElement>('.opt.cur:not(:disabled)') ||
        el.querySelector<HTMLElement>('.opt:not(:disabled)') || el.querySelector<HTMLElement>('button:not(:disabled)');
      first?.focus({ preventScroll: true });
    }
  });

  if (!p) return null;
  return (
    <div id="pop">
      <div className="pop" ref={ref} role="dialog" aria-label="Menu" style={{ visibility: 'hidden', left: 0, top: 0 }}>
        <Content p={p} s={s} />
      </div>
    </div>
  );
}

function Content({ p, s }: { p: Pop; s: State }) {
  switch (p.type) {
    case 'move': return <MovePop p={p} s={s} />;
    case 'assign': return <AssignPop p={p} s={s} />;
    case 'prio': return <PrioPop p={p} s={s} />;
    case 'effort': return <EffortPop p={p} s={s} />;
    case 'proj': return <ProjPop p={p} s={s} />;
    case 'person': case 'projpick': return <SwitchPop p={p} s={s} />;
    case 'urole': return <RolePop p={p} s={s} />;
    case 'uproj': return <UserProjectsPop p={p} s={s} />;
    case 'udisable': return <DisablePop p={p} s={s} />;
    case 'uenable': return <EnablePop p={p} s={s} />;
    case 'notify': return <NotifyPop s={s} />;
    case 'update': return <UpdatePop s={s} />;
    case 'inbox': return <InboxPop s={s} />;
    case 'followers': return <FollowersPop p={p} s={s} />;
    case 'account': return <AccountPop s={s} />;
    case 'taskmenu': return <TaskMenu p={p} s={s} />;
    case 'repeat': return <RepeatPop p={p} s={s} />;
    case 'pages': return <PagesPop s={s} />;
  }
}

function MovePop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const cur = qa ? s.draft.dueDate || s.today : p.ids!.length === 1 ? s.tasks[p.ids![0]]?.dueDate : null;
  const nextMon = addDays(weekStart(s.today), 7);
  const fri = addDays(weekStart(s.today), 4);
  const quick: [string, string][] = [
    ...(qa ? [['Today', s.today] as [string, string]] : []),
    ['Tomorrow', addDays(s.today, 1)],
    ...(fri > addDays(s.today, 1) ? [['This Friday', fri] as [string, string]] : []),
    ['Next Monday', nextMon],
    ['In a week', addDays(s.today, 7)],
  ];
  const pick = (d: string) => {
    closePop(true);
    if (qa) setDraft({ dueDate: d });
    else void moveTasks(p.ids!, d);
  };
  const title = qa ? 'Due date' : p.ids!.length > 1 ? `Move ${p.ids!.length} carried tasks to…` : 'Move to…';
  const month = p.month || s.today.slice(0, 8) + '01';
  const first = parseDate(month);
  const start = addDays(month, -((first.getDay() + 6) % 7));
  const shift = (n: number) => { const f = parseDate(month); f.setMonth(f.getMonth() + n); updatePop({ month: toDate(f) }); };
  return (
    <>
      <div className="pop-h">{title}</div>
      {quick.map(([l, d]) => (
        <button key={l} className="opt" data-act="setdate" data-d={d} onClick={() => pick(d)}>{l}<span className="r">{fmt(d)}</span></button>
      ))}
      <div className="pop-sep" />
      <div className="cal">
        <div className="cal-h">
          <button className="icon-btn" data-act="cal" data-dir="-1" aria-label="Previous month" onClick={() => shift(-1)}>{I.left()}</button>
          <b>{MONL[first.getMonth()]} {first.getFullYear()}</b>
          <button className="icon-btn" data-act="cal" data-dir="1" aria-label="Next month" onClick={() => shift(1)}>{I.right()}</button>
        </div>
        <div className="cal-g">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((x, i) => <span key={i} className="dw">{x}</span>)}
          {[...Array(42)].map((_, i) => {
            const d = addDays(start, i);
            const dd = parseDate(d);
            const cls = [dd.getMonth() !== first.getMonth() && 'om', d === s.today && 'td', d === cur && 'sel'].filter(Boolean).join(' ');
            return (
              <button key={d} className={cls} disabled={d < s.today} aria-label={fmt(d)} onClick={() => pick(d)}>{dd.getDate()}</button>
            );
          })}
        </div>
      </div>
    </>
  );
}

function AssignPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const t = qa ? null : s.tasks[p.id!];
  const pid = qa ? draftEffective(s).projectId : t?.projectId;
  const cur = qa ? draftEffective(s).assigneeId : t?.assigneeId;
  const noteRef = useRef<HTMLInputElement>(null);
  const onlyRef = useRef<HTMLInputElement>(null);
  const repeating = !!t?.series?.active && t.status === 'open';
  if (!pid) return <div className="pop-body">Pick a project first.</div>;
  const q = (p.q || '').toLowerCase();
  const list = assignable(s, pid)
    .filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const choose = (u: string) => {
    const note = noteRef.current?.value.trim();
    const thisOnly = !!onlyRef.current?.checked;
    closePop(true);
    if (qa) setDraft({ assigneeId: u });
    else void transfer(p.id!, u, note, thisOnly);
  };
  return (
    <>
      <div className="pop-h">{qa ? 'Assign to' : 'Transfer to…'}</div>
      <div style={{ padding: '0 4px' }}>
        <input className="pin" id="pop-q" placeholder="Search people" value={p.q || ''} autoComplete="off"
          onChange={(e) => updatePop({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const f = list.find((u) => u.id !== cur); if (f) choose(f.id); } }} />
      </div>
      {list.length ? list.map((u) => (
        <button key={u.id} className={`opt ${u.id === cur ? 'cur' : ''}`} onClick={() => u.id !== cur && choose(u.id)}>
          <Avatar user={u} />{displayName(u)}{u.id === s.me!.id && <span style={{ color: 'var(--faint)' }}> (you)</span>}
          <span className="r">{u.id === cur ? 'current' : u.status === 'invited' ? 'invited' : ''}</span>
        </button>
      )) : <div className="pop-empty">No one on this project matches.</div>}
      <div className="pop-foot">Only people on <b>{s.projects[pid]?.name}</b> are listed.</div>
      {!qa && (
        <><div className="pop-sep" /><div style={{ padding: '2px 4px' }}>
          <input className="pin" ref={noteRef} placeholder="Add a note for the history (optional)" style={{ margin: 0 }} />
        </div></>
      )}
      {repeating && (
        <label className="pop-check">
          <input type="checkbox" ref={onlyRef} />
          <span>Just this one. Future copies stay with {firstName(s.users[t!.series!.assigneeId])}.</span>
        </label>
      )}
    </>
  );
}

function PrioPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const cur = qa ? s.draft.priority : s.tasks[p.id!]?.priority;
  return (
    <>
      <div className="pop-h">Priority</div>
      {([1, 2, 3, 4] as Priority[]).map((k) => (
        <button key={k} className={`opt ${k === cur ? 'cur' : ''}`} data-p={k}
          onClick={() => { if (k === cur) return; closePop(true); if (qa) setDraft({ priority: k }); else void setPriority(p.id!, k); }}>
          <PrioIcon p={k} s={15} />{PRIORITIES[k].name}<span className="r">{k === cur ? 'current' : PRIORITIES[k].hint}</span>
        </button>
      ))}
    </>
  );
}

/** A task's effort, the way its project measures it: a time (typed, or a quick pick), a size or story points. */
function EffortPop({ p, s }: { p: Pop; s: State }) {
  const t = s.tasks[p.id!];
  const proj = t ? s.projects[t.projectId] : null;
  const type = proj?.effort ?? null;
  const cur = t && type ? effortFor(t.effort, type) : null;
  const [text, setText] = useState(cur && type === 'time' ? fmtTime(Number(cur)) : '');
  const [err, setErr] = useState('');
  if (!t || !proj || !type) return <div className="pop-foot">This project doesn't track effort.</div>;
  const pick = (stored: string | null) => {
    closePop(true);
    if (stored === (t.effort ?? null) && !p.thenDone) return;
    setEffort(t.id, stored, p.thenDone);
  };
  const saveTime = () => {
    const v = effortFromInput('time', text);
    if (!v) { setErr('Try 45m, 1h 30m, 1:30 or 1.5 (hours).'); return; }
    pick(v);
  };
  return (
    <div className="effort-pop">
      <div className="pop-h">{p.thenDone ? `Add the ${EFFORT_TYPES[type].name.toLowerCase()} to finish` : EFFORT_TYPES[type].name}</div>
      {type === 'time' ? (
        <>
          <form className="ef-time" onSubmit={(e) => { e.preventDefault(); saveTime(); }}>
            <input className="pin" id="pop-q" value={text} placeholder="e.g. 1h 30m" autoComplete="off" aria-label="Time spent"
              aria-invalid={!!err} onChange={(e) => { setText(e.target.value); setErr(''); }} />
            <button className="btn-primary sm" type="submit" data-act="effort-save">{p.thenDone ? 'Done' : 'Save'}</button>
          </form>
          {err && <div className="ef-err" role="alert">{err}</div>}
          <div className="ef-quick">
            {[15, 30, 60, 120, 240].map((m) => (
              <button key={m} className="chip" data-act="effort-pick" data-v={`time:${m}`} onClick={() => pick(`time:${m}`)}>{fmtTime(m)}</button>
            ))}
          </div>
        </>
      ) : EFFORT_TYPES[type].values!.map((v) => (
        <button key={v} className={`opt ${v === cur ? 'cur' : ''}`} data-act="effort-pick" data-v={`${type}:${v}`} onClick={() => pick(`${type}:${v}`)}>
          <span className="ef-v">{v}</span>{type === 'fibo' ? `point${v === '1' ? '' : 's'}` : ''}<span className="r">{v === cur ? 'current' : ''}</span>
        </button>
      ))}
      {cur && !p.thenDone && <><div className="pop-sep" /><button className="opt" data-act="effort-clear" onClick={() => pick(null)}>{I.x(14)}Clear</button></>}
      {p.thenDone && <div className="pop-foot">{proj.name} needs this before a task is marked done.</div>}
    </div>
  );
}

function ProjPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const t = qa ? null : s.tasks[p.id!];
  const cur = qa ? draftEffective(s).projectId : t?.projectId;
  const owner = t ? s.users[t.assigneeId] : null;
  return (
    <>
      <div className="pop-h">Project</div>
      {myProjects(s).map((pr) => {
        const blocked = !!owner && !onProject(owner, pr.id);
        return (
          <button key={pr.id} className={`opt ${pr.id === cur ? 'cur' : ''}`} disabled={blocked} title={pr.description}
            onClick={() => {
              if (pr.id === cur) return;
              closePop(true);
              if (qa) {
                const d = S().draft;
                const a = d.assigneeId ? s.users[d.assigneeId] : null;
                setDraft({ projectId: pr.id, ...(a && !onProject(a, pr.id) ? { assigneeId: null } : {}) });
              } else void setProject(p.id!, pr.id);
            }}>
            <Dot color={pr.color} />{pr.name}
            <span className="r">{pr.id === cur ? 'current' : blocked ? `${firstName(owner!)} isn't on it` : ''}</span>
          </button>
        );
      })}
      {isAdmin(s.me!)
        ? <><div className="pop-sep" /><button className="opt" style={{ color: 'var(--accent)' }}
            onClick={() => { closePop(false); openProjEdit(null, { forDraft: qa }); }}>
            {I.plus(14)} New project…</button></>
        : <div className="pop-foot">Only your projects are listed.</div>}
    </>
  );
}

/**
 * The switcher: whose work or which project you're looking at. One list for both pages: on Tasks, people come first;
 * on Projects, projects do. Search filters both, and the list scrolls, so it works for big teams too.
 */
function SwitchPop({ p, s }: { p: Pop; s: State }) {
  const me = s.me!.id;
  const onProjects = s.page === 'projects';
  const tasks = Object.values(s.tasks);
  const ws = addDays(weekStart(s.today), s.weekOffset * 7);
  const we = addDays(ws, 6);
  const TD = s.view === 'today';
  // Week and board: what's open that week. Today: what's open today (people) / done that day (a project).
  const inView = (t: Task) => t.status === 'open' && (TD ? shownOn(t, s.today) === s.today : shownOn(t, s.today) >= ws && shownOn(t, s.today) <= we);
  const inP = (id: string) => (t: Task) => (id === 'all' ? !!s.projects[t.projectId] && !s.projects[t.projectId].feed : t.projectId === id);
  const projCount = (id: string) => (onProjects && TD
    ? `${projectDayData(s, inP(id), s.projDay).done.length} done`
    : `${tasks.filter((t) => inP(id)(t) && inView(t)).length} open`);
  const q = (p.q || '').trim().toLowerCase();
  const match = (...xs: (string | undefined)[]) => !q || xs.some((x) => x?.toLowerCase().includes(q));
  const people = switchablePeople(s)
    .filter((u) => match(u.name, u.email, u.id === me ? 'me' : ''))
    .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : displayName(a).localeCompare(displayName(b))));
  const projects = myProjects(s).filter((pr) => match(pr.name));
  const showAll = match(isAdmin(s.me!) ? 'All projects' : 'All my projects');
  const curPerson = !onProjects && s.page === 'tasks' ? s.viewUser || me : null;
  const curProj = onProjects ? s.projSel : null;
  // "Select several": rows are checkboxes, and each tick changes the view at once (the menu stays open).
  const several = s.multiPick;
  const picked = currentSel(s);
  const nPicked = picked.people.length + picked.projects.length;
  const flip = (xs: string[], id: string) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]);
  const pickPerson = (id: string) => viewMulti({ ...picked, people: flip(picked.people, id) });
  const pickProject = (id: string) => viewMulti({ ...picked, projects: id === 'all' ? [] : flip(picked.projects, id) });
  const Chk = ({ on }: { on: boolean }) => <span className={`sw-chk ${on ? 'on' : ''}`} aria-hidden="true">{on && I.check(11)}</span>;

  const goPerson = (id: string) => { closePop(false); focusLater('[data-act="person"]'); viewPerson(id); };
  const goProject = (id: string) => {
    closePop(false);
    focusLater('[data-act="proj-pick"]');
    if (onProjects) set({ projSel: id });
    else viewProject(id);
  };

  const peopleSec = people.length > 0 && (
    <div key="people" data-sec="people">
      <div className="pop-h">People</div>
      {people.map((u) => {
        const open = tasks.filter((t) => t.assigneeId === u.id && inView(t)).length;
        const late = tasks.filter((t) => t.assigneeId === u.id && isLate(t, s.today)).length;
        return (
          <button key={u.id} className={`opt ${!several && u.id === curPerson ? 'cur' : ''}`} data-u={u.id}
            {...(several ? { role: 'menuitemcheckbox', 'aria-checked': picked.people.includes(u.id) } : {})}
            onClick={() => (several ? pickPerson(u.id) : goPerson(u.id))}>
            {several && <Chk on={picked.people.includes(u.id)} />}<Avatar user={u} size={22} /><span className="sw-name">{u.id === me ? 'Me' : displayName(u)}</span>
            <span className="r">{late > 0 && <><span style={{ color: 'var(--late)' }}>{late} late</span> · </>}{open} open</span>
          </button>
        );
      })}
    </div>
  );
  const projectsSec = (showAll || projects.length > 0) && (
    <div key="projects" data-sec="projects">
      <div className="pop-h">Projects</div>
      {showAll && (
        <button className={`opt ${!several && curProj === 'all' ? 'cur' : ''}`} data-p="all"
          {...(several ? { role: 'menuitemcheckbox', 'aria-checked': !picked.projects.length } : {})}
          title={several ? 'Any project: tasks of the people picked, wherever they are' : undefined}
          onClick={() => (several ? pickProject('all') : goProject('all'))}>
          {several && <Chk on={!picked.projects.length} />}<ProjBadge project="all" size={22} /><span className="sw-name">{isAdmin(s.me!) ? 'All projects' : 'All my projects'}</span><span className="r">{projCount('all')}</span>
        </button>
      )}
      {projects.map((pr) => (
        <button key={pr.id} className={`opt ${!several && pr.id === curProj ? 'cur' : ''}`} data-p={pr.id} title={pr.description}
          {...(several ? { role: 'menuitemcheckbox', 'aria-checked': picked.projects.includes(pr.id) } : {})}
          onClick={() => (several ? pickProject(pr.id) : goProject(pr.id))}>
          {several && <Chk on={picked.projects.includes(pr.id)} />}<span className="sw-dot"><Dot color={pr.color} /></span><span className="sw-name">{pr.name}</span><span className="r">{projCount(pr.id)}</span>
        </button>
      ))}
    </div>
  );
  // Order by the button that opened it (not the page), so picking several doesn't reshuffle the list under you.
  const projFirst = p.type === 'projpick';
  const sections = projFirst ? [projectsSec, peopleSec] : [peopleSec, projectsSec];
  const first = () => document.querySelector<HTMLElement>('.pop .sw-list .opt:not(.cur)') || document.querySelector<HTMLElement>('.pop .sw-list .opt');
  const sel = onProjects && s.projSel !== 'all' ? s.projects[s.projSel] : null;
  return (
    // As tall as the space under the button allows, so the whole list is always reachable (it scrolls).
    <div className="switch" style={{ maxHeight: Math.max(200, viewH() - p.rect.b - 48) }}>
      <div className="sw-top">
        <input className="pin" id="pop-q" placeholder="Search" aria-label={projFirst ? 'Search projects and people' : 'Search people and projects'} value={p.q || ''} autoComplete="off"
          onChange={(e) => updatePop({ q: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); first()?.click(); } }} />
        <button className={`sw-several ${several ? 'on' : ''}`} data-act="multi-pick" aria-pressed={several}
          title={several ? 'Back to picking one' : 'Pick several people and projects to see their tasks together'}
          onClick={() => setMultiPick(!several)}>
          <span className="sw-chk" aria-hidden="true">{several && I.check(11)}</span>Several
        </button>
      </div>
      {several && (
        <div className="sw-hint">
          {picked.people.length && picked.projects.length ? 'Tasks of the people picked, in the projects picked.'
            : picked.people.length > 1 ? 'Everyone picked, together. Add projects to narrow it.'
            : picked.projects.length > 1 ? 'The projects picked, together. Add people to narrow it.'
            : 'Tick people and projects to see their tasks together.'}
        </div>
      )}
      {/* Big teams: jump straight to a section instead of scrolling past the other one. */}
      {!q && people.length + projects.length > 12 && (
        <div className="sw-jump">
          {(projFirst ? (['projects', 'people'] as const) : (['people', 'projects'] as const)).map((k) => (
            <button key={k} className="no-arrow" data-act={`jump-${k}`}
              onClick={() => {
                const list = document.querySelector<HTMLElement>('.pop .sw-list');
                const sec = list?.querySelector<HTMLElement>(`[data-sec="${k}"]`);
                if (list && sec) list.scrollTo({ top: sec.offsetTop - 4, behavior: 'smooth' });
              }}>
              {k === 'people' ? 'People' : 'Projects'} <span>{k === 'people' ? people.length : projects.length}</span>
            </button>
          ))}
        </div>
      )}
      <div className="sw-list">
        {sections.filter(Boolean).map((sec, i) => <div key={i}>{i > 0 && <div className="pop-sep" />}{sec}</div>)}
        {!people.length && !projects.length && !showAll && <div className="pop-empty">No one and no project matches “{p.q}”.</div>}
      </div>
      {several && (
        <div className="sw-foot sw-picked">
          <span>{nPicked} picked</span>
          <button className="btn-ghost sm" data-act="multi-clear" disabled={!nPicked} onClick={() => viewMulti({ people: [], projects: [] })}>Clear</button>
          <button className="btn-primary sm" data-act="multi-done" onClick={() => closePop(true)}>Done</button>
        </div>
      )}
      {isAdmin(s.me!) && !q && !several && (
        <div className="sw-foot">
          {sel && (
            <button className="opt" data-act="proj-edit" onClick={() => { closePop(false); focusLater('[data-act="proj-pick"]'); openProjEdit(sel.id); }}>
              {I.edit(14)} Edit project…
            </button>
          )}
          <button className="opt" data-act="proj-new" style={{ color: 'var(--accent)' }}
            onClick={() => { closePop(false); focusLater(onProjects ? '[data-act="proj-pick"]' : '[data-act="person"]'); openProjEdit(null); }}>
            {I.plus(14)} New project…
          </button>
        </div>
      )}
    </div>
  );
}

function RolePop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const admins = localUsers(s).filter((x) => x.status !== 'disabled' && x.role === 'admin').length;
  const lastAdmin = u.role === 'admin' && admins <= 1;
  const choose = (role: 'admin' | 'member') => {
    closePop(true);
    void updateUser(u.id, { role }, role === 'admin' ? `${firstName(u)} is now an admin` : `${firstName(u)} is now a member. Check their projects.`);
  };
  return (
    <>
      <div className="pop-h">Role for {displayName(u)}</div>
      <button className={`opt ${u.role === 'admin' ? 'cur' : ''}`} onClick={() => u.role !== 'admin' && choose('admin')}>
        Admin<span className="r">{u.role === 'admin' ? 'current' : 'every project + team'}</span></button>
      <button className={`opt ${u.role === 'member' ? 'cur' : ''}`} disabled={lastAdmin} onClick={() => u.role !== 'member' && choose('member')}>
        Member<span className="r">{u.role === 'member' ? 'current' : lastAdmin ? 'last admin' : 'only their projects'}</span></button>
    </>
  );
}

function UserProjectsPop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const openIn = (pid: string) => Object.values(s.tasks).filter((t) => t.assigneeId === u.id && t.status === 'open' && t.projectId === pid).length;
  return (
    <>
      <div className="pop-h">{displayName(u)} can see</div>
      {localProjects(s).sort((a, b) => a.name.localeCompare(b.name)).map((pr) => {
        const on = u.projects.includes(pr.id);
        const n = openIn(pr.id);
        const lock = on && (n > 0 || u.projects.length === 1);
        return (
          <button key={pr.id} className={`opt check ${on ? 'on' : ''}`} role="menuitemcheckbox" aria-checked={on} disabled={lock} data-p={pr.id}
            onClick={() => void updateUser(u.id, { projects: on ? u.projects.filter((x) => x !== pr.id) : [...u.projects, pr.id] })}>
            <span className="cb">{on && I.check()}</span><Dot color={pr.color} />{pr.name}
            <span className="r">{lock ? (n > 0 ? `${n} open task${n > 1 ? 's' : ''}` : 'needs one') : ''}</span>
          </button>
        );
      })}
      <div className="pop-foot">To take someone off a project, first transfer their open tasks there.</div>
    </>
  );
}

function DisablePop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const open = Object.values(s.tasks).filter((t) => t.assigneeId === u.id && t.status === 'open');
  const projs = [...new Set(open.map((t) => t.projectId))];
  const admins = localUsers(s).filter((x) => x.status !== 'disabled' && x.role === 'admin').length;
  if (u.role === 'admin' && admins <= 1) return <><div className="pop-h">Can't disable the last admin</div><div className="pop-body">Make someone else an admin first.</div></>;
  const targets = localUsers(s).filter((x) => x.id !== u.id && x.status === 'active' && projs.every((pid) => onProject(x, pid)));
  const go = (to?: string) => { closePop(false); focusLater('[data-act="inv-open"]'); void disableUser(u.id, to); };
  return (
    <>
      <div className="pop-h">Disable {displayName(u)}?</div>
      <div className="pop-body">
        {u.status === 'invited' ? 'Their invite stops working and the address can\'t sign in.' : 'They can\'t sign in, and their assistants lose access.'}
        {' '}Their work and history stay, and you can enable them again from the People & projects page.
      </div>
      {open.length ? (
        <>
          <div className="pop-h">First, give their {open.length} open task{open.length > 1 ? 's' : ''} to</div>
          {targets.map((x) => (
            <button key={x.id} className="opt" onClick={() => go(x.id)}><Avatar user={x} />{displayName(x)}{x.id === s.me!.id && <span style={{ color: 'var(--faint)' }}> (you)</span>}<span className="r">then disable</span></button>
          ))}
          <div className="pop-foot">Only people on all of their projects are listed.</div>
        </>
      ) : <div style={{ padding: 4 }}><button className="btn-danger" data-act="do-disable" onClick={() => go()}>Disable</button></div>}
    </>
  );
}

/** Enable a disabled person again. Members pick their projects (preselected: the ones they had). */
function EnablePop({ p, s }: { p: Pop; s: State }) {
  const u = s.users[p.userId!];
  const all = localProjects(s).sort((a, b) => a.name.localeCompare(b.name));
  const [picked, setPicked] = useState<string[]>(() => u.projects.filter((id) => s.projects[id]));
  const member = u.role === 'member';
  const go = () => { closePop(false); focusLater('[data-act="disabled-toggle"]'); void enableUser(u.id, member ? picked : undefined); };
  return (
    <>
      <div className="pop-h">Enable {displayName(u)}?</div>
      <div className="pop-body">
        {member ? 'They can sign in again and see these projects:' : 'They can sign in again as an admin, with access to every project.'}
      </div>
      {member && all.map((pr) => {
        const on = picked.includes(pr.id);
        return (
          <button key={pr.id} className={`opt check ${on ? 'on' : ''}`} role="menuitemcheckbox" aria-checked={on} data-p={pr.id}
            onClick={() => setPicked(on ? picked.filter((x) => x !== pr.id) : [...picked, pr.id])}>
            <span className="cb">{on && I.check()}</span><Dot color={pr.color} />{pr.name}
          </button>
        );
      })}
      <div style={{ padding: 4 }}>
        <button className="btn-primary" data-act="do-enable" disabled={member && !picked.length} onClick={go}>
          {member && !picked.length ? 'Pick a project' : 'Enable'}
        </button>
      </div>
    </>
  );
}

function AccountPop({ s }: { s: State }) {
  const me = s.me!;
  return (
    <>
      <div className="pop-h" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Avatar user={me} size={30} />
        <span><b style={{ color: 'var(--text)', display: 'block' }}>{displayName(me)}</b><span style={{ fontWeight: 400 }}>{me.email} · {me.role === 'admin' ? 'Admin' : 'Member'}</span></span>
      </div>
      <div className="pop-sep" />
      <div className="theme-row">
        <span>Theme</span>
        <div className="seg sm" role="group" aria-label="Theme">
          {(['system', 'light', 'dark'] as ThemePref[]).map((t) => (
            <button key={t} className={s.theme === t ? 'on' : ''} aria-pressed={s.theme === t} data-act="theme" data-theme-opt={t}
              onClick={() => { setThemePref(t); set({ theme: t }); }}>{t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}</button>
          ))}
        </div>
      </div>
      <div className="pop-sep" />
      {s.pushKey && (
        <button className="opt" data-act="notify"
          onClick={() => { const a = document.querySelector<HTMLElement>('[data-act="account"]'); if (a) openPop({ type: 'notify', returnSel: '[data-act="account"]' }, a); }}>
          {I.bell(15)}Notifications<span className="r">{s.pushState === 'on' ? 'On' : s.pushState === 'blocked' ? 'Blocked' : 'Off'}</span>
        </button>
      )}
      <button className="opt" onClick={() => { closePop(false); openConnect(); }}>{I.bolt(15)}Connect an AI assistant</button>
      <button className="opt" data-act="instances" onClick={() => { closePop(false); set({ instancesOpen: true }); }}>{I.link(15)}Other instances{s.feeds.length > 0 && <span className="r">{s.feeds.length} connected</span>}</button>
      {isAdmin(me) && s.updateRepo && (
        <button className={`opt ${s.update ? 'opt-update' : ''}`} data-act="update"
          onClick={() => { const a = document.querySelector<HTMLElement>('[data-act="account"]'); if (a) openPop({ type: 'update', returnSel: '[data-act="account"]' }, a); }}>
          {s.update ? <>{I.arrowUp(15)}Update available<span className="r">{s.update.version}</span></> : <>{I.info(15)}Version {APP_VERSION}<span className="r">{s.latestRelease ? 'Up to date' : ''}</span></>}
        </button>
      )}
      {!isInstalled() && (s.canInstall ? (
        <button className="opt" data-act="install" onClick={() => { closePop(false); void installApp(); }}>{I.phone(15)}Install app</button>
      ) : isIOS() ? (
        <div className="opt-hint">{I.phone(15)}<span>To install: tap <b>Share</b>, then <b>Add to Home Screen</b>.</span></div>
      ) : null)}
      <button className="opt" onClick={() => void signOut()}>Sign out</button>
    </>
  );
}

/** Who follows a task: tick people on its project (whoever has it always hears about it). */
function FollowersPop({ p, s }: { p: Pop; s: State }) {
  const t = s.tasks[p.id!];
  if (!t) return null;
  const me = s.me!.id;
  const q = (p.q || '').toLowerCase();
  const list = assignable(s, t.projectId)
    .filter((u) => u.status === 'active' && (!q || `${u.name} ${u.email}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : displayName(a).localeCompare(displayName(b))));
  return (
    <>
      <div className="pop-h">Followers</div>
      <div style={{ padding: '0 4px' }}>
        <input className="pin" id="pop-q" placeholder="Search people" value={p.q || ''} autoComplete="off" onChange={(e) => updatePop({ q: e.target.value })} />
      </div>
      {list.length ? list.map((u) => {
        const has = u.id === t.assigneeId;
        const on = has || t.followers.includes(u.id);
        return (
          <button key={u.id} className={`opt check ${on ? 'on' : ''}`} role="menuitemcheckbox" aria-checked={on} disabled={has} data-u={u.id}
            onClick={() => void setFollowing(t.id, !on, u.id === me ? undefined : u.id)}>
            <span className="cb">{on && I.check()}</span><Avatar user={u} />{displayName(u)}{u.id === me && <span style={{ color: 'var(--faint)' }}> (you)</span>}
            <span className="r">{has ? 'has it' : u.id === t.createdBy ? 'created it' : ''}</span>
          </button>
        );
      }) : <div className="pop-empty">No one on this project matches.</div>}
      <div className="pop-foot">Followers hear about comments, when it's done or reopened, and when it's handed on. Commenting follows a task.</div>
    </>
  );
}

/** For admins: is there a newer release than the one this instance runs, and how to deploy it. */
function UpdatePop({ s }: { s: State }) {
  const u = s.update;
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (u) markUpdateSeen(u.version); }, [u]);
  const cmds = 'git pull\nnpm install\nnpm run deploy -- <instance>';
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const checked = s.updateCheckedAt ? new Date(s.updateCheckedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
  const copy = async () => { try { await navigator.clipboard.writeText(cmds); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* select it by hand */ } };
  return (
    <>
      <div className="pop-h">{u ? 'Update available' : 'Version'}</div>
      <div className="pop-body update-body">
        {u ? (
          <>
            <p><b>{u.version}</b> was released{u.publishedAt ? ` on ${when(u.publishedAt)}` : ''}. This instance runs <b>v{APP_VERSION}</b>{APP_COMMIT && <span className="muted"> ({APP_COMMIT})</span>}.</p>
            <a className="update-link" href={u.url} target="_blank" rel="noopener noreferrer">What's new {I.arrowR(13)}</a>
            <p>To update, in your copy of the app:</p>
            <pre className="update-cmds">{cmds}</pre>
            <div className="update-acts">
              <button className="btn-ghost sm" data-act="update-copy" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy commands'}</button>
              <span className="muted-s">Deploying applies any database changes first.</span>
            </div>
          </>
        ) : (
          <p>This instance runs <b>v{APP_VERSION}</b>{APP_COMMIT && <span className="muted"> ({APP_COMMIT})</span>}. {s.latestRelease ? "It's the latest release." : 'No releases have been published yet.'}</p>
        )}
      </div>
      <div className="pop-foot">
        Only admins see this. {checked ? `Checked ${checked}` : 'Not checked yet'} on <a href={`https://github.com/${s.updateRepo}/releases`} target="_blank" rel="noopener noreferrer">{s.updateRepo}</a>.{' '}
        <button className="linkish" data-act="update-check" disabled={s.updateChecking} onClick={() => void checkForUpdate(true)}>{s.updateChecking ? 'Checking…' : 'Check now'}</button>
      </div>
    </>
  );
}

/** Notifications: on or off for this device, and what to hear about (on all my devices). */
function NotifyPop({ s }: { s: State }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const st = s.pushState;
  const run = async (f: () => Promise<string | null | void>) => { setBusy(true); setMsg(null); const r = await f(); setBusy(false); if (r) setMsg(r); };
  const kinds: [keyof NotifyPrefs, string][] = [
    ['assigned', 'Someone gives me a task'],
    ['comments', 'Tasks I have or follow: comments, done, handed on'],
    ['morning', 'Morning summary at 8:00'],
  ];
  return (
    <>
      <div className="pop-h">Notifications on this device</div>
      <div className="pop-body notify-body">
        {st === 'on' && <>On. You'll hear about other people's changes, never your own.</>}
        {(st === 'off' || st === 'unknown') && <>Get a notification on this {isIOS() || /Android/.test(navigator.userAgent) ? 'phone' : 'device'} when something needs you.</>}
        {st === 'blocked' && <>Notifications are blocked for Taskivities. Allow them in {isIOS() ? 'Settings → Notifications → Taskivities' : "the browser's site settings"}, then come back here.</>}
        {st === 'install-first' && <>On iPhone and iPad, notifications only work in the installed app: tap <b>Share</b>, then <b>Add to Home Screen</b>, and open Taskivities from there.</>}
        {st === 'unsupported' && <>This browser can't show notifications. Try Chrome, Edge, Firefox or Safari, or the installed app.</>}
        {msg && <div className="notify-err" role="alert">{msg}</div>}
      </div>
      {(st === 'off' || st === 'unknown') && (
        <div style={{ padding: '2px 4px 6px' }}>
          <button className="btn-primary notify-btn" data-act="push-on" disabled={busy} onClick={() => void run(turnOnPush)}>{busy ? 'Turning on…' : 'Turn on'}</button>
        </div>
      )}
      {st === 'on' && (
        <div className="notify-acts">
          <button className="btn-ghost sm" data-act="push-test" disabled={busy}
            onClick={() => void run(async () => ((await testPush()) ? null : "The test didn't go through. Try turning notifications off and on."))}>Send a test</button>
          <button className="btn-ghost sm" data-act="push-off" disabled={busy} onClick={() => void run(turnOffPush)}>Turn off</button>
        </div>
      )}
      <div className="pop-sep" />
      <div className="pop-h">Tell me when <span style={{ fontWeight: 400 }}>· all my devices</span></div>
      {kinds.map(([k, label]) => (
        <button key={k} className={`opt check ${s.notify[k] ? 'on' : ''}`} role="menuitemcheckbox" aria-checked={s.notify[k]} data-notify={k}
          onClick={() => void setNotifyPrefs({ [k]: !s.notify[k] })}>
          <span className="cb">{s.notify[k] && I.check()}</span>{label}
        </button>
      ))}
    </>
  );
}

// ---------- repeating tasks ----------
function RepeatPop({ p, s }: { p: Pop; s: State }) {
  const qa = p.mode === 'qa';
  const t = qa ? null : s.tasks[p.id!];
  const base = qa ? s.draft.dueDate || defaultDraftDate(s) : t?.dueDate ?? s.today;
  const cur: Repeat | null = qa ? s.draft.repeat : t?.series?.active ? t.series.rule : null;
  const anchor = !qa && t?.series?.active ? t.series.anchor : base;
  const [custom, setCustom] = useState<Repeat | null>(null);
  const choose = (r: Repeat | null) => {
    closePop(true);
    if (qa) setDraft({ repeat: r });
    else if (!sameRule(r, cur)) void setRepeat(p.id!, r);
  };
  if (custom) return <CustomRepeat init={custom} base={base} onBack={() => setCustom(null)} onSave={choose} />;
  const list = presets(base);
  // Rules that read the same count as the same (weekly with no days = weekly on the due date's weekday).
  const isCur = (r: Repeat) => !!cur && (sameRule(r, cur) || describe(r, anchor) === describe(cur, anchor));
  const isPreset = !cur || list.some((x) => isCur(x.rule));
  return (
    <>
      <div className="pop-h">Repeat</div>
      {qa ? (
        <button className={`opt ${!cur ? 'cur' : ''}`} data-act="repeat-none" onClick={() => cur && choose(null)}>
          Doesn't repeat<span className="r">{!cur ? 'current' : ''}</span>
        </button>
      ) : (
        <button className="opt" data-act="repeat-none" title="It can't be turned back on" onClick={() => choose(null)}>Stop repeating</button>
      )}
      {list.map(({ label, rule }) => (
        <button key={label} className={`opt ${isCur(rule) ? 'cur' : ''}`} onClick={() => !isCur(rule) && choose(rule)}>
          {I.refresh(13)}{label}<span className="r">{isCur(rule) ? 'current' : ''}</span>
        </button>
      ))}
      {!isPreset && <button className="opt cur">{I.refresh(13)}{describe(cur!, anchor)}<span className="r">current</span></button>}
      <div className="pop-sep" />
      <button className="opt" data-act="repeat-custom" onClick={() => setCustom(cur ?? { freq: 'week', every: 1, days: [parseDate(base).getDay()] })}>
        Custom…
      </button>
      <div className="pop-foot">{qa ? 'Only one copy is open at a time. The next appears when this one is done.' : 'Stopping is permanent. This copy stays as a normal task.'}</div>
    </>
  );
}

const UNITS: [Freq, string][] = [['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']];
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function CustomRepeat({ init, base, onBack, onSave }: { init: Repeat; base: string; onBack: () => void; onSave: (r: Repeat) => void }) {
  const [r, setR] = useState<Repeat>(init);
  const [every, setEvery] = useState(String(init.every));
  const [ends, setEnds] = useState<'never' | 'on' | 'after'>(init.until ? 'on' : init.count ? 'after' : 'never');
  const [until, setUntil] = useState(init.until ?? addDays(base, 30));
  const [count, setCount] = useState(String(init.count ?? 10));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  const up = (x: Partial<Repeat>) => setR((o) => ({ ...o, ...x }));
  const dow = parseDate(base).getDay();
  const days = r.days?.length ? r.days : [dow];
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    if (next.length) up({ days: next });
  };
  const built = cleanRepeat({
    ...r,
    every: Number(every),
    days: r.freq === 'week' ? days : undefined,
    until: ends === 'on' ? until : null,
    count: ends === 'after' ? Number(count) : null,
  });
  const err = typeof built === 'string' ? built : built.until && built.until < base ? 'The end date is before the first one.' : null;
  const save = () => { if (!err && typeof built !== 'string') onSave(built); };
  const d = parseDate(base);
  const nth = Math.ceil(d.getDate() / 7);
  return (
    <div className="rp" onKeyDown={(e) => { if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); save(); } }}>
      <div className="pop-h">Custom repeat</div>
      <div className="rp-row">
        <span className="rp-l">Every</span>
        <input ref={first} className="pin rp-n" inputMode="numeric" aria-label="Interval" value={every}
          onChange={(e) => setEvery(e.target.value.replace(/\D/g, '').slice(0, 2))} />
        <div className="seg sm" role="group" aria-label="Unit">
          {UNITS.map(([u, l]) => (
            <button key={u} className={r.freq === u ? 'on' : ''} aria-pressed={r.freq === u} onClick={() => up({ freq: u })}>{Number(every) > 1 ? l : l.slice(0, -1)}</button>
          ))}
        </div>
      </div>
      {r.freq === 'week' && !r.afterDone && (
        <div className="rp-days" role="group" aria-label="On these days">
          {WEEK.map((x) => (
            <button key={x} className={days.includes(x) ? 'on' : ''} aria-pressed={days.includes(x)} aria-label={DOW[x]} onClick={() => toggleDay(x)}>{DOW[x].slice(0, 2)}</button>
          ))}
        </div>
      )}
      {r.freq === 'month' && !r.afterDone && (
        <div className="rp-row">
          <span className="rp-l">On</span>
          <div className="seg sm" role="group" aria-label="Day of the month">
            <button className={r.monthBy !== 'weekday' ? 'on' : ''} aria-pressed={r.monthBy !== 'weekday'} onClick={() => up({ monthBy: 'date' })}>Day {d.getDate()}</button>
            <button className={r.monthBy === 'weekday' ? 'on' : ''} aria-pressed={r.monthBy === 'weekday'} onClick={() => up({ monthBy: 'weekday' })}>
              {nth >= 5 ? 'Last' : ['1st', '2nd', '3rd', '4th'][nth - 1]} {DOW[dow]}
            </button>
          </div>
        </div>
      )}
      <div className="rp-row">
        <span className="rp-l">Next one</span>
        <div className="seg sm" role="group" aria-label="Count from">
          <button className={!r.afterDone ? 'on' : ''} aria-pressed={!r.afterDone} onClick={() => up({ afterDone: false })}>On schedule</button>
          <button className={r.afterDone ? 'on' : ''} aria-pressed={!!r.afterDone} onClick={() => up({ afterDone: true })}>After done</button>
        </div>
      </div>
      <div className="rp-row">
        <span className="rp-l">Ends</span>
        <div className="seg sm" role="group" aria-label="Ends">
          {(['never', 'on', 'after'] as const).map((x) => (
            <button key={x} className={ends === x ? 'on' : ''} aria-pressed={ends === x} onClick={() => setEnds(x)}>{x === 'never' ? 'Never' : x === 'on' ? 'On date' : 'After'}</button>
          ))}
        </div>
      </div>
      {ends === 'on' && (
        <div className="rp-row"><span className="rp-l" />
          <input className="pin" type="date" aria-label="Last date" min={base} value={until} onChange={(e) => setUntil(e.target.value)} /></div>
      )}
      {ends === 'after' && (
        <div className="rp-row"><span className="rp-l" />
          <input className="pin rp-n" inputMode="numeric" aria-label="Number of times" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 4))} />
          <span className="rp-l">times</span></div>
      )}
      <div className={`rp-sum ${err ? 'err' : ''}`} role="status">{err ?? describe(built as Repeat, base)}</div>
      <div className="rp-foot">
        <button className="btn-ghost sm" onClick={onBack}>Back</button>
        <button className="go sm" disabled={!!err} onClick={save}>Save</button>
      </div>
    </div>
  );
}

/** The ⋯ menu on an open task: actions that shouldn't be one click away. */
// ---------- pages (the ⋯ next to the logo) ----------
function PagesPop({ s }: { s: State }) {
  const admin = isAdmin(s.me!);
  const pages = [
    // Back to tasks from People & projects or Settings (the logo goes there too). People and projects are in the switcher.
    ...(s.page === 'team' || s.page === 'settings' ? [{ pg: 'tasks' as const, label: 'Tasks', icon: I.check(14), key: 'G T' }] : []),
    ...(admin ? [
      { pg: 'team' as const, label: 'People & projects', icon: I.users(15), key: 'G U' },
      { pg: 'settings' as const, label: 'Settings', icon: I.gear(15), key: 'G S' },
    ] : []),
  ];
  return (
    <div role="menu" aria-label="Pages">
      {pages.map((x) => (
        <button key={x.pg} role="menuitem" className={`opt${s.page === x.pg ? ' on' : ''}`} data-act="page" data-pg={x.pg}
          aria-current={s.page === x.pg ? 'page' : undefined} onClick={() => { closePop(false); setPage(x.pg); }}>
          {x.icon}{x.label}<span className="r">{x.key}</span>
        </button>
      ))}
    </div>
  );
}

function TaskMenu({ p, s }: { p: Pop; s: State }) {
  const t = s.tasks[p.id!];
  if (!t) return null;
  return (
    <>
      <button className="opt" data-act="menu-notes" onClick={() => { closePop(false); editNotes(t.id); }}>{I.list(15)}Notes<span className="r">⇧N</span></button>
      <button className="opt" data-act="menu-checklist" onClick={() => { closePop(false); editChecklist(t.id); }}>{I.check(14)}Checklist<span className="r">⇧C</span></button>
      {s.attachmentsOn && <button className="opt" data-act="menu-attach" onClick={() => { closePop(false); pickAttachments(t.id); }}>{I.clip(15)}Attach files<span className="r">⇧A</span></button>}
      <div className="pop-sep" />
      <button className="opt danger" data-act="archive" onClick={() => { closePop(false); void archiveTask(t.id); }}>
        {I.trash(15)}Archive task
      </button>
      <div className="pop-foot">Archived tasks are hidden everywhere and can be restored from the project's page.</div>
    </>
  );
}
