import { create } from 'zustand';
import type { AppSettings, ArchivedProject, FeedInfo, InboxItem, NotifyPrefs, Priority, Project, Role, Task, TaskEvent, User, WebhookInfo } from '../shared/types';
import type { EffortType } from '../shared/effort';
import { NORMAL, NOTIFY_DEFAULTS } from '../shared/types';
import type { PushState } from './push';
import type { Release } from './updates';
import type { Repeat } from '../shared/repeat';
import { type ThemePref, themePref } from './theme';

/** 'tasks' and 'projects' are one screen to people: a person's view or a project's, picked from the switcher. */
/** 'team' is the People & projects page (admins; at /manage, and the old /team). */
export type Page = 'tasks' | 'projects' | 'team' | 'settings';
export type ManageTab = 'people' | 'projects';
export interface MultiSel { people: string[]; projects: string[] }
const savedMulti = (): MultiSel => {
  try {
    const m = JSON.parse(localStorage.getItem('tv:multi') || 'null') as MultiSel | null;
    if (m && Array.isArray(m.people) && Array.isArray(m.projects)) return { people: m.people.map(String), projects: m.projects.map(String) };
  } catch { /* ignore */ }
  return { people: [], projects: [] };
};
export const BOARD_WEEKS_MAX = 52;
export type View = 'today' | 'list' | 'board';
export type PopType = 'move' | 'assign' | 'prio' | 'proj' | 'person' | 'projpick' | 'urole' | 'uproj' | 'udisable' | 'uenable' | 'notify' | 'update' | 'inbox' | 'followers' | 'account' | 'repeat' | 'taskmenu' | 'pages' | 'effort';

export interface Pop {
  type: PopType;
  /** task = acting on a task; qa = choosing a value for the quick-add draft; bulk = several tasks */
  mode?: 'task' | 'qa' | 'bulk';
  ids?: string[];
  id?: string;
  userId?: string;
  rect: { l: number; t: number; b: number; r: number };
  /** Where focus goes back to when the menu closes. */
  returnSel: string | null;
  month?: string;
  q?: string;
  /** effort: mark the task done once the effort is chosen (it was required). */
  thenDone?: boolean;
}

export interface InboxState {
  items: InboxItem[];
  /** Cursor for older entries (null: no more). */
  next: string | null;
  /** When I'd last looked, before this visit: newer entries show as unread. */
  readAt: string | null;
  loading: boolean;
  error?: boolean;
}

export interface Upload { id: string; taskId: string; name: string; loaded: number; total: number }
export interface Toast { id: number; text: string; undo?: () => void; error?: boolean; action?: { label: string; run: () => void } }
export interface Draft { title: string; notes: string; open: boolean; projectId: string | null; dueDate: string | null; assigneeId: string | null; priority: Priority; repeat: Repeat | null }
export interface InviteDraft { emails: string; role: Role; projects: string[]; err: string | null; busy?: boolean }
export interface ProjEdit {
  id: string | null; name: string; color: string; description: string; members: string[]; err: string | null; returnSel: string | null; busy?: boolean;
  effort: EffortType | null; effortRequired: boolean;
  /** Showing the "Archive this project?" confirmation. */
  archiving?: boolean;
  /** Opened from the quick-add's project menu: a new project becomes the draft's project. */
  forDraft?: boolean;
}

export interface State {
  ready: boolean;
  bootError: string | null;
  me: User | null;
  users: Record<string, User>;
  projects: Record<string, Project>;
  tasks: Record<string, Task>;
  events: Record<string, TaskEvent[] | undefined>;
  today: string;
  tz: string;
  version: number;
  dirVersion: number;
  settings: AppSettings;
  /** Admins: Gmail address invites are emailed from (null = not connected). */
  gmail: { email: string } | null;
  /** Admins: webhooks (loaded on the Settings page), and the one open in the editor. */
  hooks: WebhookInfo[] | null;
  /** Light / dark / follow the system (this browser only). */
  theme: ThemePref;
  hookEdit: string | null;
  range: { from: string; to: string } | null;
  lastSync: number;
  offline: boolean;

  page: Page;
  view: View;
  viewUser: string;
  weekOffset: number;
  boardSide: 'to' | 'by';
  /** How many weeks the Board shows side by side (it scrolls sideways past one). Remembered on this device. */
  boardWeeks: number;
  drawer: string | null;
  /** Empty notes are collapsed to an "Add notes" button; this opens the box (button or ⇧N). Reset per task. */
  notesOpen: boolean;
  /** Same for an empty checklist (button or ⇧C). */
  checklistOpen: boolean;
  /** Files on their way up (attachments), with progress. */
  uploads: Upload[];
  /** Attachments are on for this instance (it has an R2 bucket). */
  attachmentsOn: boolean;
  /** The browser offered to install the app (account menu shows "Install app"). */
  canInstall: boolean;
  /** Notifications: the instance's push key (null = not set up), this device's state, and what I'm notified about. */
  pushKey: string | null;
  pushState: PushState;
  notify: NotifyPrefs;
  /** Admins: where releases are announced, the latest one, and a newer one than this build (null: up to date). */
  updateRepo: string | null;
  latestRelease: Release | null;
  update: Release | null;
  updateCheckedAt: number | null;
  updateChecking: boolean;
  updateSeenTick: number;
  /** The inbox (the bell): how many entries I haven't seen, and the entries loaded while it's open. */
  inboxUnread: number;
  inbox: InboxState | null;
  pop: Pop | null;
  toast: Toast | null;
  help: boolean;
  connect: boolean;
  expanded: Record<string, boolean>;
  flash: Record<string, number>;
  draft: Draft;
  invite: InviteDraft | null;
  projEdit: ProjEdit | null;
  projSel: string; // project id, 'all', or 'multi' (see `multi`)
  /** Several people and/or projects at once (projSel 'multi'): tasks of these people in these projects (an empty list: any). */
  multi: MultiSel;
  /** The switcher picks several at once (checkboxes) instead of one. Remembered on this device. */
  multiPick: boolean;
  /** Other instances whose tasks (assigned to me) are shown here (src/feeds.ts), and their projects and people. */
  feeds: FeedInfo[];
  feedDir: { users: Record<string, User>; projects: Record<string, Project> };
  /** The "Other instances" sheet (account menu). */
  instancesOpen: boolean;
  projDay: string;
  projOpen: boolean;
  /** A project's view: archived tasks of the selected project (null = not loaded), and whether the section is open. */
  archived: { project: string; tasks: Task[] } | null;
  archOpen: boolean;
  /** People & projects page: archived projects (null = not loaded) and disabled people, each in a section that starts collapsed. */
  archivedProjects: ArchivedProject[] | null;
  archProjOpen: boolean;
  disabledOpen: boolean;
  /** People & projects page: which tab (/manage or /manage/projects). */
  manageTab: ManageTab;
}

const pageFromPath = (): Page => {
  const p = location.pathname;
  return p.startsWith('/projects') ? 'projects' : p.startsWith('/manage') || p.startsWith('/team') ? 'team' : p.startsWith('/settings') ? 'settings' : 'tasks';
};
const savedView = (): View => {
  const v = localStorage.getItem('tv:view');
  return v === 'today' || v === 'board' ? v : 'list';
};

export const emptyDraft = (projectId: string | null = null): Draft => ({
  title: '', notes: '', open: false, projectId, dueDate: null, assigneeId: null, priority: NORMAL, repeat: null,
});

export const useStore = create<State>()(() => ({
  ready: false,
  bootError: null,
  me: null,
  users: {},
  projects: {},
  tasks: {},
  events: {},
  today: '',
  tz: 'UTC',
  version: 0,
  dirVersion: 0,
  settings: { customLogo: false, logoVersion: '0', customIcon: false, iconVersion: '0', name: '', customWordmark: false, wordmarkVersion: '0' },
  gmail: null,
  hooks: null,
  theme: themePref(),
  hookEdit: null,
  range: null,
  lastSync: Date.now(),
  offline: false,

  page: pageFromPath(),
  view: savedView(),
  viewUser: '',
  weekOffset: 0,
  boardSide: 'to',
  boardWeeks: Math.min(BOARD_WEEKS_MAX, Math.max(1, Number(localStorage.getItem('tv:boardWeeks')) || 1)),
  drawer: null,
  notesOpen: false,
  checklistOpen: false,
  uploads: [],
  attachmentsOn: false,
  canInstall: false,
  pushKey: null,
  pushState: 'unknown',
  notify: NOTIFY_DEFAULTS,
  updateRepo: null,
  latestRelease: null,
  update: null,
  updateCheckedAt: null,
  updateChecking: false,
  updateSeenTick: 0,
  inboxUnread: 0,
  inbox: null,
  pop: null,
  toast: null,
  help: false,
  connect: false,
  expanded: {},
  flash: {},
  draft: emptyDraft(),
  invite: null,
  projEdit: null,
  projSel: localStorage.getItem('tv:proj') || 'all', // a project that's gone falls back to 'all' (ProjectsPage)
  multi: savedMulti(),
  multiPick: localStorage.getItem('tv:multiPick') === '1',
  feeds: [],
  feedDir: { users: {}, projects: {} },
  instancesOpen: false,
  projDay: '',
  projOpen: true,
  archived: null,
  archOpen: false,
  archivedProjects: null,
  archProjOpen: false,
  disabledOpen: false,
  manageTab: location.pathname.startsWith('/manage/projects') ? 'projects' : 'people',
}));

export const S = () => useStore.getState();
export const set = (p: Partial<State> | ((s: State) => Partial<State>)) => useStore.setState(p);
