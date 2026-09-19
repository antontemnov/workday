/**
 * Unit tests for manual added time: one record per ticket per day. Covers
 * the absolute set, bare Development adds landing on the record, edits
 * (minutes only / absorb), the collapse migration and the push fold.
 *
 * Run: npx tsx tests/unit/manual-added.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import {
  createEmptyLog,
  writeDailyLog,
  readDailyLog,
  addManualEntry,
  addImportedEntry,
  editManualEntry,
  deleteManualEntry,
  setAddedMinutes,
  findAddedEntry,
  collapseAddedEntries,
} from '../../src/core/daily-log.js';
import { runStartupJanitor } from '../../src/core/janitor.js';
import { buildReport } from '../../src/push/report-builder.js';
import { DayStatus, SensitivityLevel, type AppConfig, type DailyLog, type ManualEntry } from '../../src/core/types.js';

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
  boundaryHour: 4,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: [] },
  genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 0 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5],
  holidays: [],
  apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
} as unknown as AppConfig;

const makeLog = (date = '2026-06-13'): DailyLog => createEmptyLog(date, config);
const bare = (log: DailyLog, task: string, minutes: number): ManualEntry =>
  addManualEntry(log, { task, minutes, description: '', activity: 'Development' }, config);

function legacy(id: string, task: string, minutes: number, createdAt: string, extra: Partial<ManualEntry> = {}): ManualEntry {
  return { id, task, minutes, description: '', activity: 'Development', createdAt, ...extra };
}

console.log('Manual added — the absolute set');

test('setAddedMinutes creates, overwrites and removes the single record', () => {
  const log = makeLog();
  const created = setAddedMinutes(log, 'ATL-10', 45, config)!;
  assert.equal(created.added, true);
  assert.equal(created.activity, 'Development');
  assert.equal(created.description, '');

  const again = setAddedMinutes(log, 'ATL-10', 20, config)!;
  assert.equal(again.id, created.id, 'same record — a set, not an add');
  assert.equal(log.manualEntries.length, 1);
  assert.equal(log.manualEntries[0].minutes, 20);

  assert.equal(setAddedMinutes(log, 'ATL-10', 0, config), null);
  assert.equal(log.manualEntries.length, 0);
});

test('zero with nothing to remove is a no-op — a sealed day stays sealed', () => {
  const log = makeLog();
  log.status = DayStatus.Pushed;
  assert.equal(setAddedMinutes(log, 'ATL-10', 0, config), null);
  assert.equal(log.status, DayStatus.Pushed);
});

test('a real set unseals the day', () => {
  const log = makeLog();
  log.status = DayStatus.Pushed;
  setAddedMinutes(log, 'ATL-10', 15, config);
  assert.equal(log.status, DayStatus.Draft);
});

test('validation: Jira key, negative, the 8h cap is per ticket', () => {
  const log = makeLog();
  assert.throws(() => setAddedMinutes(log, 'nope', 10, config), /not a valid Jira key/);
  assert.throws(() => setAddedMinutes(log, 'ATL-10', -5, config), /zero or positive/);
  assert.throws(() => setAddedMinutes(log, 'ATL-10', 481, config), /per ticket/);
  setAddedMinutes(log, 'ATL-10', 480, config);
  setAddedMinutes(log, 'ATL-11', 480, config); // another ticket has its own cap
});

test('the day window is checked by delta, shrinking always passes', () => {
  const log = makeLog();
  for (const task of ['ATL-1', 'ATL-2']) setAddedMinutes(log, task, 480, config);
  setAddedMinutes(log, 'ATL-3', 470, config);                      // 1430 of 1440
  assert.throws(() => setAddedMinutes(log, 'ATL-3', 481, config), /per ticket/);
  assert.throws(() => setAddedMinutes(log, 'ATL-4', 11, config), /Exceeds 24h day window/);
  setAddedMinutes(log, 'ATL-4', 10, config);                       // exactly full
  setAddedMinutes(log, 'ATL-3', 100, config);                      // shrink on a full day
});

console.log('');
console.log('Manual added — bare Development adds land on the record');

test('two bare 30m logs are one 60m record', () => {
  const log = makeLog();
  const first = bare(log, 'ATL-10', 30);
  const second = bare(log, 'ATL-10', 30);
  assert.equal(second.id, first.id);
  assert.equal(second.minutes, 60, 'the returned entry carries the new total');
  assert.equal(log.manualEntries.length, 1);
  assert.equal(log.manualEntries[0].added, true);
});

test('tickets never share a record; described Development stays standalone', () => {
  const log = makeLog();
  bare(log, 'ATL-10', 30);
  bare(log, 'ATL-11', 30);
  const named = addManualEntry(log, { task: 'ATL-10', minutes: 20, description: 'pairing', activity: 'Development' }, config);
  assert.equal(named.added, undefined);
  assert.equal(log.manualEntries.length, 3);
  assert.equal(findAddedEntry(log, 'ATL-10')?.minutes, 30);
});

test('bare adds respect the per-ticket cap on the total', () => {
  const log = makeLog();
  bare(log, 'ATL-10', 300);
  assert.throws(() => bare(log, 'ATL-10', 181), /per ticket/);
  assert.equal(findAddedEntry(log, 'ATL-10')?.minutes, 300, 'a rejected add writes nothing');
});

test('a Tempo-imported bare worklog stays its own entry', () => {
  const log = makeLog();
  bare(log, 'ATL-10', 30);
  const imported = addImportedEntry(log, { task: 'ATL-10', minutes: 45, description: '', activity: 'Development' }, config);
  assert.equal(imported.added, undefined);
  assert.equal(log.manualEntries.length, 2);
});

console.log('');
console.log('Manual added — edits');

test('the record takes minutes only', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-10', 30);
  const { entry, absorbed } = editManualEntry(log, record.id, { minutes: 50 }, config);
  assert.equal(entry.minutes, 50);
  assert.equal(absorbed, null);
  // a form echoing the fixed fields back is fine
  editManualEntry(log, record.id, { minutes: 40, description: '', activity: 'Development' }, config);
  assert.throws(() => editManualEntry(log, record.id, { description: 'now named' }, config), /minutes only/);
  assert.throws(() => editManualEntry(log, record.id, { activity: 'CodeReview', description: 'x' }, config), /minutes only/);
  assert.equal(findAddedEntry(log, 'ATL-10')?.minutes, 40, 'rejected edits write nothing');
});

test('a standalone entry edited down to bare Development is absorbed', () => {
  const log = makeLog();
  bare(log, 'ATL-10', 30);
  const named = addManualEntry(log, { task: 'ATL-10', minutes: 20, description: 'pairing', activity: 'Testing' }, config);

  const { entry, absorbed } = editManualEntry(log, named.id, { minutes: 25, description: '', activity: 'Development' }, config);
  assert.equal(absorbed?.id, named.id, 'the caller tombstones its worklog by this id');
  assert.equal(entry.added, true);
  assert.equal(entry.minutes, 55);
  assert.equal(log.manualEntries.length, 1);
});

test('absorb with no record yet creates one; sourceRef entries are never absorbed', () => {
  const log = makeLog();
  const named = addManualEntry(log, { task: 'ATL-10', minutes: 20, description: 'pairing', activity: 'Development' }, config);
  const { entry, absorbed } = editManualEntry(log, named.id, { description: '' }, config);
  assert.equal(absorbed?.id, named.id);
  assert.equal(entry.added, true);
  assert.notEqual(entry.id, named.id, 'the retired id never comes back');

  const accepted = addManualEntry(log, { task: 'ATL-10', minutes: 15, description: 'sync', activity: 'Development', sourceRef: 'meeting:u:2026-06-13' }, config);
  const kept = editManualEntry(log, accepted.id, { description: '' }, config);
  assert.equal(kept.absorbed, null);
  assert.equal(kept.entry.sourceRef, 'meeting:u:2026-06-13');
});

test('a failed edit leaves the entry untouched (validate before write)', () => {
  const log = makeLog();
  const named = addManualEntry(log, { task: 'ATL-10', minutes: 20, description: 'standup', activity: 'Meeting' }, config);
  assert.throws(() => editManualEntry(log, named.id, { minutes: 45, description: '' }, config), /Description is required/);
  assert.equal(named.minutes, 20);
});

console.log('');
console.log('Manual added — collapse migration');

test('legacy session-born entries collapse to one record, earliest identity kept', () => {
  const log = makeLog();
  log.manualEntries.push(
    legacy('bbb', 'ATL-10', 30, '2026-06-13T12:00:00.000Z', { sourceSessionId: 's2' }),
    legacy('named', 'ATL-10', 15, '2026-06-13T12:30:00.000Z', { description: 'standup', activity: 'Meeting' }),
    legacy('aaa', 'ATL-10', 20, '2026-06-13T09:00:00.000Z', { sourceSessionId: 's1' }),
    legacy('ccc', 'ATL-11', 10, '2026-06-13T10:00:00.000Z', { sourceSessionId: 's3' }),
  );
  assert.equal(collapseAddedEntries(log), 3);
  assert.deepEqual(log.manualEntries.map(e => e.id), ['aaa', 'named', 'ccc']);
  const record = log.manualEntries[0];
  assert.equal(record.minutes, 50);
  assert.equal(record.createdAt, '2026-06-13T09:00:00.000Z');
  assert.equal(record.added, true);
  assert.equal(record.sourceSessionId, undefined);

  assert.equal(collapseAddedEntries(log), 0, 'idempotent');
});

test('bare standalones join only with an ownership check — and only unowned ones', () => {
  const entries = (): ManualEntry[] => [
    legacy('free', 'ATL-10', 30, '2026-06-13T09:00:00.000Z'),
    legacy('owned', 'ATL-10', 30, '2026-06-13T10:00:00.000Z'),
    legacy('ref', 'ATL-10', 30, '2026-06-13T11:00:00.000Z', { sourceRef: 'review:2026-06-13:ATL-10' }),
    legacy('born', 'ATL-10', 15, '2026-06-13T12:00:00.000Z', { sourceSessionId: 's1' }),
  ];

  const blind = makeLog();
  blind.manualEntries.push(...entries());
  collapseAddedEntries(blind); // write paths: no push-log at hand
  assert.deepEqual(blind.manualEntries.map(e => [e.id, e.minutes]), [['free', 30], ['owned', 30], ['ref', 30], ['born', 15]]);

  const log = makeLog();
  log.manualEntries.push(...entries());
  collapseAddedEntries(log, e => e.id === 'owned');
  assert.deepEqual(log.manualEntries.map(e => [e.id, e.minutes]), [['free', 45], ['owned', 30], ['ref', 30]]);
  assert.equal(log.manualEntries[0].added, true);
});

test('a pushed day keeps its bare standalones — Tempo history is not rewritten', () => {
  const log = makeLog();
  log.status = DayStatus.Pushed;
  log.pushedAt = '2026-06-14T10:00:00.000Z';
  log.manualEntries.push(
    legacy('bare1', 'ATL-10', 30, '2026-06-13T09:00:00.000Z'),
    legacy('born1', 'ATL-10', 20, '2026-06-13T10:00:00.000Z', { sourceSessionId: 's1' }),
    legacy('born2', 'ATL-10', 10, '2026-06-13T11:00:00.000Z', { sourceSessionId: 's2' }),
  );
  collapseAddedEntries(log, () => false);
  assert.deepEqual(log.manualEntries.map(e => [e.id, e.minutes]), [['bare1', 30], ['born1', 30]]);
  assert.equal(log.status, DayStatus.Pushed);
});

test('janitor pass: past days collapse on disk, per-task push totals unchanged', () => {
  const date = '2026-06-10';
  const log = makeLog(date);
  log.manualEntries.push(
    legacy('e1', 'ATL-10', 30, '2026-06-10T09:00:00.000Z'),
    legacy('e2', 'ATL-10', 30, '2026-06-10T10:00:00.000Z'),
    legacy('e3', 'ATL-10', 20, '2026-06-10T11:00:00.000Z', { sourceSessionId: 's1' }),
  );
  writeDailyLog(log);

  const result = runStartupJanitor('2026-06-13', () => false);
  assert.equal(result.collapsedEntries, 3);
  const disk = readDailyLog(date)!;
  assert.equal(disk.manualEntries.length, 1);
  assert.equal(disk.manualEntries[0].minutes, 80);
  assert.equal(runStartupJanitor('2026-06-13', () => false).collapsedEntries, 0, 'idempotent');

  const report = buildReport(date, date, config);
  assert.deepEqual(report.map(r => [r.task, r.kind, r.totalSeconds]), [['ATL-10', 'session', 75 * 60]],
    'one worklog, 80m through the 15m rounding rule');
});

test('deleting the record by id works like any entry', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-10', 30);
  assert.equal(deleteManualEntry(log, record.id).id, record.id);
  assert.equal(findAddedEntry(log, 'ATL-10'), undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
