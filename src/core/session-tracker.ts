import { basename } from 'node:path';
import { SessionState, ClosedBy, SignalType, PauseSource } from './types.js';
import type { AppConfig, DailyLog, Session, PollResult, ReflogEntry, Pause } from './types.js';
import {
  generateSessionId,
  createEmptyEvidence,
  createEmptyLog,
  writeDailyLog,
  addSignal,
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

  public constructor(config: AppConfig, initialLog?: DailyLog) {
    const today = computeWorkingDate(Date.now(), config.dayBoundaryHour, config.timezone);
    this.config = config;
    this.dailyLog = initialLog ?? createEmptyLog(today, config);

    // Normalize old sessions that lack pauses field
    for (const session of this.dailyLog.sessions) {
      if (!session.pauses) session.pauses = [];
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
    const now = new Date().toISOString();
    const repoName = basename(result.repoPath);
    let openSession = this.findOpenSession(repoName);

    // Full freeze: skip everything if session is paused
    if (openSession && this.isSessionPaused(openSession)) {
      return;
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

    return completedLog;
  }

  /** Mark manual start of workday */
  public setManualStart(timestamp: string): void {
    this.dailyLog.manualStart = timestamp;
  }

  /** Write current daily log to disk (atomic) */
  public flush(): void {
    writeDailyLog(this.dailyLog);
  }

  /** Get summary of open sessions (for status display) */
  public getOpenSessions(): readonly Session[] {
    return this.dailyLog.sessions.filter(s => !s.closedBy);
  }

  // ─── Pause / Resume ──────────────────────────────────────────────────

  /** Pause all open sessions */
  public pauseAllSessions(): void {
    const now = new Date().toISOString();
    for (const session of this.dailyLog.sessions) {
      if (!session.closedBy && !this.isSessionPaused(session)) {
        session.pauses.push({ from: now, to: null, source: PauseSource.Manual });
      }
    }
  }

  /** Pause a specific repo's open session. Returns true if a session was paused. */
  public pauseRepoSession(repoName: string): boolean {
    const session = this.findOpenSession(repoName);
    if (!session || this.isSessionPaused(session)) return false;

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
  public isSessionPaused(session: Session): boolean {
    return session.pauses.some(p => p.to === null);
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
      lastSeenAt: now,
      closedBy: null,
      evidence: createEmptyEvidence(),
      pauses: [],
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
  }

  private closeOpenPause(session: Session, now: string): void {
    const openPause = session.pauses.find(p => p.to === null);
    if (openPause) {
      openPause.to = now;
    }
  }

  // ─── Private: tick update ──────────────────────────────────────────────

  private updateSessionTick(session: Session, result: PollResult, now: string): void {
    session.lastSeenAt = now;
    session.evidence.totalSnapshots++;

    // Promote PENDING → ACTIVE on dynamics or commit
    if (session.state === SessionState.Pending) {
      const hasCommit = result.newReflogEntries.some(e => e.type === 'commit');
      if (result.delta.hasDynamics || hasCommit) {
        session.state = SessionState.Active;
      }
    }

    // Count dynamics heartbeat
    if (result.delta.hasDynamics) {
      session.evidence.dynamicsHeartbeats++;
    }
  }

  private creditReflogEvidence(session: Session, entries: ReflogEntry[]): void {
    for (const entry of entries) {
      if (entry.type === 'commit') {
        session.evidence.commits++;
        session.evidence.reflogEvents++;
      } else if (entry.type === 'checkout') {
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
