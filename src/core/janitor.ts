import { readdirSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './config.js';
import { readDailyLog, writeDailyLog, deleteDailyLog, trimTrailingPauses, generateSessionId } from './daily-log.js';
import { ClosedBy } from './types.js';
import { DEFAULT_ACTIVITY } from './constants.js';
import type { DailyLog, ManualEntry, Session } from './types.js';

/**
 * Janitor — maintains the storage invariant: a day file exists ⇔ that day
 * had confirmed work. One pass over the whole data dir at daemon start:
 *
 * - Orphaned open sessions in past day files (crash / hard power-off — the
 *   normal path on Windows, a detached daemon gets no shutdown signal)
 *   close at their trimmed honest end. Absorbs the old recoverOrphanedLogs.
 * - Legacy never-activated sessions (activatedAt = null) are pruned:
 *   report-invisible zero-duration noise from old crash-day files.
 * - Files left with zero confirmed facts (no sessions, no manual entries,
 *   never pushed) are deleted — including historical empty files from the
 *   pre-lazy-day daemon. Emptied month dirs go too.
 *
 * Today's file is never touched here: it is owned by the live SessionTracker
 * (closeCrashedSessions handles today's orphans on top of the loaded log).
 * Deletion of individual real sessions is strictly a user action
 * (workday session-delete) — the janitor never removes activated work.
 */

export interface JanitorResult {
  readonly recoveredSessions: number;
  readonly prunedSessions: number;
  readonly deletedFiles: readonly string[];
  readonly migratedAdjustments: number;
}

// Pre-SQ-1 files: sessions carried manualAdjustments {minutes, reason, addedAt}.
interface LegacyAdjustment {
  readonly minutes?: number;
  readonly addedAt?: string;
}
type LegacySession = Session & { manualAdjustments?: LegacyAdjustment[] };

/**
 * One-time migration: legacy per-session manualAdjustments become one
 * session-born ManualEntry per session (minutes summed, reasons dropped as
 * noise, createdAt = first addedAt). Totals are unchanged and session-born
 * entries fold back into the session aggregate at push time, so the day
 * status is deliberately NOT flipped to Draft — a re-push produces the exact
 * same worklogs. Idempotent: the legacy field is removed from the file.
 */
function migrateAdjustments(log: DailyLog): number {
  let migrated = 0;
  for (const session of log.sessions as LegacySession[]) {
    const adjustments = session.manualAdjustments;
    if (!Array.isArray(adjustments)) continue;

    const minutes = adjustments.reduce((sum, a) => sum + (a.minutes ?? 0), 0);
    // Task-less sessions can't become entries (and were never pushable) —
    // leave their legacy field untouched rather than dropping data.
    if (minutes > 0 && session.task) {
      const entry: ManualEntry = {
        id: generateSessionId(),
        task: session.task,
        minutes,
        description: '',
        activity: DEFAULT_ACTIVITY,
        createdAt: adjustments[0]?.addedAt ?? session.lastSeenAt,
        sourceSessionId: session.id,
      };
      if (!log.manualEntries) log.manualEntries = [];
      log.manualEntries.push(entry);
      migrated += adjustments.length;
      delete session.manualAdjustments;
    } else if (minutes === 0) {
      delete session.manualAdjustments; // empty legacy array — plain cleanup
    }
  }
  return migrated;
}

/** A day record with zero confirmed facts — safe to delete. A pending
 *  review checkout is a fact: deleting it would kill the suggestion. */
export function isEmptyDayLog(log: DailyLog): boolean {
  return log.sessions.length === 0
    && (log.manualEntries ?? []).length === 0
    && (log.reviewCheckouts ?? []).length === 0
    && !log.pushedAt;
}

/** Close orphaned open sessions at their trimmed honest end. */
function closeOrphans(log: DailyLog): number {
  let count = 0;
  for (const session of log.sessions) {
    if (session.closedBy) continue;
    const trimmedEnd = trimTrailingPauses(session);
    if (trimmedEnd) session.lastSeenAt = trimmedEnd;
    session.closedBy = ClosedBy.DaemonCrash;
    count++;
  }
  return count;
}

/** Drop sessions that never reached ACTIVE — invisible to reports. */
function pruneNeverActivated(log: DailyLog): number {
  const before = log.sessions.length;
  log.sessions = log.sessions.filter(s => !!s.activatedAt);
  return before - log.sessions.length;
}

/** All stored dates (any content), oldest first. */
function listAllStoredDates(): string[] {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) return [];

  const dates: string[] = [];
  let monthDirs: string[];
  try {
    monthDirs = readdirSync(dataDir).filter(d => /^\d{4}-\d{2}$/.test(d));
  } catch {
    return [];
  }
  for (const monthDir of monthDirs) {
    let files: string[];
    try {
      files = readdirSync(join(dataDir, monthDir));
    } catch {
      continue;
    }
    for (const file of files) {
      const match = file.match(/^\d{2}-(\d{2})\.json$/);
      if (match) dates.push(`${monthDir}-${match[1]}`);
    }
  }
  return dates.sort();
}

/** Remove month dirs that ended up empty after file deletion. */
function removeEmptyMonthDirs(): void {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) return;
  let monthDirs: string[];
  try {
    monthDirs = readdirSync(dataDir).filter(d => /^\d{4}-\d{2}$/.test(d));
  } catch {
    return;
  }
  for (const monthDir of monthDirs) {
    try { rmdirSync(join(dataDir, monthDir)); } catch { /* not empty — fine */ }
  }
}

/**
 * Run the full startup pass for every stored date before `currentDate`.
 * Corrupted files (unparseable, no backup) are left alone — never deleted
 * blindly. Idempotent: a clean data dir is a no-op.
 */
export function runStartupJanitor(currentDate: string): JanitorResult {
  let recovered = 0;
  let pruned = 0;
  let migrated = 0;
  const deletedFiles: string[] = [];

  for (const date of listAllStoredDates()) {
    if (date >= currentDate) continue;

    const log = readDailyLog(date);
    // Unparseable or structurally alien files are left alone — never delete
    // what we don't understand.
    if (!log || !Array.isArray(log.sessions)) continue;

    const closedHere = closeOrphans(log);
    const prunedHere = pruneNeverActivated(log);
    const migratedHere = migrateAdjustments(log);
    recovered += closedHere;
    pruned += prunedHere;
    migrated += migratedHere;

    if (isEmptyDayLog(log)) {
      deleteDailyLog(date);
      deletedFiles.push(date);
    } else if (closedHere > 0 || prunedHere > 0 || migratedHere > 0) {
      writeDailyLog(log);
    }
  }

  if (deletedFiles.length > 0) removeEmptyMonthDirs();

  return { recoveredSessions: recovered, prunedSessions: pruned, deletedFiles, migratedAdjustments: migrated };
}
