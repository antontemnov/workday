import type { ActivityEvaluator } from './activity-evaluator.js';
import type { SessionTracker } from './session-tracker.js';
import { bindTimer, computeDayEnd, resolveManualEntryTarget, type TimerBinding } from './daily-log.js';
import {
  cancelNewTimer,
  creditTimers,
  deleteTimer,
  describeTimer,
  findLiveTimer,
  getTimers,
  hideTimer,
  markTimersAlive,
  newTimer,
  pauseAllTimers,
  pauseTimer,
  reclaimTimer,
  removeEntryTimer,
  resolveTimerTarget,
  skipDowntime,
  startEntryTimer,
  startTimer,
  stopTimersForDayEnd,
  toTimerView,
  yieldTimer,
  type DisplacedTimer,
} from './timers.js';
import { TimerState } from './types.js';
import type { AppConfig, DailyLog, EvaluatorOptions, EvaluatorResult, ManualEntry, Timer, TimersResponse } from './types.js';

/**
 * Manual timers of the live day: the timer actions, and the glue between
 * timers and the evaluator — one counts at a time, a session or a timer.
 *
 * A timer started or paused by hand settles the lead at once through
 * evaluator.reselect(): no git poll, no extra tick. On a regular tick the
 * running timer is the evaluator's defending leader (evaluatorOptions) and
 * applyEvaluatorResult moves it between running and waiting.
 *
 * Usage:
 *   const result = evaluator.processAllTicks(ticks, timerTracker.evaluatorOptions());
 *   sessionTracker.applyEvaluatorResult(result);
 *   timerTracker.applyEvaluatorResult(result);
 */
export class TimerTracker {
  private readonly sessionTracker: SessionTracker;
  private readonly evaluator: ActivityEvaluator;
  private readonly config: AppConfig;
  // The latest New timer and whom it put on pause — what cancel gives back.
  private birth: { readonly timerId: string; readonly displaced: DisplacedTimer | null } | null = null;

  public constructor(sessionTracker: SessionTracker, evaluator: ActivityEvaluator, config: AppConfig) {
    this.sessionTracker = sessionTracker;
    this.evaluator = evaluator;
    this.config = config;
  }

  private get log(): DailyLog {
    return this.sessionTracker.getDailyLog();
  }

  // ─── Read ─────────────────────────────────────────────────────────────

  public isRunning(): boolean {
    return getTimers(this.log).some(timer => timer.state === TimerState.Running);
  }

  public hasLiveTimer(): boolean {
    return findLiveTimer(this.log) !== undefined;
  }

  /** Bring every fed entry's minutes up to now. */
  public credit(): void {
    creditTimers(this.log, Date.now());
  }

  public getTimers(): TimersResponse {
    const log = this.log;
    const nowMs = Date.now();
    creditTimers(log, nowMs);
    return {
      date: log.date,
      asOf: new Date(nowMs).toISOString(),
      counting: this.isRunning() ? 'timer' : this.sessionTracker.hasCountingSession() ? 'session' : 'none',
      desktopWidget: this.config.timer.desktopWidget,
      timers: getTimers(log).map(timer => toTimerView(log, timer, nowMs)),
    };
  }

  // ─── Actions (throw on refusal) ───────────────────────────────────────

  /** New timer: no ticket, runs at once. */
  public create(description: string): Timer {
    this.assertTracking();
    const { timer, displaced } = newTimer(this.log, description, nowIso());
    this.birth = { timerId: timer.id, displaced };
    this.takeLead();
    return timer;
  }

  public start(target: string): Timer {
    this.assertTracking();
    const timer = this.requireTimer(target);
    startTimer(this.log, timer, nowIso());
    this.takeLead();
    return timer;
  }

  /** Start timer on a manual entry (target = #index or id). */
  public startOnEntry(target: string): Timer {
    this.assertTracking();
    const entry = this.requireEntry(target);
    const { timer } = startEntryTimer(this.log, entry.id, nowIso());
    this.takeLead();
    return timer;
  }

  /** Pause by hand — the given timer, or the live one. */
  public pause(target?: string): Timer {
    const timer = target ? this.requireTimer(target) : findLiveTimer(this.log);
    if (!timer) throw new Error('No timer is running');
    pauseTimer(this.log, timer, nowIso());
    this.settleLead();
    return timer;
  }

  public describe(target: string, description: string): Timer {
    const timer = describeTimer(this.log, this.requireTimer(target).id, description);
    this.sessionTracker.flush();
    return timer;
  }

  /** task? → Log: the timer gets its ticket. */
  public bind(target: string, input: { task: string; description: string; activity: string; minutes?: number }): TimerBinding {
    this.assertTracking();
    const binding = bindTimer(this.log, this.requireTimer(target).id, input, this.config);
    this.sessionTracker.flush();
    return binding;
  }

  /** Remove timer from an entry (target = #index or id). */
  public remove(target: string): { entry: ManualEntry; removedMinutes: number } {
    const entry = this.requireEntry(target);
    const removed = removeEntryTimer(this.log, entry.id, nowIso());
    this.settleLead();
    return removed;
  }

  public delete(target: string): Timer {
    const timer = deleteTimer(this.log, this.requireTimer(target).id);
    this.settleLead();
    return timer;
  }

  /** Undo a New timer made by mistake: whoever it put on pause is back as it was. */
  public cancel(target: string): void {
    const timer = this.requireTimer(target);
    const displaced = this.birth?.timerId === timer.id ? this.birth.displaced : null;
    cancelNewTimer(this.log, timer.id, displaced, nowIso());
    this.birth = null;
    this.settleLead();
  }

  public hide(target: string): Timer {
    const timer = hideTimer(this.log, this.requireTimer(target).id);
    this.sessionTracker.flush();
    return timer;
  }

  /** Every live timer goes on pause: the daemon stopped by hand, the month closed, stop tracking. */
  public pauseAll(): number {
    return pauseAllTimers(this.log, nowIso());
  }

  /**
   * An entry went away outside the timer actions (deleted, its card
   * deleted) and may have taken the running timer with it: the sessions
   * settle the lead now, not on the next tick.
   */
  public settle(): void {
    this.settleLead();
  }

  // ─── Evaluator glue ───────────────────────────────────────────────────

  public evaluatorOptions(): EvaluatorOptions {
    return { timerRunning: this.isRunning() };
  }

  /**
   * After a tick: a session took the count — the running timer waits; no
   * session leads any more — the waiting timer counts again.
   */
  public applyEvaluatorResult(result: EvaluatorResult): void {
    const now = nowIso();
    const live = findLiveTimer(this.log);
    if (live?.state === TimerState.Running && result.leaderId !== null) {
      yieldTimer(this.log, live, now);
    } else if (live?.state === TimerState.Waiting && result.leaderId === null) {
      reclaimTimer(live, now);
    }
    markTimersAlive(this.log, now);
    creditTimers(this.log, Date.parse(now));
  }

  // ─── Daemon life ──────────────────────────────────────────────────────

  /**
   * The daemon was away — sleep, crash, reboot, self-update: that time is
   * nobody's and a live timer goes on by itself. Returns timers cut.
   */
  public skipDowntime(): number {
    return skipDowntime(this.log, nowIso());
  }

  /** Before the day's log is swapped: timers stop at the boundary and stay in the old day. */
  public handleDayBoundary(): void {
    const log = this.log;
    const dayEnd = computeDayEnd(log.date, this.config.boundaryHour, this.config.timezone);
    stopTimersForDayEnd(log, new Date(Math.min(Date.now(), dayEnd)).toISOString());
    this.birth = null;
  }

  // ─── Private ──────────────────────────────────────────────────────────

  // A start by hand: attention moves to the timer, sessions are superseded now.
  private takeLead(): void {
    this.evaluator.resetAttention();
    this.sessionTracker.applyEvaluatorResult(this.evaluator.reselect({ timerRunning: true }));
    this.sessionTracker.flush();
  }

  // A timer left the lead (or never had it): the sessions settle it among themselves.
  private settleLead(): void {
    this.sessionTracker.applyEvaluatorResult(this.evaluator.reselect(this.evaluatorOptions()));
    this.sessionTracker.flushOrDropDay();
  }

  private assertTracking(): void {
    if (this.sessionTracker.isMonthLocked()) {
      throw new Error('The month is closed in Tempo — nothing is tracked');
    }
  }

  private requireTimer(target: string): Timer {
    const timer = resolveTimerTarget(this.log, target);
    if (!timer) throw new Error(`Timer not found: ${target}`);
    return timer;
  }

  private requireEntry(target: string): ManualEntry {
    const entry = resolveManualEntryTarget(this.log, target);
    if (!entry) throw new Error(`Manual entry not found: ${target}`);
    return entry;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
