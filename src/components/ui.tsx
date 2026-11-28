import type { CSSProperties, ReactNode } from 'react';
import { type AppSettings, PRIORITIES, type Priority, type Project, type User, appName } from '../../shared/types';
import { logoUrl, wordmarkUrl } from '../brand';
import { useStore } from '../store';
import { WORDMARK_SVG } from '../wordmark';
import { displayName } from '../util';

const Svg = ({ s = 16, sw = 1.6, children }: { s?: number; sw?: number; children: ReactNode }) => (
  <svg viewBox="0 0 16 16" width={s} height={s} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const I = {
  check: (s = 12) => <Svg s={s} sw={2.2}><path d="M3.6 8.4l2.9 2.9 5.9-6.6" /></Svg>,
  cal: (s = 15) => <Svg s={s}><rect x="2.5" y="3.5" width="11" height="10" rx="2" /><path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" /></Svg>,
  swap: (s = 15) => <Svg s={s}><circle cx="6" cy="5.2" r="2.4" /><path d="M1.8 13.4c.5-2.3 2.2-3.5 4.2-3.5 1 0 1.9.3 2.6.8" /><path d="M10.5 11.5h4.5M13 9.5l2 2-2 2" /></Svg>,
  chev: (s = 14) => <Svg s={s}><path d="M4.5 6.3L8 9.8l3.5-3.5" /></Svg>,
  left: (s = 16) => <Svg s={s}><path d="M9.8 3.5L5.3 8l4.5 4.5" /></Svg>,
  right: (s = 16) => <Svg s={s}><path d="M6.2 3.5L10.7 8l-4.5 4.5" /></Svg>,
  dots: (s = 16) => <svg viewBox="0 0 16 16" width={s} height={s} aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="8" r="1.35" /><circle cx="8" cy="8" r="1.35" /><circle cx="12.5" cy="8" r="1.35" /></svg>,
  x: (s = 16) => <Svg s={s}><path d="M4 4l8 8M12 4l-8 8" /></Svg>,
  plus: (s = 18) => <Svg s={s} sw={2}><path d="M8 3v10M3 8h10" /></Svg>,
  minus: (s = 18) => <Svg s={s} sw={2}><path d="M3 8h10" /></Svg>,
  eye: (s = 16) => <Svg s={s}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></Svg>,
  arrowR: (s = 14) => <Svg s={s}><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" /></Svg>,
  bolt: (s = 15) => <Svg s={s}><path d="M9 1.8L3.5 9H8l-1 5.2L12.5 7H8z" /></Svg>,
  refresh: (s = 13) => <Svg s={s}><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" /></Svg>,
  list: (s = 14) => <Svg s={s}><path d="M5.5 4h8M5.5 8h8M5.5 12h8" /><circle cx="2.6" cy="4" r=".6" fill="currentColor" /><circle cx="2.6" cy="8" r=".6" fill="currentColor" /><circle cx="2.6" cy="12" r=".6" fill="currentColor" /></Svg>,
  gantt: (s = 14) => <Svg s={s} sw={2.2}><path d="M2.5 4h5M5.5 8h6M8.5 12h5" /></Svg>,
  board: (s = 14) => <Svg s={s}><rect x="1.8" y="2.5" width="3.4" height="11" rx="1" /><rect x="6.3" y="2.5" width="3.4" height="7.5" rx="1" /><rect x="10.8" y="2.5" width="3.4" height="9.5" rx="1" /></Svg>,
  sun: (s = 14) => <Svg s={s}><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></Svg>,
  kbd: (s = 17) => <Svg s={s}><rect x="1.5" y="4" width="13" height="8.5" rx="1.8" /><path d="M4 6.6h.01M6.7 6.6h.01M9.3 6.6h.01M12 6.6h.01M4.5 9.9h7" /></Svg>,
  chat: (s = 15) => <Svg s={s}><path d="M3 3.5h10a1.5 1.5 0 0 1 1.5 1.5v5.5A1.5 1.5 0 0 1 13 12H7l-3 2.5V12H3a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 3 3.5z" /></Svg>,
  clip: (s = 15) => <Svg s={s}><path d="M13.2 7.6l-5.3 5.3a3.3 3.3 0 0 1-4.7-4.7l5.6-5.6a2.2 2.2 0 0 1 3.1 3.1L6.4 11.2a1.1 1.1 0 0 1-1.6-1.6L9.9 4.5" /></Svg>,
  upload: (s = 15) => <Svg s={s}><path d="M8 10.5v-8M4.8 5.7L8 2.5l3.2 3.2M3 13.5h10" /></Svg>,
  download: (s = 15) => <Svg s={s}><path d="M8 2.5v8M4.8 7.6L8 10.8l3.2-3.2M3 13.5h10" /></Svg>,
  phone: (s = 15) => <Svg s={s}><rect x="4.5" y="1.5" width="7" height="13" rx="1.8" /><path d="M7.2 12.2h1.6" /></Svg>,
  mail: (s = 15) => <Svg s={s}><rect x="2" y="3.5" width="12" height="9" rx="1.8" /><path d="M2.5 4.5L8 8.6l5.5-4.1" /></Svg>,
  link: (s = 15) => <Svg s={s}><path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9" /></Svg>,
  folder: (s = 15) => <Svg s={s}><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.5 1.6h4.7A1.5 1.5 0 0 1 14 6.1v5.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /></Svg>,
  users: (s = 15) => <Svg s={s}><circle cx="6" cy="5.5" r="2.3" /><path d="M1.8 13.2c.4-2.2 2.1-3.5 4.2-3.5s3.8 1.3 4.2 3.5" /><path d="M10.4 3.4a2.2 2.2 0 0 1 0 4.2M12 9.9c1.2.5 2 1.6 2.2 3.3" /></Svg>,
  gear: (s = 15) => <Svg s={s}><circle cx="8" cy="8" r="2.1" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></Svg>,
  gauge: (s = 18) => <Svg s={s}><path d="M2.5 11.5a5.5 5.5 0 1 1 11 0" /><path d="M8 11.5l2.6-3.4" /></Svg>,
  play: (s = 15) => <Svg s={s}><path d="M5 3.2v9.6l7.6-4.8z" /></Svg>,
  stopSq: (s = 15) => <Svg s={s}><rect x="4" y="4" width="8" height="8" rx="1.4" /></Svg>,
  copy: (s = 18) => <Svg s={s}><rect x="5.5" y="5.5" width="8" height="8" rx="1.8" /><path d="M10.5 3.2V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.2" /></Svg>,
  trash: (s = 15) => <Svg s={s}><path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.3 4.3l.6 9h6.2l.6-9" /></Svg>,
  edit: (s = 15) => <Svg s={s}><path d="M10.6 2.9l2.5 2.5-7.4 7.4-3.1.6.6-3.1z" /><path d="M9.2 4.3l2.5 2.5" /></Svg>,
  bell: (s = 15) => <Svg s={s}><path d="M4 11.2V7.4a4 4 0 0 1 8 0v3.8l1.2 1.3H2.8zM6.6 14a1.5 1.5 0 0 0 2.8 0" /></Svg>,
  arrowUp: (s = 15) => <Svg s={s}><path d="M8 13V3M3.8 7.2 8 3l4.2 4.2" /></Svg>,
  info: (s = 15) => <Svg s={s}><circle cx="8" cy="8" r="5.8" /><path d="M8 7.3v3.6M8 5.1v.1" /></Svg>,
  ban: (s = 15) => <Svg s={s}><circle cx="8" cy="8" r="5.6" /><path d="M4 4l8 8" /></Svg>,
  target: (s = 15) => <Svg s={s}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="3.2" /><circle cx="8" cy="8" r=".6" fill="currentColor" /></Svg>,
  archive: (s = 15) => <Svg s={s}><rect x="2" y="2.8" width="12" height="3.2" rx="1" /><path d="M3.2 6v6.2a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V6M6.5 8.6h3" /></Svg>,
};

/** The app's logo: config/logo.svg if there is one, otherwise the built-in mark. */
/** The team's logo (uploaded on the Settings page, or the built-in one). Outside the app (sign-in page) pass no version. */
export function LogoMark({ big = false, version }: { big?: boolean; version?: string }) {
  return <img className={`logo-img${big ? ' big' : ''}`} src={logoUrl(version)} alt="" />;
}

/**
 * The name in the top bar: the team's uploaded wordmark, else their name as text, else the built-in TASKIVITIES
 * lettering (letters follow the text colour; the K is a green check). `settings`: to preview unsaved choices.
 */
export function Wordmark({ settings }: { settings?: Pick<AppSettings, 'name' | 'customWordmark' | 'wordmarkVersion'> }) {
  const stored = useStore((st) => st.settings);
  const s = settings ?? stored;
  if (s.customWordmark) return <span className="wordmark-wrap"><img className="wordmark-img" src={wordmarkUrl(s.wordmarkVersion)} alt={appName(s)} /></span>;
  if (s.name) return <span className="wordmark-wrap"><span className="wordmark-text">{s.name}</span></span>;
  return <span className="wordmark-wrap" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} />;
}

export function Avatar({ user, size = 22 }: { user: User | undefined; size?: number }) {
  const name = displayName(user);
  const initials = (user?.name || user?.email || '?').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  return (
    <span className="av" style={{ '--s': `${size}px`, background: user?.color ?? '#A0A0AB' } as CSSProperties} title={name}>
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" /> : initials}
    </span>
  );
}

export function PrioIcon({ p, s = 14 }: { p: Priority; s?: number }) {
  const c = PRIORITIES[p].color;
  if (p === 1)
    return (
      <svg viewBox="0 0 16 16" width={s} height={s} aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill={c} />
        <path d="M8 4.6v4.2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <circle cx="8" cy="11.4" r="1.15" fill="#fff" />
      </svg>
    );
  const on = 5 - p;
  const f = (n: number) => (on >= n ? c : 'var(--line-strong)');
  return (
    <svg viewBox="0 0 16 16" width={s} height={s} aria-hidden="true">
      <rect x="2" y="9" width="3" height="5" rx="1" fill={f(1)} />
      <rect x="6.5" y="6" width="3" height="8" rx="1" fill={f(2)} />
      <rect x="11" y="3" width="3" height="11" rx="1" fill={f(3)} />
    </svg>
  );
}
export const PrioTag = ({ p }: { p: Priority }) =>
  p === 3 ? null : <span className={`prio p${p}`} title={`${PRIORITIES[p].name} priority`}><PrioIcon p={p} /></span>;

export const ProjPill = ({ p }: { p: Project | undefined }) => (
  <span className="proj"><i style={{ background: p?.color ?? '#A0A0AB' }} />{p?.name ?? 'Another project'}</span>
);
export const Dot = ({ color, size = 9 }: { color: string; size?: number }) => (
  <i style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' }} />
);
export const Kbd = ({ children }: { children: ReactNode }) => <kbd>{children}</kbd>;

export function ProjBadge({ project, size = 40 }: { project: Project | 'all'; size?: number }) {
  if (project === 'all') return <span className="pbadge all" style={{ '--s': `${size}px` } as CSSProperties}>{I.board()}</span>;
  return (
    <span className="pbadge" style={{ '--s': `${size}px`, background: project.color } as CSSProperties}>
      {project.name.split(' ').map((w) => w[0]).join('').slice(0, 2)}
    </span>
  );
}
