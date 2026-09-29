/**
 * Unit tests for the timesheets v2 month model (sync-state.ts): the three-way
 * view of manual entries (local / base / Tempo), tracked time that never
 * conflicts, identity links, ticket moves recognised by content, day words.
 *
 * Run: npx tsx tests/unit/sync-state.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Pure in-memory — no disk, no Tempo.
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { createEmptyLog } from '../../src/core/daily-log.js';
import { buildMonthModel, versionFields, worklogVersion, lineVersion } from '../../src/push/sync-state.js';
import type { MonthModelInput } from '../../src/push/sync-state.js';
import { ConflictField, ConflictKind, DayStatus, MonthSyncState, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, DailyLog, PushLogEntry, PushTombstone, TaskDayReport, TempoMonthSnapshot, TempoWorklog } from '../../src/core/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const config: AppConfig = {
  repos: [],
  boundaryHour: 0,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: [] },
  genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5],
  holidays: [],
  apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal },
};

const D = '2026-09-22';
const D2 = '2026-09-23';
const ISSUE: Record<string, number> = { 'ATL-1': 1, 'ATL-2': 2, 'ATL-3': 3 };
const issueKeys = { '1': 'ATL-1', '2': 'ATL-2', '3': 'ATL-3' };

function log(date: string, status: DayStatus = DayStatus.Draft): DailyLog {
  const l = createEmptyLog(date, config);
  l.status = status;
  return l;
}

function manual(over: Partial<TaskDayReport> & { entryId: string }): TaskDayReport {
  return { date: D, task: 'ATL-1', totalSeconds: 1800, sessionCount: 0, kind: 'manual', description: 'Daily', activity: 'Meeting', ...over };
}

function session(over: Partial<TaskDayReport> = {}): TaskDayReport {
  return { date: D, task: 'ATL-2', totalSeconds: 3600, sessionCount: 1, kind: 'session', ...over };
}

function wl(id: number, task: string, over: Partial<TempoWorklog> = {}): TempoWorklog {
  return { tempoWorklogId: id, issueId: ISSUE[task], startDate: D, timeSpentSeconds: 1800, description: 'Daily', activity: 'Meeting', ...over };
}

function own(id: number, over: Partial<PushLogEntry> = {}): PushLogEntry {
  return { tempoWorklogId: id, timeSpentSeconds: 1800, pushedAt: 'x', description: 'Daily', activity: 'Meeting', ...over };
}

function snap(...worklogs: TempoWorklog[]): TempoMonthSnapshot {
  return { month: '2026-09', accountId: 'acc', fetchedAt: 'x', worklogs, issueKeys };
}

function input(over: Partial<MonthModelInput>): MonthModelInput {
  return {
    days: [{ date: D, log: log(D) }, { date: D2, log: null }],
    report: [],
    pushLog: {},
    tombstones: [],
    snapshot: snap(),
    ...over,
  };
}

const K1 = `${D}|ATL-1|m:e1`;

console.log('sync-state — versions');

test('fields named in the lab order: ticket, date, time, activity, description', () => {
  const a = { task: 'ATL-1', date: D, seconds: 1800, description: 'a', activity: 'Meeting' };
  const b = { task: 'ATL-2', date: D2, seconds: 3600, description: 'b', activity: 'Other' };
  assert.deepEqual(versionFields(a, b), [ConflictField.Ticket, ConflictField.Date, ConflictField.Time, ConflictField.Activity, ConflictField.Description]);
});

test('time within the tolerance is the same time', () => {
  const a = lineVersion(manual({ entryId: 'e1', totalSeconds: 1800 }));
  const b = worklogVersion(wl(1, 'ATL-1', { timeSpentSeconds: 1830 }), 'ATL-1');
  assert.deepEqual(versionFields(a, b), []);
});

test('placeholder of either ticket reads as an empty description', () => {
  const v = worklogVersion(wl(1, 'ATL-2', { description: 'Working on work item ATL-1' }), 'ATL-2', 'ATL-1');
  assert.equal(v.description, '');
});

console.log('\nsync-state — no snapshot');

test('no snapshot: pushed flag → pushed, draft → unpushed, empty → none', () => {
  const m = buildMonthModel(input({
    snapshot: null,
    days: [{ date: D, log: log(D, DayStatus.Pushed) }, { date: D2, log: log(D2) }, { date: '2026-09-24', log: null }],
    report: [manual({ entryId: 'e1' }), manual({ entryId: 'e2', date: D2 })],
  }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Pushed);
  assert.equal(m.days.get(D2)!.state, MonthSyncState.Unpushed);
  assert.equal(m.days.get('2026-09-24')!.state, MonthSyncState.None);
});

test('no snapshot: today with an open session → tracking', () => {
  const m = buildMonthModel(input({ snapshot: null, report: [session()], trackingDate: D }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Tracking);
});

console.log('\nsync-state — manual entries, three ways');

test('parity → pushed', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], pushLog: { [K1]: own(10) }, snapshot: snap(wl(10, 'ATL-1')) }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Pushed);
  assert.deepEqual(m.days.get(D)!.conflicts, []);
});

test('never pushed → unpushed', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })] }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Unpushed);
});

test('edited here only → unpushed, no conflict', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1', totalSeconds: 3600 })], pushLog: { [K1]: own(10) }, snapshot: snap(wl(10, 'ATL-1')) }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Unpushed);
  assert.deepEqual(m.fastForwards, []);
});

test('edited in Tempo only → fast-forward candidate; reads as a conflict until taken', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], pushLog: { [K1]: own(10) }, snapshot: snap(wl(10, 'ATL-1', { activity: 'Other' })) }));
  assert.equal(m.fastForwards.length, 1);
  assert.equal(m.fastForwards[0].tempo.activity, 'Other');
  const day = m.days.get(D)!;
  assert.equal(day.state, MonthSyncState.Conflict);
  assert.equal(day.conflicts[0].kind, ConflictKind.Edited);
  assert.deepEqual(day.conflicts[0].fields, [ConflictField.Activity]);
});

test('edited on both sides → conflict naming what differs, no fast-forward', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1', description: 'Daily (retro)' })],
    pushLog: { [K1]: own(10) },
    snapshot: snap(wl(10, 'ATL-1', { timeSpentSeconds: 2700, description: 'Daily sync' })),
  }));
  assert.deepEqual(m.fastForwards, []);
  const c = m.days.get(D)!.conflicts[0];
  assert.equal(c.kind, ConflictKind.Edited);
  assert.deepEqual(c.fields, [ConflictField.Time, ConflictField.Description]);
  assert.equal(c.tempo?.seconds, 2700);
});

test('the same change on both sides → no conflict, stale base to refresh', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1', totalSeconds: 3600 })],
    pushLog: { [K1]: own(10) },
    snapshot: snap(wl(10, 'ATL-1', { timeSpentSeconds: 3600 })),
  }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Pushed);
  assert.equal(m.staleBases.length, 1);
  assert.equal(m.staleBases[0].key, K1);
});

test('deleted in Tempo → conflict, Tempo side empty', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], pushLog: { [K1]: own(10) }, snapshot: snap() }));
  const c = m.days.get(D)!.conflicts[0];
  assert.equal(c.kind, ConflictKind.Deleted);
  assert.equal(c.tempo, null);
  assert.deepEqual(c.fields, []);
});

test('moved to another day in Tempo only → fast-forward with the new date', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], pushLog: { [K1]: own(10) }, snapshot: snap(wl(10, 'ATL-1', { startDate: D2 })) }));
  assert.equal(m.fastForwards[0].tempo.date, D2);
  assert.equal(m.days.get(D)!.conflicts[0].kind, ConflictKind.Moved);
});

test('moved in Tempo + time edited here → "Date and time differ"', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1', totalSeconds: 5400 })],
    pushLog: { [K1]: own(10, { timeSpentSeconds: 3600 }) },
    snapshot: snap(wl(10, 'ATL-1', { startDate: D2, timeSpentSeconds: 3600 })),
  }));
  const c = m.days.get(D)!.conflicts[0];
  assert.equal(c.kind, ConflictKind.Moved);
  assert.deepEqual(c.fields, [ConflictField.Date, ConflictField.Time]);
  assert.deepEqual(m.fastForwards, []);
});

test('base carrying a start date (Mine on a move) → our side only, unpushed', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1' })],
    pushLog: { [K1]: own(10, { startDate: D2 }) },
    snapshot: snap(wl(10, 'ATL-1', { startDate: D2 })),
  }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Unpushed);
  assert.deepEqual(m.days.get(D)!.conflicts, []);
});

console.log('\nsync-state — ticket moves (Tempo recreates the worklog)');

test('gone here, same content on another ticket → Ticket differs, paired, not foreign', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1', totalSeconds: 2700 })],
    pushLog: { [K1]: own(10) },
    snapshot: snap(wl(11, 'ATL-3')),
  }));
  assert.equal(m.moves.length, 1);
  assert.equal(m.moves[0].toTask, 'ATL-3');
  const c = m.days.get(D)!.conflicts[0];
  assert.equal(c.kind, ConflictKind.Ticket);
  assert.deepEqual(c.fields, [ConflictField.Ticket, ConflictField.Time]);
  assert.equal(c.tempo?.task, 'ATL-3');
  assert.deepEqual(m.foreign, []);
});

test('two candidates → no guess: deletion, both stay foreign', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1' })],
    pushLog: { [K1]: own(10) },
    snapshot: snap(wl(11, 'ATL-3'), wl(12, 'ATL-2')),
  }));
  assert.deepEqual(m.moves, []);
  assert.equal(m.days.get(D)!.conflicts[0].kind, ConflictKind.Deleted);
  assert.equal(m.foreign.length, 2);
});

test('different content on another ticket → no pair', () => {
  const m = buildMonthModel(input({
    report: [manual({ entryId: 'e1' })],
    pushLog: { [K1]: own(10) },
    snapshot: snap(wl(11, 'ATL-3', { timeSpentSeconds: 900 })),
  }));
  assert.deepEqual(m.moves, []);
  assert.equal(m.foreign.length, 1);
});

console.log('\nsync-state — tracked time is always ours');

test('tracked edited in Tempo → unpushed, never a conflict', () => {
  const m = buildMonthModel(input({ report: [session()], pushLog: { [`${D}|ATL-2`]: own(20, { timeSpentSeconds: 3600 }) }, snapshot: snap(wl(20, 'ATL-2', { timeSpentSeconds: 7200 })) }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Unpushed);
  assert.deepEqual(m.days.get(D)!.conflicts, []);
});

test('tracked deleted or moved in Tempo → unpushed', () => {
  const gone = buildMonthModel(input({ report: [session()], pushLog: { [`${D}|ATL-2`]: own(20, { timeSpentSeconds: 3600 }) }, snapshot: snap() }));
  assert.equal(gone.days.get(D)!.state, MonthSyncState.Unpushed);
  const moved = buildMonthModel(input({ report: [session()], pushLog: { [`${D}|ATL-2`]: own(20, { timeSpentSeconds: 3600 }) }, snapshot: snap(wl(20, 'ATL-2', { timeSpentSeconds: 3600, startDate: D2 })) }));
  assert.equal(moved.days.get(D)!.state, MonthSyncState.Unpushed);
});

test('tracked in parity → pushed', () => {
  const m = buildMonthModel(input({ report: [session()], pushLog: { [`${D}|ATL-2`]: own(20, { timeSpentSeconds: 3600 }) }, snapshot: snap(wl(20, 'ATL-2', { timeSpentSeconds: 3600 })) }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Pushed);
});

console.log('\nsync-state — identity links');

test('never-pushed entry with an exact twin in Tempo → linked, in sync, not foreign', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], snapshot: snap(wl(30, 'ATL-1')) }));
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].key, K1);
  assert.equal(m.days.get(D)!.state, MonthSyncState.Pushed);
  assert.deepEqual(m.foreign, []);
});

test('never-pushed tracked time with a same-length twin → linked', () => {
  const m = buildMonthModel(input({ report: [session()], snapshot: snap(wl(31, 'ATL-2', { timeSpentSeconds: 3600, description: '', activity: 'Development' })) }));
  assert.equal(m.links[0].kind, 'session');
  assert.equal(m.days.get(D)!.state, MonthSyncState.Pushed);
});

test('a manual twin wins over tracked time of the same length', () => {
  const m = buildMonthModel(input({
    report: [session({ task: 'ATL-1', totalSeconds: 1800 }), manual({ entryId: 'e1' })],
    snapshot: snap(wl(32, 'ATL-1')),
  }));
  assert.equal(m.links.length, 1);
  assert.equal(m.links[0].kind, 'manual');
  assert.equal(m.days.get(D)!.state, MonthSyncState.Unpushed); // tracked still to push
});

test('orphan relinks to an exact twin on the same ticket instead of a deletion', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], pushLog: { [K1]: own(10) }, snapshot: snap(wl(33, 'ATL-1')) }));
  assert.equal(m.links.length, 1);
  assert.deepEqual(m.days.get(D)!.conflicts, []);
});

test('other content → no link, the worklog is foreign', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], snapshot: snap(wl(34, 'ATL-1', { description: 'someone else' })) }));
  assert.deepEqual(m.links, []);
  assert.equal(m.foreign.length, 1);
  assert.equal(m.days.get(D)!.state, MonthSyncState.Unpushed);
});

console.log('\nsync-state — deletes, foreign rows, today');

test('stray ownership on a day with data → unpushed; without a log → untouched', () => {
  const withLog = buildMonthModel(input({ pushLog: { [`${D}|ATL-2`]: own(40, { timeSpentSeconds: 3600 }) }, snapshot: snap(wl(40, 'ATL-2', { timeSpentSeconds: 3600 })) }));
  assert.equal(withLog.days.get(D)!.state, MonthSyncState.Unpushed);
  const noLog = buildMonthModel(input({ pushLog: { [`${D2}|ATL-2`]: own(41, { timeSpentSeconds: 3600 }) }, snapshot: snap(wl(41, 'ATL-2', { startDate: D2 })) }));
  assert.equal(noLog.days.get(D2)!.state, MonthSyncState.None);
});

test('alive tombstone → unpushed even when the day file is gone', () => {
  const t: PushTombstone = { date: D2, task: 'ATL-1', entryId: 'x', tempoWorklogId: 50, deletedAt: 'x' };
  const m = buildMonthModel(input({ tombstones: [t], snapshot: snap(wl(50, 'ATL-1', { startDate: D2 })) }));
  assert.equal(m.days.get(D2)!.state, MonthSyncState.Unpushed);
  assert.deepEqual(m.foreign, []);
});

test('a day of foreign worklogs only → pushed (Tempo holds what is shown)', () => {
  const m = buildMonthModel(input({ days: [{ date: D2, log: null }], snapshot: snap(wl(60, 'ATL-3', { startDate: D2 })) }));
  assert.equal(m.days.get(D2)!.state, MonthSyncState.Pushed);
  assert.equal(m.foreign.length, 1);
});

test('today with an open session → tracking; its conflicts still reported', () => {
  const m = buildMonthModel(input({ report: [manual({ entryId: 'e1' })], pushLog: { [K1]: own(10) }, snapshot: snap(), trackingDate: D }));
  assert.equal(m.days.get(D)!.state, MonthSyncState.Tracking);
  assert.equal(m.days.get(D)!.conflicts.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
