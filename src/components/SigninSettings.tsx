// Settings → Sign-in (admins): how people sign in here, the sender for emailed codes, and the drive pickers' keys.
// Saved encrypted on the server (worker/signin-settings.ts). Secret values never come back: a saved one shows as
// "ends in …"; leave its box empty to keep it. New Google, Microsoft or WorkOS credentials are saved only after a real
// sign-in with them works ("Save and test"), so a typo can't lock everyone out.
import { type ReactNode, useEffect, useState } from 'react';
import type { SigninProvider, SigninSettings as Data } from '../../shared/types';
import { ApiError, api } from '../api';
import { toast, toastError } from '../actions';

interface Field { key: string; label: string; secret?: boolean; toggle?: string; placeholder?: string; help?: ReactNode }
interface Part {
  id: SigninProvider;
  title: string;
  /** On, as the server sees it (null: not a way in, e.g. drive keys). */
  on: (d: Data) => boolean | null;
  about: ReactNode;
  fields: Field[];
  /** Addresses to paste into the provider's console. */
  paste?: (d: Data) => [string, string][];
  save: string;
  /** What "Turn off" clears (none: no such button). */
  off?: string[];
}

const PARTS: Part[] = [
  {
    id: 'email', title: 'Email codes', on: (d) => d.on.code, save: 'Save and send a test email', off: ['EMAIL_CODES'],
    about: <>People type their address and get a 6-digit code to sign in with. No Google or Microsoft account needed. Codes are sent
      through <a href="https://resend.com" target="_blank" rel="noreferrer">Resend</a>: add your domain there, then create an API key
      with permission to send.</>,
    fields: [
      { key: 'EMAIL_CODES', label: 'Let people sign in with a code sent to their email', toggle: 'on' },
      { key: 'RESEND_API_KEY', label: 'Resend API key', secret: true, placeholder: 're_…' },
      { key: 'MAIL_FROM', label: 'From address', placeholder: 'tasks@yourcompany.com', help: 'On a domain verified in Resend.' },
      { key: 'MAIL_FROM_NAME', label: 'From name' },
    ],
  },
  {
    id: 'google', title: 'Google', on: (d) => d.on.google, save: 'Save and test', off: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    about: <>Anyone with a Google account (Gmail or Google Workspace). In the <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google
      Cloud console</a>: Create credentials → OAuth client ID → Web application, with the redirect URI below.</>,
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', placeholder: '….apps.googleusercontent.com' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
    paste: (d) => [['Authorized redirect URI', d.redirects.google]],
  },
  {
    id: 'microsoft', title: 'Microsoft 365', on: (d) => d.on.microsoft, save: 'Save and test', off: ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID'],
    about: <>Your organization's Microsoft accounts (Entra ID), and guests it invited. In the <a href="https://entra.microsoft.com" target="_blank" rel="noreferrer">Entra
      admin center</a>: App registrations → New registration, single tenant, with the Web redirect URI below; then add a client secret.</>,
    fields: [
      { key: 'MS_CLIENT_ID', label: 'Application (client) ID' },
      { key: 'MS_CLIENT_SECRET', label: 'Client secret (its Value)', secret: true },
      { key: 'MS_TENANT_ID', label: 'Directory (tenant) ID, or one of its domains', placeholder: 'contoso.com' },
    ],
    paste: (d) => [['Redirect URI (Web)', d.redirects.microsoft]],
  },
  {
    id: 'workos', title: 'WorkOS AuthKit', on: (d) => d.on.workos, save: 'Save and test', off: ['WORKOS_CLIENT_ID', 'WORKOS_API_KEY'],
    about: <>A hosted sign-in page from <a href="https://workos.com/authkit" target="_blank" rel="noreferrer">WorkOS</a> that can offer passkeys,
      other providers and its own email codes. Shown as "Continue with email".</>,
    fields: [
      { key: 'WORKOS_CLIENT_ID', label: 'Client ID', placeholder: 'client_…' },
      { key: 'WORKOS_API_KEY', label: 'API key', secret: true, placeholder: 'sk_…' },
    ],
    paste: (d) => [['Redirect URI', d.redirects.workos], ['Sign-in endpoint', d.redirects.workosSignin]],
  },
  {
    id: 'files', title: 'Files from Google Drive and OneDrive', on: () => null, save: 'Save',
    about: <>Lets people attach files from their drives. Google Drive needs Google sign-in plus the Picker's API key and the Cloud project's
      number; OneDrive needs Microsoft 365 sign-in and the extra steps in the README.</>,
    fields: [
      { key: 'GOOGLE_PICKER_API_KEY', label: 'Google Picker API key', secret: true },
      { key: 'GOOGLE_APP_ID', label: 'Google Cloud project number' },
      { key: 'MS_FILES', label: 'OneDrive and SharePoint are set up on the Microsoft app registration', toggle: 'on' },
    ],
    paste: (d) => [['Authorized JavaScript origin (Google)', d.redirects.pickerOrigin], ['SPA redirect URI (Microsoft)', d.redirects.onedrive]],
  },
];

export function SigninSettings() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.get<Data>('/api/admin/signin').then(setD).catch((e) => setErr(e instanceof Error ? e.message : 'Could not load the sign-in settings.'));
  }, []);
  const ways = d ? [d.on.code && 'Email codes', d.on.google && 'Google', d.on.microsoft && 'Microsoft', d.on.workos && 'WorkOS'].filter(Boolean).join(' · ') : '';
  const startOver = async () => {
    if (!confirm('Forget the saved sign-in settings and invite mailboxes, and enter them again? This can’t be undone.')) return;
    try { setD(await api.post<Data>('/api/admin/signin/start-over')); toast('Started over. Enter the sign-in settings again.'); } catch (e) { toastError(e); }
  };
  return (
    <section className="sec">
      <div className="sec-h"><h2>Sign-in</h2><span className="cnt">{ways || (d ? 'Nothing set up' : '')}</span></div>
      {err && <div className="set-err" role="alert">{err}</div>}
      {d?.status === 'no_key' && (
        <div className="set-note" role="status">These come from the deployment's settings on this instance, so they can't be changed here. Add a
          <b> TOKEN_KEY</b> line to its <code>tenants/&lt;instance&gt;.env</code> (or deploy again with the latest version, which adds one) to
          manage them here; the current values move over by themselves.</div>
      )}
      {d?.status === 'short_key' && (
        <div className="set-note" role="status">This instance's TOKEN_KEY is too short to protect saved settings (it needs 32 characters or more),
          so these come from the deployment's settings and can't be changed here.</div>
      )}
      {d?.status === 'key_changed' && (
        <div className="set-err" role="alert">
          This instance's TOKEN_KEY changed, and the saved sign-in settings can't be read with the new one. Deploy with the old key as
          <b> TOKEN_KEY_OLD</b> (next to the new TOKEN_KEY) and they move over by themselves. If the old key is lost, start over and
          enter them again. Until then, people sign in with the deployment's settings, if it has any.
          <div className="set-actions" style={{ marginTop: 10 }}><button className="btn-ghost" data-act="signin-start-over" onClick={() => void startOver()}>Start over…</button></div>
        </div>
      )}
      {d && (
        <div className="card ss-card">
          {PARTS.map((p) => <PartView key={p.id} part={p} d={d} readOnly={d.status !== 'ok'} onSaved={setD} />)}
        </div>
      )}
    </section>
  );
}

function PartView({ part, d, readOnly, onSaved }: { part: Part; d: Data; readOnly: boolean; onSaved: (d: Data) => void }) {
  const on = part.on(d);
  const anySet = part.fields.some((f) => d.fields[f.key]?.set);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const value = (f: Field) => draft[f.key] ?? (f.secret ? '' : d.fields[f.key]?.value ?? '');
  const changed = Object.keys(draft).length > 0;

  const send = async (body: Record<string, string>, done: string) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.put<Data | { test: string }>(`/api/admin/signin/${part.id}`, body);
      if ('test' in r) { location.href = r.test; return; }
      onSaved(r); setDraft({}); setOpen(false); toast(done);
    } catch (e) {
      setErr(e instanceof ApiError || e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  const save = () => void send(draft, `${part.title}: saved.`);
  const off = () => void send(Object.fromEntries((part.off ?? []).map((k) => [k, ''])), `${part.title}: turned off.`);

  return (
    <div className={`ss-part${open ? ' open' : ''}`} data-part={part.id}>
      <div className="ss-head">
        <b>{part.title}</b>
        {on !== null && <span className={`ss-pill${on ? ' on' : ''}`}>{on ? 'On' : 'Off'}</span>}
        {on === null && anySet && <span className="ss-pill on">Set up</span>}
        <button className="btn-ghost sm" data-act={`signin-${part.id}-open`} onClick={() => { setOpen(!open); setErr(null); setDraft({}); }}>
          {open ? 'Close' : readOnly ? 'View' : on || anySet ? 'Change' : 'Set up'}
        </button>
      </div>
      {open && (
        <div className="ss-body">
          <p>{part.about}</p>
          {part.paste && (
            <div className="ss-paste">
              {part.paste(d).map(([label, v]) => (
                <div key={label}>
                  <span>{label}</span>
                  <code>{v}</code>
                  <button className="btn-ghost sm" onClick={() => void navigator.clipboard.writeText(v).then(() => toast('Copied.'))}>Copy</button>
                </div>
              ))}
            </div>
          )}
          {part.fields.map((f) => f.toggle ? (
            <label key={f.key} className="ss-check">
              <input type="checkbox" disabled={readOnly} checked={value(f) === f.toggle} data-act={`signin-${f.key}`}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked ? f.toggle! : '' })} />
              {f.label}
            </label>
          ) : (
            <label key={f.key} className="ss-field">
              <span>{f.label}</span>
              <input className="inv-in" type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} disabled={readOnly}
                data-act={`signin-${f.key}`} value={value(f)}
                placeholder={f.secret && d.fields[f.key]?.set ? `Saved, ends in ${d.fields[f.key].hint}. Type to replace it.`
                  : f.key === 'MAIL_FROM_NAME' ? d.defaultFromName : f.placeholder ?? ''}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })} />
              {f.help && <small>{f.help}</small>}
            </label>
          ))}
          {err && <div className="set-err" role="alert">{err}</div>}
          {!readOnly && (
            <div className="set-actions">
              <button className="btn-primary" data-act={`signin-${part.id}-save`} disabled={busy || !changed} onClick={save}>{busy ? 'Saving…' : part.save}</button>
              {part.off && on && <button className="btn-ghost" data-act={`signin-${part.id}-off`} disabled={busy} onClick={off}>Turn off</button>}
            </div>
          )}
          {!readOnly && part.save === 'Save and test' && (
            <p className="ss-small">You'll sign in with {part.title} once to check it works (any account will do); only then is it saved. If the
              provider shows an error instead, go back: nothing changes.</p>
          )}
        </div>
      )}
    </div>
  );
}
