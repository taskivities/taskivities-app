// Folding a task's history for display: what one person did in a burst becomes one entry.
// Nothing is merged in the data; the history itself stays one row per change.
import type { EventType, TaskEvent } from '../shared/types';

/** Changes by the same person this close together are shown as one entry. */
export const GROUP_GAP_MS = 15 * 60 * 1000;

/** One line inside an entry: a single change, or a run of the same checklist change ("checked A, B and C"). */
export interface HistoryLine {
  key: string;
  events: TaskEvent[];
}

export type HistoryEntry =
  | { kind: 'comment'; key: string; event: TaskEvent }
  | { kind: 'changes'; key: string; actorId: string; via: string | null; lines: HistoryLine[]; first: string; last: string };

/** Checklist changes that read well as one line when repeated: "added A, B and C to the checklist". */
const MERGEABLE: EventType[] = ['check_added', 'check_done', 'check_undone', 'check_removed', 'attached', 'detached'];

/**
 * Groups events (oldest first, as the API returns them) into entries, newest entry first.
 * Comments always stand alone. Inside an entry the lines stay in the order they happened.
 */
export function groupHistory(all: TaskEvent[]): HistoryEntry[] {
  const { events, attach } = foldTimer(all);
  const out: HistoryEntry[] = [];
  for (const e of events) {
    if (e.type === 'comment') { out.push({ kind: 'comment', key: e.id, event: e }); continue; }
    const prev = out[out.length - 1];
    const close = prev?.kind === 'changes' && prev.actorId === e.actorId && prev.via === (e.via ?? null)
      && Date.parse(e.at) - Date.parse(prev.last) <= GROUP_GAP_MS;
    if (prev?.kind === 'changes' && close) {
      const lastLine = prev.lines[prev.lines.length - 1];
      if (MERGEABLE.includes(e.type) && lastLine.events[0].type === e.type) lastLine.events.push(e);
      else prev.lines.push({ key: e.id, events: [e, ...(attach.get(e.id) ?? [])] });
      prev.last = e.at;
    } else {
      out.push({ kind: 'changes', key: e.id, actorId: e.actorId, via: e.via ?? null, lines: [{ key: e.id, events: [e, ...(attach.get(e.id) ?? [])] }], first: e.at, last: e.at });
    }
  }
  return out.reverse();
}

/**
 * A timer run reads as one line: "logged 25m with the timer (1h 55m in all)". The start of a run that was stopped is
 * left out, and the time-spent change the stop made rides on the stop (as its line's second event). A timer that is
 * still running keeps its "started the timer" line.
 */
function foldTimer(events: TaskEvent[]) {
  const drop = new Set<string>();
  const attach = new Map<string, TaskEvent[]>();
  let started: TaskEvent | null = null;
  events.forEach((e, i) => {
    if (e.type === 'timer_started') started = e;
    else if (e.type === 'timer_stopped') {
      if (started) drop.add(started.id);
      started = null;
      const eff = events.slice(i + 1).find((x) => x.at === e.at && x.actorId === e.actorId && x.type === 'effort_set');
      if (eff) { drop.add(eff.id); attach.set(e.id, [eff]); }
    }
  });
  return { events: events.filter((e) => !drop.has(e.id)), attach };
}

/** "A", "A and B", "A, B and C". */
export const andList = <T,>(xs: T[], sep: (i: number) => string = (i) => (i === xs.length - 1 ? ' and ' : ', ')) =>
  xs.flatMap((x, i) => (i === 0 ? [x] : [sep(i), x]));
