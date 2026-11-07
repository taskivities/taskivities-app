import { useEffect, useRef } from 'react';
import { fmt } from '../../shared/dates';
import { EMAIL_RE, isAdmin } from '../../shared/rules';
import { DESCRIPTION_MAX, PROJECT_COLORS, type Role } from '../../shared/types';
import { EFFORT_ORDER, EFFORT_TYPES, type EffortType } from '../../shared/effort';
import { MAILBOX, addPeople, archiveProject, connectInviteMail, copyInviteLink, loadArchivedProjects, openPop, resendInvite, restoreProject, saveProject, setManageTab, signInHow } from '../actions';
import { activeSelector, focusLater } from '../focus';
import { S, set, useStore, type ManageTab, type ProjEdit, type State } from '../store';
import { displayName, people } from '../util';
import { Avatar, I } from '../components/ui';

const openIn = (s: State, u: string, p?: string) =>
  Object.values(s.tasks).filter((t) => t.assigneeId === u && t.status === 'open' && (!p || t.projectId === p)).length;

/** Opens the project editor (a sheet that works on any page). `forDraft`: from the quick-add's project menu. */
export function openProjEdit(id: string | null, opts: { forDraft?: boolean } = {}) {
  const s = S();
  const p = id ? s.projects[id] : null;
  set({
    projEdit: {
      id, forDraft: opts.forDraft, name: p?.name ?? '', color: p?.color ?? PROJECT_COLORS[Object.keys(s.projects).length % PROJECT_COLORS.length],
      description: p?.description ?? '',
      effort: p?.effort ?? null, effortRequired: p?.effortRequired ?? false,
      members: id ? people(s).filter((u) => !isAdmin(u) && u.projects.includes(id)).map((u) => u.id) : [],
      err: null, returnSel: activeSelector(),
    },
  });
  focusLater('#pe-name');
}

export function TeamPage() {
  const s = useStore();
  if (!isAdmin(s.me!)) return <div className="empty-sec">Only admins can manage the team.</div>;
  const list = people(s).sort((a, b) => a.status.localeCompare(b.status) || Number(isAdmin(b)) - Number(isAdmin(a)) || displayName(a).localeCompare(displayName(b)));
  const admins = list.filter(isAdmin).length;
  const invited = list.filter((u) => u.status === 'invited').length;
  const projects = Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name));
  const disabled = Object.values(s.users).filter((u) => u.status === 'disabled')
    .sort((a, b) => (b.disabledAt ?? '').localeCompare(a.disabledAt ?? '') || displayName(a).localeCompare(displayName(b)));

  const tab = s.manageTab;
  const tabs: { id: ManageTab; label: string; n: number }[] = [
    { id: 'people', label: 'People', n: list.length },
    { id: 'projects', label: 'Projects', n: projects.length },
  ];
  // Tabs: ← → move between them (and switch), like other tab lists.
  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tabs[(tabs.findIndex((t) => t.id === tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    setManageTab(next);
    focusLater(`[data-act="mtab"][data-tab="${next}"]`);
  };

  return (
    <>
      <div className="phead">
        <div>
          <div className="h1 team-h">People &amp; projects</div>
          <div className="sub">
            {tab === 'people'
              ? <>{list.length} people · {admins} admin{admins === 1 ? '' : 's'}{invited > 0 && ` · ${invited} invited`}</>
              : <>{projects.length} project{projects.length === 1 ? '' : 's'} · who's on each one</>}
          </div>
        </div>
        {/* Just the tab's main action (no week controls), so no bar around it on phones. */}
        <div className="weeknav page-act">
          {tab === 'people' ? !s.invite && (
            <button className="btn-primary" data-act="inv-open"
              onClick={() => { set({ invite: { emails: '', role: 'member', projects: [], err: null } }); focusLater('#inv-emails'); }}>
              {I.plus(14)} Add people
            </button>
          ) : (
            <button className="btn-primary" data-act="pe-new" onClick={() => openProjEdit(null)}>{I.plus(14)} New project</button>
          )}
        </div>
      </div>
      <div className="mtabs" role="tablist" aria-label="People and projects" onKeyDown={onTabKey}>
        {tabs.map((t) => (
          <button key={t.id} role="tab" id={`mtab-${t.id}`} aria-controls={`mpanel-${t.id}`} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1}
            className={tab === t.id ? 'on' : ''} data-act="mtab" data-tab={t.id} onClick={() => setManageTab(t.id)}>
            {t.label}<span className="n">{t.n}</span>
          </button>
        ))}
      </div>
      {tab === 'people' ? (
        <section className="sec" role="tabpanel" id="mpanel-people" aria-labelledby="mtab-people">
          {s.invite && <InviteForm s={s} />}
        <div className="card team">
          <div className="trow th"><div>Person</div><div>Role</div><div>Projects</div><div>Status</div><div /></div>
          {list.map((u) => {
            const me = u.id === s.me!.id;
            return (
              <div key={u.id} className={`trow ${s.flash['u:' + u.id] ? 'flash' : ''}`}>
                <div className="tp">
                  <Avatar user={u} size={32} />
                  <div>
                    <b>{displayName(u)}{me && <span className="you"> (you)</span>}</b>
                    <span title={u.timeZone ? `Time zone: ${u.timeZone}` : undefined}>
                      {u.status === 'invited' ? 'Not signed in yet' : u.email}
                      {u.status !== 'invited' && u.timeZone && ` · ${u.timeZone.split('/').pop()!.replace(/_/g, ' ')}`}
                    </span>
                  </div>
                </div>
                <div>
                  <button className="chip" data-act="urole" data-u={u.id} disabled={me} title={me ? "You can't change your own role" : undefined}
                    onClick={(e) => openPop({ type: 'urole', userId: u.id }, e.currentTarget)}>
                    {u.role === 'admin' ? 'Admin' : 'Member'} {!me && I.chev()}
                  </button>
                </div>
                <div className="tproj">
                  {u.role === 'admin' ? <span className="allp">All projects</span> : (
                    <button className="pbtn" data-act="uproj" data-u={u.id} aria-label={`Projects for ${displayName(u)}`}
                      onClick={(e) => openPop({ type: 'uproj', userId: u.id }, e.currentTarget)}>
                      {u.projects.map((p) => s.projects[p] && <span key={p} className="proj"><i style={{ background: s.projects[p].color }} />{s.projects[p].name}</span>)}
                      <span className="pedit">{I.chev()}</span>
                    </button>
                  )}
                </div>
                <div className="tstat">
                  {u.status === 'invited' ? <span className="st inv">Invited · {fmt(u.addedAt.slice(0, 10)).split(', ')[1]}</span> : <span className="st ok">Active</span>}
                </div>
                <div className="tact">
                  {u.status === 'invited' && (s.inviteMail ? (
                    <button className="icon-btn" data-act="resend" title="Email the invite again" aria-label={`Email the invite to ${u.email} again`}
                      onClick={() => void resendInvite(u.id)}>{I.mail()}</button>
                  ) : (
                    <button className="icon-btn" data-act="copy-invite" title="Copy the sign-in link to send them" aria-label={`Copy the sign-in link for ${u.email}`}
                      onClick={() => void copyInviteLink()}>{I.link()}</button>
                  ))}
                  {!me && (
                    <button className="icon-btn" data-act="udisable" data-u={u.id} title="Disable" aria-label={`Disable ${displayName(u)}`}
                      onClick={(e) => openPop({ type: 'udisable', userId: u.id }, e.currentTarget)}>{I.ban()}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
          {disabled.length > 0 && <DisabledPeople s={s} list={disabled} />}
          <p className="fine">Admins see every project and manage people. Members see and work on tasks only in their projects, and can only assign tasks to people on the same project.</p>
        </section>
      ) : (
        <section className="sec" role="tabpanel" id="mpanel-projects" aria-labelledby="mtab-projects">
        <div className="card">
          {projects.map((p) => {
            const ppl = people(s).filter((u) => u.status === 'active' && !isAdmin(u) && u.projects.includes(p.id));
            return (
              <div key={p.id} className={`prow ${s.flash['p:' + p.id] ? 'flash' : ''}`}>
                <i style={{ background: p.color }} />
                <div className="pname">
                  <b>{p.name}</b>
                  <span className="pdesc" title={p.description}>{p.description || <em>No description yet. AI assistants will guess what belongs here.</em>}</span>
                </div>
                <span className="avs">{ppl.map((u) => <Avatar key={u.id} user={u} size={22} />)}</span>
                <span className="n">{ppl.length} member{ppl.length === 1 ? '' : 's'} + admins</span>
                <span className="n">{Object.values(s.tasks).filter((t) => t.projectId === p.id && t.status === 'open').length} open</span>
                <button className="btn-ghost sm" data-act="pe-open" data-p={p.id} aria-label={`Edit ${p.name}`} onClick={() => openProjEdit(p.id)}>Edit</button>
              </div>
            );
          })}
          {!projects.length && <div className="prow"><span className="n">No projects yet. Create the first one.</span></div>}
        </div>
          <ArchivedProjects s={s} />
        </section>
      )}
    </>
  );
}

/** Disabled people: they can't sign in, but their history stays. Collapsed by default; each can be enabled again. */
function DisabledPeople({ s, list }: { s: State; list: State['users'][string][] }) {
  return (
    <div className="sub-sec">
      <button className="collapsed" data-act="disabled-toggle" aria-expanded={s.disabledOpen} onClick={() => set({ disabledOpen: !s.disabledOpen })}>
        <span className="dn">Disabled</span> can't sign in · their work and history stay
        <span className="sum">{list.length} {list.length === 1 ? 'person' : 'people'} {!s.disabledOpen && I.chev()}</span>
      </button>
      {s.disabledOpen && (
        <div className="card arch-list" style={{ marginTop: 8 }}>
          {list.map((u) => (
            <div key={u.id} className={`arch-row ${s.flash['u:' + u.id] ? 'flash' : ''}`}>
              <Avatar user={u} size={28} />
              <div className="arch-main">
                <b>{displayName(u)}</b>
                <span>
                  {u.email}{u.email && ' · '}{u.role === 'admin' ? 'Admin' : u.projects.map((p) => s.projects[p]?.name).filter(Boolean).join(', ') || 'No projects'}
                  {u.disabledAt && <> · disabled{u.disabledBy && s.users[u.disabledBy] ? ` by ${displayName(s.users[u.disabledBy])}` : ''}, {fmt(u.disabledAt.slice(0, 10))}</>}
                </span>
              </div>
              <button className="btn-ghost sm" data-act="uenable" data-u={u.id} aria-label={`Enable ${displayName(u)}`} onClick={(e) => openPop({ type: 'uenable', userId: u.id }, e.currentTarget)}>Enable</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Archived projects: hidden from everyone with all their tasks. Collapsed by default; each can be restored. */
function ArchivedProjects({ s }: { s: State }) {
  const n = Object.keys(s.projects).length;
  useEffect(() => { void loadArchivedProjects(); }, [n]);
  const list = s.archivedProjects;
  if (!list?.length) return null;
  return (
    <div className="sub-sec">
      <button className="collapsed" data-act="archproj-toggle" aria-expanded={s.archProjOpen} onClick={() => set({ archProjOpen: !s.archProjOpen })}>
        <span className="dn">Archived</span> hidden from everyone, with their tasks
        <span className="sum">{list.length} project{list.length > 1 ? 's' : ''} {!s.archProjOpen && I.chev()}</span>
      </button>
      {s.archProjOpen && (
        <div className="card arch-list" style={{ marginTop: 8 }}>
          {list.map((p) => (
            <div key={p.id} className="arch-row">
              <i className="arch-dot" style={{ background: p.color }} />
              <div className="arch-main">
                <b>{p.name}</b>
                <span>
                  {p.done} done · {p.open} open
                  {p.archivedAt && <> · archived{p.archivedBy && s.users[p.archivedBy] ? ` by ${displayName(s.users[p.archivedBy])}` : ''}, {fmt(p.archivedAt.slice(0, 10))}</>}
                </span>
              </div>
              <button className="btn-ghost sm" data-act="prestore" data-p={p.id} aria-label={`Restore ${p.name}`} onClick={() => void restoreProject(p.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InviteForm({ s }: { s: State }) {
  const inv = s.invite!;
  const ref = useRef<HTMLInputElement>(null);
  const upd = (p: Partial<NonNullable<State['invite']>>) => set((st) => ({ invite: st.invite ? { ...st.invite, ...p } : null }));
  const close = () => { set({ invite: null }); focusLater('[data-act="inv-open"]'); };
  const submit = async () => {
    const emails = [...new Set(inv.emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (!emails.length) { upd({ err: 'Enter at least one email address.' }); ref.current?.focus(); return; }
    if (bad.length) { upd({ err: `Not a valid email: ${bad.join(', ')}` }); ref.current?.focus(); return; }
    if (inv.role === 'member' && !inv.projects.length) { upd({ err: 'Pick at least one project for a member.' }); return; }
    upd({ busy: true, err: null });
    try {
      await addPeople(emails, inv.role, inv.projects);
      close();
    } catch (e) {
      upd({ busy: false, err: e instanceof Error ? e.message : 'Could not add.' });
    }
  };
  const setRole = (role: Role) => upd({ role, err: null });
  return (
    <div className="invite card" role="group" aria-label="Add people"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <label className="lbl" htmlFor="inv-emails">Email addresses</label>
      <input id="inv-emails" ref={ref} className="inv-in" placeholder="name@yourcompany.com, someone@client.com" autoComplete="off"
        value={inv.emails} onChange={(e) => upd({ emails: e.target.value, err: null })}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }} />
      {inv.err && <div className="inv-err" role="alert">{inv.err}</div>}
      <div className="inv-grid">
        <div>
          <div className="lbl">Role</div>
          <div className="seg sm">
            <button className={inv.role === 'member' ? 'on' : ''} onClick={() => setRole('member')}>Member</button>
            <button className={inv.role === 'admin' ? 'on' : ''} onClick={() => setRole('admin')}>Admin</button>
          </div>
        </div>
        <div>
          <div className="lbl">Projects</div>
          {inv.role === 'admin' ? <div className="muted-s">Admins can see every project and manage the team.</div> : (
            <div className="pchips">
              {Object.values(s.projects).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
                const on = inv.projects.includes(p.id);
                return (
                  <button key={p.id} className={`pchip ${on ? 'on' : ''}`} aria-pressed={on}
                    onClick={() => upd({ err: null, projects: on ? inv.projects.filter((x) => x !== p.id) : [...inv.projects, p.id] })}>
                    <i style={{ background: p.color }} />{p.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="inv-foot">
        <span className="muted-s inv-mail">
          {s.inviteMail
            ? <>{I.mail(13)} We'll email them an invite from {s.inviteMail.email}.</>
            : <>
                They {signInHow(s)} using exactly this address.
                {s.inviteMailOptions[0] && <>
                  {' '}<button className="linkish" data-act={`${s.inviteMailOptions[0]}-connect`} onClick={() => connectInviteMail(s.inviteMailOptions[0], '/manage')}>
                    Connect {MAILBOX[s.inviteMailOptions[0]].name}
                  </button> to email invites automatically.
                </>}
              </>}
        </span>
        <button className="btn-ghost" onClick={close}>Cancel</button>
        <button className="btn-primary" disabled={inv.busy} onClick={() => void submit()}>{inv.busy ? 'Adding…' : 'Add'}</button>
      </div>
    </div>
  );
}

export function ProjectEditor({ pe, s }: { pe: ProjEdit; s: State }) {
  const isNew = !pe.id;
  const upd = (p: Partial<ProjEdit>) => set((st) => ({ projEdit: st.projEdit ? { ...st.projEdit, ...p } : null }));
  const close = () => { const r = pe.returnSel; set({ projEdit: null }); focusLater(r); };
  const save = async () => {
    if (!pe.name.trim()) { upd({ err: 'Give the project a name.' }); focusLater('#pe-name'); return; }
    upd({ busy: true, err: null });
    const r = await saveProject({ id: pe.id, name: pe.name.trim(), color: pe.color, description: pe.description.trim(), members: pe.members, effort: pe.effort, effortRequired: pe.effortRequired });
    if ('error' in r) { upd({ busy: false, err: r.error }); focusLater('#pe-name'); return; }
    // A new project shows up where it was asked for: picked in a project's view, or in the quick-add.
    const fresh = !pe.id;
    set((st) => ({
      projEdit: null,
      ...(fresh && st.page === 'projects' ? { projSel: r.id } : {}),
      ...(fresh && pe.forDraft ? { draft: { ...st.draft, projectId: r.id } } : {}),
    }));
    focusLater(pe.returnSel);
  };
  const members = people(s).filter((u) => !isAdmin(u));
  const openHere = pe.id ? Object.values(s.tasks).filter((t) => t.projectId === pe.id && t.status === 'open').length : 0;
  const archive = async () => {
    upd({ busy: true, err: null });
    const err = await archiveProject(pe.id!);
    if (err) { upd({ busy: false, archiving: false, err }); return; }
    focusLater(S().page === 'projects' ? '[data-act="proj-pick"]' : '[data-act="pe-new"]');
  };
  return (
    <>
      <div className="backdrop" onClick={close} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="pe-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); close(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (e.target as HTMLElement).id === 'pe-name')) { e.preventDefault(); void save(); }
        }}>
        <div className="help-h"><b id="pe-title">{isNew ? 'New project' : 'Edit project'}</b><span className="muted" />
          <button className="icon-btn" aria-label="Close" onClick={close}>{I.x()}</button></div>
        <div className="sheet-b">
          <label className="lbl" htmlFor="pe-name">Name</label>
          <input id="pe-name" className="inv-in" value={pe.name} placeholder="e.g. Website Redesign" autoComplete="off" onChange={(e) => upd({ name: e.target.value, err: null })} />
          {pe.err && <div className="inv-err" role="alert">{pe.err}</div>}
          <div className="lbl">Color</div>
          <div className="swatches" role="radiogroup" aria-label="Color">
            {PROJECT_COLORS.map((c) => (
              <button key={c} className={`sw ${c === pe.color ? 'on' : ''}`} style={{ ['--c' as string]: c }} role="radio" aria-checked={c === pe.color}
                aria-label={`Color ${c}`} onClick={() => upd({ color: c })} />
            ))}
          </div>
          <label className="lbl" htmlFor="pe-desc">Description <span className="muted">· read mainly by AI assistants</span></label>
          <textarea id="pe-desc" className="pe-desc" maxLength={DESCRIPTION_MAX} value={pe.description} onChange={(e) => upd({ description: e.target.value })}
            placeholder={'What work belongs here, what doesn\'t, and how tasks are usually named. For example: Redesign of the marketing site: pages, copy, imagery, SEO. Not the app or blog. Titles start with the page, e.g. "Pricing: update FAQ".'} />
          <div className="pe-help">
            <span>{I.bolt()} Assistants connected over MCP (like Claude) read this to decide which project a new task belongs in and what a project is about. People see it as a tooltip.</span>
            <span className="pe-count">{pe.description.length}/{DESCRIPTION_MAX}</span>
          </div>
          <div className="lbl" id="pe-effort-l">Effort <span className="muted">· how this project measures the work in a task</span></div>
          <div className="pchips" role="radiogroup" aria-labelledby="pe-effort-l">
            {([null, ...EFFORT_ORDER] as (EffortType | null)[]).map((k) => (
              <button key={k ?? 'none'} className={`pchip ${pe.effort === k ? 'on' : ''}`} role="radio" aria-checked={pe.effort === k} data-act="pe-effort" data-e={k ?? 'none'}
                onClick={() => upd({ effort: k, ...(k ? {} : { effortRequired: false }) })}>
                {k ? EFFORT_TYPES[k].name : 'Not tracked'}
              </button>
            ))}
          </div>
          {pe.effort && (
            <div className="pe-effort">
              <span className="muted-s">{EFFORT_TYPES[pe.effort].hint}.</span>
              <label className="pe-req">
                <input type="checkbox" data-act="pe-effort-req" checked={pe.effortRequired} onChange={(e) => upd({ effortRequired: e.target.checked })} />
                Required before a task is marked done
              </label>
            </div>
          )}
          {pe.id && s.projects[pe.id]?.effort && pe.effort !== s.projects[pe.id]?.effort && (
            <div className="muted-s pe-effort">Effort already recorded as {EFFORT_TYPES[s.projects[pe.id].effort!].name.toLowerCase()} is kept, and shows again if you switch back.</div>
          )}
          <div className="lbl">Members <span className="muted">· admins are on every project</span></div>
          <div className="pchips">
            {members.map((u) => {
              const on = pe.members.includes(u.id);
              const n = pe.id ? openIn(s, u.id, pe.id) : 0;
              const lock = on && !!pe.id && (n > 0 || u.projects.length === 1);
              return (
                <button key={u.id} className={`pchip ${on ? 'on' : ''}`} aria-pressed={on} disabled={lock}
                  title={lock ? (n > 0 ? 'Has open tasks here' : 'Needs at least one project') : undefined}
                  onClick={() => upd({ members: on ? pe.members.filter((x) => x !== u.id) : [...pe.members, u.id] })}>
                  <Avatar user={u} size={18} />{displayName(u)}
                </button>
              );
            })}
            {!members.length && <span className="muted-s">No members yet. Add people on this page first.</span>}
          </div>
        </div>
        {pe.archiving ? (
          <div className="inv-foot sheet-f pe-arch" role="alert">
            <span className="muted-s">
              Archive {pe.name || 'this project'}? It's hidden from everyone{openHere ? `, with its ${openHere} open task${openHere > 1 ? 's' : ''}` : ''}, until you restore it {s.page === 'team' ? 'from this page' : 'on the People & projects page'}. Nothing is deleted.
            </span>
            <button className="btn-ghost" onClick={() => { upd({ archiving: false }); focusLater('[data-act="pe-archive"]'); }}>Cancel</button>
            <button className="btn-danger" data-act="pe-archive-yes" disabled={pe.busy} onClick={() => void archive()}>{pe.busy ? 'Archiving…' : 'Archive'}</button>
          </div>
        ) : (
          <div className="inv-foot sheet-f">
            {!isNew && <button className="btn-ghost pe-arch-btn" data-act="pe-archive" onClick={() => { upd({ archiving: true, err: null }); focusLater('[data-act="pe-archive-yes"]'); }}>{I.archive()} Archive</button>}
            <span className="muted-s"><span className="kbd-i">⌘ Enter</span> to save</span>
            <button className="btn-ghost" onClick={close}>Cancel</button>
            <button className="btn-primary" disabled={pe.busy} onClick={() => void save()}>{pe.busy ? 'Saving…' : isNew ? 'Create project' : 'Save'}</button>
          </div>
        )}
      </div>
    </>
  );
}
