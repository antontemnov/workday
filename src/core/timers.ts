// Manual timers of a day — pure functions over DailyLog, no I/O.
//
// A timer is a source of time for the entry it feeds: creditTimers moves
// whole minutes of its share into entry.minutes, so everything downstream
// (report, push, Tempo mirror, day total) keeps reading the entry alone.
// At most one timer is live (running or waiting) at a time.

import { randomBytes } from 'node:crypto';
import { MS_PER_MINUTE } from './constants.js';
import { DayStatus, TimerState, type DailyLog, type ManualEntry, type Timer, type TimerSpan, type TimerView } from './types.js';

/** The live timer a start put on pause — what cancelNewTimer gives back. */
export interface DisplacedTimer {
  readonly id: string;
  readonly state: TimerState;
}

export interface TimerStart {
  readonly timer: Timer;
  readonly displaced: DisplacedTimer | null;
}

// ─── Lookup ──────────────────────────────────────────────────────────────

export function getTimers(log: DailyLog): readonly Timer[] {
  return log.timers ?? [];
}

export function findTimer(log: DailyLog, timerId: string): Timer | undefined {
  return getTimers(log).find(timer => timer.id === timerId);
}

export function findEntryTimer(log: DailyLog, entryId: string): Timer | undefined {
  return getTimers(log).find(timer => timer.entryId === entryId);
}

export function isLiveTimer(timer: Timer): boolean {
  return timer.state !== TimerState.Paused;
}

export function findLiveTimer(log: DailyLog): Timer | undefined {
  return getTimers(log).find(isLiveTimer);
}

function requireTimer(log: DailyLog, timerId: string): Timer {
  const timer = findTimer(log, timerId);
  if (!timer) throw new Error(`Timer not found: ${timerId}`);
  return timer;
}

function entryOf(log: DailyLog, timer: Timer): ManualEntry | undefined {
  if (timer.entryId === null) return undefined;
  return (log.manualEntries ?? []).find(entry => entry.id === timer.entryId);
}

// ─── Time ────────────────────────────────────────────────────────────────

function spanMs(span: TimerSpan, nowMs: number): number {
  const end = span.to === null ? nowMs : Date.parse(span.to);
  return Math.max(0, end - Date.parse(span.from));
}

/** Everything the timer counted, the stretches cut off by a smaller number included. */
export function countedMs(timer: Timer, nowMs: number): number {
  return timer.spans.reduce((sum, span) => sum + spanMs(span, nowMs), 0);
}

/** The timer's own time — its share of the entry it feeds. */
export function shareMs(timer: Timer, nowMs: number): number {
  return timer.spans.reduce((sum, span) => sum + (span.off ? 0 : spanMs(span, nowMs)), 0);
}

/** Minutes of the entry typed by hand — its total without the timer's credit. */
export function handMinutes(log: DailyLog, entry: ManualEntry): number {
  return entry.minutes - (findEntryTimer(log, entry.id)?.creditedMinutes ?? 0);
}

function creditTimer(log: DailyLog, timer: Timer, nowMs: number): boolean {
  const entry = entryOf(log, timer);
  if (!entry) return false;
  const credited = Math.floor(shareMs(timer, nowMs) / MS_PER_MINUTE);
  if (credited === timer.creditedMinutes) return false;
  entry.minutes += credited - timer.creditedMinutes;
  timer.creditedMinutes = credited;
  if (log.status !== DayStatus.Draft) log.status = DayStatus.Draft;
  return true;
}

/** The timer as one row of the island: an entry's whole time, or a no-ticket timer's own. */
export function toTimerView(log: DailyLog, timer: Timer, nowMs: number): TimerView {
  const entry = entryOf(log, timer);
  const share = shareMs(timer, nowMs);
  const typed = entry ? entry.minutes - timer.creditedMinutes : 0;
  return {
    id: timer.id,
    state: timer.state,
    entryId: timer.entryId,
    task: entry?.task ?? null,
    activity: entry?.activity ?? null,
    added: !!entry && (!!entry.added || !!entry.sourceSessionId),
    description: entry ? entry.description : timer.description,
    totalMs: typed * MS_PER_MINUTE + share,
    shareMs: share,
    handMinutes: typed,
    hidden: timer.hidden === true,
    touchedAt: timer.touchedAt,
  };
}

/** Move the whole minutes every timer has counted into its entry. True = an entry changed. */
export function creditTimers(log: DailyLog, nowMs: number): boolean {
  let changed = false;
  for (const timer of getTimers(log)) {
    if (creditTimer(log, timer, nowMs)) changed = true;
  }
  return changed;
}

// ─── Spans ───────────────────────────────────────────────────────────────

function openSpan(timer: Timer, nowIso: string): void {
  timer.spans.push({ from: nowIso, to: null });
}

function closeSpan(timer: Timer, atIso: string): void {
  const open = timer.spans.find(span => span.to === null);
  if (!open) return;
  if (Date.parse(atIso) <= Date.parse(open.from)) {
    timer.spans = timer.spans.filter(span => span !== open);
    return;
  }
  open.to = atIso;
}

function haltTimer(log: DailyLog, timer: Timer, atIso: string): void {
  closeSpan(timer, atIso);
  timer.state = TimerState.Paused;
  creditTimer(log, timer, Date.parse(atIso));
}

function removeTimer(log: DailyLog, timer: Timer): void {
  const rest = getTimers(log).filter(other => other !== timer);
  if (rest.length > 0) log.timers = rest;
  else delete log.timers;
}

// ─── Start / pause ───────────────────────────────────────────────────────

function addTimer(log: DailyLog, entryId: string | null, description: string, nowIso: string): Timer {
  const timer: Timer = {
    id: randomBytes(4).toString('hex'),
    entryId,
    description,
    state: TimerState.Paused,
    spans: [],
    creditedMinutes: 0,
    lastSeenAt: nowIso,
    touchedAt: nowIso,
    createdAt: nowIso,
  };
  (log.timers ??= []).push(timer);
  return timer;
}

/** Start by hand: the timer runs, whatever other timer was live goes on pause. */
export function startTimer(log: DailyLog, timer: Timer, nowIso: string): DisplacedTimer | null {
  let displaced: DisplacedTimer | null = null;
  for (const other of getTimers(log)) {
    if (other === timer || !isLiveTimer(other)) continue;
    displaced = { id: other.id, state: other.state };
    haltTimer(log, other, nowIso);
  }
  if (timer.state !== TimerState.Running) {
    timer.state = TimerState.Running;
    openSpan(timer, nowIso);
  }
  timer.touchedAt = nowIso;
  timer.lastSeenAt = nowIso;
  delete timer.hidden;
  return displaced;
}

/** A timer without a ticket, running at once. */
export function newTimer(log: DailyLog, description: string, nowIso: string): TimerStart {
  const timer = addTimer(log, null, description.trim(), nowIso);
  return { timer, displaced: startTimer(log, timer, nowIso) };
}

/** Put a timer on a manual entry (or start the one it has). Throws when the entry is unknown. */
export function startEntryTimer(log: DailyLog, entryId: string, nowIso: string): TimerStart {
  if (!(log.manualEntries ?? []).some(entry => entry.id === entryId)) {
    throw new Error(`Manual entry not found: ${entryId}`);
  }
  const timer = findEntryTimer(log, entryId) ?? addTimer(log, entryId, '', nowIso);
  return { timer, displaced: startTimer(log, timer, nowIso) };
}

/** Pause by hand, from running or waiting. */
export function pauseTimer(log: DailyLog, timer: Timer, nowIso: string): void {
  haltTimer(log, timer, nowIso);
  timer.touchedAt = nowIso;
}

/** A session took the count: running → waiting. */
export function yieldTimer(log: DailyLog, timer: Timer, nowIso: string): void {
  if (timer.state !== TimerState.Running) return;
  closeSpan(timer, nowIso);
  timer.state = TimerState.Waiting;
  creditTimer(log, timer, Date.parse(nowIso));
}

/** No session counts any more: waiting → running. */
export function reclaimTimer(timer: Timer, nowIso: string): void {
  if (timer.state !== TimerState.Waiting) return;
  timer.state = TimerState.Running;
  openSpan(timer, nowIso);
}

/** Every live timer goes on pause — the daemon stopped by hand, a closed month, stop tracking. */
export function pauseAllTimers(log: DailyLog, nowIso: string): number {
  let paused = 0;
  for (const timer of getTimers(log)) {
    if (!isLiveTimer(timer)) continue;
    haltTimer(log, timer, nowIso);
    paused++;
  }
  return paused;
}

// ─── No-ticket timers ────────────────────────────────────────────────────

/** The text of a no-ticket timer; one with a ticket has none — its text is the entry's description. */
export function describeTimer(log: DailyLog, timerId: string, description: string): Timer {
  const timer = requireTimer(log, timerId);
  if (timer.entryId !== null) throw new Error('A timer with a ticket takes its description from the entry');
  timer.description = description.trim();
  return timer;
}

/** A no-ticket timer goes; one with a ticket leaves through removeEntryTimer, or with its entry. */
export function deleteTimer(log: DailyLog, timerId: string): Timer {
  const timer = requireTimer(log, timerId);
  if (timer.entryId !== null) throw new Error('A timer with a ticket is removed from its entry');
  removeTimer(log, timer);
  return timer;
}

/**
 * Undo an accidental New timer: the fresh timer goes, the one it put on
 * pause gets its state back. Only a timer still without ticket and
 * description can be taken back this way.
 */
export function cancelNewTimer(log: DailyLog, timerId: string, displaced: DisplacedTimer | null, nowIso: string): void {
  const timer = requireTimer(log, timerId);
  if (timer.entryId !== null || timer.description !== '') {
    throw new Error('Only a fresh timer without ticket and description can be cancelled');
  }
  removeTimer(log, timer);
  const previous = displaced ? findTimer(log, displaced.id) : undefined;
  if (!previous || !displaced || previous.state !== TimerState.Paused) return;
  previous.state = displaced.state;
  if (displaced.state === TimerState.Running) openSpan(previous, nowIso);
  previous.lastSeenAt = nowIso;
}

/** Take a paused timer off the desktop widget; a start brings it back. */
export function hideTimer(log: DailyLog, timerId: string): Timer {
  const timer = requireTimer(log, timerId);
  if (timer.state !== TimerState.Paused) throw new Error('Only a paused timer can be hidden');
  timer.hidden = true;
  return timer;
}

// ─── Entry ↔ timer ───────────────────────────────────────────────────────

/**
 * Cut the timer's time down to `keepMs`: its latest stretches stop counting,
 * the one the cut falls into is split. A running timer counts on from now.
 */
export function trimShare(timer: Timer, keepMs: number, nowIso: string): void {
  const counting = timer.spans.some(span => span.to === null);
  closeSpan(timer, nowIso);
  let excess = shareMs(timer, Date.parse(nowIso)) - keepMs;
  for (let index = timer.spans.length - 1; index >= 0 && excess > 0; index--) {
    const span = timer.spans[index];
    if (span.off || span.to === null) continue;
    const length = Date.parse(span.to) - Date.parse(span.from);
    if (length <= excess) {
      span.off = true;
      excess -= length;
      continue;
    }
    const cutIso = new Date(Date.parse(span.to) - excess).toISOString();
    timer.spans.splice(index, 1, { from: span.from, to: cutIso }, { from: cutIso, to: span.to, off: true });
    excess = 0;
  }
  if (counting) openSpan(timer, nowIso);
}

/**
 * A number was typed into the entry: what its timer counted stays as it is.
 * Only a number smaller than that cuts the timer down to it. Call with the
 * timers credited, before the number is written.
 */
export function fitTimerToEntry(log: DailyLog, entryId: string, minutes: number, nowIso: string): void {
  const timer = findEntryTimer(log, entryId);
  if (!timer || minutes >= timer.creditedMinutes) return;
  trimShare(timer, minutes * MS_PER_MINUTE, nowIso);
  timer.creditedMinutes = minutes;
}

/** The entry is gone — so is its timer. */
export function dropEntryTimer(log: DailyLog, entryId: string): void {
  const timer = findEntryTimer(log, entryId);
  if (timer) removeTimer(log, timer);
}

function mergeTimers(target: Timer, source: Timer): void {
  target.spans = [...target.spans, ...source.spans].sort((a, b) => a.from.localeCompare(b.from));
  target.creditedMinutes += source.creditedMinutes;
  if (!isLiveTimer(target) && isLiveTimer(source)) target.state = source.state;
  if (source.touchedAt > target.touchedAt) target.touchedAt = source.touchedAt;
  if (source.lastSeenAt > target.lastSeenAt) target.lastSeenAt = source.lastSeenAt;
  if (!source.hidden) delete target.hidden;
}

/** The source timer pours into the target and leaves the day; the target keeps its place. */
export function absorbTimer(log: DailyLog, target: Timer, source: Timer): void {
  mergeTimers(target, source);
  removeTimer(log, source);
}

/**
 * Entries merged into one: their timers follow to the surviving entry and
 * become one — the first in the day's order keeps its place.
 */
export function relinkTimers(log: DailyLog, fromEntryIds: readonly string[], toEntryId: string): void {
  let survivor: Timer | null = null;
  for (const timer of [...getTimers(log)]) {
    if (timer.entryId === null) continue;
    if (timer.entryId !== toEntryId && !fromEntryIds.includes(timer.entryId)) continue;
    timer.entryId = toEntryId;
    if (survivor === null) {
      survivor = timer;
      continue;
    }
    absorbTimer(log, survivor, timer);
  }
}

/**
 * Remove timer: its time leaves the entry, what was typed by hand stays.
 * An entry grown from the timer alone has nothing to keep — that is a delete.
 */
export function removeEntryTimer(log: DailyLog, entryId: string, nowIso: string): { entry: ManualEntry; removedMinutes: number } {
  const timer = findEntryTimer(log, entryId);
  const entry = timer ? entryOf(log, timer) : undefined;
  if (!timer || !entry) throw new Error(`No timer on entry: ${entryId}`);
  if (handMinutes(log, entry) < 1) throw new Error('Nothing typed by hand — delete the entry instead');

  haltTimer(log, timer, nowIso);
  const removedMinutes = timer.creditedMinutes;
  entry.minutes -= removedMinutes;
  removeTimer(log, timer);
  if (log.status !== DayStatus.Draft) log.status = DayStatus.Draft;
  return { entry, removedMinutes };
}

// ─── Daemon life ─────────────────────────────────────────────────────────

/** Stamp the live timers as seen — the moment a sleep or a crash cuts them at. */
export function markTimersAlive(log: DailyLog, nowIso: string): void {
  for (const timer of getTimers(log)) {
    if (isLiveTimer(timer)) timer.lastSeenAt = nowIso;
  }
}

/**
 * The daemon was away (sleep, crash, reboot, restart): the time since each
 * live timer was last seen is nobody's. A running timer counts on from now.
 */
export function skipDowntime(log: DailyLog, nowIso: string): number {
  let cut = 0;
  for (const timer of getTimers(log)) {
    if (!isLiveTimer(timer)) continue;
    const counting = timer.spans.some(span => span.to === null);
    closeSpan(timer, timer.lastSeenAt);
    if (counting) openSpan(timer, nowIso);
    timer.lastSeenAt = nowIso;
    cut++;
  }
  creditTimers(log, Date.parse(nowIso));
  return cut;
}

// The day's minutes are final: a timer without an entry stays as the day's
// unlinked time, one that never counted leaves nothing behind.
function settleDay(log: DailyLog, atMs: number): void {
  creditTimers(log, atMs);
  const kept = getTimers(log).filter(timer => timer.entryId !== null || countedMs(timer, atMs) > 0);
  if (kept.length > 0) log.timers = kept;
  else delete log.timers;
}

/** The day is over: every timer stops at the boundary. Timers stay in the day's log. */
export function stopTimersForDayEnd(log: DailyLog, boundaryIso: string): void {
  for (const timer of getTimers(log)) {
    closeSpan(timer, boundaryIso);
    timer.state = TimerState.Paused;
  }
  settleDay(log, Date.parse(boundaryIso));
}

/**
 * A past day left with live timers (a crash or a power-off before its
 * boundary): each ends where it was last seen. Returns how many were live.
 */
export function settleOrphanTimers(log: DailyLog): number {
  let settled = 0;
  for (const timer of getTimers(log)) {
    if (!isLiveTimer(timer)) continue;
    closeSpan(timer, timer.lastSeenAt);
    timer.state = TimerState.Paused;
    settled++;
  }
  if (settled > 0) settleDay(log, Date.now());
  return settled;
}

/** Resolve a timer by id, or by its 1-based place in the day's order (#2) — a CLI fallback. */
export function resolveTimerTarget(log: DailyLog, target: string): Timer | null {
  const timers = getTimers(log);
  const byId = timers.find(timer => timer.id === target);
  if (byId) return byId;
  const index = parseInt(target.replace('#', ''), 10);
  if (!isNaN(index) && index >= 1 && index <= timers.length) return timers[index - 1];
  return null;
}

/**
 * Cut the timers at a moment (the month closed): stretches after it go,
 * one running across it ends there, a no-ticket timer born after it is
 * removed. Returns how many timers were touched.
 */
export function trimTimersAt(log: DailyLog, cutIso: string): number {
  const cutMs = Date.parse(cutIso);
  let touched = 0;
  for (const timer of [...getTimers(log)]) {
    if (timer.entryId === null && Date.parse(timer.createdAt) >= cutMs) {
      removeTimer(log, timer);
      touched++;
      continue;
    }
    const kept = timer.spans.filter(span => Date.parse(span.from) < cutMs);
    let changed = kept.length !== timer.spans.length;
    for (const span of kept) {
      if (span.to !== null && Date.parse(span.to) <= cutMs) continue;
      span.to = cutIso;
      changed = true;
    }
    if (!changed) continue;
    timer.spans = kept;
    timer.state = TimerState.Paused;
    touched++;
  }
  creditTimers(log, cutMs);
  return touched;
}
