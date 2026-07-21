// Manual-entry mutations on a past day's log, disk-to-disk. Mirrors the
// tracker paths used for today: same core validation (addManualEntry &
// friends unseal the day back to draft), plus the storage invariant —
// file exists ⇔ a confirmed fact happened. Shared by the CLI --date
// handlers and the HTTP date-aware manual-entry endpoints.

import {
  readDailyLog,
  writeDailyLog,
  deleteDailyLog,
  createEmptyLog,
  addManualEntry,
  addImportedEntry,
  editManualEntry,
  deleteManualEntry,
  findManualEntry,
  resolveManualEntryTarget,
  resolveSessionTarget,
} from './daily-log.js';
import { isEmptyDayLog } from './janitor.js';
import { DEFAULT_ACTIVITY } from './constants.js';
import { DayStatus } from './types.js';
import type { AppConfig, DailyLog, ManualEntry, Session } from './types.js';

function requireLog(date: string): DailyLog {
  const log = readDailyLog(date);
  if (!log) throw new Error(`No data for ${date}`);
  return log;
}

/**
 * Add a standalone manual entry on a date. The entry is a confirmed fact —
 * the day file is created when absent. Throws on validation failure.
 */
export function addEntryOnDate(
  date: string,
  input: { task: string; minutes: number; description: string; activity: string; sourceRef?: string },
  config: AppConfig,
): { entry: ManualEntry; log: DailyLog } {
  const log = readDailyLog(date) ?? createEmptyLog(date, config);
  const entry = addManualEntry(log, input, config);
  writeDailyLog(log);
  return { entry, log };
}

/**
 * Adopt a Tempo worklog as a manual entry on a date (mirror import). The
 * worklog is a confirmed fact — the day file is created when absent.
 * Throws on validation failure.
 */
export function importEntryOnDate(
  date: string,
  input: { task: string; minutes: number; description: string; activity: string },
  config: AppConfig,
): { entry: ManualEntry; log: DailyLog } {
  const log = readDailyLog(date) ?? createEmptyLog(date, config);
  const entry = addImportedEntry(log, input, config);
  writeDailyLog(log);
  return { entry, log };
}

/**
 * "+ Add time" on a past day's session: session-born entry, task from the
 * session, Development, no description. Throws when the session (or its
 * task) is missing.
 */
export function addSessionEntryOnDate(
  date: string,
  target: string,
  minutes: number,
  config: AppConfig,
): { entry: ManualEntry; log: DailyLog } {
  const log = requireLog(date);
  const session = resolveSessionTarget(log, target);
  if (!session) throw new Error(`Session not found: ${target}`);
  if (!session.task) {
    throw new Error('Session has no task — log the time with `workday log <task> ...`');
  }
  const entry = addManualEntry(log, {
    task: session.task,
    minutes,
    description: '',
    activity: DEFAULT_ACTIVITY,
    sourceSessionId: session.id,
  }, config);
  writeDailyLog(log);
  return { entry, log };
}

/** Edit a manual entry on a date (target = #index or id). Throws on failure. */
export function editEntryOnDate(
  date: string,
  target: string,
  patch: { minutes?: number; description?: string; activity?: string },
  config: AppConfig,
): { entry: ManualEntry; log: DailyLog } {
  const log = requireLog(date);
  const found = resolveManualEntryTarget(log, target);
  if (!found) throw new Error(`Manual entry not found: ${target}`);
  editManualEntry(log, found.id, patch, config);
  writeDailyLog(log);
  return { entry: findManualEntry(log, found.id)!, log };
}

/**
 * Delete a manual entry on a date. Removing the day's last fact deletes the
 * file (storage invariant). Throws when the target is unknown.
 */
export function deleteEntryOnDate(
  date: string,
  target: string,
): { deleted: ManualEntry; log: DailyLog; dayFileDeleted: boolean } {
  const log = requireLog(date);
  const found = resolveManualEntryTarget(log, target);
  if (!found) throw new Error(`Manual entry not found: ${target}`);
  const deleted = deleteManualEntry(log, found.id);

  if (isEmptyDayLog(log)) {
    deleteDailyLog(date);
    return { deleted, log, dayFileDeleted: true };
  }
  writeDailyLog(log);
  return { deleted, log, dayFileDeleted: false };
}

// Shared tail of the session/task deletes: storage invariant (file exists ⇔
// a confirmed fact happened; pushedAt is a fact — the file stays as the push
// marker so the next push can propagate the delete to Tempo), unseal to
// Draft otherwise.
function finishDayDeletion(date: string, log: DailyLog): boolean {
  if (isEmptyDayLog(log)) {
    deleteDailyLog(date);
    return true;
  }
  if (log.status !== DayStatus.Draft) log.status = DayStatus.Draft;
  writeDailyLog(log);
  return false;
}

/**
 * Delete a session on a date (target = #index or id) — review-time cleanup,
 * disk-to-disk. Session-born entries of the ticket survive: manual time is
 * user intent, not machine noise. Throws when the target is unknown.
 */
export function deleteSessionOnDate(
  date: string,
  target: string,
): { deleted: Session; log: DailyLog; dayFileDeleted: boolean; dayWasPushed: boolean } {
  const log = requireLog(date);
  const session = resolveSessionTarget(log, target);
  if (!session) throw new Error(`Session not found: ${target}`);

  const dayWasPushed = !!log.pushedAt;
  log.sessions = log.sessions.filter(s => s !== session);
  const dayFileDeleted = finishDayDeletion(date, log);
  return { deleted: session, log, dayFileDeleted, dayWasPushed };
}

/**
 * Delete a ticket's whole tracked block on a date: every session on the task
 * plus its session-born ("+ Add time") entries, one atomic write. Standalone
 * manual entries are separate worklogs and stay. Throws when the task has no
 * tracked time that day.
 */
export function deleteTaskOnDate(
  date: string,
  task: string,
): { sessions: readonly Session[]; entries: readonly ManualEntry[]; log: DailyLog; dayFileDeleted: boolean; dayWasPushed: boolean } {
  const log = requireLog(date);
  const sessions = log.sessions.filter(s => s.task === task);
  const entries = (log.manualEntries ?? []).filter(e => !!e.sourceSessionId && e.task === task);
  if (sessions.length === 0 && entries.length === 0) {
    throw new Error(`No tracked time for ${task} on ${date}`);
  }

  const dayWasPushed = !!log.pushedAt;
  log.sessions = log.sessions.filter(s => s.task !== task);
  if (log.manualEntries) {
    log.manualEntries = log.manualEntries.filter(e => !(e.sourceSessionId && e.task === task));
  }
  const dayFileDeleted = finishDayDeletion(date, log);
  return { sessions, entries, log, dayFileDeleted, dayWasPushed };
}
