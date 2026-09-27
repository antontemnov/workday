// One conflict, one side (timesheets v2). Mine — the base takes Tempo's
// current version, so the next push overwrites Tempo with ours: a deleted
// worklog is recreated, a copy Tempo moved to another ticket is deleted and
// the entry recreated on ours. Tempo — the entry takes Tempo's version:
// values, day, ticket; a deletion deletes it here too. Acts on the snapshot
// the user saw — no Tempo read. A month that is not OPEN is refused.

import { readDailyLog, writeDailyLog } from '../core/daily-log.js';
import { ConflictKind, DayStatus, ResolveSide } from '../core/types.js';
import type { AppConfig, PushLogEntry, Secrets, TempoResolveResponse } from '../core/types.js';
import { loadPushLog, loadTombstones, pushLogKey, saveTombstones } from './push-log.js';
import { acquirePushLock } from './push-lock.js';
import { closedMonthMessage, closedMonthStatus } from './tempo-approvals.js';
import { loadMonthSnapshot } from './tempo-snapshot.js';
import { baseOf, commitOwnership, entryValuesOf, mirrorWriter, readMonthModel, type LiveToday } from './tempo-sync.js';

export interface ResolveOptions {
  readonly config: AppConfig;
  readonly today: string;
  readonly live?: LiveToday | null;
}

// Our side wins on the next push: the day has something to send again.
function unseal(date: string, today: string): void {
  if (date === today) return;
  const log = readDailyLog(date);
  if (!log || log.status === DayStatus.Draft) return;
  log.status = DayStatus.Draft;
  writeDailyLog(log);
}

/** Resolve on the cached snapshot. Throws when there is no such conflict. */
export function resolveOnSnapshot(date: string, entryId: string, side: ResolveSide, options: ResolveOptions): TempoResolveResponse {
  const { config, today } = options;
  const live = options.live ?? null;
  const [year, month] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))];
  const snapshot = loadMonthSnapshot(year, month);
  if (!snapshot) throw new Error(`No Tempo snapshot for ${date.slice(0, 7)} — fetch first`);

  const model = readMonthModel(snapshot, config);
  const conflict = model.days.get(date)?.conflicts.find(c => c.entryId === entryId);
  if (!conflict) throw new Error(`No conflict on ${date} for entry ${entryId}`);

  const mirror = mirrorWriter(config, today, live);
  if (date === today && !live) throw new Error(`${date} is today — the running daemon resolves it`);

  const key = pushLogKey(date, conflict.task, entryId);
  const own = loadPushLog()[key];
  const worklog = own ? snapshot.worklogs.find(w => w.tempoWorklogId === own.tempoWorklogId) : undefined;
  const move = model.moves.find(m => m.key === key);
  const stay = { date, entryId, side, kind: conflict.kind, dateAfter: date, taskAfter: conflict.task, entryIdAfter: entryId };

  if (side === ResolveSide.Mine) {
    if (conflict.kind === ConflictKind.Deleted) {
      commitOwnership(new Map([[key, null]]));
    } else if (move) {
      // The copy on the other ticket goes; ours is created anew.
      saveTombstones([...loadTombstones(), {
        date: move.worklog.startDate, task: move.toTask, entryId,
        tempoWorklogId: move.worklog.tempoWorklogId, deletedAt: new Date().toISOString(),
      }]);
      commitOwnership(new Map([[key, null]]));
    } else if (worklog) {
      const base: PushLogEntry = worklog.startDate !== date
        ? { ...baseOf(worklog), startDate: worklog.startDate }
        : baseOf(worklog);
      commitOwnership(new Map([[key, base]]));
    }
    unseal(date, today);
    return stay;
  }

  if (conflict.kind === ConflictKind.Deleted) {
    commitOwnership(new Map([[key, null]]));
    mirror.remove(date, entryId);
    return { ...stay, entryIdAfter: null };
  }

  const tempo = conflict.tempo!;
  const source = move?.worklog ?? worklog;
  if (!source) throw new Error(`Tempo's version of ${entryId} is gone — fetch again`);
  const values = entryValuesOf(tempo);
  if (tempo.date === date && tempo.task === conflict.task) {
    mirror.overwrite(date, entryId, values);
    commitOwnership(new Map([[key, baseOf(source)]]));
    return stay;
  }
  // Tempo's day may be ahead: the choice is explicit, the entry follows it.
  if (tempo.date === today && !live) throw new Error(`${tempo.date} is today — the running daemon resolves it`);
  const entry = mirror.relocate({ date, entryId, key }, { date: tempo.date, task: tempo.task }, values, source);
  return { ...stay, dateAfter: tempo.date, taskAfter: tempo.task, entryIdAfter: entry.id };
}

/**
 * Resolve one manual-entry conflict under the push lock (push-log changes).
 * Without secrets the month cannot be checked and counts as open.
 */
export async function resolveConflict(
  date: string,
  entryId: string,
  side: ResolveSide,
  secrets: Secrets | null,
  options: ResolveOptions,
): Promise<TempoResolveResponse> {
  const closedStatus = secrets ? await closedMonthStatus(Number(date.slice(0, 4)), Number(date.slice(5, 7)), secrets) : null;
  if (closedStatus) throw new Error(closedMonthMessage(date.slice(0, 7), closedStatus));
  const releaseLock = acquirePushLock('resolve');
  try {
    return resolveOnSnapshot(date, entryId, side, options);
  } finally {
    releaseLock();
  }
}
