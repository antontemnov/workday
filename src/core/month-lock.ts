// Closed-month lock (a timesheet IN_REVIEW / APPROVED in Tempo): nothing in
// the month changes after the submit. The submit lands on the site at an
// unknown moment, so whatever the tracker wrote after it is cut away once the
// daemon learns of it — by the moment Tempo reports, not by when it was seen.

import { SUBMIT_WINDOW_WORKING_DAYS } from './constants.js';
import { isWorkingDay, trimTrailingPauses } from './daily-log.js';
import { ClosedBy } from './types.js';
import type { AppConfig, DailyLog, ManualEntry } from './types.js';

/** First day of the month's submit window: its Nth working day from the end. */
export function submissionWindowStart(year: number, month: number, config: AppConfig, workingDays = SUBMIT_WINDOW_WORKING_DAYS): string {
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let found = 0;
  for (let day = daysInMonth; day >= 1; day--) {
    const date = `${prefix}-${String(day).padStart(2, '0')}`;
    if (isWorkingDay(date, config) && ++found === workingDays) return date;
  }
  return `${prefix}-01`;
}

/** The date sits in its own month's submit window (weekends at the end count). */
export function inSubmissionWindow(date: string, config: AppConfig): boolean {
  return date >= submissionWindowStart(Number(date.slice(0, 4)), Number(date.slice(5, 7)), config);
}

/** Every date of a month ("YYYY-MM"). */
export function monthDates(month: string): string[] {
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  return Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
}

export interface DayCut {
  readonly removedSessionIds: readonly string[];
  readonly closedSessionIds: readonly string[];
  readonly removedEntries: readonly ManualEntry[];
}

export function isEmptyCut(cut: DayCut): boolean {
  return cut.removedSessionIds.length === 0 && cut.closedSessionIds.length === 0 && cut.removedEntries.length === 0;
}

/**
 * Cut a day at the moment its month closed: sessions activated after it go,
 * sessions running across it end there, entries created after it go unless
 * they own a Tempo worklog (taken from Tempo, so they are Tempo already).
 */
export function cutDayAt(log: DailyLog, cutAt: string, ownsWorklog: (entry: ManualEntry) => boolean): DayCut {
  const cut = Date.parse(cutAt);
  const cutIso = new Date(cut).toISOString();
  const removedSessionIds: string[] = [];
  const closedSessionIds: string[] = [];

  log.sessions = log.sessions.filter(session => {
    const start = Date.parse(session.activatedAt ?? session.startedAt);
    if (start >= cut) {
      removedSessionIds.push(session.id);
      return false;
    }
    const open = session.closedBy === null;
    if (!open && Date.parse(session.lastSeenAt) <= cut) return true;

    session.pauses = session.pauses
      .filter(p => Date.parse(p.from) < cut)
      .map(p => (p.to === null || Date.parse(p.to) > cut ? { ...p, to: null } : p));
    // A pause running at the cut is where work really stopped.
    session.lastSeenAt = trimTrailingPauses(session) ?? cutIso;
    if (open) session.closedBy = ClosedBy.MonthClosed;
    closedSessionIds.push(session.id);
    return true;
  });

  const removedEntries = log.manualEntries.filter(e => Date.parse(e.createdAt) >= cut && !ownsWorklog(e));
  if (removedEntries.length > 0) {
    log.manualEntries = log.manualEntries.filter(e => !removedEntries.includes(e));
  }
  return { removedSessionIds, closedSessionIds, removedEntries };
}
