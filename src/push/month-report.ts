import { readDailyLog, computeTotalClaimedMs } from '../core/daily-log.js';
import { DayStatus } from '../core/types.js';
import { MonthDayStatus } from '../core/types.js';
import type {
  AppConfig,
  DailyLog,
  MonthDaySummary,
  MonthDayTask,
  MonthResponse,
  TaskDayReport,
} from '../core/types.js';
import { buildReport } from './report-builder.js';

/** First/last calendar day of a month as YYYY-MM-DD. */
export function getMonthRange(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Parse "YYYY-MM" → {year, month} or null when malformed/out of range. */
export function parseYearMonth(value: string): { year: number; month: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

// Sync state vs Tempo, from the daily log alone (offline). Confirmed is dead
// but old files may still carry it — anything not pushed counts as draft.
function deriveDayStatus(log: DailyLog | null): MonthDayStatus {
  if (!log) return MonthDayStatus.None;
  if (log.status === DayStatus.Pushed) return MonthDayStatus.Pushed;
  return log.pushedAt ? MonthDayStatus.Outdated : MonthDayStatus.Pending;
}

function toMonthDayTask(entry: TaskDayReport): MonthDayTask {
  return {
    task: entry.task,
    seconds: entry.totalSeconds,
    kind: entry.kind,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.activity !== undefined ? { activity: entry.activity } : {}),
  };
}

/**
 * Month aggregate for the timesheets tab: daily logs + the push view of each
 * day (rounded task lines, session-born entries folded). Pure disk read — no
 * Tempo calls, works offline. The caller is responsible for flushing today's
 * live log to disk first when the month includes today.
 */
export function buildMonthResponse(year: number, month: number, config: AppConfig): MonthResponse {
  const { from, to } = getMonthRange(year, month);

  const tasksByDate = new Map<string, MonthDayTask[]>();
  for (const entry of buildReport(from, to, config)) {
    const list = tasksByDate.get(entry.date) ?? [];
    list.push(toMonthDayTask(entry));
    tasksByDate.set(entry.date, list);
  }

  const days: MonthDaySummary[] = [];
  const totals = {
    claimedMs: 0,
    reportedSeconds: 0,
    daysWithData: 0,
    pendingDays: 0,
    outdatedDays: 0,
    pushedDays: 0,
  };
  let lastPushAt: string | null = null;

  const lastDay = parseInt(to.slice(8), 10);
  for (let dayNum = 1; dayNum <= lastDay; dayNum++) {
    const date = `${from.slice(0, 8)}${String(dayNum).padStart(2, '0')}`;
    const log = readDailyLog(date);
    const status = deriveDayStatus(log);
    const tasks = tasksByDate.get(date) ?? [];
    const claimedMs = log ? computeTotalClaimedMs(log) : 0;
    const reportedSeconds = tasks.reduce((sum, t) => sum + t.seconds, 0);

    days.push({
      date,
      dayType: log?.dayType ?? null,
      status,
      claimedMs,
      reportedSeconds,
      taskCount: new Set(tasks.map(t => t.task)).size,
      tasks,
      pushedAt: log?.pushedAt ?? null,
    });

    totals.claimedMs += claimedMs;
    totals.reportedSeconds += reportedSeconds;
    if (log) totals.daysWithData++;
    if (status === MonthDayStatus.Pending) totals.pendingDays++;
    if (status === MonthDayStatus.Outdated) totals.outdatedDays++;
    if (status === MonthDayStatus.Pushed) totals.pushedDays++;
    if (log?.pushedAt && (!lastPushAt || log.pushedAt > lastPushAt)) {
      lastPushAt = log.pushedAt;
    }
  }

  return { year, month, from, to, days, totals, lastPushAt };
}
