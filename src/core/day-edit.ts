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
  editManualEntry,
  deleteManualEntry,
  findManualEntry,
  resolveManualEntryTarget,
  resolveSessionTarget,
} from './daily-log.js';
import { isEmptyDayLog } from './janitor.js';
import { DEFAULT_ACTIVITY } from './constants.js';
import type { AppConfig, DailyLog, ManualEntry } from './types.js';

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
  input: { task: string; minutes: number; description: string; activity: string },
  config: AppConfig,
): { entry: ManualEntry; log: DailyLog } {
  const log = readDailyLog(date) ?? createEmptyLog(date, config);
  const entry = addManualEntry(log, input, config);
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
