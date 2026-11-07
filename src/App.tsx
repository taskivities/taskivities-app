import { useEffect, useLayoutEffect, useState } from 'react';
import { InstancesSheet } from './components/InstancesSheet';
import { boot, closePop, goHome, openConnect, openHelp, openPop, openTask, sync } from './actions';
import { updateBadge } from './push';
import { checkForUpdate, updateSeen } from './updates';
import { openInbox } from './inbox';
import { appName } from '../shared/types';
import { Drawer } from './components/Drawer';
import { ConnectSheet } from './components/ConnectSheet';
import { HelpSheet } from './components/HelpSheet';
import { WebhookSheet } from './components/WebhookSheet';
import { Popover } from './components/Popover';
import { Avatar, I, LogoMark, Wordmark } from './components/ui';
import { afterRender, focusNav, navEls, onFocusIn } from './focus';
import { onKeyDown } from './keyboard';
import { ProjectsPage } from './pages/ProjectsPage';
import { TasksPage } from './pages/TasksPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProjectEditor, TeamPage } from './pages/TeamPage';
import { S, useStore } from './store';

const POLL_MS = 10_000;
const HIDDEN_POLL_MS = 60_000;

export function App() {
  const s = useStore();

  useEffect(() => {
    void boot();
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('keydown', onKeyDown);
    const outside = (e: MouseEvent) => {
      if (S().pop && !(e.target as Element | null)?.closest?.('.pop')) closePop(false);
    };
    document.addEventListener('mousedown', outside);
    // Close popovers when the window gets wider or narrower (they're placed by their button), but not when only the
    // height changes: on phones that's the on-screen keyboard, which opens when you tap a popover's search box.
    let lastW = innerWidth;
    const closeOnResize = () => {
      if (innerWidth === lastW) return;
      lastW = innerWidth;
      if (S().pop) closePop(false);
    };
    window.addEventListener('resize', closeOnResize);
    // Live updates: poll every 10s, every 60s when the tab is hidden, and right away when it comes back.
    const timer = setInterval(() => {
      if (document.hidden && Date.now() - S().lastSync < HIDDEN_POLL_MS) return;
      void sync();
    }, POLL_MS);
    // A tapped notification, while the app is already open: the service worker asks this window to open the task.
    const onMessage = (e: MessageEvent<{ type?: string; url?: string }>) => {
      if (e.data?.type !== 'open' || !e.data.url) return;
      const id = new URL(e.data.url, location.origin).searchParams.get('task');
      if (id) void openTask(id);
      void sync();
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    const onVisible = () => { if (!document.hidden) { void sync(); void checkForUpdate(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', closeOnResize);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  useLayoutEffect(() => afterRender());

  if (s.bootError) return <div className="loading">Couldn't load Taskivities: {s.bootError} <button className="btn-ghost sm" onClick={() => location.reload()}>Retry</button></div>;
  // The installed app's icon shows how many of my tasks are open today (carried-over ones included).
  const myToday = s.me ? Object.values(s.tasks).filter((t) => t.assigneeId === s.me!.id && t.status === 'open' && !t.archivedAt && t.dueDate <= s.today && s.projects[t.projectId]).length : 0;
  useEffect(() => { if (s.ready) updateBadge(myToday); }, [s.ready, myToday]);

  if (!s.ready || !s.me) return <div className="loading">Loading…</div>;
  const admin = s.me.role === 'admin';

  return (
    <div className="app">
      <div className="topbar">
        <button className="skip" onClick={() => focusNav(navEls().find((n) => n.tabIndex === 0) || navEls()[0])}>Skip to tasks</button>
        {/* The logo goes home (your week); admins' other pages are in the ⋯ menu next to it. People and projects are
            both picked from the switcher on the page itself. */}
        <button className="logo" data-act="home" aria-label={`${appName(s.settings)}: go to my week`} title="My week  (G T)" onClick={goHome}>
          <LogoMark version={s.settings.logoVersion} /><Wordmark />
        </button>
        {admin && <button className={`icon-btn pages-btn${s.pop?.type === 'pages' ? ' on' : ''}`} data-act="pages" aria-label="Pages" aria-haspopup="menu" title="People & projects, Settings"
          onClick={(e) => openPop({ type: 'pages' }, e.currentTarget)}>{I.dots()}</button>}
        <div className="spacer" />
        <button className="ai-btn" data-act="connect" title="MCP: connect Claude or another AI assistant" onClick={openConnect}>{I.bolt(14)}<span>MCP</span></button>
        <button className="icon-btn kb-btn" title="Keyboard shortcuts  (?)" aria-label="Keyboard shortcuts" onClick={openHelp}>{I.kbd()}</button>
        <SyncPill />
        <button className={`icon-btn inbox-btn${s.pop?.type === 'inbox' ? ' on' : ''}`} data-act="inbox" aria-haspopup="dialog"
          aria-label={s.inboxUnread ? `Inbox, ${s.inboxUnread} new` : 'Inbox'} title="Inbox  (G I)" onClick={(e) => openInbox(e.currentTarget)}>
          {I.bell(17)}
          {s.inboxUnread > 0 && <span className="inbox-n">{s.inboxUnread > 99 ? '99+' : s.inboxUnread}</span>}
        </button>
        <button className="me" data-act="account" title={`${s.me.name} · ${admin ? 'Admin' : 'Member'}${s.update ? ' · Update available' : ''}`}
          onClick={(e) => openPop({ type: 'account' }, e.currentTarget)}>
          <Avatar user={s.me} size={30} />
          {s.update && !updateSeen(s.update.version) && <span className="me-dot" aria-label="Update available" />}
        </button>
      </div>
      <div className="app-scroll">
        <div className={`page ${(s.page === 'tasks' || s.page === 'projects') && s.view === 'board' ? 'wide' : ''}`}>
          {s.page === 'settings' ? <SettingsPage /> : s.page === 'team' ? <TeamPage /> : s.page === 'projects' ? <ProjectsPage /> : <TasksPage />}
        </div>
      </div>
      <Drawer />
      {s.help && <HelpSheet />}
      {s.connect && <ConnectSheet />}
      {s.instancesOpen && <InstancesSheet today={s.today} />}
      {s.hookEdit && <WebhookSheet key={s.hookEdit} />}
      {s.projEdit && <ProjectEditor pe={s.projEdit} s={s} />}
      {s.toast && (
        <div className={`toast ${s.toast.error ? 'err' : ''}`} role="status" key={s.toast.id}>
          <span>{s.toast.text}</span>
          {s.toast.undo && <button onClick={s.toast.undo}>Undo</button>}
          {s.toast.action && <button onClick={s.toast.action.run}>{s.toast.action.label}</button>}
        </div>
      )}
      {s.offline && <div className="offline">Offline. Changes will fail until the connection is back.</div>}
      <Popover />
    </div>
  );
}

function SyncPill() {
  return (
    <div className="sync" title="Checks for changes every 10 seconds">
      <span className="dot" /><span className="lbl-t">Live</span>
    </div>
  );
}
