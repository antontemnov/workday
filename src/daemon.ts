import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, getDataDir, computeWorkingDate } from './core/config.js';
import { readDailyLog, writeDailyLog } from './core/daily-log.js';
import { GitTracker } from './collectors/git-tracker.js';
import { SessionTracker } from './core/session-tracker.js';
import type { AppConfig, Secrets } from './core/types.js';
import { CLOSED_BY } from './core/types.js';

export class Daemon {
  private config!: AppConfig;
  private secrets!: Secrets;
  private gitTracker!: GitTracker;
  private sessionTracker!: SessionTracker;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private dayBoundaryTimer: ReturnType<typeof setInterval> | null = null;
  private currentDate: string = '';
  private running: boolean = false;

  public async start(): Promise<void> {
    this.config = loadConfig();
    this.secrets = loadSecrets();

    this.ensureSingleInstance();

    this.currentDate = computeWorkingDate(Date.now(), this.config.dayBoundaryHour);
    this.gitTracker = new GitTracker(this.config, this.secrets);

    // Crash recovery: resume from today's log if it exists
    const existingLog = readDailyLog(this.currentDate) ?? undefined;
    this.sessionTracker = new SessionTracker(this.config, existingLog);

    this.writePidFile();
    this.registerShutdownHandlers();

    this.running = true;
    const pollMs = this.config.session.diffPollSeconds * 1000;
    this.pollTimer = setInterval(() => void this.pollTick(), pollMs);
    this.dayBoundaryTimer = setInterval(() => this.checkDayBoundary(), 60_000);

    console.log(`Daemon started (PID ${process.pid})`);
    console.log(`  Repos: ${this.config.repos.map(r => r.split('/').pop()).join(', ')}`);
    console.log(`  Poll: ${this.config.session.diffPollSeconds}s`);
    console.log(`  Date: ${this.currentDate}`);

    if (existingLog) {
      const openCount = existingLog.sessions.filter(s => !s.closedBy).length;
      if (openCount > 0) {
        console.log(`  Resumed ${openCount} open session(s)`);
      }
    }
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.dayBoundaryTimer) clearInterval(this.dayBoundaryTimer);

    this.sessionTracker.closeAllSessions(CLOSED_BY.DAEMON_STOP);
    this.sessionTracker.flush();
    this.removePidFile();

    console.log('Daemon stopped.');
  }

  // ─── Poll loop ─────────────────────────────────────────────────────────

  private async pollTick(): Promise<void> {
    if (!this.running) return;

    try {
      const results = await this.gitTracker.pollAll();
      for (const result of results) {
        this.sessionTracker.processPollResult(result);
      }
      this.sessionTracker.flush();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[poll] ${message}`);
    }
  }

  // ─── Day boundary ─────────────────────────────────────────────────────

  private checkDayBoundary(): void {
    const newDate = computeWorkingDate(Date.now(), this.config.dayBoundaryHour);
    if (newDate === this.currentDate) return;

    const oldLog = this.sessionTracker.handleDayBoundary();
    writeDailyLog(oldLog);

    const sessionCount = oldLog.sessions.length;
    console.log(`[day] ${oldLog.date} closed (${sessionCount} sessions) → ${newDate}`);
    this.currentDate = newDate;
  }

  // ─── PID file ──────────────────────────────────────────────────────────

  private getPidFilePath(): string {
    return join(getDataDir(), 'workday.pid');
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
