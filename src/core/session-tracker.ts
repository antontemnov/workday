import { basename } from 'node:path';
import type { AppConfig, DailyLog, Session, PollResult, ReflogEntry, ClosedBy } from './types.js';
import { SESSION_STATE, CLOSED_BY, SIGNAL_TYPE } from './types.js';
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
    const today = computeWorkingDate(Date.now(), config.dayBoundaryHour);
    this.config = config;
    this.dailyLog = initialLog ?? createEmptyLog(today, config);
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
   * 4. Update session tick (endedAt, evidence, promote PENDING→ACTIVE)
   */
  public processPollResult(result: PollResult): void {
    const now = new Date().toISOString();
    const repoName = basename(result.repoPath);
    let openSession = this.findOpenSession(repoName);

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
        this.closeSession(openSession, CLOSED_BY.CHECKOUT_OTHER_TASK, now);
      }
      return;
    }

    if (openSession && openSession.task !== result.task) {
      // Task changed → close old, will open new below
      this.closeSession(openSession, CLOSED_BY.CHECKOUT_OTHER_TASK, now);
      openSession = null;
    }

    if (!openSession) {
      openSession = this.openSession(repoName, result.task, result.branch, now);
    }

    // 4. Update session with current tick data
    this.updateSessionTick(openSession, result, now);
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
    this.closeAllSessions(CLOSED_BY.DAY_BOUNDARY);
    const completedLog = this.dailyLog;

    const newDate = computeWorkingDate(Date.now(), this.config.dayBoundaryHour);
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
      state: SESSION_STATE.PENDING,
      startedAt: now,
      endedAt: now,
      closedBy: null,
      evidence: createEmptyEvidence(),
    };
    this.dailyLog.sessions.push(session);
    return session;
  }

  private closeSession(session: Session, reason: ClosedBy, now: string): void {
    if (session.closedBy) return; // already closed
    session.closedBy = reason;
    session.endedAt = now;
    // state stays as 'pending' or 'active' — preserved for reporting
  }

  // ─── Private: tick update ──────────────────────────────────────────────

  private updateSessionTick(session: Session, result: PollResult, now: string): void {
    session.endedAt = now;
    session.evidence.totalSnapshots++;

    // Promote PENDING → ACTIVE on dynamics or commit
    if (session.state === SESSION_STATE.PENDING) {
      const hasCommit = result.newReflogEntries.some(e => e.type === 'commit');
      if (result.delta.hasDynamics || hasCommit) {
        session.state = SESSION_STATE.ACTIVE;
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

    if (result.delta.hasDynamics) {
      addSignal(this.dailyLog, {
        ts: now,
        type: SIGNAL_TYPE.DIFF_DYNAMICS,
        repo: repoName,
        delta: {
          added: result.delta.addedDelta,
          removed: result.delta.removedDelta,
        },
      });
    }

    for (const entry of result.newReflogEntries) {
      if (entry.type === 'commit') {
        addSignal(this.dailyLog, {
          ts: entry.ts,
          type: SIGNAL_TYPE.COMMIT,
          repo: repoName,
          task: result.task,
        });
      } else if (entry.type === 'checkout') {
        addSignal(this.dailyLog, {
          ts: entry.ts,
          type: SIGNAL_TYPE.CHECKOUT,
          repo: repoName,
          task: result.task,
        });
      }
    }
  }
}
