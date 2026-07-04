import { readFileSync, writeFileSync, copyFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync, writeSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir, computeWorkingDate } from './config.js';
import { DayStatus, DayType, SignalType, type DailyLog, type Session, type Signal, type Evidence, type AppConfig, type Pause, type ManualEntry, type ActiveInterval } from './types.js';
import { TMP_EXTENSION, BACKUP_EXTENSION, LOCK_EXTENSION, LOCK_STALE_MS, MAX_ENTRY_MINUTES, MS_PER_MINUTE, DEFAULT_ACTIVITY } from './constants.js';

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
    sessions: [],
    signals: [],
    manualEntries: [],
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

/**
 * List all stored dates that have at least one session.
 * Scans the data directory; sorted descending (newest first).
 */
export function listAvailableDates(): string[] {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) return [];

  let monthDirs: string[];
  try {
    monthDirs = readdirSync(dataDir).filter(d => /^\d{4}-\d{2}$/.test(d));
  } catch {
    return [];
  }

  const dates: string[] = [];
  for (const monthDir of monthDirs) {
    let files: string[];
    try {
      files = readdirSync(join(dataDir, monthDir));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = file.match(/^(\d{2})-(\d{2})\.json$/);
      if (!match) continue;
      const date = `${monthDir}-${match[2]}`;
      const log = readDailyLog(date);
      if (log && log.sessions.length > 0) {
        dates.push(date);
      }
    }
  }

  return dates.sort().reverse();
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

/**
 * Delete a day file together with its backup and stray tmp — the .bak must
 * go too, or readDailyLog would resurrect the day from it. Storage
 * invariant: a file exists ⇔ the day had confirmed facts.
 */
export function deleteDailyLog(date: string): void {
  const filePath = getDailyLogPath(date);
  for (const p of [filePath, filePath + BACKUP_EXTENSION, filePath + TMP_EXTENSION]) {
    try { unlinkSync(p); } catch { /* best effort */ }
  }
}

/** Get or create today's daily log */
export function getOrCreateTodayLog(config: AppConfig): DailyLog {
  const today = computeWorkingDate(Date.now(), config.boundaryHour, config.timezone);
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

/**
 * Trailing-pause trim: honest session end. When the session sits in an open
 * pause, the real end of work is where that pause chain began — walk back
 * through back-to-back pauses (auto-pause transitions like Superseded →
 * IdleTimeout share the boundary timestamp), drop the chain from the record
 * and return its start. A closed trailing pause means activity happened
 * after it — nothing to trim, returns null. Effective duration is unchanged
 * either way (trimmed pauses were already subtracted).
 */
export function trimTrailingPauses(session: Session): string | null {
  const pauses = session.pauses;
  if (pauses.length === 0) return null;
  if (pauses[pauses.length - 1].to !== null) return null;

  let start = pauses.length - 1;
  while (start > 0 && pauses[start - 1].to === pauses[start].from) {
    start--;
  }
  const chainStart = pauses[start].from;
  session.pauses = pauses.slice(0, start);
  return chainStart;
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

/**
 * UI-only resolver for the day-start indicator. Returns null when no session
 * has reached ACTIVE yet, so the client hides the indicator until then.
 *
 * The result is the EARLIEST `activatedAt` across all sessions (first
 * CONFIRMED work), NOT `sessions[0]`. Array order follows repo discovery,
 * so the first entry may be a session that activated much later — anchoring
 * to it would push the indicator past the real start.
 */
export function resolveUiDayStart(log: DailyLog): string | null {
  let earliest: string | null = null;
  for (const s of log.sessions) {
    if (!s.activatedAt) continue;
    if (earliest === null || new Date(s.activatedAt).getTime() < new Date(earliest).getTime()) {
      earliest = s.activatedAt;
    }
  }
  return earliest;
}

/** Compute day end timestamp (next day boundary) */
export function computeDayEnd(date: string, dayBoundaryHour: number, timezone: string): number {
  // Day end = next calendar day at dayBoundaryHour
  const nextDay = new Date(date + 'T12:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDateStr = `${nextDay.getUTCFullYear()}-${String(nextDay.getUTCMonth() + 1).padStart(2, '0')}-${String(nextDay.getUTCDate()).padStart(2, '0')}`;
  return parseDateWithHour(nextDateStr, dayBoundaryHour, timezone);
}

/**
 * Budget v2: the full physical day window (boundary hour → next boundary
 * hour, ~24h). Depends only on log.date and config — never on sessions or
 * the daemon lifecycle, so restarts mid-day don't shrink it.
 * On DST transition days the window is honestly 23/25h — the physical day
 * length, not a bug.
 */
export function computeBudgetMs(log: DailyLog, config: AppConfig): number {
  const dayStart = parseDateWithHour(log.date, config.boundaryHour, config.timezone);
  const dayEnd = computeDayEnd(log.date, config.boundaryHour, config.timezone);
  return Math.max(0, dayEnd - dayStart);
}

/** Sum of all manual entries' minutes (ms) */
export function computeTotalManualEntryMs(log: DailyLog): number {
  return (log.manualEntries ?? []).reduce((sum, e) => sum + e.minutes * MS_PER_MINUTE, 0);
}

/** Sum of all sessions' observed duration + manual entries (ms) */
export function computeTotalClaimedMs(log: DailyLog): number {
  const sessionsMs = log.sessions.reduce((sum, s) => sum + computeEffectiveDuration(s), 0);
  return sessionsMs + computeTotalManualEntryMs(log);
}

/** Remaining budget in ms, clamped >= 0 */
export function getRemainingBudgetMs(log: DailyLog, config: AppConfig): number {
  return Math.max(0, computeBudgetMs(log, config) - computeTotalClaimedMs(log));
}

/** Compute per-session active intervals (pauses excluded, no cross-session merge). */
export function computeActiveIntervals(sessions: readonly Session[]): ActiveInterval[] {
  const intervals: Array<{ from: number; to: number; sessionId: string; repo: string }> = [];

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
        intervals.push({ from: cursor, to: pause.from, sessionId: session.id, repo: session.repo });
      }
      cursor = Math.max(cursor, pause.to);
    }
    if (cursor < end) {
      intervals.push({ from: cursor, to: end, sessionId: session.id, repo: session.repo });
    }
  }

  intervals.sort((a, b) => a.from - b.from);

  return intervals.map(iv => ({
    from: new Date(iv.from).toISOString(),
    to: new Date(iv.to).toISOString(),
    sessionId: iv.sessionId,
    repo: iv.repo,
  }));
}

/** Allow edits on any day. A pushed/confirmed day reverts to Draft so the next
 *  push re-syncs it; status=Draft also flags "unsynced local changes" for the UI. */
function unsealForEdit(log: DailyLog): void {
  if (log.status !== DayStatus.Draft) {
    log.status = DayStatus.Draft;
  }
}

// ─── Manual entries ───────────────────────────────────────────────────────

/** Find a manual entry by id */
export function findManualEntry(log: DailyLog, id: string): ManualEntry | undefined {
  return (log.manualEntries ?? []).find(e => e.id === id);
}

/** Resolve a manual entry by 1-based index (#2) or id */
export function resolveManualEntryTarget(log: DailyLog, target: string): ManualEntry | null {
  const entries = log.manualEntries ?? [];
  const index = parseInt(target.replace('#', ''), 10);
  if (!isNaN(index) && index >= 1 && index <= entries.length) {
    return entries[index - 1];
  }
  return entries.find(e => e.id === target) ?? null;
}

/** Validate a task key against the configured pattern (full-string match). */
export function assertValidTask(task: string, config: AppConfig): void {
  const match = task.match(new RegExp(config.taskPattern));
  if (!match || match[0] !== task) {
    throw new Error(`Task "${task}" is not a valid key (pattern: ${config.taskPattern})`);
  }
}

/**
 * Add a manual entry — declared time on a task. Session-born entries
 * (sourceSessionId set) have no description and are always Development;
 * standalone entries require description and activity.
 * Budget invariant: total claimed ≤ day window. Throws on validation failure.
 */
export function addManualEntry(
  log: DailyLog,
  input: { task: string; minutes: number; description: string; activity: string; sourceSessionId?: string },
  config: AppConfig,
): ManualEntry {
  const task = input.task.trim();
  if (!task) throw new Error('Task is required');
  assertValidTask(task, config);

  if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
    throw new Error('Minutes must be positive');
  }
  if (input.minutes > MAX_ENTRY_MINUTES) {
    throw new Error(`Max is ${MAX_ENTRY_MINUTES} minutes (8h)`);
  }

  const sessionBorn = !!input.sourceSessionId;
  const description = sessionBorn ? '' : input.description.trim();
  if (!sessionBorn && !description) throw new Error('Description is required');

  const activity = sessionBorn ? DEFAULT_ACTIVITY : input.activity.trim();
  if (!activity) throw new Error('Activity is required');

  const addMs = input.minutes * MS_PER_MINUTE;
  if (computeTotalClaimedMs(log) + addMs > computeBudgetMs(log, config)) {
    const remainMinutes = Math.floor(getRemainingBudgetMs(log, config) / MS_PER_MINUTE);
    throw new Error(`Exceeds 24h day window. Remaining: ${remainMinutes}m.`);
  }

  unsealForEdit(log);
  if (!log.manualEntries) log.manualEntries = [];
  const entry: ManualEntry = {
    id: generateSessionId(),
    task,
    minutes: input.minutes,
    description,
    activity,
    createdAt: new Date().toISOString(),
    ...(sessionBorn ? { sourceSessionId: input.sourceSessionId } : {}),
  };
  log.manualEntries.push(entry);
  return entry;
}

/**
 * Edit a manual entry in place (absolute set of provided fields).
 * Budget re-checked when minutes increase. Throws on validation failure.
 */
export function editManualEntry(
  log: DailyLog,
  id: string,
  patch: { minutes?: number; description?: string; activity?: string },
  config: AppConfig,
): void {
  const entry = findManualEntry(log, id);
  if (!entry) throw new Error(`Manual entry not found: ${id}`);
  if (entry.sourceSessionId) {
    throw new Error('Session-born entry is not editable');
  }

  if (patch.minutes !== undefined) {
    if (!Number.isFinite(patch.minutes) || patch.minutes <= 0) {
      throw new Error('Minutes must be positive');
    }
    if (patch.minutes > MAX_ENTRY_MINUTES) {
      throw new Error(`Max is ${MAX_ENTRY_MINUTES} minutes (8h)`);
    }
    const deltaMs = (patch.minutes - entry.minutes) * MS_PER_MINUTE;
    if (deltaMs > 0 && computeTotalClaimedMs(log) + deltaMs > computeBudgetMs(log, config)) {
      const remainMinutes = Math.floor(getRemainingBudgetMs(log, config) / MS_PER_MINUTE);
      throw new Error(`Exceeds 24h day window. Remaining: ${remainMinutes}m.`);
    }
    entry.minutes = patch.minutes;
  }

  if (patch.description !== undefined) {
    const d = patch.description.trim();
    if (!d) throw new Error('Description cannot be empty');
    entry.description = d;
  }

  if (patch.activity !== undefined) {
    const a = patch.activity.trim();
    if (!a) throw new Error('Activity cannot be empty');
    entry.activity = a;
  }

  unsealForEdit(log);
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
