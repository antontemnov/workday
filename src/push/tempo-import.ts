// Mirror import: adopt foreign Tempo worklogs (unowned, not tombstoned) as
// local manual entries plus a push-log ownership record whose baseline is
// the current remote state — so an imported entry lands in verified parity
// and becomes a first-class mirror citizen (editable, deletable, pushable).

import { importEntryOnDate } from '../core/day-edit.js';
import type { AppConfig, ManualEntry, Secrets, TempoImportItem, TempoImportResponse, TempoMonthSnapshot, TempoWorklog } from '../core/types.js';
import { loadPushLog, savePushLog, loadTombstones, pushLogKey } from './push-log.js';
import { acquirePushLock } from './push-lock.js';
import { fetchMonthSnapshot } from './tempo-snapshot.js';

export interface ImportEntryInput {
  readonly task: string;
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;
}

export interface ImportOptions {
  readonly config: AppConfig;
  // Working date: future-dated worklogs are refused, today's entries are
  // routed through the live tracker when the caller provides the hook.
  readonly today: string;
  readonly date?: string;                    // only worklogs on this day
  readonly worklogIds?: readonly number[];   // only these worklogs
  readonly addEntryToday?: (input: ImportEntryInput) => ManualEntry;
}

// Strip the Tempo auto-placeholder — locally an empty description IS empty.
function importDescription(wl: TempoWorklog, task: string): string {
  const desc = wl.description ?? '';
  return desc === `Working on work item ${task}` ? '' : desc;
}

/**
 * Adopt foreign worklogs from an already-loaded snapshot. Per-worklog
 * failures (unresolved key, day window, future date) land as item errors —
 * the rest still import. Ownership is persisted after every adopted entry.
 */
export function importFromSnapshot(snapshot: TempoMonthSnapshot, options: ImportOptions): Omit<TempoImportResponse, 'syncedAt'> {
  const { config, today } = options;
  const ownedIds = new Set(Object.values(loadPushLog()).map(e => e.tempoWorklogId));
  const tombstoneIds = new Set(loadTombstones().map(t => t.tempoWorklogId));
  const snapById = new Map(snapshot.worklogs.map(w => [w.tempoWorklogId, w]));

  // Explicit ids get per-id feedback (absent / owned / tombstoned); the
  // no-ids form silently targets whatever is foreign right now.
  const items: TempoImportItem[] = [];
  let targets: TempoWorklog[];
  if (options.worklogIds !== undefined) {
    targets = [];
    for (const id of options.worklogIds) {
      const wl = snapById.get(id);
      if (!wl) {
        items.push({ tempoWorklogId: id, date: '', task: '', seconds: 0, error: 'Not in the Tempo snapshot — re-sync and retry' });
      } else if (ownedIds.has(id)) {
        items.push(itemOf(wl, snapshot, 'Already imported (owned locally)'));
      } else if (tombstoneIds.has(id)) {
        items.push(itemOf(wl, snapshot, 'Pending local delete — push first'));
      } else {
        targets.push(wl);
      }
    }
  } else {
    targets = snapshot.worklogs.filter(w => !ownedIds.has(w.tempoWorklogId) && !tombstoneIds.has(w.tempoWorklogId));
  }
  if (options.date) {
    for (const wl of targets.filter(w => w.startDate !== options.date)) {
      if (options.worklogIds !== undefined) items.push(itemOf(wl, snapshot, `Not on ${options.date}`));
    }
    targets = targets.filter(w => w.startDate === options.date);
  }
  targets.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.tempoWorklogId - b.tempoWorklogId);

  for (const wl of targets) {
    const task = snapshot.issueKeys?.[String(wl.issueId)];
    if (!task) {
      items.push(itemOf(wl, snapshot, 'Ticket key unresolved — check Jira access, re-sync'));
      continue;
    }
    if (wl.startDate > today) {
      items.push(itemOf(wl, snapshot, 'Future-dated in Tempo — import once the day arrives'));
      continue;
    }

    const input: ImportEntryInput = {
      task,
      // Nearest minute stays within TEMPO_TOLERANCE_SECONDS — no drift.
      minutes: Math.max(1, Math.round(wl.timeSpentSeconds / 60)),
      description: importDescription(wl, task),
      activity: wl.activity ?? '',
    };

    let entry: ManualEntry;
    try {
      entry = wl.startDate === today && options.addEntryToday
        ? options.addEntryToday(input)
        : importEntryOnDate(wl.startDate, input, config).entry;
    } catch (err) {
      items.push(itemOf(wl, snapshot, err instanceof Error ? err.message : String(err)));
      continue;
    }

    // Baseline = raw remote fields: the diff sees parity, remoteChanged sees
    // exactly what we adopted. Saved per entry — a mid-batch crash leaves an
    // unowned twin that the next push re-adopts by content match. Fresh
    // read-modify-write per save: a held copy would resurrect keys dropped by
    // a concurrent recordEntryDeletion (entry deletes run outside the lock).
    const freshLog = loadPushLog();
    freshLog[pushLogKey(wl.startDate, task, entry.id)] = {
      tempoWorklogId: wl.tempoWorklogId,
      timeSpentSeconds: wl.timeSpentSeconds,
      pushedAt: new Date().toISOString(),
      ...(wl.description !== undefined ? { description: wl.description } : {}),
      ...(wl.activity !== undefined ? { activity: wl.activity } : {}),
    };
    savePushLog(freshLog);
    items.push({ ...itemOf(wl, snapshot), task, entryId: entry.id });
  }

  items.sort((a, b) => a.date.localeCompare(b.date) || a.tempoWorklogId - b.tempoWorklogId);
  return {
    month: snapshot.month,
    imported: items.filter(i => !i.error).length,
    failed: items.filter(i => i.error).length,
    items,
  };
}

function itemOf(wl: TempoWorklog, snapshot: TempoMonthSnapshot, error?: string): TempoImportItem {
  return {
    tempoWorklogId: wl.tempoWorklogId,
    date: wl.startDate,
    task: snapshot.issueKeys?.[String(wl.issueId)] ?? `issue #${wl.issueId}`,
    seconds: wl.timeSpentSeconds,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Full import pipeline: refetch the month snapshot (adopting from a stale
 * mirror could resurrect a worklog just edited or deleted in Tempo), then
 * adopt. Throws when the fetch itself fails — import is an online operation.
 */
export async function importTempoWorklogs(
  year: number,
  month: number,
  secrets: Secrets,
  options: ImportOptions,
): Promise<TempoImportResponse> {
  // Import rewrites push-log — same cross-process lock as a commit push.
  const releaseLock = acquirePushLock('import');
  try {
    const snapshot = await fetchMonthSnapshot(year, month, secrets);
    return { ...importFromSnapshot(snapshot, options), syncedAt: snapshot.fetchedAt };
  } finally {
    releaseLock();
  }
}
