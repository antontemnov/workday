// Timesheets v2 — the month against Tempo, three ways: the local version,
// the base (what the last sync left in push-log) and Tempo now. Pure: the
// reader (month-report) derives day words and conflicts from it, the writer
// (tempo-sync) persists what it finds. Tracked time (the session aggregate)
// is always ours — it never conflicts, a change in Tempo just leaves the day
// unpushed. A ticket change in Tempo recreates the worklog under a new id, so
// a move is recognised by content, never by id.

import { TEMPO_TOLERANCE_SECONDS } from '../core/constants.js';
import { ConflictField, ConflictKind, DayStatus, MonthSyncState } from '../core/types.js';
import type {
  DailyLog, EntryConflict, PushLogEntry, PushTombstone, TaskDayReport,
  TempoMonthSnapshot, TempoWorklog, WorklogVersion,
} from '../core/types.js';
import { pushLogKey } from './push-log.js';
import { normalizeDescription } from './reconcile.js';

export interface MonthDayInput {
  readonly date: string;
  readonly log: DailyLog | null;
}

export interface MonthModelInput {
  readonly days: readonly MonthDayInput[];
  readonly report: readonly TaskDayReport[];
  readonly pushLog: Readonly<Record<string, PushLogEntry>>;
  readonly tombstones: readonly PushTombstone[];
  readonly snapshot: TempoMonthSnapshot | null;
  // Today, while a session is open — the day is not pushed while it runs.
  readonly trackingDate?: string | null;
}

// A line of ours without a live worklog, and a worklog nobody owns with the
// same content on the same ticket and day: our push whose ownership got
// lost, or the same thing logged in Tempo by hand. It IS the line.
export interface IdentityLink {
  readonly key: string;
  readonly kind: TaskDayReport['kind'];
  readonly date: string;
  readonly task: string;
  readonly entryId?: string;
  readonly worklog: TempoWorklog;
}

// An owned manual worklog gone from Tempo, and a new one on another ticket
// carrying the last synced content: the entry was moved to that ticket.
export interface TicketMove {
  readonly key: string;
  readonly date: string;
  readonly entryId: string;
  readonly task: string;
  readonly toTask: string;
  readonly worklog: TempoWorklog;
}

// Changed only in Tempo: the entry takes Tempo's version.
export interface FastForward {
  readonly key: string;
  readonly date: string;
  readonly entryId: string;
  readonly task: string;
  readonly tempo: WorklogVersion;
  readonly worklog: TempoWorklog;
}

export interface DaySync {
  readonly state: MonthSyncState;
  readonly conflicts: readonly EntryConflict[];
}

export interface MonthModel {
  readonly days: ReadonlyMap<string, DaySync>;
  readonly links: readonly IdentityLink[];
  readonly moves: readonly TicketMove[];
  readonly fastForwards: readonly FastForward[];
  // Both sides made the same change — only the base lags behind.
  readonly staleBases: readonly IdentityLink[];
  // Worklogs nobody owns and no line claims: adoption candidates.
  readonly foreign: readonly TempoWorklog[];
}

function lineKey(line: TaskDayReport): string {
  return pushLogKey(line.date, line.task, line.kind === 'manual' ? line.entryId : undefined);
}

export function lineVersion(line: TaskDayReport): WorklogVersion {
  return {
    task: line.task,
    date: line.date,
    seconds: line.totalSeconds,
    description: normalizeDescription(line.description, line.task),
    activity: line.activity ?? '',
  };
}

export function baseVersion(own: PushLogEntry, date: string, task: string): WorklogVersion {
  return {
    task,
    date: own.startDate ?? date,
    seconds: own.timeSpentSeconds,
    description: normalizeDescription(own.description, task),
    activity: own.activity ?? '',
  };
}

// The Tempo placeholder of an empty description may name either ticket once
// a worklog moved between them — both read as empty.
export function worklogVersion(wl: TempoWorklog, task: string, alsoTask?: string): WorklogVersion {
  let description = normalizeDescription(wl.description, task);
  if (alsoTask) description = normalizeDescription(description, alsoTask);
  return { task, date: wl.startDate, seconds: wl.timeSpentSeconds, description, activity: wl.activity ?? '' };
}

/** Fields two versions differ in, in the order a conflict names them. */
export function versionFields(a: WorklogVersion, b: WorklogVersion): ConflictField[] {
  const fields: ConflictField[] = [];
  if (a.task !== b.task) fields.push(ConflictField.Ticket);
  if (a.date !== b.date) fields.push(ConflictField.Date);
  if (Math.abs(a.seconds - b.seconds) > TEMPO_TOLERANCE_SECONDS) fields.push(ConflictField.Time);
  if (a.activity !== b.activity) fields.push(ConflictField.Activity);
  if (a.description !== b.description) fields.push(ConflictField.Description);
  return fields;
}

export function sameVersion(a: WorklogVersion, b: WorklogVersion): boolean {
  return versionFields(a, b).length === 0;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

// Without a snapshot the word falls back to the day's own pushed flag.
function flagState(date: string, log: DailyLog | null, lineCount: number, trackingDate?: string | null): MonthSyncState {
  if (date === trackingDate) return MonthSyncState.Tracking;
  if (!log || lineCount === 0) return MonthSyncState.None;
  return log.status === DayStatus.Pushed ? MonthSyncState.Pushed : MonthSyncState.Unpushed;
}

export function buildMonthModel(input: MonthModelInput): MonthModel {
  const { snapshot, pushLog, tombstones, trackingDate } = input;
  const days = new Map<string, DaySync>();
  const linesByDate = groupBy(input.report, l => l.date);

  if (!snapshot) {
    for (const d of input.days) {
      const lines = linesByDate.get(d.date) ?? [];
      days.set(d.date, { state: flagState(d.date, d.log, lines.length, trackingDate), conflicts: [] });
    }
    return { days, links: [], moves: [], fastForwards: [], staleBases: [], foreign: [] };
  }

  const byId = new Map(snapshot.worklogs.map(w => [w.tempoWorklogId, w]));
  const keyOf = (wl: TempoWorklog): string | undefined => snapshot.issueKeys?.[String(wl.issueId)];
  const ownedIds = new Set(Object.values(pushLog).map(e => e.tempoWorklogId));
  const tombstoneIds = new Set(tombstones.map(t => t.tempoWorklogId));
  const pool = snapshot.worklogs
    .filter(w => !ownedIds.has(w.tempoWorklogId) && !tombstoneIds.has(w.tempoWorklogId))
    .sort((a, b) => a.tempoWorklogId - b.tempoWorklogId);
  const taken = new Set<number>();

  // Manual lines first: an exact twin must not go to a session aggregate
  // that matches it by time alone.
  const ordered = [...input.report].sort((a, b) => a.date.localeCompare(b.date)
    || (a.kind === b.kind ? 0 : a.kind === 'manual' ? -1 : 1)
    || (a.entryId ?? a.task).localeCompare(b.entryId ?? b.task));

  const hasLiveWorklog = (line: TaskDayReport): boolean => {
    const own = pushLog[lineKey(line)];
    return !!own && byId.has(own.tempoWorklogId);
  };

  const links: IdentityLink[] = [];
  const linkByKey = new Map<string, IdentityLink>();
  for (const line of ordered) {
    if (hasLiveWorklog(line)) continue;
    const version = lineVersion(line);
    const twin = pool.find(w => !taken.has(w.tempoWorklogId)
      && w.startDate === line.date
      && keyOf(w) === line.task
      && (line.kind === 'session'
        ? Math.abs(w.timeSpentSeconds - line.totalSeconds) <= TEMPO_TOLERANCE_SECONDS
        : sameVersion(version, worklogVersion(w, line.task))));
    if (!twin) continue;
    taken.add(twin.tempoWorklogId);
    const link: IdentityLink = {
      key: lineKey(line), kind: line.kind, date: line.date, task: line.task,
      ...(line.entryId !== undefined ? { entryId: line.entryId } : {}),
      worklog: twin,
    };
    links.push(link);
    linkByKey.set(link.key, link);
  }

  // Ticket moves: the owned worklog is gone, exactly one new worklog on
  // another ticket carries the base content — anything else stays a deletion.
  const moves: TicketMove[] = [];
  const moveByKey = new Map<string, TicketMove>();
  for (const line of ordered) {
    if (line.kind !== 'manual' || line.entryId === undefined) continue;
    const key = lineKey(line);
    const own = pushLog[key];
    if (!own || byId.has(own.tempoWorklogId) || linkByKey.has(key)) continue;
    const base = baseVersion(own, line.date, line.task);
    const candidates = pool.filter(w => {
      const toTask = keyOf(w);
      if (taken.has(w.tempoWorklogId) || !toTask || toTask === line.task) return false;
      return versionFields(worklogVersion(w, toTask, line.task), base).every(f => f === ConflictField.Ticket);
    });
    if (candidates.length !== 1) continue;
    const worklog = candidates[0];
    taken.add(worklog.tempoWorklogId);
    const move: TicketMove = { key, date: line.date, entryId: line.entryId, task: line.task, toTask: keyOf(worklog)!, worklog };
    moves.push(move);
    moveByKey.set(key, move);
  }

  const fastForwards: FastForward[] = [];
  const staleBases: IdentityLink[] = [];
  const claimed = new Set<number>(taken);
  const conflictsByDate = new Map<string, EntryConflict[]>();
  const outgoingDates = new Set<string>();

  for (const line of ordered) {
    const key = lineKey(line);
    if (linkByKey.has(key)) continue;
    const own = pushLog[key];
    const wl = own ? byId.get(own.tempoWorklogId) : undefined;

    if (line.kind === 'session') {
      if (!wl) { outgoingDates.add(line.date); continue; }
      claimed.add(wl.tempoWorklogId);
      const onTask = keyOf(wl);
      if (wl.startDate !== line.date
        || Math.abs(wl.timeSpentSeconds - line.totalSeconds) > TEMPO_TOLERANCE_SECONDS
        || (onTask !== undefined && onTask !== line.task)) {
        outgoingDates.add(line.date);
      }
      continue;
    }

    if (!own || line.entryId === undefined) { outgoingDates.add(line.date); continue; }
    const conflicts = conflictsByDate.get(line.date) ?? [];
    conflictsByDate.set(line.date, conflicts);
    const local = lineVersion(line);

    if (!wl) {
      const move = moveByKey.get(key);
      if (move) {
        const tempo = worklogVersion(move.worklog, move.toTask, line.task);
        conflicts.push({ entryId: line.entryId, task: line.task, kind: ConflictKind.Ticket, fields: versionFields(local, tempo), tempo });
      } else {
        conflicts.push({ entryId: line.entryId, task: line.task, kind: ConflictKind.Deleted, fields: [], tempo: null });
      }
      continue;
    }

    claimed.add(wl.tempoWorklogId);
    const base = baseVersion(own, line.date, line.task);
    const tempo = worklogVersion(wl, keyOf(wl) ?? line.task, line.task);
    const localChanged = !sameVersion(local, base);
    if (sameVersion(tempo, base)) {
      if (localChanged) outgoingDates.add(line.date);
      continue;
    }
    if (sameVersion(local, tempo)) {
      staleBases.push({ key, kind: 'manual', date: line.date, task: line.task, entryId: line.entryId, worklog: wl });
      continue;
    }
    if (!localChanged && tempo.task === base.task) {
      fastForwards.push({ key, date: line.date, entryId: line.entryId, task: line.task, tempo, worklog: wl });
    }
    // Until a sync takes it (or when none may — a closed month), a change
    // made in Tempo without us reads as a conflict.
    const kind = tempo.task !== local.task ? ConflictKind.Ticket
      : tempo.date !== local.date ? ConflictKind.Moved : ConflictKind.Edited;
    conflicts.push({ entryId: line.entryId, task: line.task, kind, fields: versionFields(local, tempo), tempo });
  }

  // Strays: ownership whose line is gone while the worklog lives — the push
  // deletes it, but only where the day still has data (loss never cascades).
  const lineKeys = new Set(input.report.map(lineKey));
  const logByDate = new Map(input.days.map(d => [d.date, d.log]));
  for (const [key, own] of Object.entries(pushLog)) {
    const date = key.slice(0, 10);
    if (!logByDate.has(date) || lineKeys.has(key)) continue;
    const wl = byId.get(own.tempoWorklogId);
    if (!wl || claimed.has(wl.tempoWorklogId)) continue;
    claimed.add(wl.tempoWorklogId);
    if (logByDate.get(date)) outgoingDates.add(date);
  }
  for (const t of tombstones) {
    if (logByDate.has(t.date) && byId.has(t.tempoWorklogId)) outgoingDates.add(t.date);
  }

  const foreign = pool.filter(w => !taken.has(w.tempoWorklogId));
  const foreignDates = new Set(foreign.map(w => w.startDate));

  for (const d of input.days) {
    const conflicts = conflictsByDate.get(d.date) ?? [];
    const hasRows = (linesByDate.get(d.date)?.length ?? 0) > 0 || foreignDates.has(d.date);
    let state: MonthSyncState;
    if (d.date === trackingDate) state = MonthSyncState.Tracking;
    else if (conflicts.length > 0) state = MonthSyncState.Conflict;
    else if (outgoingDates.has(d.date)) state = MonthSyncState.Unpushed;
    else if (hasRows) state = MonthSyncState.Pushed;
    else state = MonthSyncState.None;
    days.set(d.date, { state, conflicts });
  }

  return { days, links, moves, fastForwards, staleBases, foreign };
}
