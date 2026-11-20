import { TimerState, TimerView } from '../models/workday.models';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

// The daemon gives a timer's time as of one moment (`asOf`); a running timer
// has counted on since then, everything else stands.
function countedSince(timer: TimerView, asOfMs: number, nowMs: number): number {
  return timer.state === TimerState.Running ? Math.max(0, nowMs - asOfMs) : 0;
}

/** The fed entry's whole time right now — what its record shows. */
export function liveTotalMs(timer: TimerView, asOfMs: number, nowMs: number): number {
  return timer.totalMs + countedSince(timer, asOfMs, nowMs);
}

/** The timer's own time right now — what its row shows and what Remove takes out. */
export function liveShareMs(timer: TimerView, asOfMs: number, nowMs: number): number {
  return timer.shareMs + countedSince(timer, asOfMs, nowMs);
}

/** Whole minutes of the fed entry right now. */
export function liveMinutes(timer: TimerView, asOfMs: number, nowMs: number): number {
  return Math.floor(liveTotalMs(timer, asOfMs, nowMs) / MS_PER_MINUTE);
}

/** 47m · 1h 02m */
export function formatMinutes(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / MS_PER_MINUTE));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m`;
}

/** 47m 15s · 1h 02m 15s — a ticking time keeps its seconds past the hour too. */
export function formatTicking(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${formatMinutes(ms)} ${seconds}s`;
}

/**
 * The time a timer's row prints — the timer's own, not its entry's. On an
 * entry at rest it reads in whole minutes, like the entry; whatever is
 * switched on, and a timer without a ticket, keeps its seconds.
 */
export function formatTimerTime(timer: TimerView, asOfMs: number, nowMs: number): string {
  const ms = liveShareMs(timer, asOfMs, nowMs);
  return timer.entryId !== null && timer.state === TimerState.Paused ? formatMinutes(ms) : formatTicking(ms);
}

/** The time a record's row prints while its timer is on: the record's whole time — typed and counted. */
export function formatRecordTime(timer: TimerView, asOfMs: number, nowMs: number): string {
  return formatTicking(liveTotalMs(timer, asOfMs, nowMs));
}

/** The timer the header chip shows: the running one, else the waiting one, else the last touched by hand. */
export function currentTimer(timers: readonly TimerView[]): TimerView | null {
  const live = timers.find(t => t.state === TimerState.Running) ?? timers.find(t => t.state === TimerState.Waiting);
  if (live) return live;
  let last: TimerView | null = null;
  for (const timer of timers) {
    if (last === null || timer.touchedAt >= last.touchedAt) last = timer;
  }
  return last;
}
