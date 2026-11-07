// Types shared by the Worker (API) and the browser app.
import type { SeriesInfo } from './repeat';
import type { EffortType } from './effort';

export type Role = 'admin' | 'member';
/** Disabled people can't sign in, but stay on the People & projects page (and in every task's history) and can be enabled again. */
export type UserStatus = 'invited' | 'active' | 'disabled';
export type Priority = 1 | 2 | 3 | 4; // 1 Urgent · 2 High · 3 Normal (default) · 4 Low

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  role: Role;
  status: UserStatus;
  /** Project ids this member belongs to (empty for admins: they are on every project). */
  projects: string[];
  addedAt: string;
  /** IANA time zone from their browser (null until they've opened the app). */
  timeZone: string | null;
  /** When and by whom they were disabled (null unless disabled). */
  disabledAt: string | null;
  disabledBy: string | null;
  /** App only: someone on another instance (src/feeds.ts), shown on tasks from there. Never in this instance's lists. */
  feed?: string;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  /** Written mainly for AI assistants (MCP clients): what belongs here, what doesn't, naming conventions. */
  description: string;
  archived: boolean;
  /** How the project measures effort on its tasks (null: it doesn't), and whether a task needs it before it's done. */
  effort: EffortType | null;
  effortRequired: boolean;
  /** App only: a project on another instance (src/feeds.ts). Never in this instance's lists. */
  feed?: string;
}

/** What a person is notified about on their devices (Web Push). */
export interface NotifyPrefs {
  /** A task given to you by someone else (new, or handed over). */
  assigned: boolean;
  /** Tasks I follow (or have): comments, done or reopened, handed to someone, and being added as a follower. */
  comments: boolean;
  /** At 8:00 in your time zone: how many tasks today, if any. */
  morning: boolean;
}
export const NOTIFY_DEFAULTS: NotifyPrefs = { assigned: true, comments: true, morning: true };

/**
 * One entry in someone's inbox (the bell): read from the task history, never stored separately.
 * new: a task made for you · assigned: a task handed to you · and on tasks you have or follow: comment, done,
 * reopened, handed (to someone else; also when your task is handed away) · followed: someone added you as a follower.
 */
export type InboxKind = 'new' | 'assigned' | 'comment' | 'done' | 'reopened' | 'handed' | 'followed';
export interface InboxItem {
  /** The history entry's id. */
  id: string;
  kind: InboxKind;
  taskId: string;
  /** The task as it is now. */
  title: string;
  done: boolean;
  projectId: string;
  actorId: string;
  /** The assistant or webhook that made the change for the actor. */
  via: string | null;
  /** The comment, or the note sent with a handover. */
  note: string | null;
  /** handed: who got the task. */
  to: string | null;
  at: string;
}
export interface InboxPage {
  items: InboxItem[];
  /** Pass as `before` for the next (older) page; null when there are no older entries. */
  next: string | null;
  /** When I last opened the inbox, before this visit: newer items are unread. */
  readAt: string | null;
}
export const INBOX_PAGE = 50;

/** An archived project, as the People & projects page lists it. */
export interface ArchivedProject extends Project {
  archivedAt: string | null;
  archivedBy: string | null;
  /** Its tasks (not counting archived tasks): hidden with it, back when it's restored. */
  open: number;
  done: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  projectId: string;
  assigneeId: string;
  createdBy: string;
  assignedBy: string;
  /** YYYY-MM-DD, always set */
  dueDate: string;
  priority: Priority;
  status: 'open' | 'done';
  doneAt: string | null;
  /** YYYY-MM-DD in the time zone of whoever marked it done */
  doneOn: string | null;
  doneBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Set when this task is a copy of a repeating task. */
  series: SeriesInfo | null;
  /** Number of comments in its history. */
  comments: number;
  /** The task's checklist, in order (empty: no checklist). */
  checklist: ChecklistItem[];
  /** Files attached to the task, oldest first. */
  attachments: AttachmentInfo[];
  /** Archived tasks are hidden everywhere except a project view's Archived section. */
  archivedAt: string | null;
  archivedBy: string | null;
  /** People following it (the creator, unless they stopped, and anyone who followed, was added or commented). Whoever has it always hears about it too. */
  followers: string[];
  /** '<type>:<value>' (shared/effort.ts), or null. Only counts when its type is what the project tracks now. */
  effort: string | null;
}

export type EventType =
  | 'created'
  | 'transferred'
  | 'date_moved'
  | 'priority_changed'
  /** Effort set, changed or cleared: from/to are stored values ('time:90', 'tshirt:M'; null: none). */
  | 'effort_set'
  | 'project_changed'
  | 'renamed'
  | 'notes_edited'
  | 'done'
  | 'reopened'
  /** Repeating tasks: to_value holds the rule's description. */
  | 'repeat_set'
  | 'repeat_changed'
  | 'repeat_stopped'
  /** Skipped this copy: the date moved to the next scheduled one. */
  | 'skipped'
  /** A comment: the text is in `note`. Like everything in the history, it can't be edited or deleted. */
  | 'comment'
  /** Checklist: to_value is the item's text (check_renamed: from_value → to_value). */
  | 'check_added'
  | 'check_done'
  | 'check_undone'
  | 'check_renamed'
  | 'check_removed'
  /** Attachments: to_value is the file name. */
  /** Someone else was added as a follower / taken off (to_value: who). Following yourself isn't recorded. */
  | 'follower_added'
  | 'follower_removed'
  | 'attached'
  | 'detached'
  /** Archived (hidden from every list) / restored. */
  | 'archived'
  | 'restored';

export interface TaskEvent {
  id: string;
  taskId: string;
  actorId: string;
  /** Set when an AI assistant made the change on the actor's behalf (e.g. "Claude"). */
  via: string | null;
  type: EventType;
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  at: string;
}

/** Settings an admin edits on the Settings page. */
export interface AppSettings {
  /** An uploaded logo is in use (otherwise the built-in one). */
  customLogo: boolean;
  /** Cache-buster for /logo.svg; changes whenever the logo does. */
  logoVersion: string;
  /** An uploaded home-screen icon (PNG) is in use (otherwise the built-in one). */
  customIcon: boolean;
  /** Cache-buster for /icons/<size>.png. */
  iconVersion: string;
  /** The team's name for the app ('' = "Taskivities"): top bar, sign-in page, browser tab, home-screen label, invite emails. */
  name: string;
  /** An uploaded wordmark (SVG) replaces the name in the top bar and on the sign-in page. */
  customWordmark: boolean;
  /** Cache-buster for /wordmark.svg. */
  wordmarkVersion: string;
}

/** The longest team name: it has to fit the top bar. */
export const NAME_MAX = 40;
export const appName = (s: Pick<AppSettings, 'name'> | null | undefined) => s?.name || 'Taskivities';

/** Home-screen icon sizes: iPhone (180) and Android / install prompts (192, 512). */
export const ICON_SIZES = [180, 192, 512] as const;

export interface Bootstrap {
  me: User;
  users: User[];
  projects: Project[];
  today: string;
  tz: string;
  version: number;
  directoryVersion: number;
  settings: AppSettings;
  /** Attachments are available on this instance (it has an R2 bucket). */
  attachments: boolean;
  /** Admins: the Gmail address invites are emailed from, or null when not connected (then they share the link). */
  gmail: { email: string } | null;
  /** Notifications: the key devices subscribe with (null when the instance has no push keys), and my choices. */
  push: { publicKey: string } | null;
  notify: NotifyPrefs;
  /** Admins: the GitHub repository whose releases tell them an update is available (null: not shown, or turned off). */
  updates: { repo: string } | null;
  /** Inbox entries I haven't seen yet (at most 100). */
  inboxUnread: number;
}

// ---------- other instances (worker/feed.ts) ----------
/** Someone on another instance, as that instance describes them (only what's needed to show their name). */
export interface FeedPerson { id: string; name: string; email: string; color: string }
/** What another instance sends: your tasks there (assigned to you), and the projects and people they mention. */
export interface FeedTasks {
  instance: string;
  me: FeedPerson;
  projects: Project[];
  users: FeedPerson[];
  tasks: Task[];
}
/** Another instance you show your tasks from. */
export interface FeedInfo {
  id: string;
  url: string;
  /** That instance's own name. */
  name: string;
  color: string;
  /** Who you are there. */
  user: { name: string; email: string };
  lastOkAt: string | null;
  /** Why the last fetch failed (null when it worked). */
  lastError: string | null;
}
/** An access token you made, so another instance can show your tasks from here. The token itself is shown once. */
export interface AccessTokenInfo { id: string; name: string; createdAt: string; lastUsedAt: string | null }
/** Access tokens look like this, so they're easy to spot (and to scan for if one leaks). */
export const TOKEN_PREFIX = 'tvk_';

/** A webhook as admins see it (Settings → Webhooks; worker/webhooks.ts). */
export interface WebhookInfo {
  id: string;
  name: string;
  /** The secret address other services POST to. */
  url: string;
  /** Paused webhooks log requests but make no tasks. */
  active: boolean;
  /** null = capturing samples (no tasks yet). */
  mapping: import('./webhook').Mapping | null;
  /** Tasks are made as this admin (whoever last saved the mapping). */
  createdBy: string;
  createdAt: string;
  lastReceivedAt: string | null;
}

export interface WebhookRequestInfo {
  id: string;
  receivedAt: string;
  method: string;
  contentType: string | null;
  request: import('./webhook').HookRequestView;
  size: number;
  result: 'captured' | 'created' | 'skipped' | 'duplicate' | 'error' | 'paused';
  detail: string | null;
  taskId: string | null;
}

/** What happened to the invite emails when people were added (worker/gmail.ts). */
export interface InviteEmailResult {
  status: 'sent' | 'not_connected' | 'failed';
  sent: string[];
  failed: string[];
  reason?: string;
}

export interface SyncResponse {
  changed: boolean;
  version: number;
  directoryVersion: number;
  today: string;
  tasks?: Task[];
  /** Tasks that changed but are no longer visible to you (e.g. moved to a project you're not on). */
  gone?: string[];
  /** Sent when something changed: inbox entries I haven't seen yet. */
  inboxUnread?: number;
}

export const NORMAL: Priority = 3;
export const PRIORITIES: Record<Priority, { name: string; hint: string; color: string }> = {
  1: { name: 'Urgent', hint: 'Drop everything', color: '#D92D20' },
  2: { name: 'High', hint: 'Do these first', color: '#DC6803' },
  3: { name: 'Normal', hint: 'The default', color: '#6B6B78' },
  4: { name: 'Low', hint: "When there's time", color: '#A0A0AB' },
};

export const PROJECT_COLORS = ['#2E90FA', '#7A5AF8', '#F79009', '#12B76A', '#06AED4', '#DB2777', '#D92D20', '#667085'];
export const USER_COLORS = ['#4F46E5', '#DB2777', '#0E9384', '#E8590C', '#2E90FA', '#7A5AF8', '#9E77ED', '#15B79E', '#F79009', '#D92D20'];
export const DESCRIPTION_MAX = 600;
export const TITLE_MAX = 300;
export const NOTES_MAX = 10000;
export const COMMENT_MAX = 4000;
export const CHECK_TEXT_MAX = 300;
export const CHECK_ITEMS_MAX = 100;

export interface ChecklistItem { id: string; text: string; done: boolean }

export const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
export const ATTACH_PER_TASK_MAX = 50;
export interface AttachmentInfo { id: string; name: string; size: number; type: string; by: string; at: string }
