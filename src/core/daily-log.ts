import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir, computeWorkingDate } from './config.js';
import { DayStatus, DayType, SignalType, type DailyLog, type Session, type Signal, type Evidence, type AppConfig, type Pause } from './types.js';
import { TMP_EXTENSION, BACKUP_EXTENSION } from './constants.js';

/** Generate short unique session id */
export function generateSessionId(): string {
  return randomBytes(4).toString('hex');
}

/** Get data file path for a given date: data/YYYY-MM/MM-DD.json */
export function getDailyLogPath(date: string): string {
  const [year, month, day] = date.split('-');
  const monthDir = `${year}-${month}`;
  const fileName = `${month}-${day}.json`;
  return join(getDataDir(), monthDir, fileName);
}

/** Ensure the data directory for a given date exists */
function ensureDataDir(date: string): void {
  const filePath = getDailyLogPath(date);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Determine day type based on config */
function determineDayType(date: string, config: AppConfig): DailyLog['dayType'] {
  if (config.holidays.includes(date)) {
    return DayType.Holiday;
  }
  const dt = new Date(date + 'T12:00:00');
  const dayOfWeek = dt.getDay();
  // JS: 0=Sun, 1=Mon..6=Sat. Config uses ISO: 1=Mon..7=Sun
  const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek;
  if (!config.workDays.includes(isoDay)) {
    return DayType.Weekend;
  }
  return DayType.Workday;
}

/** Create empty daily log for a given date */
export function createEmptyLog(date: string, config: AppConfig): DailyLog {
  return {
    date,
    status: DayStatus.Draft,
    dayType: determineDayType(date, config),
    manualStart: null,
    sessions: [],
    signals: [],
    confirmedAt: null,
    pushedAt: null,
    note: '',
  };
}

/** Create empty evidence object */
export function createEmptyEvidence(): Evidence {
  return {
    commits: 0,
    dynamicsHeartbeats: 0,
    totalSnapshots: 0,
    reflogEvents: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: 0,
  };
}

/** Try parsing JSON from a file path. Returns parsed object or null. */
function tryParseLogFile(filePath: string): DailyLog | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as DailyLog;
  } catch {
    return null;
  }
}

/** Read daily log from disk. Falls back to .bak if main file is corrupted. */
export function readDailyLog(date: string): DailyLog | null {
  const filePath = getDailyLogPath(date);
  const log = tryParseLogFile(filePath);
  if (log) return log;

  // Main file missing or corrupted — try backup
  const bakPath = filePath + BACKUP_EXTENSION;
  const backup = tryParseLogFile(bakPath);
  if (backup) {
    console.warn(`[daily-log] Restored ${date} from backup (main file corrupted or missing)`);
    // Promote backup to main file
    writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');
    return backup;
  }

  if (existsSync(filePath)) {
    console.error(`[daily-log] Corrupted JSON in ${filePath}, no backup available`);
  }
  return null;
}

/** Write daily log to disk using atomic write pattern with backup */
export function writeDailyLog(log: DailyLog): void {
  ensureDataDir(log.date);
  const filePath = getDailyLogPath(log.date);
  const tmpPath = filePath + TMP_EXTENSION;
  const bakPath = filePath + BACKUP_EXTENSION;

  // Backup current valid file before overwriting (copy, not rename — safe if crash mid-write)
  if (tryParseLogFile(filePath)) {
    try { copyFileSync(filePath, bakPath); } catch { /* best effort */ }
  }

  writeFileSync(tmpPath, JSON.stringify(log, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

/** Get or create today's daily log */
export function getOrCreateTodayLog(config: AppConfig): DailyLog {
  const today = computeWorkingDate(Date.now(), config.dayBoundaryHour, config.timezone);
  const existing = readDailyLog(today);
  if (existing) {
    return existing;
  }
  const newLog = createEmptyLog(today, config);
  writeDailyLog(newLog);
  return newLog;
}

/** Find session by id */
export function findSession(log: DailyLog, sessionId: string): Session | undefined {
  return log.sessions.find(s => s.id === sessionId);
}

// ─── Duration helpers ───────────────────────────────────────────────────

/** Total pause duration for a session in milliseconds */
export function computeTotalPauseDuration(session: Session): number {
  let total = 0;
  for (const pause of session.pauses ?? []) {
    const from = new Date(pause.from).getTime();
    const to = pause.to ? new Date(pause.to).getTime() : Date.now();
    total += to - from;
  }
  return total;
}

/** Effective working duration: (end - activatedAt) - pauses, in milliseconds. Returns 0 for PENDING sessions. */
export function computeEffectiveDuration(session: Session): number {
  if (!session.activatedAt) return 0;
  const start = new Date(session.activatedAt).getTime();
  const end = session.closedBy ? new Date(session.lastSeenAt).getTime() : Date.now();
  const gross = end - start;
  return Math.max(0, gross - computeTotalPauseDuration(session));
}

/**
 * Compute actual work/downtime using interval merge across all sessions.
 * Downtime = periods when NO session was actively working (all paused or no sessions).
 */
export function computeDaySummary(sessions: readonly Session[]): {
  readonly workMs: number;
  readonly downtimeMs: number;
  readonly spanMs: number;
} {
  const workIntervals: Array<{ from: number; to: number }> = [];

  for (const session of sessions) {
    if (!session.activatedAt) continue;

    const sessionStart = new Date(session.activatedAt).getTime();
    const sessionEnd = session.closedBy
      ? new Date(session.lastSeenAt).getTime()
      : Date.now();

    // Build working intervals by subtracting pauses from active range
    const sortedPauses = [...session.pauses]
      .map(p => ({
        from: Math.max(new Date(p.from).getTime(), sessionStart),
        to: Math.min(p.to ? new Date(p.to).getTime() : Date.now(), sessionEnd),
      }))
      .filter(p => p.from < p.to)
      .sort((a, b) => a.from - b.from);

    let cursor = sessionStart;
    for (const pause of sortedPauses) {
      if (pause.from > cursor) {
        workIntervals.push({ from: cursor, to: pause.from });
      }
      cursor = Math.max(cursor, pause.to);
    }
    if (cursor < sessionEnd) {
      workIntervals.push({ from: cursor, to: sessionEnd });
    }
  }

  if (workIntervals.length === 0) {
    return { workMs: 0, downtimeMs: 0, spanMs: 0 };
  }

  // Merge overlapping work intervals (union)
  workIntervals.sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [{ ...workIntervals[0] }];

  for (let i = 1; i < workIntervals.length; i++) {
    const last = merged[merged.length - 1];
    const curr = workIntervals[i];
    if (curr.from <= last.to) {
      last.to = Math.max(last.to, curr.to);
    } else {
      merged.push({ ...curr });
    }
  }

  const spanMs = merged[merged.length - 1].to - merged[0].from;
  const workMs = merged.reduce((sum, iv) => sum + (iv.to - iv.from), 0);

  return { workMs, downtimeMs: spanMs - workMs, spanMs };
}

// ─── Signals ────────────────────────────────────────────────────────────

/** Add signal with deduplication for diff_dynamics (same repo, accumulate deltas) */
export function addSignal(log: DailyLog, signal: Signal, deduplicationSeconds: number): void {
  if (signal.type === SignalType.DiffDynamics && log.signals.length > 0) {
    // Search backward for last diff_dynamics from the same repo
    for (let i = log.signals.length - 1; i >= 0; i--) {
      const prev = log.signals[i];
      if (prev.type !== SignalType.DiffDynamics) continue;
      if (prev.repo !== signal.repo) continue;

      // Found same-repo signal — check dedup window
      if (signal.ts - prev.ts < deduplicationSeconds * 1000) {
        // Accumulate deltas and update timestamp
        log.signals[i] = {
          ts: signal.ts,
          type: SignalType.DiffDynamics,
          repo: signal.repo,
          delta: {
            added: prev.delta.added + signal.delta.added,
            removed: prev.delta.removed + signal.delta.removed,
            untracked: (prev.delta.untracked ?? 0) + (signal.delta.untracked ?? 0),
          },
        };
        return;
      }
      break; // outside window — append new
    }
  }
  log.signals.push(signal);
}
