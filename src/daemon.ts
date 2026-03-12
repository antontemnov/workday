import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, getDataDir, computeWorkingDate } from './core/config.js';
import { readDailyLog, writeDailyLog } from './core/daily-log.js';
import { GitTracker } from './collectors/git-tracker.js';
import { SessionTracker } from './core/session-tracker.js';
import { ActivityEvaluator } from './core/activity-evaluator.js';
import { HttpServer } from './http-server.js';
import type { HttpServerDeps } from './http-server.js';
import { StatusRenderer } from './core/status-renderer.js';
import type { AppConfig, Secrets } from './core/types.js';
import { ClosedBy } from './core/types.js';
import { PID_FILE_NAME } from './core/constants.js';

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
  private currentDate: string = '';
  private running: boolean = false;
  private foreground: boolean = false;
  private startedAt: number = 0;
  private budgetExhaustedLogged: boolean = false;

  public async start(options?: { foreground?: boolean }): Promise<void> {
    this.foreground = options?.foreground ?? false;
    this.config = loadConfig();
    this.secrets = loadSecrets();

    this.ensureSingleInstance();

    this.currentDate = computeWorkingDate(Date.now(), this.config.dayBoundaryHour, this.config.timezone);
    this.gitTracker = new GitTracker(this.config, this.secrets);

    // Crash recovery: close orphaned sessions from previous days
    this.recoverOrphanedLogs();

    // Load today's log and close any orphaned sessions
    const existingLog = readDailyLog(this.currentDate) ?? undefined;
    this.sessionTracker = new SessionTracker(this.config, existingLog);

    // Set dayStartedAt if not already set (first daemon start of the day)
    this.sessionTracker.setDayStartedAt(new Date().toISOString());

    const crashedCount = this.sessionTracker.closeCrashedSessions();
    if (crashedCount > 0) {
      this.sessionTracker.flush();
      console.log(`  Crash recovery: closed ${crashedCount} orphaned session(s) from ${this.currentDate}`);
    }

    // Activity evaluator
    this.activityEvaluator = new ActivityEvaluator(this.config.session.diffPollSeconds);
    this.sessionTracker.onSessionClosed = (sessionId) => this.activityEvaluator.removeSession(sessionId);

    this.writePidFile();
    this.registerShutdownHandlers();

    // HTTP API server
    this.startedAt = Date.now();
    const deps: HttpServerDeps = {
      sessionTracker: this.sessionTracker,
      config: this.config,
      stopCallback: () => this.stopAndExit(),
      getStartedAt: () => this.startedAt,
      getCurrentDate: () => this.currentDate,
      onBudgetFreed: () => { this.budgetExhaustedLogged = false; },
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
    await this.pollTick();
    const pollMs = this.config.session.diffPollSeconds * 1000;
    this.pollTimer = setInterval(() => void this.pollTick(), pollMs);
    const boundaryMs = this.config.session.dayBoundaryCheckSeconds * 1000;
    this.dayBoundaryTimer = setInterval(() => this.checkDayBoundary(), boundaryMs);

    if (!this.foreground) {
      console.log(`Daemon started (PID ${process.pid})`);
      console.log(`  API: http://127.0.0.1:${this.config.apiPort}`);
      console.log(`  Timezone: ${this.config.timezone}`);
      console.log(`  Repos: ${this.config.repos.map(r => r.split('/').pop()).join(', ')}`);
      console.log(`  Poll: ${this.config.session.diffPollSeconds}s`);
      console.log(`  Day boundary: ${this.config.dayBoundaryHour}:00`);
      console.log(`  Date: ${this.currentDate}`);
    }
  }

  public async stop(): Promise<void> {
    if (!this.running) return;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.dayBoundaryTimer) clearInterval(this.dayBoundaryTimer);

    // Final poll to capture last-moment activity before shutdown
    await this.pollTick();

    this.running = false;
    if (this.httpServer) await this.httpServer.stop();
    this.sessionTracker.closeAllSessions(ClosedBy.DaemonStop);
    this.sessionTracker.flush();
    this.activityEvaluator.clear();
    this.removePidFile();

    console.log('Daemon stopped.');
  }

  private async stopAndExit(): Promise<void> {
    await this.stop();
    process.exit(0);
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────

  private async pollTick(): Promise<void> {
    if (!this.running) return;

    try {
      const results = await this.gitTracker.pollAll();

      // 1. Session lifecycle + evidence
      for (const result of results) {
        this.sessionTracker.processPollResult(result);
      }

      // 2. Build tick inputs for evaluator
      const tickInputs = this.sessionTracker.buildTickInputs(results);

      // 3. Evaluate activity scores and leadership
      const evaluatorResult = this.activityEvaluator.processAllTicks(tickInputs);

      // 4. Apply evaluator decisions (auto-pause/resume, promotion)
      this.sessionTracker.applyEvaluatorResult(evaluatorResult);

      // 5. Budget check — close all sessions if budget exhausted
      if (this.sessionTracker.isBudgetExhausted()) {
        this.sessionTracker.closeBudgetExhausted();
        if (!this.budgetExhaustedLogged) {
          this.budgetExhaustedLogged = true;
          console.warn('[budget] Day budget exhausted — all sessions closed. Use set-start to extend.');
        }
      }

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

  // ─── Crash recovery ────────────────────────────────────────────────────

  /** Scan recent daily logs for orphaned sessions (cross-day crash) */
  private recoverOrphanedLogs(): void {
    const lookbackDays = 7;

    for (let i = 1; i <= lookbackDays; i++) {
      const d = new Date(this.currentDate + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - i);
      const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

      const log = readDailyLog(dateStr);
      if (!log) continue;

      const openSessions = log.sessions.filter(s => !s.closedBy);
      if (openSessions.length === 0) continue;

      for (const session of openSessions) {
        const openPause = session.pauses?.find(p => p.to === null);
        if (openPause) openPause.to = session.lastSeenAt;
        session.closedBy = ClosedBy.DaemonCrash;
      }

      writeDailyLog(log);
      console.log(`  Crash recovery: closed ${openSessions.length} orphaned session(s) from ${dateStr}`);
    }
  }

  // ─── Day boundary ─────────────────────────────────────────────────────

  private checkDayBoundary(): void {
    const newDate = computeWorkingDate(Date.now(), this.config.dayBoundaryHour, this.config.timezone);
    if (newDate === this.currentDate) return;

    const oldLog = this.sessionTracker.handleDayBoundary();
    writeDailyLog(oldLog);
    this.activityEvaluator.clear();

    const sessionCount = oldLog.sessions.length;
    this.currentDate = newDate;

    if (this.statusRenderer) {
      this.statusRenderer.updateDate(newDate);
      this.statusRenderer.render();
    } else {
      console.log(`[day] ${oldLog.date} closed (${sessionCount} sessions) → ${newDate}`);
    }
  }

  // ─── PID file ──────────────────────────────────────────────────────────

  private getPidFilePath(): string {
    return join(getDataDir(), PID_FILE_NAME);
  }

  private ensureSingleInstance(): void {
    const pidPath = this.getPidFilePath();
    if (!existsSync(pidPath)) return;

    const oldPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
    if (Daemon.isProcessRunning(oldPid)) {
      console.error(`Daemon already running (PID ${oldPid})`);
      process.exit(1);
    }

    // Stale PID file
    unlinkSync(pidPath);
  }

  private static isProcessRunning(pid: number): boolean {
    try {
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

// ─── Entry point (direct execution / background mode) ────────────────────

const isMain = process.argv[1] &&
  resolve(process.argv[1]).replace(/\\/g, '/') ===
  fileURLToPath(import.meta.url).replace(/\\/g, '/');

if (isMain) {
  const daemon = new Daemon();
  await daemon.start();
}
