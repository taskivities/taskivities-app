import { useEffect, useMemo, useRef, useState } from 'react';
import { localProjects, localUsers } from '../feeds';
import { fmt } from '../../shared/dates';
import { isAdmin } from '../../shared/rules';
import { PRIORITIES, type Priority, type WebhookInfo, type WebhookRequestInfo } from '../../shared/types';
import { type Mapping, evaluate, leaves } from '../../shared/webhook';
import { closeHook, deleteHook, hookRequests, replayHookRequest, rotateHook, saveHook, toast } from '../actions';
import { type State, useStore } from '../store';
import { displayName } from '../util';
import { I } from './ui';

/** Mapping fields that take a {{field}} template, and fields that take a single field path. */
type Target = 'title' | 'notes' | 'assignee' | 'due' | 'priority' | 'when' | 'dedupe';
const TEMPLATE: Target[] = ['title', 'notes'];
const TARGET_LABEL: Record<Target, string> = {
  title: 'Title', notes: 'Notes', assignee: 'Assignee field', due: 'Due date field', priority: 'Priority field', when: '"Only when" field', dedupe: 'Duplicate check field',
};

const RESULT: Record<WebhookRequestInfo['result'], [string, string]> = {
  captured: ['Sample', 'cap'], created: ['Task created', 'ok'], skipped: ['Skipped', 'skip'],
  duplicate: ['Duplicate', 'skip'], error: ['Error', 'err'], paused: ['Paused', 'skip'],
};

export const hookStatus = (h: WebhookInfo): [string, string] =>
  !h.mapping ? (h.lastReceivedAt ? ['Capturing samples', 'cap'] : ['Waiting for a request', 'cap']) : h.active ? ['Live', 'ok'] : ['Paused', 'skip'];

const time = (iso: string) => {
  const d = new Date(iso);
  return `${fmt(iso.slice(0, 10)).split(', ')[1] ?? ''} ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
};

function blankMapping(s: State): Mapping {
  const projectId = localProjects(s).sort((a, b) => a.name.localeCompare(b.name))[0]?.id ?? '';
  return { title: '', notes: '', projectId, assignee: { userId: s.me!.id }, due: { mode: 'today' }, priority: { value: 3 }, when: null, dedupePath: null };
}

export function WebhookSheet() {
  const s = useStore();
  const h = s.hooks?.find((x) => x.id === s.hookEdit);
  const [reqs, setReqs] = useState<WebhookRequestInfo[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [m, setM] = useState<Mapping>(() => h?.mapping ?? blankMapping(s));
  const [name, setName] = useState(h?.name ?? '');
  const [target, setTarget] = useState<Target>('title');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const inputs = useRef<Partial<Record<Target, HTMLInputElement | HTMLTextAreaElement | null>>>({});

  // Recent requests, refreshed every few seconds while the editor is open (so a test request shows up by itself).
  useEffect(() => {
    if (!h) return;
    let stop = false;
    const load = () => hookRequests(h.id).then((r) => { if (!stop) setReqs(r); }).catch(() => undefined);
    void load();
    const t = setInterval(() => !document.hidden && void load(), 4000);
    return () => { stop = true; clearInterval(t); };
  }, [h?.id]);
  useEffect(() => { if (reqs?.length && (!sel || !reqs.some((r) => r.id === sel))) setSel(reqs[0].id); }, [reqs]);
  useEffect(() => { document.querySelector<HTMLElement>('#hk-name')?.focus(); }, []);

  const members = useMemo(
    () => localUsers(s).filter((u) => u.status !== 'disabled' && (isAdmin(u) || u.projects.includes(m.projectId))).sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [s.users, m.projectId],
  );
  if (!h) return null;
  const req = reqs?.find((r) => r.id === sel) ?? null;
  const fields = req ? leaves(req.request).filter(([p, v]) => !filter || `${p} ${v}`.toLowerCase().includes(filter.toLowerCase())) : [];
  const preview = req && m.title.trim() ? evaluate(m, req.request, { today: s.today, members: members.map((u) => ({ id: u.id, email: u.email, name: u.name })) }) : null;
  const [statusText, statusCls] = hookStatus(h);
  const changed = JSON.stringify(m) !== JSON.stringify(h.mapping ?? blankMapping(s));

  const up = (p: Partial<Mapping>) => { setErr(null); setM((o) => ({ ...o, ...p })); };
  /** Clicking a field: templates get {{path}} at the cursor; the other targets get the path itself. */
  const use = (path: string) => {
    const el = inputs.current[target];
    if (TEMPLATE.includes(target)) {
      const key = target as 'title' | 'notes';
      const cur = m[key] ?? '';
      const at = el && document.activeElement === el ? el.selectionStart ?? cur.length : cur.length;
      const ins = `{{${path}}}`;
      const next = cur.slice(0, at) + ins + cur.slice(at);
      up({ [key]: next } as Partial<Mapping>);
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + ins.length, at + ins.length); });
    } else {
      if (target === 'assignee') up({ assignee: { ...m.assignee, fromPath: path } });
      if (target === 'due') up({ due: { mode: 'path', path } });
      if (target === 'priority') up({ priority: { ...m.priority, fromPath: path } });
      if (target === 'when') up({ when: { path, equals: m.when?.equals ?? '' } });
      if (target === 'dedupe') up({ dedupePath: path });
      requestAnimationFrame(() => el?.focus());
    }
  };
  const focusProps = (t: Target) => ({ ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => { inputs.current[t] = el; }, onFocus: () => setTarget(t) });

  const save = async (patch: Parameters<typeof saveHook>[1], msg: string) => {
    setBusy(true);
    setErr(null);
    try {
      const w = await saveHook(h.id, patch);
      if (patch.mapping !== undefined) setM(w.mapping ?? blankMapping(s));
      toast(msg);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const saveName = () => { const n = name.trim(); if (n && n !== h.name) void save({ name: n }, 'Renamed'); else setName(h.name); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(h.url); toast('Address copied'); } catch { toast(`Copy this address: ${h.url}`, undefined, true); }
  };

  return (
    <>
      <div className="backdrop" onClick={closeHook} />
      <div className="sheet hook" role="dialog" aria-modal="true" aria-labelledby="hk-title">
        <div className="help-h">
          <b id="hk-title">Webhook</b><span className={`hk-st ${statusCls}`}>{statusText}</span><span className="muted" />
          <button className="icon-btn cn-close" aria-label="Close" onClick={closeHook}>{I.x()}</button>
        </div>
        <div className="sheet-b hk-b">
          <div className="hk-head">
            <div className="hk-name">
              <label className="lbl" htmlFor="hk-name">Name</label>
              <input id="hk-name" className="pin" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }} />
            </div>
            <div className="hk-url">
              <div className="lbl">Address <span className="muted">· secret: anyone with it can create tasks</span></div>
              <div className="cn-url">
                <code>{h.url}</code>
                <button className="btn-primary sm" data-act="hook-copy" onClick={() => void copy()}>Copy</button>
                <button className="btn-ghost sm" title="Make a new address. The old one stops working." onClick={() => void rotateHook(h.id)}>New address</button>
              </div>
            </div>
          </div>
          <p className="cn-small">
            Paste this address into the other service's webhook settings (it should send <b>POST</b> requests, JSON or form data).
            {h.mapping ? ' Each request creates a task as set up on the right.' : ' Then send a test request: it appears below, and you click its fields to decide what the task says.'}
          </p>

          <div className="hk-cols">
            <section className="hk-reqs" aria-label="Recent requests">
              <div className="lbl">Recent requests <span className="muted">· last 15 · updates by itself</span></div>
              {!reqs ? <div className="muted-s">Loading…</div> : !reqs.length ? (
                <div className="hk-empty">Waiting for the first request…<br /><span>Send a test from the other service, or try:<br /><code>curl -X POST -H 'content-type: application/json' -d '{`{"title":"Hello"}`}' {h.url}</code></span></div>
              ) : (
                <div className="hk-list" role="listbox" aria-label="Requests">
                  {reqs.map((r) => {
                    const [label, cls] = RESULT[r.result];
                    return (
                      <button key={r.id} role="option" aria-selected={r.id === sel} className={`hk-req ${r.id === sel ? 'on' : ''}`} onClick={() => setSel(r.id)} title={r.detail ?? undefined}>
                        <span className="t">{time(r.receivedAt)}</span><span className="m">{r.method}</span><span className={`hk-st ${cls}`}>{label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {req && (
                <>
                  {req.detail && <div className={`hk-detail ${req.result === 'error' ? 'err' : ''}`}>{req.detail}</div>}
                  <div className="hk-fields-h">
                    <span className="lbl">Fields</span>
                    <input className="pin hk-find" placeholder="Find a field" aria-label="Find a field" value={filter} onChange={(e) => setFilter(e.target.value)} />
                  </div>
                  <div className="hk-hint">Click a field to put it in <b>{TARGET_LABEL[target]}</b>.</div>
                  <div className="hk-fields">
                    {fields.map(([p, v]) => (
                      <button key={p} className="hk-f" onClick={() => use(p)} title={`Use ${p}`}>
                        <span className="p">{p}</span><span className="v">{v.length > 90 ? `${v.slice(0, 90)}…` : v || <i>empty</i>}</span>
                      </button>
                    ))}
                    {!fields.length && <div className="muted-s">No fields match.</div>}
                  </div>
                </>
              )}
            </section>

            <section className="hk-map" aria-label="Task to create">
              <div className="lbl">Create a task</div>
              <label className="hk-l" htmlFor="hk-title-t">Title <span>· text and {'{{fields}}'}</span></label>
              <input id="hk-title-t" className={`pin ${target === 'title' ? 'tgt' : ''}`} value={m.title} placeholder="e.g. Fix: {{body.issue.title}}" {...focusProps('title')} onChange={(e) => up({ title: e.target.value })} />
              <label className="hk-l" htmlFor="hk-notes">Notes</label>
              <textarea id="hk-notes" className={`pin hk-ta ${target === 'notes' ? 'tgt' : ''}`} value={m.notes ?? ''} placeholder="e.g. {{body.issue.html_url}}" {...focusProps('notes')} onChange={(e) => up({ notes: e.target.value })} />

              <div className="hk-grid">
                <label className="hk-l" htmlFor="hk-proj">Project</label>
                <select id="hk-proj" value={m.projectId} onChange={(e) => {
                  const projectId = e.target.value;
                  const ok = localUsers(s).some((u) => u.id === m.assignee.userId && (isAdmin(u) || u.projects.includes(projectId)));
                  up({ projectId, assignee: ok ? m.assignee : { ...m.assignee, userId: s.me!.id } });
                }}>
                  {localProjects(s).sort((a, b) => a.name.localeCompare(b.name)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>

                <label className="hk-l" htmlFor="hk-who">Assignee</label>
                <div className="hk-row">
                  <select id="hk-who" value={m.assignee.userId} onChange={(e) => up({ assignee: { ...m.assignee, userId: e.target.value } })}>
                    {members.map((u) => <option key={u.id} value={u.id}>{displayName(u)}</option>)}
                  </select>
                  <input className={`pin hk-path ${target === 'assignee' ? 'tgt' : ''}`} placeholder="or from field (email or name)" aria-label="Assignee field"
                    value={m.assignee.fromPath ?? ''} {...focusProps('assignee')} onChange={(e) => up({ assignee: { ...m.assignee, fromPath: e.target.value || undefined } })} />
                </div>

                <label className="hk-l" htmlFor="hk-due">Due</label>
                <div className="hk-row">
                  <select id="hk-due" value={m.due.mode} onChange={(e) => up({ due: { mode: e.target.value as Mapping['due']['mode'], days: m.due.days ?? 1, path: m.due.path } })}>
                    <option value="today">Today</option>
                    <option value="days">Days from now</option>
                    <option value="path">From a field</option>
                  </select>
                  {m.due.mode === 'days' && (
                    <input className="pin hk-num" type="number" min={0} max={365} aria-label="Days from now" value={m.due.days ?? 1}
                      onChange={(e) => up({ due: { mode: 'days', days: Math.max(0, Math.min(365, Number(e.target.value) || 0)) } })} />
                  )}
                  {m.due.mode === 'path' && (
                    <input className={`pin hk-path ${target === 'due' ? 'tgt' : ''}`} placeholder="field with a date (missing: today)" aria-label="Due date field"
                      value={m.due.path ?? ''} {...focusProps('due')} onChange={(e) => up({ due: { mode: 'path', path: e.target.value } })} />
                  )}
                </div>

                <label className="hk-l" htmlFor="hk-prio">Priority</label>
                <div className="hk-row">
                  <select id="hk-prio" value={m.priority.value} onChange={(e) => up({ priority: { ...m.priority, value: Number(e.target.value) as Priority } })}>
                    {([1, 2, 3, 4] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITIES[p].name}</option>)}
                  </select>
                  <input className={`pin hk-path ${target === 'priority' ? 'tgt' : ''}`} placeholder="or from field (high, P1, 2…)" aria-label="Priority field"
                    value={m.priority.fromPath ?? ''} {...focusProps('priority')} onChange={(e) => up({ priority: { ...m.priority, fromPath: e.target.value || undefined } })} />
                </div>

                <label className="hk-l" htmlFor="hk-when">Only when</label>
                <div className="hk-row">
                  <input id="hk-when" className={`pin hk-path ${target === 'when' ? 'tgt' : ''}`} placeholder="field (optional)" value={m.when?.path ?? ''} {...focusProps('when')}
                    onChange={(e) => up({ when: e.target.value ? { path: e.target.value, equals: m.when?.equals ?? '' } : null })} />
                  <span className="hk-eq">is</span>
                  <input className="pin hk-path" placeholder="value, e.g. opened" aria-label="Only when the field is" value={m.when?.equals ?? ''} disabled={!m.when?.path}
                    onChange={(e) => up({ when: { path: m.when!.path, equals: e.target.value } })} />
                </div>

                <label className="hk-l" htmlFor="hk-dedupe">Skip repeats</label>
                <input id="hk-dedupe" className={`pin hk-path ${target === 'dedupe' ? 'tgt' : ''}`} placeholder="field that identifies the item, e.g. body.issue.id (optional)"
                  value={m.dedupePath ?? ''} {...focusProps('dedupe')} onChange={(e) => up({ dedupePath: e.target.value || null })} />
              </div>

              <div className="lbl" style={{ marginTop: 14 }}>Preview <span className="muted">· {req ? 'from the selected request' : 'select a request to see one'}</span></div>
              <div className={`hk-prev ${preview?.kind ?? ''}`} role="status">
                {!preview ? <span className="muted-s">{req ? 'Add a title to see the task.' : 'No request yet.'}</span>
                  : preview.kind === 'skip' ? <>Skipped: {preview.reason}</>
                  : preview.kind === 'error' ? <>{preview.error}</>
                  : (
                    <>
                      <b>{preview.task.title}</b>
                      <span>{s.projects[preview.task.projectId]?.name} · {displayName(s.users[preview.task.assigneeId])} · due {fmt(preview.task.dueDate)} · {PRIORITIES[preview.task.priority].name}</span>
                      {preview.task.notes && <span className="n">{preview.task.notes.length > 160 ? `${preview.task.notes.slice(0, 160)}…` : preview.task.notes}</span>}
                      {preview.warnings.map((w) => <span key={w} className="w">{w}</span>)}
                    </>
                  )}
              </div>
              {err && <div className="set-err" role="alert">{err}</div>}
            </section>
          </div>
        </div>
        <div className="sheet-f hk-foot">
          <button className={`btn-ghost ${confirmDel ? 'danger' : ''}`} onClick={() => (confirmDel ? void deleteHook(h.id) : setConfirmDel(true))} onBlur={() => setConfirmDel(false)}>
            {confirmDel ? 'Click again to delete' : 'Delete webhook'}
          </button>
          {h.mapping && (
            <>
              <button className="btn-ghost" onClick={() => void save({ active: !h.active }, h.active ? 'Paused: requests are logged but make no tasks' : 'Live again')}>{h.active ? 'Pause' : 'Resume'}</button>
              <button className="btn-ghost" title="Stop creating tasks and go back to collecting samples" onClick={() => void save({ mapping: null }, 'Back to collecting samples')}>Stop &amp; edit samples</button>
            </>
          )}
          <span className="sp" />
          {h.mapping && req && !changed && (
            <button className="btn-ghost" title="Run this request through the mapping now" onClick={() => void replayHookRequest(h.id, req.id)}>Create task from this request</button>
          )}
          <button className="btn-primary" disabled={busy || !m.title.trim() || (!changed && !!h.mapping)} onClick={() => void save({ mapping: m }, h.mapping ? 'Mapping saved' : "Live: new requests now create tasks")}>
            {busy ? 'Saving…' : h.mapping ? 'Save changes' : 'Save & go live'}
          </button>
        </div>
      </div>
    </>
  );
}
