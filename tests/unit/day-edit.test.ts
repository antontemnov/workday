/**
 * Unit tests for past-day manual-entry mutations (day-edit): disk round-trip,
 * unseal to draft, storage invariant on delete.
 *
 * Run: npx tsx tests/unit/day-edit.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  createEmptyLog,
  writeDailyLog,
  readDailyLog,
  getDailyLogPath,
} from '../../src/core/daily-log.js';
import {
  addEntryOnDate,
  addSessionEntryOnDate,
  editEntryOnDate,
  deleteEntryOnDate,
  deleteSessionOnDate,
  deleteTaskOnDate,
} from '../../src/core/day-edit.js';
import { ClosedBy, DayStatus, SensitivityLevel, SessionState } from '../../src/core/types.js';
import type { AppConfig, Session } from '../../src/core/types.js';

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

function makeConfig(): AppConfig {
  return {
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
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
  };
}

function makeSession(task: string | null): Session {
  return {
    id: 'sess-1',
    repo: 'web',
    task,
    branch: task ? `feature/${task}-x` : 'main',
    state: SessionState.Active,
    startedAt: '2026-05-08T09:00:00.000Z',
    activatedAt: '2026-05-08T09:00:00.000Z',
    lastSeenAt: '2026-05-08T10:00:00.000Z',
    closedBy: ClosedBy.DayBoundary,
    evidence: { commits: 0, reflogEvents: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    pauses: [],
    baseSha: null,
    mergeBaseSha: null,
    evidenceBaseline: null,
    lastBranchCommits: null,
    ledger: null,
  };
}

const config = makeConfig();

console.log('Day edit — past-day manual entries');

test('addEntryOnDate creates the day file when absent', () => {
  const date = '2026-05-04';
  assert.equal(readDailyLog(date), null);
  const { entry } = addEntryOnDate(date, { task: 'ATL-7', minutes: 30, description: 'Standup', activity: 'Meeting' }, config);
  const disk = readDailyLog(date)!;
  assert.equal(disk.manualEntries.length, 1);
  assert.equal(disk.manualEntries[0].id, entry.id);
  assert.equal(disk.status, DayStatus.Draft);
});

test('editEntryOnDate persists the patch and unseals a pushed day', () => {
  const date = '2026-05-05';
  const log = createEmptyLog(date, config);
  log.status = DayStatus.Pushed;
  log.pushedAt = '2026-05-05T18:00:00.000Z';
  writeDailyLog(log);
  addEntryOnDate(date, { task: 'ATL-7', minutes: 30, description: 'Standup', activity: 'Meeting' }, config);

  const { entry } = editEntryOnDate(date, '#1', { minutes: 45 }, config);
  assert.equal(entry.minutes, 45);
  const disk = readDailyLog(date)!;
  assert.equal(disk.manualEntries[0].minutes, 45);
  // pushed day edited → draft with pushedAt kept (month view derives 'outdated')
  assert.equal(disk.status, DayStatus.Draft);
  assert.equal(disk.pushedAt, '2026-05-05T18:00:00.000Z');
});

test('deleteEntryOnDate removes the file with the last fact', () => {
  const date = '2026-05-06';
  addEntryOnDate(date, { task: 'ATL-7', minutes: 30, description: 'Standup', activity: 'Meeting' }, config);
  const result = deleteEntryOnDate(date, '#1');
  assert.equal(result.dayFileDeleted, true);
  assert.equal(existsSync(getDailyLogPath(date)), false);
});

test('deleteEntryOnDate keeps a pushed day file (pushedAt is a fact)', () => {
  const date = '2026-05-07';
  const log = createEmptyLog(date, config);
  log.status = DayStatus.Pushed;
  log.pushedAt = '2026-05-07T18:00:00.000Z';
  writeDailyLog(log);
  addEntryOnDate(date, { task: 'ATL-7', minutes: 30, description: 'Standup', activity: 'Meeting' }, config);

  const result = deleteEntryOnDate(date, '#1');
  assert.equal(result.dayFileDeleted, false);
  const disk = readDailyLog(date)!;
  assert.equal(disk.manualEntries.length, 0);
  assert.equal(disk.status, DayStatus.Draft); // → 'outdated' in the month view
});

test('addSessionEntryOnDate takes task from the session, folds as session-born', () => {
  const date = '2026-05-08';
  const log = createEmptyLog(date, config);
  log.sessions.push(makeSession('ATL-9'));
  writeDailyLog(log);

  const { entry } = addSessionEntryOnDate(date, 'sess-1', 25, config);
  assert.equal(entry.task, 'ATL-9');
  assert.equal(entry.sourceSessionId, 'sess-1');
  assert.equal(entry.activity, 'Development');
  assert.equal(entry.description, '');
});

test('addSessionEntryOnDate rejects a session without a task', () => {
  const date = '2026-05-09';
  const log = createEmptyLog(date, config);
  log.sessions.push(makeSession(null));
  writeDailyLog(log);

  assert.throws(() => addSessionEntryOnDate(date, 'sess-1', 25, config), /has no task/);
});

test('mutations on a missing day throw "No data"', () => {
  assert.throws(() => editEntryOnDate('2026-05-20', '#1', { minutes: 10 }, config), /No data for 2026-05-20/);
  assert.throws(() => deleteEntryOnDate('2026-05-21', '#1'), /No data for 2026-05-21/);
});

console.log('');
console.log('Day edit — session & task deletes');

test('deleteSessionOnDate removes the session, keeps its session-born adds', () => {
  const date = '2026-05-10';
  const log = createEmptyLog(date, config);
  log.sessions.push(makeSession('ATL-9'));
  writeDailyLog(log);
  addSessionEntryOnDate(date, 'sess-1', 25, config);

  const result = deleteSessionOnDate(date, '#1');
  assert.equal(result.deleted.id, 'sess-1');
  assert.equal(result.dayFileDeleted, false);
  const disk = readDailyLog(date)!;
  assert.equal(disk.sessions.length, 0);
  // manual time is user intent — it survives the machine record's deletion
  assert.equal(disk.manualEntries.length, 1);
  assert.equal(disk.manualEntries[0].sourceSessionId, 'sess-1');
});

test('deleteSessionOnDate removes the file with the last fact', () => {
  const date = '2026-05-11';
  const log = createEmptyLog(date, config);
  log.sessions.push(makeSession('ATL-9'));
  writeDailyLog(log);

  const result = deleteSessionOnDate(date, 'sess-1');
  assert.equal(result.dayFileDeleted, true);
  assert.equal(existsSync(getDailyLogPath(date)), false);
});

test('deleteSessionOnDate keeps a pushed day file and unseals to Draft', () => {
  const date = '2026-05-12';
  const log = createEmptyLog(date, config);
  log.sessions.push(makeSession('ATL-9'));
  log.status = DayStatus.Pushed;
  log.pushedAt = '2026-05-12T18:00:00.000Z';
  writeDailyLog(log);

  const result = deleteSessionOnDate(date, 'sess-1');
  assert.equal(result.dayFileDeleted, false);
  assert.equal(result.dayWasPushed, true);
  const disk = readDailyLog(date)!;
  assert.equal(disk.sessions.length, 0);
  assert.equal(disk.status, DayStatus.Draft);
  assert.equal(disk.pushedAt, '2026-05-12T18:00:00.000Z');
});

test('deleteTaskOnDate removes the ticket block, standalone entries stay', () => {
  const date = '2026-05-13';
  const log = createEmptyLog(date, config);
  log.sessions.push(makeSession('ATL-9'));
  writeDailyLog(log);
  addSessionEntryOnDate(date, 'sess-1', 25, config);
  addEntryOnDate(date, { task: 'ATL-9', minutes: 30, description: 'Standup', activity: 'Meeting' }, config);

  const result = deleteTaskOnDate(date, 'ATL-9');
  assert.equal(result.sessions.length, 1);
  assert.equal(result.entries.length, 1);
  assert.equal(result.dayFileDeleted, false);
  const disk = readDailyLog(date)!;
  assert.equal(disk.sessions.length, 0);
  // the standalone entry is its own worklog — the block delete never touches it
  assert.equal(disk.manualEntries.length, 1);
  assert.equal(disk.manualEntries[0].description, 'Standup');
});

test('deleteTaskOnDate with no tracked time throws', () => {
  const date = '2026-05-14';
  addEntryOnDate(date, { task: 'ATL-9', minutes: 30, description: 'Standup', activity: 'Meeting' }, config);
  assert.throws(() => deleteTaskOnDate(date, 'ATL-9'), /No tracked time for ATL-9/);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
