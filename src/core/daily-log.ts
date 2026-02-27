import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir, computeWorkingDate } from './config.js';
import { DayStatus, DayType, SignalType, type DailyLog, type Session, type Signal, type Evidence, type AppConfig, type Pause } from './types.js';
import { TMP_EXTENSION } from './constants.js';

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
  };
}

/** Read daily log from disk. Returns null if file doesn't exist. */
export function readDailyLog(date: string): DailyLog | null {
  const filePath = getDailyLogPath(date);
  if (!existsSync(filePath)) {
    return null;
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as DailyLog;
}

/** Write daily log to disk using atomic write pattern */
export function writeDailyLog(log: DailyLog): void {
  ensureDataDir(log.date);
  const filePath = getDailyLogPath(log.date);
  const tmpPath = filePath + TMP_EXTENSION;
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

/** Effective working duration: (lastSeenAt - startedAt) - pauses, in milliseconds */
export function computeEffectiveDuration(session: Session): number {
  const start = new Date(session.startedAt).getTime();
  const end = new Date(session.lastSeenAt).getTime();
  const gross = end - start;
  return Math.max(0, gross - computeTotalPauseDuration(session));
}

// ─── Signals ────────────────────────────────────────────────────────────

/** Add signal with basic deduplication for consecutive diff_dynamics */
export function addSignal(log: DailyLog, signal: Signal, deduplicationSeconds: number): void {
  // Deduplicate consecutive diff_dynamics within window from same repo
  if (signal.type === SignalType.DiffDynamics && log.signals.length > 0) {
    const last = log.signals[log.signals.length - 1];
    if (
      last.type === SignalType.DiffDynamics &&
      last.repo === signal.repo &&
      signal.ts - last.ts < deduplicationSeconds
    ) {
      // Replace last signal with newer one (keep first and last pattern)
      log.signals[log.signals.length - 1] = signal;
      return;
    }
  }
  log.signals.push(signal);
}
