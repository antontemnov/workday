import { basename } from 'node:path';
import { SessionState, ClosedBy, SignalType, PauseSource, SensitivityLevel } from './types.js';
import type { AppConfig, DailyLog, Session, ManualEntry, PollResult, TickInput, EvaluatorResult, ActivitySignals, EvidenceSnapshot, LedgerQuery } from './types.js';
import { applyLedgerUpdate, countSessionCommits, createEmptyLedger } from './commit-ledger.js';
import {
  generateSessionId,
  createEmptyEvidence,
  createEmptyLog,
  writeDailyLog,
  addSignal,
  isBudgetExhausted,
  addManualAdjustment,
  addManualEntry,
  editManualEntry,
  setDayManualStart,
  resolveSessionTarget,
  computeManualMinutes,
  getRemainingBudgetMs,
  getOpenPause,
} from './daily-log.js';
import { computeWorkingDate, getSensitivityForRepo, resolveSensitivityTicks, writeConfig } from './config.js';

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
  private lastEvaluatorResult: EvaluatorResult | null = null;
  public onSessionClosed: ((sessionId: string) => void) | null = null;

  public constructor(config: AppConfig, initialLog?: DailyLog) {
    const today = computeWorkingDate(Date.now(), config.schedule.end, config.timezone);
    this.config = config;
    this.dailyLog = initialLog ?? createEmptyLog(today, config);

    // Normalize old logs that lack new fields
    if (this.dailyLog.dayStartedAt === undefined) {
      (this.dailyLog as DailyLog).dayStartedAt = null;
    }
    if (!this.dailyLog.manualEntries) {
      this.dailyLog.manualEntries = [];
    }

    // Normalize old sessions that lack new fields
    for (const session of this.dailyLog.sessions) {
      if (!session.pauses) session.pauses = [];
      if (!session.manualAdjustments) session.manualAdjustments = [];
      if (session.activatedAt === undefined) (session as Session).activatedAt = null;
      if (session.evidence.linesAdded === undefined) session.evidence.linesAdded = 0;
      if (session.evidence.linesRemoved === undefined) session.evidence.linesRemoved = 0;
      if (session.evidence.filesChanged === undefined) session.evidence.filesChanged = 0;
      if (session.baseSha === undefined) session.baseSha = null;
      if (session.mergeBaseSha === undefined) session.mergeBaseSha = null;
      if (session.evidenceBaseline === undefined) session.evidenceBaseline = null;
      if (session.lastBranchCommits === undefined) session.lastBranchCommits = null;
      if (session.ledger === undefined) session.ledger = null;
    }
  }

  /** True when a unix-seconds timestamp falls inside this log's working day. */
  private readonly isInDay = (unixSeconds: number): boolean =>
    computeWorkingDate(unixSeconds * 1000, this.config.schedule.end, this.config.timezone) === this.dailyLog.date;

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

    // 1. Log signals (reflog evidence is now derived from `git rev-list baseSha..HEAD`
    //    each tick, not accumulated from reflog entries — see updateSessionTick).
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
    this.pruneEmptySessions();
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
    this.pruneEmptySessions();
  }

  /** Close open sessions for a specific repo (used when the repo is removed). */
  public closeSessionsForRepo(repoName: string): void {
    const now = new Date().toISOString();
    for (const session of this.dailyLog.sessions) {
      if (session.repo === repoName && !session.closedBy) {
        this.closeSession(session, ClosedBy.ManualStop, now);
      }
    }
    this.pruneEmptySessions();
  }

  /**
   * Drop sessions that never reached ACTIVE (no activatedAt).
   * Called from all shutdown / recovery paths before flushing.
   * Notifies the evaluator so it releases any runtime state.
   */
  private pruneEmptySessions(): void {
    const kept: Session[] = [];
    for (const session of this.dailyLog.sessions) {
      if (session.activatedAt) {
        kept.push(session);
      } else {
        this.onSessionClosed?.(session.id);
      }
    }
    if (kept.length !== this.dailyLog.sessions.length) {
      this.dailyLog.sessions = kept;
    }
  }

  /**
   * Handle day boundary: close all sessions, return completed log, start fresh.
   * Caller should flush the returned log to disk.
   */
  public handleDayBoundary(): DailyLog {
    this.closeAllSessions(ClosedBy.DayBoundary);
    const completedLog = this.dailyLog;

    const newDate = computeWorkingDate(Date.now(), this.config.schedule.end, this.config.timezone);
    this.dailyLog = createEmptyLog(newDate, this.config);

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

  /** Set manual day start. Pass null to clear. */
  public setManualDayStart(isoTimestamp: string | null): { ok: boolean; error?: string } {
    try {
      setDayManualStart(this.dailyLog, isoTimestamp, this.config);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Add a manual entry to today's log */
  public addManualEntry(input: { task: string; minutes: number; description: string; activity: string }): { ok: boolean; error?: string; entry?: ManualEntry } {
    try {
      const entry = addManualEntry(this.dailyLog, input, this.config);
      return { ok: true, entry };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Edit a manual entry in today's log */
  public editManualEntry(id: string, patch: { minutes?: number; description?: string; activity?: string }): { ok: boolean; error?: string } {
    try {
      editManualEntry(this.dailyLog, id, patch, this.config);
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

  /**
   * Resolve baseSha per configured repoPath for the next poll tick — used by
   * GitTracker to build `git diff baseSha` / `git rev-list baseSha..HEAD`.
   * Returns null for repos with no open session yet.
   */
  public getBaseShasPerRepoPath(repoPaths: readonly string[]): Map<string, string | null> {
    const map = new Map<string, string | null>();
    for (const repoPath of repoPaths) {
      const name = basename(repoPath);
      const session = this.dailyLog.sessions.find(s => !s.closedBy && s.repo === name);
      map.set(repoPath, session?.baseSha ?? null);
    }
    return map;
  }

  /**
   * Per-repo commit-ledger context for the next poll tick. The open session's
   * ledger wins; with none open, the newest closed session today that carries
   * a ledger keeps reflog continuity across close/reopen (transitions that
   * happened while the session was closed replay instead of getting lost).
   * Null → the collector seeds a fresh ledger.
   */
  public getLedgerQueries(repoPaths: readonly string[]): Map<string, LedgerQuery | null> {
    const map = new Map<string, LedgerQuery | null>();
    for (const repoPath of repoPaths) {
      const name = basename(repoPath);
      let source = this.dailyLog.sessions.find(s => !s.closedBy && s.repo === name) ?? null;
      if (!source) {
        for (let i = this.dailyLog.sessions.length - 1; i >= 0; i--) {
          const s = this.dailyLog.sessions[i];
          if (s.repo === name && s.ledger) { source = s; break; }
        }
      }
      if (!source?.ledger) {
        map.set(repoPath, null);
        continue;
      }
      map.set(repoPath, {
        branch: source.branch,
        pointer: source.ledger.pointer,
        knownShas: source.ledger.commits.map(c => c.sha),
      });
    }
    return map;
  }

  // ─── Evaluator integration ────────────────────────────────────────────

  /** Build TickInput[] for all open sessions (except manually paused) */
  public buildTickInputs(pollResults: readonly PollResult[]): readonly TickInput[] {
    const resultMap = new Map<string, PollResult>();
    for (const r of pollResults) {
      resultMap.set(basename(r.repoPath), r);
    }

    const pollSeconds = this.config.session.diffPollSeconds;
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
            deltaMagnitude: poll.delta.magnitude,
          }
        : { hasDynamics: false, hasCommit: false, deltaMagnitude: 0 };

      const level = getSensitivityForRepo(this.config, session.repo);
      const { maxTicks, ignoreIdleTimeout } = resolveSensitivityTicks(level, pollSeconds);

      ticks.push({
        sessionId: session.id,
        signals,
        maxTicks,
        ignoreIdleTimeout,
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
          // score == 0 with idle-timeout eligible (Always-on already filtered upstream)
          this.applyAutoPause(session, PauseSource.IdleTimeout, now);
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

  // ─── Sensitivity management ──────────────────────────────────────────

  /**
   * Set sensitivity for a repo (perRepo override) or global default.
   * Persisted to config.json immediately. Auto-resumes manual pause on the
   * affected repos as a side effect — switching off Pause via the scale pill.
   */
  public setSensitivity(level: SensitivityLevel, repoName?: string): void {
    if (repoName) {
      this.config.sensitivity.perRepo[repoName] = level;
    } else {
      this.config.sensitivity.default = level;
    }
    writeConfig(this.config);

    // Side effect: any manual pause on the affected repo(s) is closed —
    // picking a sensitivity pill implicitly resumes the session.
    const now = new Date().toISOString();
    for (const session of this.dailyLog.sessions) {
      if (session.closedBy) continue;
      if (repoName && session.repo !== repoName) continue;
      if (this.getOpenPauseSource(session) === PauseSource.Manual) {
        this.closeOpenPause(session, now);
      }
    }
  }

  /** Current sensitivity for a repo (perRepo override → default). */
  public getSensitivity(repoName: string): SensitivityLevel {
    return getSensitivityForRepo(this.config, repoName);
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

  /**
   * True when someone is plausibly mid-work: at least one open, unpaused
   * session. Used as the quiet-window gate for self-update restarts.
   */
  public hasActiveWork(): boolean {
    return this.getOpenSessions().some(s => !this.hasOpenPause(s));
  }

  // ─── Private: session lifecycle ────────────────────────────────────────

  private findOpenSession(repo: string): Session | null {
    return this.dailyLog.sessions.find(
      s => s.repo === repo && !s.closedBy
    ) ?? null;
  }

  private openSession(repo: string, task: string | null, branch: string, now: string): Session {
    // Continued work on the same repo+task today inherits the evidence
    // baseline and counters, so the day's numbers keep accumulating across
    // close/reopen. If no prior session is found, the first poll captures
    // a fresh baseline — see updateSessionTick.
    const prior = this.findPriorTaskSession(repo, task);
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
      baseSha: prior?.baseSha ?? null,
      mergeBaseSha: null,
      evidenceBaseline: prior?.evidenceBaseline ? { ...prior.evidenceBaseline } : null,
      lastBranchCommits: prior?.lastBranchCommits ?? null,
      ledger: prior?.ledger ? structuredClone(prior.ledger) : null,
    };
    if (prior) {
      // Commit accumulator continues from where the prior session stopped.
      session.evidence.commits = prior.evidence.commits;
    }
    this.dailyLog.sessions.push(session);
    return session;
  }

  /** Most-recent session today on the same (repo, task) with a captured evidence base. */
  private findPriorTaskSession(repo: string, task: string | null): Session | null {
    if (!task) return null;
    for (let i = this.dailyLog.sessions.length - 1; i >= 0; i--) {
      const s = this.dailyLog.sessions[i];
      if (s.repo === repo && s.task === task && (s.baseSha || s.evidenceBaseline || s.ledger)) return s;
    }
    return null;
  }

  private closeSession(session: Session, reason: ClosedBy, now: string): void {
    if (session.closedBy) return; // already closed

    // Close any open pause before closing the session
    this.closeOpenPause(session, now);

    session.closedBy = reason;
    session.lastSeenAt = now;
    // state stays as 'pending' or 'active' — preserved for reporting

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

  /**
   * Apply one poll tick.
   *
   * Merge-base mode (default branch resolved): evidenceSnapshot holds branch
   * totals vs the *fresh* merge-base — rebase-stable by construction. Lines
   * and files are the delta vs the baseline captured at session open; commits
   * accumulate only positive jumps of the branch commit count, so squash /
   * drop / amend / rebase never erase already-counted work. No re-anchoring,
   * no zeroing.
   *
   * Fallback mode (no default branch): sticky baseSha anchored at session
   * start, evidence overwritten from the snapshot each tick, re-anchor +
   * zero on rebase reflog entries or when baseSha becomes unreachable
   * (force-push / hard reset) — the pre-merge-base behavior.
   */
  private updateSessionTick(session: Session, result: PollResult, now: string): void {
    session.lastSeenAt = now;

    if (result.evidenceBasis === 'merge_base' && result.evidenceSnapshot !== null) {
      this.applyMergeBaseEvidence(session, result.evidenceSnapshot, result);
      return;
    }

    if (session.baseSha === null) {
      session.baseSha = result.currentHead;
      return;
    }

    if (result.newReflogEntries.some(e => e.type === 'rebase')) {
      // Rebase without a resolvable merge-base — the stale anchor would count
      // upstream commits as today's work. Re-anchor and start over.
      session.baseSha = result.currentHead;
      this.zeroLineEvidence(session);
      if (session.ledger === null) session.evidence.commits = 0;
      return;
    }

    if (result.evidenceSnapshot !== null) {
      // A ledger-backed commit count is never clobbered by the raw rev-list
      // count of a fallback tick (merge-base transiently unresolvable).
      if (session.ledger === null) session.evidence.commits = result.evidenceSnapshot.commits;
      session.evidence.linesAdded = result.evidenceSnapshot.linesAdded;
      session.evidence.linesRemoved = result.evidenceSnapshot.linesRemoved;
      session.evidence.filesChanged = result.evidenceSnapshot.filesChanged;
      return;
    }

    // baseSha invalidated — zero out and re-anchor at HEAD.
    this.zeroLineEvidence(session);
    if (session.ledger === null) session.evidence.commits = 0;
    session.baseSha = result.currentHead;
  }

  /**
   * Merge-base evidence: baseline-delta for lines/files, positive-jump
   * accumulator for commits.
   *
   * The baseline ratchets down when branch totals drop below it (own work
   * merged upstream, dropped commits) so evidence never goes negative and
   * subsequent work is counted from the new, lower base.
   */
  private applyMergeBaseEvidence(session: Session, snap: EvidenceSnapshot, result: PollResult): void {
    // Commit ledger first: a seed also delivers the day-start line baseline.
    const ledgerActive = this.applyLedger(session, result);

    let base = session.evidenceBaseline;
    if (base === null) {
      base = {
        linesAdded: snap.linesAdded,
        linesRemoved: snap.linesRemoved,
        filesChanged: snap.filesChanged,
      };
      session.evidenceBaseline = base;
    } else {
      base.linesAdded = Math.min(base.linesAdded, snap.linesAdded);
      base.linesRemoved = Math.min(base.linesRemoved, snap.linesRemoved);
      base.filesChanged = Math.min(base.filesChanged, snap.filesChanged);
    }
    session.evidence.linesAdded = snap.linesAdded - base.linesAdded;
    session.evidence.linesRemoved = snap.linesRemoved - base.linesRemoved;
    session.evidence.filesChanged = snap.filesChanged - base.filesChanged;

    if (!ledgerActive && session.lastBranchCommits !== null && snap.commits > session.lastBranchCommits) {
      session.evidence.commits += snap.commits - session.lastBranchCommits;
    }
    session.lastBranchCommits = snap.commits;

    session.mergeBaseSha = result.mergeBaseSha;
    // Sticky anchor kept for ticks where merge-base resolution fails.
    if (session.baseSha === null) {
      session.baseSha = result.currentHead;
    }
  }

  /**
   * Feed this tick's ledger update into the session's commit ledger and
   * derive evidence.commits from it. Returns true when the ledger owns the
   * commit counter this tick (the positive-jump fallback must then stay off).
   *
   * A seed on a session that already carries a ledger merges (known SHAs are
   * skipped) — happens when reflog continuity was lost. A transitions/resync
   * update can't initialize a ledger from nothing: without the seeded branch
   * state it would miss pre-existing commits, so the tick stays on fallback
   * and the next poll (query = null) seeds properly.
   */
  private applyLedger(session: Session, result: PollResult): boolean {
    const update = result.ledgerUpdate ?? null;
    if (update === null) {
      // Reflog unavailable this tick — a ledger-backed counter stays frozen
      // rather than being overwritten by the raw rev-list count.
      return session.ledger !== null;
    }
    if (session.ledger === null) {
      if (update.kind !== 'seed') return false;
      session.ledger = createEmptyLedger();
    } else if (update.kind === 'seed' && session.ledger.pointer !== null) {
      // Inherited ledger with reflog continuity, but the seed was computed
      // against another session's stale query (e.g. task switch). Adopting
      // its pointer would skip the unreplayed transitions — ignore the seed;
      // the next tick's query comes from this session and replays properly.
      session.evidence.commits = countSessionCommits(session.ledger);
      return true;
    }
    applyLedgerUpdate(session.ledger, update, this.isInDay);
    session.evidence.commits = countSessionCommits(session.ledger);

    if (update.kind === 'seed' && session.evidenceBaseline === null) {
      // Line baseline anchored at the last pre-day commit: lines committed
      // earlier today (before the daemon saw the repo) count, older don't.
      session.evidenceBaseline = { ...update.baseline };
    }
    return true;
  }

  private zeroLineEvidence(session: Session): void {
    session.evidence.linesAdded = 0;
    session.evidence.linesRemoved = 0;
    session.evidence.filesChanged = 0;
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
