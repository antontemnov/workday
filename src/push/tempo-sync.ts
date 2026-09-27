// Every read of Tempo is a sync (timesheets v2). The fresh snapshot is
// written back into the local mirror: lost ownership is restored (identity
// twins), bases lagging behind the same change on both sides are refreshed,
// changes made only in Tempo are taken (fast-forward), and worklogs created
// there without us are adopted as manual entries. A month that is not OPEN
// in Tempo is left alone entirely — nothing read, nothing written. Today's
// log lives in the tracker: its writes go through the live hooks, and
// without them today is skipped (another process may hold it).

import { JIRA_KEY_PATTERN } from '../core/constants.js';
import { overwriteEntryFromTempo, readDailyLog, writeDailyLog } from '../core/daily-log.js';
import { deleteEntryOnDate, importEntryOnDate } from '../core/day-edit.js';
import type {
  AdoptedEntry, AppConfig, DailyLog, ManualEntry, PushLogEntry, Secrets,
  TempoMonthSnapshot, TempoSyncResponse, TempoWorklog,
} from '../core/types.js';
import { buildReport } from './report-builder.js';
import { getMonthRange } from './month-report.js';
import { loadPushLog, loadTombstones, pushLogKey, savePushLog } from './push-log.js';
import { acquirePushLock } from './push-lock.js';
import { buildMonthModel, type MonthModel } from './sync-state.js';
import { fetchMonthSnapshot, loadMonthSnapshot } from './tempo-snapshot.js';
import { importFromSnapshot, type ImportEntryInput } from './tempo-import.js';
import { isMonthClosed } from './tempo-approvals.js';

export interface TempoEntryValues {
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;
}

// Today's log, owned by the live tracker. Each hook persists its write.
export interface LiveToday {
  readonly addEntry: (input: ImportEntryInput) => ManualEntry;
  readonly overwriteEntry: (id: string, values: TempoEntryValues) => void;
  readonly deleteEntry: (id: string) => void;
}

export interface MonthSyncOptions {
  readonly config: AppConfig;
  readonly today: string;
  readonly live?: LiveToday | null;
}

export type MonthSyncResult = Pick<TempoSyncResponse, 'adopted' | 'fastForwarded' | 'linked' | 'conflicts'>;

function monthKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function readMonthModel(snapshot: TempoMonthSnapshot, config: AppConfig): MonthModel {
  const [year, month] = snapshot.month.split('-').map(Number);
  const { from, to } = getMonthRange(year, month);
  const days: { date: string; log: DailyLog | null }[] = [];
  const last = Number(to.slice(8));
  for (let day = 1; day <= last; day++) {
    const date = `${from.slice(0, 8)}${String(day).padStart(2, '0')}`;
    days.push({ date, log: readDailyLog(date) });
  }
  return buildMonthModel({
    days, report: buildReport(from, to, config),
    pushLog: loadPushLog(), tombstones: loadTombstones(), snapshot,
  });
}

// The base after a sync is the raw remote state — the same baseline an
// import writes, so the three-way sees parity.
function baseOf(wl: TempoWorklog): PushLogEntry {
  return {
    tempoWorklogId: wl.tempoWorklogId,
    timeSpentSeconds: wl.timeSpentSeconds,
    pushedAt: new Date().toISOString(),
    ...(wl.description !== undefined ? { description: wl.description } : {}),
    ...(wl.activity !== undefined ? { activity: wl.activity } : {}),
  };
}

// Fresh read-modify-write: a held copy would resurrect keys dropped by a
// concurrent entry delete (those run outside the push lock).
function commitOwnership(changes: ReadonlyMap<string, PushLogEntry | null>): void {
  if (changes.size === 0) return;
  const log = loadPushLog();
  for (const [key, entry] of changes) {
    if (entry === null) delete log[key];
    else log[key] = entry;
  }
  savePushLog(log);
}

/**
 * Write a fetched snapshot back into the mirror. Per-item failures (day
 * window, a vanished entry) leave that item as it was — the next read
 * retries; a change it could not take stays visible as a conflict.
 */
export function applyMonthSync(snapshot: TempoMonthSnapshot, options: MonthSyncOptions): MonthSyncResult {
  const { config, today } = options;
  const live = options.live ?? null;
  const writable = (date: string): boolean => date < today || (date === today && live !== null);

  const model = readMonthModel(snapshot, config);

  const identity = new Map<string, PushLogEntry | null>();
  for (const link of [...model.links, ...model.staleBases]) identity.set(link.key, baseOf(link.worklog));
  commitOwnership(identity);

  const overwrite = (date: string, id: string, values: TempoEntryValues): void => {
    if (date === today && live) { live.overwriteEntry(id, values); return; }
    const log = readDailyLog(date);
    if (!log) throw new Error(`No data for ${date}`);
    overwriteEntryFromTempo(log, id, values);
    writeDailyLog(log);
  };
  const add = (date: string, input: ImportEntryInput): ManualEntry => {
    // A move interrupted after its add left the entry already there.
    const log = date === today && live ? null : readDailyLog(date);
    const owned = new Set(Object.keys(loadPushLog()));
    const again = (log?.manualEntries ?? []).find(e => e.task === input.task && e.minutes === input.minutes
      && e.description === input.description && e.activity === input.activity
      && !owned.has(pushLogKey(date, e.task, e.id)));
    if (again) return again;
    return date === today && live ? live.addEntry(input) : importEntryOnDate(date, input, config).entry;
  };
  const remove = (date: string, id: string): void => {
    if (date === today && live) live.deleteEntry(id);
    else deleteEntryOnDate(date, id);
  };

  let fastForwarded = 0;
  for (const ff of model.fastForwards) {
    const target = ff.tempo.date;
    // A move into the future stays a conflict: the entry would leave sight.
    if (target > today || !writable(ff.date) || !writable(target)) continue;
    const values: TempoEntryValues = {
      minutes: Math.max(1, Math.round(ff.tempo.seconds / 60)),
      description: ff.tempo.description,
      activity: ff.tempo.activity,
    };
    try {
      if (target === ff.date) {
        overwrite(ff.date, ff.entryId, values);
        commitOwnership(new Map([[ff.key, baseOf(ff.worklog)]]));
      } else {
        // Add, move the ownership, then remove — never a window where the
        // worklog is owned by a key whose line is gone (the push would
        // delete it in Tempo).
        const entry = add(target, { task: ff.task, ...values });
        commitOwnership(new Map<string, PushLogEntry | null>([
          [pushLogKey(target, ff.task, entry.id), baseOf(ff.worklog)],
          [ff.key, null],
        ]));
        remove(ff.date, ff.entryId);
      }
      fastForwarded++;
    } catch { /* stays a conflict; the next read retries */ }
  }

  const adoptable = model.foreign.filter(w => {
    const task = snapshot.issueKeys?.[String(w.issueId)];
    // Keyless (no Jira access) stays a read-only row; the future arrives
    // with its day.
    return !!task && JIRA_KEY_PATTERN.test(task) && w.startDate <= today && writable(w.startDate);
  });
  const adopted: AdoptedEntry[] = [];
  if (adoptable.length > 0) {
    const imported = importFromSnapshot(snapshot, {
      config,
      today,
      worklogIds: adoptable.map(w => w.tempoWorklogId),
      ...(live ? { addEntryToday: (input: ImportEntryInput) => live.addEntry(input) } : {}),
    });
    for (const item of imported.items) {
      if (item.error || !item.entryId) continue;
      adopted.push({ date: item.date, task: item.task, entryId: item.entryId, tempoWorklogId: item.tempoWorklogId });
    }
  }

  const after = readMonthModel(snapshot, config);
  const conflicts = [...after.days.values()].reduce((sum, d) => sum + d.conflicts.length, 0);
  return { adopted, fastForwarded, linked: model.links.length, conflicts };
}

/**
 * Read a month from Tempo and sync the mirror with it, under the push lock
 * (the sync rewrites push-log). A month that is not OPEN is skipped before
 * any worklog is read.
 */
export async function syncTempoMonth(
  year: number,
  month: number,
  secrets: Secrets,
  options: MonthSyncOptions,
): Promise<TempoSyncResponse> {
  if (await isMonthClosed(year, month, secrets)) {
    const cached = loadMonthSnapshot(year, month);
    const conflicts = cached
      ? [...readMonthModel(cached, options.config).days.values()].reduce((sum, d) => sum + d.conflicts.length, 0)
      : 0;
    return {
      month: monthKeyOf(year, month),
      syncedAt: cached?.fetchedAt ?? '',
      worklogCount: cached?.worklogs.length ?? 0,
      adopted: [], fastForwarded: 0, linked: 0, conflicts,
      skipped: 'closed',
    };
  }

  const releaseLock = acquirePushLock('sync');
  try {
    const snapshot = await fetchMonthSnapshot(year, month, secrets);
    return {
      month: snapshot.month,
      syncedAt: snapshot.fetchedAt,
      worklogCount: snapshot.worklogs.length,
      ...applyMonthSync(snapshot, options),
    };
  } finally {
    releaseLock();
  }
}
