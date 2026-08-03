import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, getDataDir, computeWorkingDate, writeConfig, ensureConfigFiles } from './core/config.js';
import { readDailyLog, writeDailyLog } from './core/daily-log.js';
import { runStartupJanitor } from './core/janitor.js';
import { writeStopMarker, clearStopMarker } from './core/stop-marker.js';
import { GitTracker } from './collectors/git-tracker.js';
import { CalendarCollector } from './collectors/calendar-collector.js';
import { SessionTracker } from './core/session-tracker.js';
import { ActivityEvaluator } from './core/activity-evaluator.js';
import { checkGap } from './core/gap-detector.js';
import { UpdateManager } from './core/update-manager.js';
import { NotificationCenter } from './core/notification-center.js';
import { HttpServer } from './http-server.js';
import type { HttpServerDeps } from './http-server.js';
import { StatusRenderer } from './core/status-renderer.js';
import type { ActivityScopeConfig, AppConfig, CalendarConfig, Secrets, SearchConfig, TrackingConfig, UpdateCheckResponse, UpdateApplyResponse } from './core/types.js';
import { ClosedBy } from './core/types.js';
import {
  PID_FILE_NAME,
  UPDATE_CHECK_INTERVAL_HOURS,
  UPDATE_CHECK_JITTER_MINUTES,
} from './core/constants.js';

export class Daemon {
  private config!: AppConfig;
  private secrets!: Secrets;
  private gitTracker!: GitTracker;
  private sessionTracker!: SessionTracker;
  private activityEvaluator!: ActivityEvaluator;
  private httpServer: HttpServer | null = null;
  private statusRenderer: StatusRenderer | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private dayBoundaryTimer: ReturnType<typeof setInterval> | null = null;
  private updateTimer: ReturnType<typeof setTimeout> | null = null;
  private updateManager: UpdateManager = new UpdateManager();
  private notificationCenter!: NotificationCenter;
  private calendarCollector!: CalendarCollector;
  // Version installed on disk and waiting for a quiet window to restart into.
  private pendingRestartVersion: string | null = null;
  private updateInFlight: boolean = false;
  private currentDate: string = '';
  private running: boolean = false;
  private foreground: boolean = false;
  private startedAt: number = 0;
  // Last moment the process was known to be alive (any timer fired).
  // Used to detect observation gaps: PC sleep / hibernate / suspend.
  private lastAliveAt: number = 0;
  // Serializes scheduled and forced ticks so parallel calls do not race
  // over git polling, in-memory state or flush writes.
  private tickQueue: Promise<void> = Promise.resolve();

  public async start(options?: { foreground?: boolean }): Promise<void> {
    this.foreground = options?.foreground ?? false;
    const bootstrap = ensureConfigFiles();
    if (bootstrap.createdConfig || bootstrap.createdSecrets) {
      console.log('Fresh install detected — created template config; finish setup in the tray app or via "workday setup".');
    }
    this.config = loadConfig();
    this.secrets = loadSecrets();

    await this.ensureSingleInstance();

    this.currentDate = computeWorkingDate(Date.now(), this.config.boundaryHour, this.config.timezone);
    this.gitTracker = new GitTracker(this.config);

    // Janitor: close orphaned sessions in past files (crash recovery),
    // prune never-activated noise, delete factless day files.
    const janitor = runStartupJanitor(this.currentDate);
    if (janitor.recoveredSessions > 0 || janitor.prunedSessions > 0 || janitor.deletedFiles.length > 0 || janitor.migratedAdjustments > 0) {
      console.log(`  Janitor: closed ${janitor.recoveredSessions} orphan(s), pruned ${janitor.prunedSessions} never-activated, deleted ${janitor.deletedFiles.length} empty file(s), migrated ${janitor.migratedAdjustments} adjustment(s)`);
    }

    // Load today's log and close any orphaned sessions
    const existingLog = readDailyLog(this.currentDate) ?? undefined;
    this.sessionTracker = new SessionTracker(this.config, existingLog);

    const crashedCount = this.sessionTracker.closeCrashedSessions();
    if (crashedCount > 0) {
      this.sessionTracker.flush();
      console.log(`  Crash recovery: closed ${crashedCount} orphaned session(s) from ${this.currentDate}`);
    }

    // Activity evaluator
    this.activityEvaluator = new ActivityEvaluator(this.config.session.diffPollSeconds);
    this.sessionTracker.onSessionClosed = (sessionId) => this.activityEvaluator.removeSession(sessionId);

    this.writePidFile();
    // A starting daemon voids any manual-stop intent — the tray watchdog
    // may resume guarding it.
    clearStopMarker();
    this.registerShutdownHandlers();

    // HTTP API server
    this.startedAt = Date.now();
    this.notificationCenter = new NotificationCenter({
      getConfig: () => this.config,
      // The month aggregate reads from disk — same flush contract as handleMonth.
      flushToday: () => this.sessionTracker.flush(),
    });
    this.calendarCollector = new CalendarCollector({
      getConfig: () => this.config,
      getIcsUrl: () => this.secrets.Calendar_IcsUrl?.trim() || null,
    });
    const deps: HttpServerDeps = {
      sessionTracker: this.sessionTracker,
      config: this.config,
      stopCallback: () => this.stopAndExit(),
      getStartedAt: () => this.startedAt,
      getCurrentDate: () => this.currentDate,
      forceTick: () => this.pollTick(),
      applyConfigUpdate: (patch) => this.applyConfigUpdate(patch),
      addRepo: (path) => this.addRepo(path),
      removeRepo: (path) => this.removeRepo(path),
      getVersion: () => this.updateManager.getCurrentVersion(),
      checkUpdate: () => this.updateManager.checkForUpdate(),
      applyUpdate: () => this.applyUpdateNow(),
      getWatchingRepos: () => this.gitTracker.getWatchingRepos(),
      notificationCenter: this.notificationCenter,
      calendarCollector: this.calendarCollector,
      onSecretsUpdated: () => { this.secrets = loadSecrets(); },
    };
    this.httpServer = new HttpServer(this.config.apiPort, deps);
    await this.httpServer.start();

    this.running = true;

    if (this.foreground) {
      this.statusRenderer = new StatusRenderer({
        sessionTracker: this.sessionTracker,
        config: this.config,
        currentDate: this.currentDate,
        startedAt: this.startedAt,
        timezone: this.config.timezone,
        pollSeconds: this.config.session.diffPollSeconds,
        repos: this.config.repos,
      });
    }

    // First poll immediately, then on interval
    this.lastAliveAt = Date.now();
    await this.pollTick();
    const pollMs = this.config.session.diffPollSeconds * 1000;
    this.pollTimer = setInterval(() => void this.pollTick(), pollMs);
    const boundaryMs = this.config.session.dayBoundaryCheckSeconds * 1000;
    this.dayBoundaryTimer = setInterval(() => this.checkDayBoundary(), boundaryMs);
    this.scheduleUpdateCheck(true);

    if (this.calendarCollector.isConfigured()) {
      void this.calendarCollector.refresh()
        .then(r => console.log(`[calendar] feed fetched: ${r.instanceCount} instance(s)`))
        .catch(err => console.warn(`[calendar] initial fetch failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    if (!this.foreground) {
      console.log(`Daemon started (PID ${process.pid}) — http://127.0.0.1:${this.config.apiPort}`);
      console.log(`  Repos: ${this.config.repos.map(r => r.split('/').pop()).join(', ')}`);
      console.log(`  Poll: ${this.config.session.diffPollSeconds}s · Day boundary: ${String(this.config.boundaryHour).padStart(2, '0')}:00 (${this.config.timezone})`);
      console.log(`  Date: ${this.currentDate}`);
    }
  }

  // ─── Hot-apply config changes ─────────────────────────────────────────

  /**
   * Apply a config patch to the running daemon without restart.
   * Serializes with the poll loop via tickQueue — config.repos cannot be
   * mutated while gitTracker.pollAll() iterates over it.
   */
  public applyConfigUpdate(patch: Partial<AppConfig>): Promise<void> {
    this.tickQueue = this.tickQueue.then(() => this.applyConfigUpdateBody(patch));
    return this.tickQueue;
  }

  private applyConfigUpdateBody(patch: Partial<AppConfig>): void {
    // repos
    if (patch.repos && !arraysEqual(patch.repos, this.config.repos)) {
      const added = patch.repos.filter(r => !this.config.repos.includes(r));
      const removed = this.config.repos.filter(r => !patch.repos!.includes(r));
      for (const repoPath of removed) {
        const repoName = basename(repoPath);
        this.sessionTracker.closeSessionsForRepo(repoName);
        this.gitTracker.removeRepo(repoPath);
      }
      for (const repoPath of added) this.gitTracker.addRepo(repoPath);
      (this.config as { repos: readonly string[] }).repos = [...patch.repos];
    }

    // tracking — deep-merge so a project reselect keeps the owner list and
    // an owner edit keeps the project selection.
    if (patch.tracking) {
      const cur = this.config.tracking;
      const next: TrackingConfig = {
        projectKeys: patch.tracking.projectKeys ?? cur.projectKeys,
        branchOwners: patch.tracking.branchOwners ?? cur.branchOwners,
      };
      (this.config as { tracking: TrackingConfig }).tracking = next;
      this.gitTracker.setTracking(next);
    }

    // boundaryHour
    if (patch.boundaryHour !== undefined && patch.boundaryHour !== this.config.boundaryHour) {
      (this.config as { boundaryHour: number }).boundaryHour = patch.boundaryHour;
      // Re-check day boundary in case the new hour crosses now.
      const newDate = computeWorkingDate(Date.now(), this.config.boundaryHour, this.config.timezone);
      if (newDate !== this.currentDate) this.checkDayBoundary();
    }

    // timezone
    if (patch.timezone !== undefined && patch.timezone !== this.config.timezone) {
      (this.config as { timezone: string }).timezone = patch.timezone;
      const newDate = computeWorkingDate(Date.now(), this.config.boundaryHour, this.config.timezone);
      if (newDate !== this.currentDate) this.checkDayBoundary();
    }

    // sensitivity.default — delegate so manual pauses get auto-resumed
    if (patch.sensitivity?.default && patch.sensitivity.default !== this.config.sensitivity.default) {
      this.sessionTracker.setSensitivity(patch.sensitivity.default);
    }

    // search — deep-merge so a selection change keeps the cached catalog and
    // a catalog refresh keeps the selection.
    if (patch.search) {
      const cur = this.config.search;
      (this.config as { search: SearchConfig }).search = {
        projectKeys: patch.search.projectKeys ?? cur.projectKeys,
        knownProjects: patch.search.knownProjects ?? cur.knownProjects,
      };
    }

    // activities — allow-list only; the catalog lives in the work-attributes cache.
    if (patch.activities?.values) {
      (this.config as { activities: ActivityScopeConfig }).activities = {
        values: [...patch.activities.values],
      };
    }

    // calendar — the collector reads config lazily, so swapping suffices.
    if (patch.calendar) {
      const cur = this.config.calendar;
      (this.config as { calendar: CalendarConfig }).calendar = {
        enabled: patch.calendar.enabled ?? cur.enabled,
        hidePrivate: patch.calendar.hidePrivate ?? cur.hidePrivate,
      };
    }

    // browser — /api/open reads it live; null clears to the system default.
    if (patch.browser !== undefined) {
      (this.config as { browser?: string | null }).browser = patch.browser;
    }
  }

  public async addRepo(repoPath: string): Promise<{ ok: boolean; error?: string }> {
    if (this.config.repos.includes(repoPath)) return { ok: false, error: 'Already added' };
    await this.applyConfigUpdate({ repos: [...this.config.repos, repoPath] });
    writeConfig(this.config);
    return { ok: true };
  }

  public async removeRepo(repoPath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.config.repos.includes(repoPath)) return { ok: false, error: 'Not in list' };
    if (this.config.repos.length === 1) return { ok: false, error: 'Cannot remove last repo' };
    await this.applyConfigUpdate({ repos: this.config.repos.filter(r => r !== repoPath) });
    writeConfig(this.config);
    return { ok: true };
  }

  /**
   * Graceful stop. `manual` marks a user-initiated stop (CLI `workday stop`,
   * tray Stop, Ctrl+C) — it writes the stop marker so the tray watchdog does
   * not respawn the daemon. Self-update restarts pass false: the daemon is
   * coming right back and must stay under the watchdog's guard.
   */
  public async stop(manual: boolean = true): Promise<void> {
    if (!this.running) return;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.dayBoundaryTimer) clearInterval(this.dayBoundaryTimer);
    if (this.updateTimer) clearTimeout(this.updateTimer);

    // Final poll to capture last-moment activity before shutdown
    await this.pollTick();

    this.running = false;
    if (this.httpServer) await this.httpServer.stop();
    this.sessionTracker.closeAllSessions(ClosedBy.DaemonStop);
    this.sessionTracker.flush();
    this.activityEvaluator.clear();
    this.removePidFile();
    if (manual) writeStopMarker();

    console.log('Daemon stopped.');
  }

  private async stopAndExit(): Promise<void> {
    await this.stop();
    process.exit(0);
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────

  /**
   * Run one tick. Serializes with any currently-running tick via tickQueue
   * so scheduled ticks and HTTP-triggered force ticks never overlap.
   */
  public pollTick(): Promise<void> {
    this.tickQueue = this.tickQueue.then(() => this.runTickBody());
    return this.tickQueue;
  }

  private async runTickBody(): Promise<void> {
    if (!this.running) return;

    try {
      // 0a. Observation gap (PC sleep) — retro-pause everything at pre-gap
      //     lastSeenAt before any new activity is processed.
      this.handleObservationGap(Date.now());

      // 0b. Idle auto-close (honest end) — before processing new activity, so
      //     a long-idle session closes at its trimmed end and fresh activity
      //     births a new session instead of resuming a stale pause.
      this.sessionTracker.closeIdleSessions(Date.now());

      const baseShas = this.sessionTracker.getBaseShasPerRepoPath(this.config.repos);
      const ledgerQueries = this.sessionTracker.getLedgerQueries(this.config.repos);
      const results = await this.gitTracker.pollAll(baseShas, ledgerQueries);

      // 1. Session lifecycle + evidence
      for (const result of results) {
        this.sessionTracker.processPollResult(result);
      }

      // 2. Build tick inputs for evaluator
      const tickInputs = this.sessionTracker.buildTickInputs(results);

      // 3. Evaluate activity scores and leadership
      const evaluatorResult = this.activityEvaluator.processAllTicks(tickInputs);

      // 4. Apply evaluator decisions (auto-pause/resume, candidate
      //    promotion / drained-candidate evaporation)
      this.sessionTracker.applyEvaluatorResult(evaluatorResult);

      this.sessionTracker.flush();

      if (this.statusRenderer) {
        this.statusRenderer.render();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.statusRenderer) {
        this.statusRenderer.renderError(message);
      } else {
        console.error(`[poll] ${message}`);
      }
    }
  }

  // ─── Observation gap (sleep / hibernate) ──────────────────────────────

  /**
   * Timers don't fire while the machine sleeps: the evaluator never decays
   * and lastSeenAt never advances, so the first tick after wake-up would
   * credit the whole gap as work. On a gap: every open unpaused session
   * gets a retroactive idle pause at its pre-gap lastSeenAt; candidates and
   * evaluator state are stale and dropped (real activity re-earns both);
   * idle auto-close then immediately closes sessions whose gap already
   * exceeds idleCloseHours — honest end at the last pre-sleep activity.
   * A short gap stays a mid-session pause, auto-resumed by activity.
   * Runs from both the poll tick and the day-boundary timer — whichever
   * fires first after wake-up, and before rollover closes sessions.
   */
  private handleObservationGap(now: number): void {
    const check = checkGap(now, this.lastAliveAt, this.config.session.diffPollSeconds);
    this.lastAliveAt = now;
    if (check.kind === 'none') return;

    if (check.kind === 'clock_jump_back') {
      console.warn(`[gap] clock jumped back ${Math.round(-check.gapMs / 1000)}s — re-anchored, no action`);
      return;
    }

    const paused = this.sessionTracker.applyGapPauses();
    this.sessionTracker.dropAllCandidates();
    this.activityEvaluator.clear();
    this.sessionTracker.closeIdleSessions(now);
    this.sessionTracker.flush();

    if (!this.statusRenderer) {
      console.log(`[gap] ${Math.round(check.gapMs / 60_000)}min observation gap — ${paused} session(s) retro-paused`);
    }
  }

  // ─── Self-update ───────────────────────────────────────────────────────
  //
  // Order is sacred: install new version → verify on disk → only then
  // restart. The daemon never stops itself before the replacement is
  // confirmed; a failed npm install leaves the old version running.

  private restarting: boolean = false;

  /** First check ~1h after start, then every UPDATE_CHECK_INTERVAL_HOURS. */
  private scheduleUpdateCheck(initial: boolean): void {
    const jitterMs = Math.random() * UPDATE_CHECK_JITTER_MINUTES * 60_000;
    const baseMs = (initial ? 1 : UPDATE_CHECK_INTERVAL_HOURS) * 3_600_000;
    this.updateTimer = setTimeout(() => void this.runScheduledUpdateCheck(), baseMs + jitterMs);
  }

  private async runScheduledUpdateCheck(): Promise<void> {
    try {
      if (this.pendingRestartVersion === null && !this.updateInFlight) {
        this.updateInFlight = true;
        try {
          const check = await this.updateManager.checkForUpdate();
          if (check.updateAvailable) {
            console.log(`[update] ${check.current} → ${check.latest}: installing...`);
            await this.updateManager.installVersion(check.latest);
            this.pendingRestartVersion = check.latest;
            console.log(`[update] v${check.latest} installed — restart at the next quiet window`);
          }
        } finally {
          this.updateInFlight = false;
        }
      }
      this.maybeRestartIntoUpdate();
    } catch (err) {
      console.warn(`[update] check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (this.running && !this.restarting) this.scheduleUpdateCheck(false);
    }
  }

  /**
   * Quiet-window gate: a pending update restarts the daemon only when no
   * open session is actively worked on (all paused or none open). Re-tested
   * on every day-boundary timer tick, so the restart lands within ~1 min of
   * the workspace going quiet — and the nightly boundary is a guaranteed slot.
   */
  private maybeRestartIntoUpdate(): void {
    if (this.pendingRestartVersion === null || this.restarting) return;
    if (this.sessionTracker.hasActiveWork()) return;
    void this.selfRestart(this.pendingRestartVersion);
  }

  /**
   * Immediate update path for POST /api/update/apply (tray button).
   * Skips the quiet window — the user asked for it explicitly.
   */
  public async applyUpdateNow(): Promise<UpdateApplyResponse> {
    if (this.restarting) {
      return { updating: true, target: this.pendingRestartVersion ?? '', message: 'Restart already in progress' };
    }
    if (this.pendingRestartVersion !== null) {
      const v = this.pendingRestartVersion;
      setTimeout(() => void this.selfRestart(v), 500);
      return { updating: true, target: v, message: `v${v} already installed — daemon restarting` };
    }
    if (this.updateInFlight) {
      return { updating: true, target: '', message: 'Update check already in progress' };
    }

    this.updateInFlight = true;
    try {
      const check = await this.updateManager.checkForUpdate();
      if (!check.updateAvailable) {
        return { updating: false, target: check.current, message: `Already up to date (v${check.current})` };
      }
      await this.updateManager.installVersion(check.latest);
      this.pendingRestartVersion = check.latest;
      // Respond first; restart a beat later so the HTTP response flushes.
      setTimeout(() => void this.selfRestart(check.latest), 500);
      return { updating: true, target: check.latest, message: `Installed v${check.latest} — daemon restarting` };
    } finally {
      this.updateInFlight = false;
    }
  }

  /**
   * Graceful swap: full stop (final poll, flush, port released, PID file
   * removed), then respawn this same script path — npm has already replaced
   * its content with the new version — and exit.
   */
  private async selfRestart(targetVersion: string): Promise<void> {
    if (this.restarting) return;
    this.restarting = true;
    console.log(`[update] restarting into v${targetVersion}...`);

    await this.stop(false);

    const script = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [...process.execArgv, script], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    process.exit(0);
  }

  // ─── Day boundary ─────────────────────────────────────────────────────

  private checkDayBoundary(): void {
    // Gap check first: after a sleep across the boundary the sessions must
    // be retro-paused/closed at their honest ends BEFORE rollover closes
    // them at the wake-up moment.
    this.handleObservationGap(Date.now());

    // Piggyback on the 60s boundary timer: pending updates wait here for a
    // quiet window instead of having their own restart poller; the calendar
    // feed re-fetches on its own cadence the same way.
    this.maybeRestartIntoUpdate();
    this.calendarCollector.maybeScheduledRefresh();

    const newDate = computeWorkingDate(Date.now(), this.config.boundaryHour, this.config.timezone);
    if (newDate === this.currentDate) return;

    // Lazy rollover: an empty day writes nothing and says nothing.
    const { oldLog, materialized } = this.sessionTracker.handleDayBoundary();
    if (materialized) writeDailyLog(oldLog);
    this.activityEvaluator.clear();

    this.currentDate = newDate;

    if (this.statusRenderer) {
      this.statusRenderer.updateDate(newDate);
      this.statusRenderer.render();
    } else if (materialized) {
      console.log(`[day] ${oldLog.date} closed (${oldLog.sessions.length} sessions) → ${newDate}`);
    }
  }

  // ─── PID file ──────────────────────────────────────────────────────────

  private getPidFilePath(): string {
    return join(getDataDir(), PID_FILE_NAME);
  }

  private async ensureSingleInstance(): Promise<void> {
    const pidPath = this.getPidFilePath();
    if (!existsSync(pidPath)) return;

    const oldPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!Daemon.isProcessRunning(oldPid)) {
      // Stale PID file — old process is gone
      unlinkSync(pidPath);
      return;
    }

    // Process is alive — verify it actually serves HTTP. A daemon that hung
    // before listen() (or crashed in a way that left the port closed) leaves
    // the PID file behind and traps subsequent starts in a loop.
    if (await this.isDaemonResponsive()) {
      console.error(`Daemon already running (PID ${oldPid})`);
      process.exit(1);
    }

    console.warn(`Found unresponsive daemon (PID ${oldPid}) — terminating it`);
    try { process.kill(oldPid); } catch { /* already dead */ }
    try { unlinkSync(pidPath); } catch { /* best effort */ }
  }

  private async isDaemonResponsive(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.config.apiPort}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private static isProcessRunning(pid: number): boolean {
    try {
      // Signal 0 tests process existence without killing (POSIX idiom)
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private writePidFile(): void {
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(this.getPidFilePath(), String(process.pid), 'utf-8');
  }

  private removePidFile(): void {
    try {
      const pidPath = this.getPidFilePath();
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch {
      // ignore cleanup errors
    }
  }

  // ─── Shutdown ──────────────────────────────────────────────────────────

  private registerShutdownHandlers(): void {
    const shutdown = async (): Promise<void> => {
      console.log('\nShutting down...');
      await this.stop();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    // Last-resort synchronous cleanup (OS shutdown, uncaught exit)
    // closeAllSessions + flush are synchronous (writeFileSync)
    process.on('exit', () => {
      if (!this.running) return;
      this.sessionTracker.closeAllSessions(ClosedBy.DaemonStop);
      this.sessionTracker.flush();
      this.removePidFile();
    });
  }
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Entry point (direct execution / background mode) ────────────────────

const isMain = process.argv[1] &&
  resolve(process.argv[1]).replace(/\\/g, '/') ===
  fileURLToPath(import.meta.url).replace(/\\/g, '/');

if (isMain) {
  const daemon = new Daemon();
  await daemon.start();
}
