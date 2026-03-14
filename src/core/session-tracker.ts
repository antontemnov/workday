import { basename } from 'node:path';
import { SessionState, ClosedBy, SignalType, PauseSource } from './types.js';
import type { AppConfig, DailyLog, Session, PollResult, ReflogEntry, TickInput, EvaluatorResult, ActivitySignals } from './types.js';
import {
  generateSessionId,
  createEmptyEvidence,
  createEmptyLog,
  writeDailyLog,
  addSignal,
  isBudgetExhausted,
  addManualAdjustment,
  setDayManualStart,
  resolveSessionTarget,
  computeManualMinutes,
  getRemainingBudgetMs,
  getOpenPause,
} from './daily-log.js';
import { computeWorkingDate } from './config.js';

/**
 * Manages session lifecycle within a DailyLog.
 *
 * Responsibilities:
 * - Opens/closes/updates sessions based on PollResult from GitTracker
 * - Handles task switches (close old → open new)
 * - Handles day boundary (close all → start fresh)
 * - Logs signals (diff_dynamics, commit, checkout)
 * - Credits evidence counters to sessions
 * - Supports crash recovery (resume open sessions from disk)
 *
 * Usage:
 *   const tracker = new SessionTracker(config);
 *   // or with crash recovery:
 *   const tracker = new SessionTracker(config, existingLog);
 *
 *   // each poll tick:
 *   for (const result of pollResults) {
 *     tracker.processPollResult(result);
 *   }
 *   tracker.flush();
 */
export class SessionTracker {
  private dailyLog: DailyLog;
  private readonly config: AppConfig;
  private readonly autoPauseDisabledSessions: Set<string> = new Set();
  private lastEvaluatorResult: EvaluatorResult | null = null;
  public onSessionClosed: ((sessionId: string) => void) | null = null;

  public constructor(config: AppConfig, initialLog?: DailyLog) {
    const today = computeWorkingDate(Date.now(), config.dayBoundaryHour, config.timezone);
    this.config = config;
    this.dailyLog = initialLog ?? createEmptyLog(today, config);

    // Normalize old logs that lack new fields
    if (this.dailyLog.dayStartedAt === undefined) {
      (this.dailyLog as DailyLog).dayStartedAt = null;
    }

    // Normalize old sessions that lack new fields
    for (const session of this.dailyLog.sessions) {
      if (!session.pauses) session.pauses = [];
      if (!session.manualAdjustments) session.manualAdjustments = [];
      if (session.activatedAt === undefined) (session as Session).activatedAt = null;
      if (session.evidence.linesAdded === undefined) session.evidence.linesAdded = 0;
      if (session.evidence.linesRemoved === undefined) session.evidence.linesRemoved = 0;
      if (session.evidence.filesChanged === undefined) session.evidence.filesChanged = 0;
    }
  }

  public getDailyLog(): DailyLog {
    return this.dailyLog;
  }

  /**
   * Process one poll tick for a single repo.
   *
   * Flow:
   * 1. Credit reflog evidence to current open session (before any close)
   * 2. Log signals (dynamics, commits, checkouts)
   * 3. Handle session lifecycle (close/open/switch)
   * 4. Update session tick (lastSeenAt, evidence, promote PENDING→ACTIVE)
   */
  public processPollResult(result: PollResult): void {
    if (this.isBudgetExhausted()) return;

    const now = new Date().toISOString();
    const repoName = basename(result.repoPath);
    let openSession = this.findOpenSession(repoName);

    // Pause handling
    if (openSession && this.hasOpenPause(openSession)) {
      const pauseSource = this.getOpenPauseSource(openSession);
      const hasActivity = result.delta.hasDynamics || result.newReflogEntries.some(e => e.type === 'commit');

      if (pauseSource === PauseSource.Manual) {
        if (hasActivity) {
          // Auto-resume: developer forgot to resume, close pause and continue
          this.closeOpenPause(openSession, now);
        } else {
          // Manual pause, no activity — full freeze
          return;
        }
      }
      // Auto-pauses (IdleTimeout/Superseded) — fall through, normal processing
    }

    // 1. Credit reflog evidence to current open session before potential close
    if (openSession && result.newReflogEntries.length > 0) {
      this.creditReflogEvidence(openSession, result.newReflogEntries);
    }

    // 2. Log signals
    this.logSignals(repoName, result);

    // 3. Handle session lifecycle
    if (result.task === null) {
      // Not on developer's branch → close if open
      if (openSession) {
        this.closeSession(openSession, ClosedBy.CheckoutOtherTask, now);
      }
      return;
    }

    if (openSession && openSession.task !== result.task) {
      // Task changed → close old, will open new below
      this.closeSession(openSession, ClosedBy.CheckoutOtherTask, now);
      openSession = null;
    }

    if (!openSession) {
      openSession = this.openSession(repoName, result.task, result.branch, now);
    }

    // 4. Update session with current tick data
    this.updateSessionTick(openSession, result, now);
  }

  /**
   * Close orphaned sessions from a previous daemon crash.
   * Preserves saved lastSeenAt (last known poll time, at most ~30s before crash).
   */
  public closeCrashedSessions(): number {
    let count = 0;
    for (const session of this.dailyLog.sessions) {
      if (!session.closedBy) {
        this.closeOpenPause(session, session.lastSeenAt);
        session.closedBy = ClosedBy.DaemonCrash;
        count++;
      }
    }
    return count;
  }

  /** Close all open sessions with given reason */
  public closeAllSessions(reason: ClosedBy): void {
    const now = new Date().toISOString();
    for (const session of this.dailyLog.sessions) {
      if (!session.closedBy) {
        this.closeSession(session, reason, now);
      }
    }
  }

  /**
   * Handle day boundary: close all sessions, return completed log, start fresh.
   * Caller should flush the returned log to disk.
   */
  public handleDayBoundary(): DailyLog {
    this.closeAllSessions(ClosedBy.DayBoundary);
    const completedLog = this.dailyLog;

    const newDate = computeWorkingDate(Date.now(), this.config.dayBoundaryHour, this.config.timezone);
    this.dailyLog = createEmptyLog(newDate, this.config);

    this.autoPauseDisabledSessions.clear();
    this.lastEvaluatorResult = null;

    return completedLog;
  }

  /** Mark manual start of workday */
  public setManualStart(timestamp: string): void {
    this.dailyLog.manualStart = timestamp;
  }

  /** Set dayStartedAt (called by daemon on startup) */
  public setDayStartedAt(timestamp: string): void {
    if (!this.dailyLog.dayStartedAt) {
      this.dailyLog.dayStartedAt = timestamp;
    }
  }

  // ─── Budget ────────────────────────────────────────────────────────────

  /** Check if budget is exhausted */
  public isBudgetExhausted(): boolean {
    return isBudgetExhausted(this.dailyLog, this.config);
  }

  /** Close all open sessions with BudgetExhausted */
  public closeBudgetExhausted(): void {
    this.closeAllSessions(ClosedBy.BudgetExhausted);
  }

  /** Add manual time adjustment to a session */
  public addAdjustment(target: string, minutes: number, reason: string): { ok: boolean; error?: string; sessionId?: string } {
    const session = resolveSessionTarget(this.dailyLog, target);
    if (!session) {
      return { ok: false, error: `Session not found: ${target}` };
    }
    try {
      addManualAdjustment(this.dailyLog, session.id, minutes, reason, this.config);
      return { ok: true, sessionId: session.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Set manual day start */
  public setManualDayStart(isoTimestamp: string): { ok: boolean; error?: string } {
    try {
      setDayManualStart(this.dailyLog, isoTimestamp, this.config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get remaining budget in ms */
  public getRemainingBudgetMs(): number {
    return getRemainingBudgetMs(this.dailyLog, this.config);
  }

  /** Get manual minutes for a session */
  public getManualMinutes(session: Session): number {
    return computeManualMinutes(session);
  }

  /** Write current daily log to disk (atomic) */
  public flush(): void {
    writeDailyLog(this.dailyLog);
  }

  /** Get summary of open sessions (for status display) */
  public getOpenSessions(): readonly Session[] {
    return this.dailyLog.sessions.filter(s => !s.closedBy);
  }

  // ─── Evaluator integration ────────────────────────────────────────────

  /** Build TickInput[] for all open sessions (except manually paused) */
  public buildTickInputs(pollResults: readonly PollResult[]): readonly TickInput[] {
    const resultMap = new Map<string, PollResult>();
    for (const r of pollResults) {
      resultMap.set(basename(r.repoPath), r);
    }

    const ticks: TickInput[] = [];
    for (const session of this.dailyLog.sessions) {
      if (session.closedBy) continue;

      // Manually paused sessions are frozen — don't send to evaluator
      if (this.hasOpenPause(session) && this.getOpenPauseSource(session) === PauseSource.Manual) {
        continue;
      }

      const poll = resultMap.get(session.repo);
      const signals: ActivitySignals = poll
        ? {
            hasDynamics: poll.delta.hasDynamics,
            hasCommit: poll.newReflogEntries.some(e => e.type === 'commit'),
            deltaMagnitude: Math.abs(poll.delta.addedDelta) + Math.abs(poll.delta.removedDelta),
          }
        : { hasDynamics: false, hasCommit: false, deltaMagnitude: 0 };

      ticks.push({
        sessionId: session.id,
        signals,
        autoPauseDisabled: this.autoPauseDisabledSessions.has(session.id),
      });
    }

    return ticks;
  }

  /** Apply evaluator results: auto-pause, auto-resume, Pending→Active promotion */
  public applyEvaluatorResult(result: EvaluatorResult): void {
    this.lastEvaluatorResult = result;
    const now = new Date().toISOString();

    for (const session of this.dailyLog.sessions) {
      if (session.closedBy) continue;

      const sessionScore = result.scores.get(session.id);
      if (!sessionScore) continue; // manually paused, not in evaluator

      const isLeader = result.leaderId === session.id;

      if (session.state === SessionState.Active) {
        if (isLeader) {
          // Leader — close any auto-pause
          this.closeAutoPause(session, now);
        } else if (sessionScore.isIdleTimeout) {
          // score == 0 → IdleTimeout (unless autopause disabled)
          if (!this.autoPauseDisabledSessions.has(session.id)) {
            this.applyAutoPause(session, PauseSource.IdleTimeout, now);
          }
        } else {
          // score > 0 but not leader → Superseded
          this.applyAutoPause(session, PauseSource.Superseded, now);
        }
      } else if (session.state === SessionState.Pending) {
        // Pending → Active: score > 0 AND is leader
        if (sessionScore.score > 0 && isLeader) {
          session.state = SessionState.Active;
          session.activatedAt = now;
        }
      }
    }
  }

  public getLastEvaluatorResult(): EvaluatorResult | null {
    return this.lastEvaluatorResult;
  }

  // ─── Autopause management ────────────────────────────────────────────

  /** Toggle autopause for a specific repo or all repos. Returns affected repo names. */
  public setAutoPauseDisabled(disabled: boolean, repoName?: string): string[] {
    const affected: string[] = [];
    for (const session of this.dailyLog.sessions) {
      if (session.closedBy) continue;
      if (repoName && session.repo !== repoName) continue;

      if (disabled) {
        this.autoPauseDisabledSessions.add(session.id);
      } else {
        this.autoPauseDisabledSessions.delete(session.id);
      }
      affected.push(session.repo);
    }
    return affected;
  }

  public isAutoPauseDisabled(sessionId: string): boolean {
    return this.autoPauseDisabledSessions.has(sessionId);
  }

  // ─── Pause / Resume ──────────────────────────────────────────────────

  /** Pause all open sessions */
  public pauseAllSessions(): void {
    const now = new Date().toISOString();
    for (const session of this.dailyLog.sessions) {
      if (!session.closedBy && !this.hasOpenPause(session)) {
        session.pauses.push({ from: now, to: null, source: PauseSource.Manual });
      }
    }
  }

  /** Pause a specific repo's open session. Returns true if a session was paused. */
  public pauseRepoSession(repoName: string): boolean {
    const session = this.findOpenSession(repoName);
    if (!session || this.hasOpenPause(session)) return false;

    const now = new Date().toISOString();
    session.pauses.push({ from: now, to: null, source: PauseSource.Manual });
    return true;
  }

  /** Resume all paused sessions */
  public resumeAllSessions(): void {
    const now = new Date().toISOString();
    for (const session of this.dailyLog.sessions) {
      if (!session.closedBy) {
        this.closeOpenPause(session, now);
      }
    }
  }

  /** Check if a session is currently paused */
  public hasOpenPause(session: Session): boolean {
    return getOpenPause(session) !== null;
  }

  // ─── Private: session lifecycle ────────────────────────────────────────

  private findOpenSession(repo: string): Session | null {
    return this.dailyLog.sessions.find(
      s => s.repo === repo && !s.closedBy
    ) ?? null;
  }

  private openSession(repo: string, task: string | null, branch: string, now: string): Session {
    const session: Session = {
      id: generateSessionId(),
      repo,
      task,
      branch,
      state: SessionState.Pending,
      startedAt: now,
      activatedAt: null,
      lastSeenAt: now,
      closedBy: null,
      evidence: createEmptyEvidence(),
      pauses: [],
      manualAdjustments: [],
    };
    this.dailyLog.sessions.push(session);
    return session;
  }

  private closeSession(session: Session, reason: ClosedBy, now: string): void {
    if (session.closedBy) return; // already closed

    // Close any open pause before closing the session
    this.closeOpenPause(session, now);

    session.closedBy = reason;
    session.lastSeenAt = now;
    // state stays as 'pending' or 'active' — preserved for reporting

    this.autoPauseDisabledSessions.delete(session.id);
    this.onSessionClosed?.(session.id);
  }

  private closeOpenPause(session: Session, now: string): void {
    const pause = getOpenPause(session);
    if (pause) {
      pause.to = now;
    }
  }

  private getOpenPauseSource(session: Session): PauseSource | null {
    return getOpenPause(session)?.source ?? null;
  }

  /** Apply auto-pause if not already paused with the same source */
  private applyAutoPause(session: Session, source: PauseSource, now: string): void {
    const currentSource = this.getOpenPauseSource(session);
    if (currentSource === PauseSource.Manual) return; // Never override manual pause
    if (currentSource === source) return; // already paused with same source
    if (currentSource !== null) {
      // Close existing auto-pause before applying new one
      this.closeOpenPause(session, now);
    }
    session.pauses.push({ from: now, to: null, source });
  }

  /** Close auto-pause (IdleTimeout or Superseded) if present */
  private closeAutoPause(session: Session, now: string): void {
    const pause = getOpenPause(session);
    if (pause && (pause.source === PauseSource.IdleTimeout || pause.source === PauseSource.Superseded)) {
      pause.to = now;
    }
  }

  // ─── Private: tick update ──────────────────────────────────────────────

  private updateSessionTick(session: Session, result: PollResult, now: string): void {
    session.lastSeenAt = now;

    // Accumulate line stats (positive deltas = new edits, negative = committed/reverted)
    if (result.delta.addedDelta > 0) {
      session.evidence.linesAdded += result.delta.addedDelta;
    }
    if (result.delta.removedDelta > 0) {
      session.evidence.linesRemoved += result.delta.removedDelta;
    }

    // Track max concurrent files changed (high water mark)
    if (result.snapshot.trackedFileCount > session.evidence.filesChanged) {
      session.evidence.filesChanged = result.snapshot.trackedFileCount;
    }
  }

  private creditReflogEvidence(session: Session, entries: ReflogEntry[]): void {
    for (const entry of entries) {
      if (entry.type === 'commit') {
        session.evidence.commits++;
        session.evidence.reflogEvents++;
      } else if (entry.type === 'checkout' || entry.type === 'reset') {
        session.evidence.reflogEvents++;
      }
    }
  }

  // ─── Private: signals ──────────────────────────────────────────────────

  private logSignals(repoName: string, result: PollResult): void {
    const now = Date.now();
    const dedup = this.config.session.signalDeduplicationSeconds;

    if (result.delta.hasDynamics) {
      addSignal(this.dailyLog, {
        ts: now,
        type: SignalType.DiffDynamics,
        repo: repoName,
        delta: {
          added: result.delta.addedDelta,
          removed: result.delta.removedDelta,
          untracked: result.delta.untrackedDelta,
        },
      }, dedup);
    }

    for (const entry of result.newReflogEntries) {
      if (entry.type === 'commit') {
        addSignal(this.dailyLog, {
          ts: entry.ts,
          type: SignalType.Commit,
          repo: repoName,
          task: result.task,
        }, dedup);
      } else if (entry.type === 'checkout') {
        addSignal(this.dailyLog, {
          ts: entry.ts,
          type: SignalType.Checkout,
          repo: repoName,
          task: result.task,
        }, dedup);
      }
    }
  }
}
