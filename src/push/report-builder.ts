import { readDailyLog, computeFullEffectiveDuration } from '../core/daily-log.js';
import { formatDate } from '../core/config.js';
import type { AppConfig, TaskDayReport, ReportResponse } from '../core/types.js';

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

/** Aggregate daily logs into per-task-per-day report entries */
export function buildReport(from: string, to: string, config: AppConfig): TaskDayReport[] {
  const entries: TaskDayReport[] = [];

  for (const date of iterateDates(from, to)) {
    const log = readDailyLog(date);
    if (!log) continue;

    // Group sessions by task, skip null tasks
    const taskMap = new Map<string, { totalMs: number; count: number }>();
    for (const session of log.sessions) {
      if (!session.task) continue;
      const durationMs = computeFullEffectiveDuration(session);
      if (durationMs <= 0) continue;

      const existing = taskMap.get(session.task);
      if (existing) {
        existing.totalMs += durationMs;
        existing.count++;
      } else {
        taskMap.set(session.task, { totalMs: durationMs, count: 1 });
      }
    }

    for (const [task, { totalMs, count }] of taskMap) {
      let totalSeconds = Math.round(totalMs / 1000);
      if (config.report.roundingMinutes > 0) {
        totalSeconds = roundToMinutes(totalSeconds, config.report.roundingMinutes);
      }
      if (totalSeconds <= 0) continue;

      entries.push({ date, task, totalSeconds, sessionCount: count });
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
