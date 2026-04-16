import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, writeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir, computeWorkingDate } from './config.js';
import { DayStatus, DayType, SignalType, type DailyLog, type Session, type Signal, type Evidence, type AppConfig, type Pause, type ManualAdjustment, type ActiveInterval } from './types.js';
import { TMP_EXTENSION, BACKUP_EXTENSION, LOCK_EXTENSION, LOCK_STALE_MS, MAX_ADJUSTMENT_MINUTES, MS_PER_MINUTE } from './constants.js';

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
    dayStartedAt: null,
    sessions: [],
    signals: [],
    pushedAt: null,
  };
}

/** Create empty evidence object */
export function createEmptyEvidence(): Evidence {
  return {
    commits: 0,
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

// ─── File locking ──────────────────────────────────────────────────────

/** Acquire an exclusive lock file. Removes stale locks automatically. */
function acquireLock(lockPath: string): number {
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    return fd;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    // Lock exists — check if stale
    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        return fd;
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Lock was released between check and unlink — retry once
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, String(process.pid));
        return fd;
      }
    }
    throw new Error(`File is locked: ${lockPath}`);
  }
}

/** Release a lock file */
function releaseLock(lockPath: string, fd: number): void {
  try { closeSync(fd); } catch { /* best effort */ }
  try { unlinkSync(lockPath); } catch { /* best effort */ }
}

/** Write daily log to disk using atomic write pattern with backup */
export function writeDailyLog(log: DailyLog): void {
  ensureDataDir(log.date);
  const filePath = getDailyLogPath(log.date);
  const lockPath = filePath + LOCK_EXTENSION;
  const tmpPath = filePath + TMP_EXTENSION;
  const bakPath = filePath + BACKUP_EXTENSION;

  const fd = acquireLock(lockPath);
  try {
    // Backup current valid file before overwriting
    if (tryParseLogFile(filePath)) {
      try { copyFileSync(filePath, bakPath); } catch { /* best effort */ }
    }

    writeFileSync(tmpPath, JSON.stringify(log, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  } finally {
    releaseLock(lockPath, fd);
  }
}

/** Get or create today's daily log */
export function getOrCreateTodayLog(config: AppConfig): DailyLog {
  const today = computeWorkingDate(Date.now(), config.schedule.end, config.timezone);
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

// ─── Pause helpers ──────────────────────────────────────────────────────

/** Find open (unclosed) pause in a session */
export function getOpenPause(session: Session): Pause | null {
  return session.pauses.find(p => p.to === null) ?? null;
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

// ─── Session target resolution ───────────────────────────────────────────

/** Resolve session by 1-based index or hex id */
export function resolveSessionTarget(log: DailyLog, target: string): Session | null {
  const index = parseInt(target.replace('#', ''), 10);
  if (!isNaN(index) && index >= 1 && index <= log.sessions.length) {
    return log.sessions[index - 1];
  }
  return log.sessions.find(s => s.id === target) ?? null;
}

// ─── Budget computation ─────────────────────────────────────────────────

/** Sum of manual adjustment minutes for a session */
export function computeManualMinutes(session: Session): number {
  if (!session.manualAdjustments || session.manualAdjustments.length === 0) return 0;
  return session.manualAdjustments.reduce((sum, a) => sum + a.minutes, 0);
}

/** Effective duration including manual adjustments (ms) */
export function computeFullEffectiveDuration(session: Session): number {
  return computeEffectiveDuration(session) + computeManualMinutes(session) * MS_PER_MINUTE;
}

/** Resolve dayStart timestamp using priority chain: manualStart → dayStartedAt → first session */
export function computeDayStart(log: DailyLog, config: AppConfig): number {
  if (log.manualStart) {
    return new Date(log.manualStart).getTime();
  }
  if (log.dayStartedAt) {
    return new Date(log.dayStartedAt).getTime();
  }
  // Fallback: first activated session
  for (const s of log.sessions) {
    if (s.activatedAt) return new Date(s.activatedAt).getTime();
  }
  // No sessions yet — use day boundary start (date + dayBoundaryHour in timezone)
  return parseDateWithHour(log.date, config.schedule.end, config.timezone);
}

/** Compute day end timestamp (next day boundary) */
export function computeDayEnd(date: string, dayBoundaryHour: number, timezone: string): number {
  // Day end = next calendar day at dayBoundaryHour
  const nextDay = new Date(date + 'T12:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDateStr = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;
  return parseDateWithHour(nextDateStr, dayBoundaryHour, timezone);
}

/** Compute total budget in ms */
export function computeBudgetMs(log: DailyLog, config: AppConfig): number {
  const dayStart = computeDayStart(log, config);
  const dayEnd = computeDayEnd(log.date, config.schedule.end, config.timezone);
  return Math.max(0, dayEnd - dayStart);
}

/** Sum of all sessions' full effective duration (ms) */
export function computeTotalClaimedMs(log: DailyLog): number {
  return log.sessions.reduce((sum, s) => sum + computeFullEffectiveDuration(s), 0);
}

/** Check if day budget is exhausted */
export function isBudgetExhausted(log: DailyLog, config: AppConfig): boolean {
  return computeTotalClaimedMs(log) >= computeBudgetMs(log, config);
}

/** Remaining budget in ms, clamped >= 0 */
export function getRemainingBudgetMs(log: DailyLog, config: AppConfig): number {
  return Math.max(0, computeBudgetMs(log, config) - computeTotalClaimedMs(log));
}

/** Compute merged active work intervals from sessions (excluding pauses) */
export function computeActiveIntervals(sessions: readonly Session[]): ActiveInterval[] {
  const raw: Array<{ from: number; to: number }> = [];

  for (const session of sessions) {
    if (!session.activatedAt) continue;

    const start = new Date(session.activatedAt).getTime();
    const end = session.closedBy
      ? new Date(session.lastSeenAt).getTime()
      : Date.now();

    const sortedPauses = [...session.pauses]
      .map(p => ({
        from: Math.max(new Date(p.from).getTime(), start),
        to: Math.min(p.to ? new Date(p.to).getTime() : Date.now(), end),
      }))
      .filter(p => p.from < p.to)
      .sort((a, b) => a.from - b.from);

    let cursor = start;
    for (const pause of sortedPauses) {
      if (pause.from > cursor) {
        raw.push({ from: cursor, to: pause.from });
      }
      cursor = Math.max(cursor, pause.to);
    }
    if (cursor < end) {
      raw.push({ from: cursor, to: end });
    }
  }

  if (raw.length === 0) return [];

  raw.sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [{ ...raw[0] }];

  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1];
    const curr = raw[i];
    if (curr.from <= last.to) {
      last.to = Math.max(last.to, curr.to);
    } else {
      merged.push({ ...curr });
    }
  }

  return merged.map(iv => ({
    from: new Date(iv.from).toISOString(),
    to: new Date(iv.to).toISOString(),
  }));
}

/** Add manual adjustment to a session. Throws on validation failure. */
export function addManualAdjustment(log: DailyLog, sessionId: string, minutes: number, reason: string, config: AppConfig): void {
  if (log.status !== DayStatus.Draft) {
    throw new Error('Cannot adjust confirmed/pushed day');
  }

  const session = log.sessions.find(s => s.id === sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (minutes <= 0) {
    throw new Error('Minutes must be positive');
  }

  if (minutes > MAX_ADJUSTMENT_MINUTES) {
    throw new Error(`Max adjustment is ${MAX_ADJUSTMENT_MINUTES} minutes (8h)`);
  }

  // Check budget
  const currentClaimed = computeTotalClaimedMs(log);
  const addMs = minutes * MS_PER_MINUTE;
  const budget = computeBudgetMs(log, config);
  if (currentClaimed + addMs > budget) {
    const remainMinutes = Math.floor(getRemainingBudgetMs(log, config) / MS_PER_MINUTE);
    throw new Error(`Exceeds day budget. Remaining: ${remainMinutes}m. Use set-start to extend.`);
  }

  if (!session.manualAdjustments) {
    session.manualAdjustments = [];
  }

  session.manualAdjustments.push({
    minutes,
    reason,
    addedAt: new Date().toISOString(),
  });
}

/** Set manual day start. Can only shift earlier. */
export function setDayManualStart(log: DailyLog, isoTimestamp: string, config: AppConfig): void {
  const newStart = new Date(isoTimestamp).getTime();
  const currentStart = computeDayStart(log, config);

  if (newStart > currentStart) {
    throw new Error('Can only shift day start earlier');
  }

  // Must be >= previous day boundary
  const prevBoundary = parseDateWithHour(log.date, config.schedule.end, config.timezone);
  if (newStart < prevBoundary) {
    throw new Error(`Cannot start before previous day boundary (${String(config.schedule.end).padStart(2, '0')}:00)`);
  }

  log.manualStart = isoTimestamp;
}

/** Parse a date string + hour into a timestamp in the given timezone */
function parseDateWithHour(date: string, hour: number, timezone: string): number {
  // Build a date at noon UTC, then adjust by finding the offset
  const [year, month, day] = date.split('-').map(Number);
  // Try the target hour in UTC first, then adjust for timezone
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  // Get the actual hour in the target timezone for this guess
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(guess);

  const hourPart = parts.find(p => p.type === 'hour');
  if (!hourPart) throw new Error(`Failed to parse hour in timezone ${timezone}`);
  const actualHour = parseInt(hourPart.value);
  const h = actualHour === 24 ? 0 : actualHour;
  // Offset correction
  const diff = hour - h;
  return guess.getTime() + diff * 3_600_000;
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
