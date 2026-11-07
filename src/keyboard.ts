// Global keyboard shortcuts. Press ? in the app for the full list.
import { addDays } from '../shared/dates';
import { isAdmin } from '../shared/rules';
import type { Priority } from '../shared/types';
import {
  closeConnect, closeDrawer, goHome, closeHelp, closePop, moveTasks, openDrawer, openHelp, openPop, setPage, setPriority, setView, skipTask, toast, toggleDone, closeHook, elsewhere, editChecklist, editNotes, pickAttachments, setFollowing } from './actions';
import { openInbox } from './inbox';
import { isFeed } from './feeds';
import { openMove } from './components/rows';
import { curNav, focusLater, focusNav, navEls, trapTab } from './focus';
import { S, set } from './store';
import { shownOn } from './util';

let gPending = 0;

const taskFromNav = () => {
  const s = S();
  if (s.drawer) return s.tasks[s.drawer];
  const k = curNav()?.dataset.nav || '';
  return /^(task|ghost):/.test(k) ? s.tasks[k.split(':')[1]] : undefined;
};

function stepTask(dir: number) {
  const el = curNav();
  const all = navEls();
  if (!all.length) return;
  if (!el) return focusNav(all[dir > 0 ? 0 : all.length - 1]);
  const col = el.closest('.col');
  const pool = col ? [...col.querySelectorAll<HTMLElement>('[data-nav]')] : all;
  const n = pool[pool.indexOf(el) + dir];
  if (n) focusNav(n);
}

function stepColumn(dir: number): boolean {
  const el = curNav();
  const col = el?.closest('.col');
  if (!el || !col) return false;
  const cols = [...document.querySelectorAll('.col')];
  const idx = [...col.querySelectorAll('[data-nav]')].indexOf(el);
  for (let c = cols.indexOf(col) + dir; c >= 0 && c < cols.length; c += dir) {
    const items = [...cols[c].querySelectorAll<HTMLElement>('[data-nav]')];
    if (items.length) { focusNav(items[Math.min(idx, items.length - 1)]); return true; }
  }
  return true;
}

function drawerStep(dir: number) {
  const ids = navEls().filter((n) => n.dataset.nav!.startsWith('task:')).map((n) => n.dataset.nav!.slice(5));
  const n = ids[ids.indexOf(S().drawer!) + dir];
  if (n) openDrawer(n);
}

function popKeys(e: KeyboardEvent) {
  const pop = document.querySelector('.pop');
  if (!pop) return;
  const k = e.key;
  const a = document.activeElement as HTMLElement | null;
  if (k === 'Escape') { e.preventDefault(); closePop(true); return; }
  if (k === 'Tab') { trapTab(e, pop); return; }
  // .no-arrow: shortcuts (like the switcher's section jumps) that arrows skip; Tab still reaches them.
  const f = [...pop.querySelectorAll<HTMLElement>('input, button:not(:disabled):not(.no-arrow)')];
  const i = a ? f.indexOf(a) : -1;
  if (a?.closest('.cal-g')) {
    const g = [...pop.querySelectorAll<HTMLButtonElement>('.cal-g button')];
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[k];
    if (step) {
      e.preventDefault();
      const n = g[g.indexOf(a as HTMLButtonElement) + step];
      if (n && !n.disabled) n.focus();
      else if (k === 'ArrowUp') pop.querySelector<HTMLElement>('.cal-h [data-dir="1"]')?.focus();
    }
    return;
  }
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    let n = i < 0 ? f[0] : f[i + (k === 'ArrowDown' ? 1 : -1)];
    if (n?.closest('.cal-g') && k === 'ArrowDown') n = pop.querySelector<HTMLElement>('.cal-g button.sel:not(:disabled)') || pop.querySelector<HTMLElement>('.cal-g button.td') || n;
    n?.focus();
  }
}

export function onKeyDown(e: KeyboardEvent) {
  const s = S();
  if (!s.ready) return;
  const k = e.key;
  const t = e.target as HTMLElement;
  const editing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable;
  const isQuestion = k === '?' || (k === '/' && e.shiftKey);

  if (s.projEdit) { if (k === 'Tab') trapTab(e, document.querySelector('.sheet')); return; } // the editor handles Esc / Enter itself
  if (s.hookEdit) { if (k === 'Escape') { e.preventDefault(); closeHook(); } else if (k === 'Tab') trapTab(e, document.querySelector('.sheet')); return; }
  if (s.instancesOpen) { if (k === 'Tab') trapTab(e, document.querySelector('.sheet')); return; } // the sheet handles Esc
  if (s.connect) { if (k === 'Escape') { e.preventDefault(); closeConnect(); } else if (k === 'Tab') trapTab(e, document.querySelector('.sheet')); return; }
  if (s.help) { if (k === 'Escape' || isQuestion) { e.preventDefault(); closeHelp(); } else if (k === 'Tab') trapTab(e, document.querySelector('.help')); return; }
  if (s.pop) { popKeys(e); return; }

  if (k === 'Escape') {
    if (editing) {
      t.blur();
      if (t.closest('#qa')) focusNav(curNav() || navEls()[0]);
      else if (s.drawer) document.querySelector<HTMLElement>('.drawer')?.focus();
      return;
    }
    if (s.drawer) closeDrawer(true);
    return;
  }
  if (editing) return;
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') {
    if (s.toast?.undo) { e.preventDefault(); s.toast.undo(); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === 'Tab' && s.drawer) { trapTab(e, document.querySelector('.drawer')); return; }

  // ----- anywhere -----
  if (isQuestion) { e.preventDefault(); openHelp(); return; }
  if (gPending && Date.now() - gPending < 1200 && (k === 't' || k === 'p' || ((k === 'u' || k === 's') && isAdmin(s.me!)))) {
    gPending = 0;
    e.preventDefault();
    // G T: your week. G P: the project you last looked at.
    if (k === 't') goHome();
    else setPage(k === 'p' ? 'projects' : k === 'u' ? 'team' : 'settings');
    return;
  }
  if (gPending && Date.now() - gPending < 1200 && k === 'i') {
    gPending = 0;
    e.preventDefault();
    const b = document.querySelector<HTMLElement>('[data-act="inbox"]');
    if (b) openInbox(b);
    return;
  }
  if (k === 'g') { gPending = Date.now(); return; }
  // N = new task, ⇧N = notes of the selected task (decided by Shift, so Caps Lock doesn't matter).
  const isN = k === 'n' || k === 'N';
  if (isN && !e.shiftKey) {
    e.preventDefault();
    if (s.drawer) closeDrawer(false);
    if (s.page !== 'tasks' && !(s.page === 'projects' && s.view !== 'today')) {
      const one = s.projSel === 'multi' ? (s.multi.projects.length === 1 ? s.multi.projects[0] : null) : s.projSel !== 'all' ? s.projSel : null;
      if (s.page === 'projects' && one) set((st) => ({ draft: { ...st.draft, projectId: one } }));
      setPage('tasks');
      setTimeout(() => document.getElementById('qa-input')?.focus(), 0);
    } else document.getElementById('qa-input')?.focus();
    return;
  }
  if (k === 'v' && (s.page === 'tasks' || s.page === 'projects')) {
    const order = ['today', 'list', 'board'] as const;
    setView(order[(order.indexOf(s.view) + 1) % 3]);
    return;
  }
  if (k === 'p') {
    const b = document.querySelector<HTMLElement>(s.page === 'projects' ? '[data-act="proj-pick"]' : '[data-act="person"]');
    if (b && s.page !== 'team') openPop({ type: s.page === 'projects' ? 'projpick' : 'person' }, b);
    return;
  }
  if (k === '[' || k === ']') {
    if (s.page === 'projects' && s.view === 'today') {
      const n = addDays(s.projDay || s.today, k === ']' ? 1 : -1);
      if (n <= s.today) set({ projDay: n });
    } else if ((s.page === 'tasks' || s.page === 'projects') && s.view !== 'today') set({ weekOffset: s.weekOffset + (k === ']' ? 1 : -1) });
    return;
  }

  // ----- moving around: arrows only when focus isn't on another control; J/K/H/L always -----
  const onNav = !!t.closest?.('[data-nav]');
  const free = onNav || t === document.body || t.classList?.contains('drawer');
  const task = taskFromNav();
  if (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
    if (task && free && task.status === 'open') {
      e.preventDefault();
      const d = addDays(shownOn(task, s.today), k === 'ArrowRight' ? 1 : -1);
      if (d < s.today) toast("Can't move a task into the past", undefined, true);
      else void moveTasks([task.id], d);
    }
    return;
  }
  if ((k === 'ArrowDown' && free) || k === 'j') { e.preventDefault(); s.drawer ? drawerStep(1) : stepTask(1); return; }
  if ((k === 'ArrowUp' && free) || k === 'k') { e.preventDefault(); s.drawer ? drawerStep(-1) : stepTask(-1); return; }
  if (((k === 'ArrowRight' && free) || k === 'l') && !s.drawer) { if (stepColumn(1)) e.preventDefault(); return; }
  if (((k === 'ArrowLeft' && free) || k === 'h') && !s.drawer) { if (stepColumn(-1)) e.preventDefault(); return; }

  // ----- upcoming copies (previews) only open the real task -----
  const navKey = curNav()?.dataset.nav || '';
  if (navKey.startsWith('preview:') && !s.drawer && (k === 'Enter' || k === 'o')) { e.preventDefault(); openDrawer(navKey.split(':')[1]); return; }

  // ----- actions on the selected task -----
  if (!task) return;
  const isDiv = onNav && t.tagName === 'DIV';
  if ((k === 'Enter' && isDiv && !s.drawer) || (k === 'o' && !s.drawer)) { e.preventDefault(); openDrawer(task.id); return; }
  // Tasks from other instances: handing over, repeating, following and files are done there.
  if (isFeed(task.id) && (k === 't' || k === 'r' || k === 's' || k === 'f' || ((k === 'a' || k === 'A') && e.shiftKey))) { e.preventDefault(); elsewhere(task.id); return; }
  if (k === 'e') { e.preventDefault(); openDrawer(task.id, true); return; }
  if (isN && e.shiftKey) { e.preventDefault(); editNotes(task.id); return; }
  if ((k === 'a' || k === 'A') && e.shiftKey) { e.preventDefault(); pickAttachments(task.id); return; }
  // C = comment, ⇧C = checklist (by Shift, like N / ⇧N).
  if (k === 'f' && task.assigneeId !== s.me!.id) { e.preventDefault(); void setFollowing(task.id, !task.followers.includes(s.me!.id)); return; }
  if ((k === 'c' || k === 'C') && e.shiftKey) { e.preventDefault(); editChecklist(task.id); return; }
  if (k === 'c' || k === 'C') { e.preventDefault(); if (s.drawer !== task.id) openDrawer(task.id); focusLater('#comment-box'); return; }
  if (k === 'x' || (k === ' ' && (isDiv || t.classList.contains('drawer')))) { e.preventDefault(); toggleDone(task.id); return; }
  const anchor = (act: 'move' | 'assign' | 'repeat') =>
    (s.drawer ? document.querySelector<HTMLElement>(`.drawer [data-act="${act}"]`) : curNav()?.querySelector<HTMLElement>(`[data-act="${act}"]`)) || curNav();
  if (k === 'd') { e.preventDefault(); const a = anchor('move'); if (a) openMove([task.id], a); return; }
  if (k === 'r' && task.series?.active && task.status === 'open') { e.preventDefault(); const a = anchor('repeat'); if (a) openPop({ type: 'repeat', mode: 'task', id: task.id }, a); return; }
  if (k === 's' && task.series?.active && task.status === 'open') { e.preventDefault(); void skipTask(task.id); return; }
  if (k === 't') { e.preventDefault(); const a = anchor('assign'); if (a) openPop({ type: 'assign', mode: 'task', id: task.id }, a); return; }
  if (/^[1-4]$/.test(k)) { e.preventDefault(); const p = Number(k) as Priority; if (task.priority !== p) void setPriority(task.id, p); }
}
