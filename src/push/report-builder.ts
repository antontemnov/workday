import { readDailyLog, computeEffectiveDuration } from '../core/daily-log.js';
import { formatDate, computeWorkingDate } from '../core/config.js';
import { ClosedBy } from '../core/types.js';
import { MS_PER_MINUTE } from '../core/constants.js';
import type { AppConfig, TaskDayReport, ReportResponse, Session, ManualEntry } from '../core/types.js';

/** Iterate calendar dates from `from` to `to` (inclusive) */
function* iterateDates(from: string, to: string): Generator<string> {
  const current = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (current <= end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, '0');
    const d = String(current.getUTCDate()).padStart(2, '0');
    yield `${y}-${m}-${d}`;
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

/** Round seconds to nearest N-minute block, minimum one block */
function roundToMinutes(seconds: number, minutes: number): number {
  const blockSeconds = minutes * 60;
  const blocks = Math.round(seconds / blockSeconds);
  return Math.max(blocks, 1) * blockSeconds;
}

/** First day of current month as YYYY-MM-DD */
export function getDefaultFromDate(config: AppConfig): string {
  const now = formatDate(Date.now(), config.timezone);
  return now.slice(0, 8) + '01';
}

/** Today as YYYY-MM-DD */
export function getDefaultToDate(config: AppConfig): string {
  return formatDate(Date.now(), config.timezone);
}

/**
 * Report-side clamp: an open session on a PAST day ends at lastSeenAt, not
 * Date.now(). Covers hard-killed daemons (Windows shutdown sends no signal)
 * pushed before the next daemon start, and orphans older than the recovery
 * lookback — mirrors exactly what crash recovery would write (session and
 * its open pause closed at lastSeenAt). Today's live sessions still count
 * to now.
 */
function clampPastOpenSession(session: Session, isPastDay: boolean): Session {
  if (!isPastDay || session.closedBy !== null) return session;
  return {
    ...session,
    closedBy: ClosedBy.DaemonCrash,
    pauses: (session.pauses ?? []).map(p => (p.to === null ? { ...p, to: session.lastSeenAt } : p)),
  };
}

/** Aggregate daily logs into per-task-per-day report entries */
export function buildReport(from: string, to: string, config: AppConfig): TaskDayReport[] {
  const entries: TaskDayReport[] = [];
  const today = computeWorkingDate(Date.now(), config.boundaryHour, config.timezone);

  for (const date of iterateDates(from, to)) {
    const log = readDailyLog(date);
    if (!log) continue;

    // Group sessions by task, skip null tasks
    const taskMap = new Map<string, { totalMs: number; count: number }>();
    for (const session of log.sessions) {
      if (!session.task) continue;
      const durationMs = computeEffectiveDuration(clampPastOpenSession(session, date < today));
      if (durationMs <= 0) continue;

      const existing = taskMap.get(session.task);
      if (existing) {
        existing.totalMs += durationMs;
        existing.count++;
      } else {
        taskMap.set(session.task, { totalMs: durationMs, count: 1 });
      }
    }

    // Session-born entries ("+ Add time") fold into the task aggregate before
    // rounding — one Tempo worklog per (date, task), never a separate line.
    // Merge is by task: a dangling sourceSessionId (session deleted) still
    // lands the declared minutes on the right worklog.
    const standalone: ManualEntry[] = [];
    for (const entry of log.manualEntries ?? []) {
      if (!entry.sourceSessionId) {
        standalone.push(entry);
        continue;
      }
      const addMs = entry.minutes * MS_PER_MINUTE;
      const existing = taskMap.get(entry.task);
      if (existing) {
        existing.totalMs += addMs;
      } else {
        taskMap.set(entry.task, { totalMs: addMs, count: 0 });
      }
    }

    for (const [task, { totalMs, count }] of taskMap) {
      let totalSeconds = Math.round(totalMs / 1000);
      if (config.report.roundingMinutes > 0) {
        totalSeconds = roundToMinutes(totalSeconds, config.report.roundingMinutes);
      }
      if (totalSeconds <= 0) continue;

      entries.push({ date, task, totalSeconds, sessionCount: count, kind: 'session' });
    }

    // Standalone manual entries: each is its own unit (becomes its own worklog).
    // Exact minutes — user-entered time is precise, so no rounding. Never
    // collapsed with each other: what the user logged is what ships (SQ-2
    // cancelled by design).
    for (const entry of standalone) {
      const totalSeconds = entry.minutes * 60;
      if (totalSeconds <= 0) continue;
      entries.push({
        date,
        task: entry.task,
        totalSeconds,
        sessionCount: 0,
        kind: 'manual',
        entryId: entry.id,
        description: entry.description,
        activity: entry.activity,
      });
    }
  }

  return entries;
}

/** Build full report response with totals */
export function buildReportResponse(from: string, to: string, config: AppConfig): ReportResponse {
  const entries = buildReport(from, to, config);

  const taskTotals: Record<string, number> = {};
  let totalSeconds = 0;
  for (const entry of entries) {
    taskTotals[entry.task] = (taskTotals[entry.task] ?? 0) + entry.totalSeconds;
    totalSeconds += entry.totalSeconds;
  }

  return { from, to, entries, taskTotals, totalSeconds };
}
