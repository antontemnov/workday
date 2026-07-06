// Push-log persistence: the ownership map localKey → what we last sent to
// Tempo, plus tombstones for pushed-then-deleted manual entries. Tombstones
// are only recorded here; delete propagation to Tempo lands with the
// reconcile engine (mirror-sync stage 3).

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { PUSH_LOG_FILE, PUSH_TOMBSTONES_FILE, TMP_EXTENSION } from '../core/constants.js';
import type { PushLogEntry, PushTombstone } from '../core/types.js';

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(getDataDir(), { recursive: true });
  const tmpPath = filePath + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);
}

function readJsonOr<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/** Ownership key: session aggregate `date|task`, manual entry `date|task|m:id`. */
export function pushLogKey(date: string, task: string, entryId?: string): string {
  return entryId ? `${date}|${task}|m:${entryId}` : `${date}|${task}`;
}

export function loadPushLog(): Record<string, PushLogEntry> {
  return readJsonOr(join(getDataDir(), PUSH_LOG_FILE), {});
}

export function savePushLog(log: Record<string, PushLogEntry>): void {
  writeJsonAtomic(join(getDataDir(), PUSH_LOG_FILE), log);
}

export function loadTombstones(): PushTombstone[] {
  return readJsonOr<PushTombstone[]>(join(getDataDir(), PUSH_TOMBSTONES_FILE), []);
}

export function saveTombstones(tombstones: readonly PushTombstone[]): void {
  writeJsonAtomic(join(getDataDir(), PUSH_TOMBSTONES_FILE), tombstones);
}

/** Drop tombstones whose worklogs are gone from Tempo (deleted by our push or remotely). */
export function removeTombstonesByWorklogIds(ids: ReadonlySet<number>): void {
  const rest = loadTombstones().filter(t => !ids.has(t.tempoWorklogId));
  saveTombstones(rest);
}

/**
 * Manual entry deleted locally after being pushed: drop its ownership key and
 * remember the worklog as a tombstone. No-op (false) for entries that never
 * had their own worklog — unpushed or session-born ones.
 */
export function recordEntryDeletion(date: string, task: string, entryId: string): boolean {
  const log = loadPushLog();
  const key = pushLogKey(date, task, entryId);
  const owned = log[key];
  if (!owned) return false;

  delete log[key];
  savePushLog(log);

  const tombstones = loadTombstones();
  tombstones.push({
    date,
    task,
    entryId,
    tempoWorklogId: owned.tempoWorklogId,
    deletedAt: new Date().toISOString(),
  });
  saveTombstones(tombstones);
  return true;
}
