import { useEffect, useRef, useState } from 'react';
import { isAdmin } from '../../shared/rules';
import { MAILBOX, connectInviteMail, createHook, disconnectInviteMail, loadHooks, openHook, resetIcon, resetLogo, resetWordmark, saveAppName, uploadIcon, uploadLogo, uploadWordmark } from '../actions';
import { ICON_SIZES, NAME_MAX, appName } from '../../shared/types';
import { hookStatus } from '../components/WebhookSheet';
import { logoUrl } from '../brand';
import { I, LogoMark, Wordmark } from '../components/ui';
import { useStore } from '../store';

const MAX_KB = 256;

/** Checks the file in the browser first (the server checks again): SVG only, and it must actually draw. */
async function readSvg(file: File, what = 'logo'): Promise<string> {
  if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') throw new Error('Only SVG files are supported.');
  if (file.size > MAX_KB * 1024) throw new Error(`The ${what} must be under ${MAX_KB} KB.`);
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.nodeName.toLowerCase() !== 'svg') throw new Error("That file isn't a valid SVG.");
  const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((ok, fail) => {
      const img = new Image();
      img.onload = () => ok();
      img.onerror = () => fail(new Error("That SVG can't be displayed. Try exporting it again."));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  return text;
}

/**
 * Trims a wordmark to what it actually draws: many SVGs have empty space around the lettering, which would push it
 * off-centre on the sign-in page and make it look small in the top bar. The browser measures the drawing (with a copy
 * stripped of scripts and event handlers, so measuring can't run anything) and tightens the viewBox around it.
 */
function trimSvg(text: string): string {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  const probe = document.importNode(root, true) as unknown as SVGSVGElement;
  probe.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
  for (const el of [probe, ...probe.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:2000px;height:2000px;visibility:hidden;pointer-events:none';
  host.appendChild(probe);
  document.body.appendChild(host);
  try {
    const b = probe.getBBox();
    if (!(b.width > 0 && b.height > 0)) return text;
    const pad = b.height * 0.04; // room for strokes and anti-aliasing
    root.setAttribute('viewBox', [b.x - pad, b.y - pad, b.width + 2 * pad, b.height + 2 * pad].map((n) => +n.toFixed(2)).join(' '));
    root.removeAttribute('width');
    root.removeAttribute('height');
    return new XMLSerializer().serializeToString(doc);
  } catch {
    return text;
  } finally {
    host.remove();
  }
}

export function SettingsPage() {
  const s = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isAdmin(s.me!)) return <div className="empty-sec">Only admins can change settings.</div>;
  const { customLogo, logoVersion } = s.settings;
  const app = appName(s.settings);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setBusy(true);
    try {
      setErr(await uploadLogo(await readSvg(f)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  return (
    <>
      <div className="phead">
        <div>
          <div className="h1 team-h">Settings</div>
          <div className="sub">These apply to everyone on the team. Only admins can change them.</div>
        </div>
      </div>
      <section className="sec">
        <div className="sec-h"><h2>Logo</h2><span className="cnt">{customLogo ? 'Custom' : 'Built-in'}</span></div>
        <div className="card set-card">
          <div className="set-prev" aria-label="Preview">
            <div className="sp-head"><LogoMark version={logoVersion} /><Wordmark /></div>
            <div className="sp-tab"><img src={logoUrl(logoVersion)} alt="" />{appName(s.settings)}<span className="x">×</span></div>
          </div>
          <div className="set-body">
            <p>Shown in the header, on the sign-in page and as the browser tab icon. <b>SVG only</b>, up to {MAX_KB} KB. A square logo works best.</p>
            <div className="set-actions">
              <button className="btn-primary" data-act="logo-upload" disabled={busy} onClick={() => file.current?.click()}>
                {busy ? 'Uploading…' : customLogo ? 'Replace logo…' : 'Upload SVG logo…'}
              </button>
              {customLogo && <button className="btn-ghost" data-act="logo-reset" disabled={busy} onClick={() => { setErr(null); void resetLogo(); }}>Use the built-in logo</button>}
            </div>
            {err && <div className="set-err" role="alert">{err}</div>}
            <input ref={file} type="file" accept=".svg,image/svg+xml" hidden aria-hidden="true" tabIndex={-1}
              onChange={(e) => void pick(e.target.files?.[0])} />
          </div>
        </div>
      </section>
      <AppName />
      <AppIcon />
      <Webhooks />
      <section className="sec">
        <div className="sec-h"><h2>Invite emails</h2><span className="cnt">{s.inviteMail ? 'On' : 'Off'} · just for you</span></div>
        <div className="card set-card">
          <div className="set-body">
            {s.inviteMail ? (
              <p>When you add people, {app} emails them an invite from <b>{s.inviteMail.email}</b> through your {MAILBOX[s.inviteMail.via].name}. A copy is in your Sent folder, and replies come to you.</p>
            ) : s.inviteMailOptions.length ? (
              <p>Connect your {s.inviteMailOptions.map((v) => MAILBOX[v].name).join(' or ')} and {app} emails people an invite from your address when you add them. Until then, you send them the sign-in link yourself.
                {' '}{s.inviteMailOptions.map((v) => MAILBOX[v].company).join(' or ')} will ask you to allow <b>sending email</b> on your behalf: {app} can't read your mail.</p>
            ) : (
              <p>Emailing invites needs Google or Microsoft sign-in set up on this instance. Until then, you send people the sign-in link yourself.</p>
            )}
            <div className="set-actions">
              {s.inviteMail ? (
                <button className="btn-ghost" data-act="invite-mail-disconnect" onClick={() => void disconnectInviteMail()}>Disconnect {MAILBOX[s.inviteMail.via].name}</button>
              ) : s.inviteMailOptions.map((v, i) => (
                <button key={v} className={i === 0 ? 'btn-primary' : 'btn-ghost'} data-act={`${v}-connect`} onClick={() => connectInviteMail(v, '/settings')}>
                  {I.mail(14)} Connect {MAILBOX[v].name}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** The team's name in place of "Taskivities", and optionally a wordmark image for the top bar. */
function AppName() {
  const s = useStore();
  const { name, customWordmark, wordmarkVersion, logoVersion } = s.settings;
  const [text, setText] = useState(name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setText(name), [name]);
  const draft = text.replace(/\s+/g, ' ').trim();
  const changed = draft !== name;
  const save = async (value: string) => {
    setBusy(true); setErr(null);
    setErr(await saveAppName(value));
    setBusy(false);
  };
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setBusy(true);
    try {
      setErr(await uploadWordmark(trimSvg(await readSvg(f, 'wordmark'))));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <section className="sec">
      <div className="sec-h"><h2>Name</h2><span className="cnt">{customWordmark ? 'Wordmark' : name ? 'Custom' : 'Built-in'}</span></div>
      <div className="card set-card">
        <div className="set-prev" aria-label="Preview">
          <div className="sp-head"><LogoMark version={logoVersion} /><Wordmark settings={{ name: draft, customWordmark, wordmarkVersion }} /></div>
          <div className="sp-tab"><img src={logoUrl(logoVersion)} alt="" />{draft || 'Taskivities'}<span className="x">×</span></div>
        </div>
        <div className="set-body">
          <p>Your team's name for the app. It replaces <b>TASKIVITIES</b> in the top bar, and is the name on the sign-in page, in the browser tab, under the home-screen icon and in invite emails.</p>
          <div className="set-actions name-row">
            <input className="inv-in" data-act="name-input" aria-label="App name" placeholder="Taskivities" maxLength={NAME_MAX} value={text}
              onChange={(e) => { setText(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && changed) { e.preventDefault(); void save(draft); } }} />
            <button className="btn-primary" data-act="name-save" disabled={busy || !changed} onClick={() => void save(draft)}>Save</button>
            {name && <button className="btn-ghost" data-act="name-reset" disabled={busy} onClick={() => { setText(''); void save(''); }}>Use Taskivities</button>}
          </div>
          <p className="set-sub">Or upload a <b>wordmark</b>: your name as a wide SVG image, shown in the top bar and on the sign-in page instead of the text. The name above is still used everywhere else.</p>
          <div className="set-actions">
            <button className="btn-ghost" data-act="wordmark-upload" disabled={busy} onClick={() => file.current?.click()}>
              {customWordmark ? 'Replace wordmark…' : 'Upload SVG wordmark…'}
            </button>
            {customWordmark && <button className="btn-ghost" data-act="wordmark-reset" disabled={busy} onClick={() => { setErr(null); void resetWordmark(); }}>Remove wordmark</button>}
          </div>
          {err && <div className="set-err" role="alert">{err}</div>}
          <input ref={file} type="file" accept=".svg,image/svg+xml" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
      </div>
    </section>
  );
}

function Webhooks() {
  const s = useStore();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void loadHooks(); }, []);
  const add = async () => {
    if (!name.trim()) { setErr('Give it a name, like "GitHub issues".'); return; }
    try { await createHook(name.trim()); setName(''); setErr(null); } catch (e) { setErr(e instanceof Error ? e.message : 'Could not create it.'); }
  };
  return (
    <section className="sec">
      <div className="sec-h"><h2>Webhooks</h2><span className="cnt">Create tasks from other services</span></div>
      <div className="card hk-card">
        <p className="hk-intro">Give another service (GitHub, a form, Zapier, your own app…) an address to send requests to. A new webhook first collects a few
          sample requests; you click their fields to decide what each task says, then it goes live and every request becomes a task.</p>
        {s.hooks?.map((h) => {
          const [label, cls] = hookStatus(h);
          return (
            <div key={h.id} className="hk-item">
              <b>{h.name}</b>
              <span className={`hk-st ${cls}`}>{label}</span>
              <span className="muted-s">{h.lastReceivedAt ? `Last request ${new Date(h.lastReceivedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'No requests yet'}</span>
              <button className="btn-ghost sm" data-act="hook-open" onClick={() => openHook(h.id)}>Open</button>
            </div>
          );
        })}
        <div className="hk-new">
          <input className="pin" placeholder='New webhook name, e.g. "GitHub issues"' aria-label="New webhook name" value={name} maxLength={80}
            onChange={(e) => { setName(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
          <button className="btn-primary" data-act="hook-new" onClick={() => void add()}>{I.plus(14)} New webhook</button>
        </div>
        {err && <div className="set-err" role="alert">{err}</div>}
      </div>
    </section>
  );
}

/**
 * Resizes an uploaded image to each home-screen icon size (PNG). Non-square images are centred on white;
 * transparent areas become white too, since iPhones would show them as black.
 */
async function makeIcons(file: File): Promise<{ icons: Record<number, string>; small: boolean }> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error('Choose a PNG image (JPEG and WebP work too).');
  if (file.size > 10 * 1024 * 1024) throw new Error('That image is over 10 MB.');
  let img: ImageBitmap;
  try { img = await createImageBitmap(file); } catch { throw new Error("That image couldn't be read."); }
  const icons: Record<number, string> = {};
  for (const size of ICON_SIZES) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.imageSmoothingQuality = 'high';
    const scale = Math.min(size / img.width, size / img.height);
    const w = img.width * scale, h = img.height * scale;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    const blob = await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("That image couldn't be converted."))), 'image/png'));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    icons[size] = btoa(bin);
  }
  return { icons, small: Math.min(img.width, img.height) < 512 };
}

function AppIcon() {
  const s = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { customIcon, iconVersion } = s.settings;
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null); setNote(null); setBusy(true);
    try {
      const { icons, small } = await makeIcons(f);
      const e = await uploadIcon(icons);
      setErr(e);
      if (!e && small) setNote('That image is smaller than 512×512, so the icon may look a little soft. A larger square PNG works best.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  return (
    <section className="sec">
      <div className="sec-h"><h2>App icon</h2><span className="cnt">{customIcon ? 'Custom' : 'Built-in'} · phone home screens</span></div>
      <div className="card set-card">
        <div className="set-prev icon-prev" aria-label="Preview">
          <div className="ip-phone">
            <img src={`/icons/180.png?v=${iconVersion}`} alt="" />
            <span>{appName(s.settings)}</span>
          </div>
        </div>
        <div className="set-body">
          <p>Shown when someone adds {appName(s.settings)} to their phone's home screen, and in app switchers. <b>A square PNG, 512×512 or larger</b>, works best.
            Phones round the corners themselves; transparent areas become white.</p>
          <div className="set-actions">
            <button className="btn-primary" data-act="icon-upload" disabled={busy} onClick={() => file.current?.click()}>
              {busy ? 'Uploading…' : customIcon ? 'Replace icon…' : 'Upload PNG icon…'}
            </button>
            {customIcon && <button className="btn-ghost" data-act="icon-reset" disabled={busy} onClick={() => { setErr(null); setNote(null); void resetIcon(); }}>Use the built-in icon</button>}
          </div>
          {err && <div className="set-err" role="alert">{err}</div>}
          {note && <div className="set-note" role="status">{note}</div>}
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
        </div>
      </div>
    </section>
  );
}
