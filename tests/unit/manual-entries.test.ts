/**
 * Unit tests for manual entries: CRUD + budget invariant in daily-log.
 *
 * Run: npx tsx tests/unit/manual-entries.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Pure in-memory — no disk, no daemon.
 */
import assert from 'node:assert/strict';
import {
  createEmptyLog,
  addManualEntry,
  editManualEntry,
  findManualEntry,
  resolveManualEntryTarget,
  computeTotalManualEntryMs,
  computeTotalClaimedMs,
} from '../../src/core/daily-log.js';
import { DayStatus, SensitivityLevel, type AppConfig, type DailyLog } from '../../src/core/types.js';

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

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    repos: [],
    boundaryHour: 0,
    timezone: 'UTC',
    taskPattern: 'ATL-\\d+',
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
    ...overrides,
  };
}

function makeLog(config: AppConfig): DailyLog {
  return createEmptyLog('2026-06-13', config);
}

type EntryOverride = Partial<{ task: string; minutes: number; description: string; activity: string }>;

function addStd(log: DailyLog, config: AppConfig, over: EntryOverride = {}) {
  return addManualEntry(log, {
    task: over.task ?? 'ATL-10',
    minutes: over.minutes ?? 30,
    description: over.description ?? 'Daily standup',
    activity: over.activity ?? 'Meeting',
  }, config);
}

console.log('Manual entries — daily-log');

test('createEmptyLog initializes manualEntries', () => {
  const log = makeLog(makeConfig());
  assert.deepEqual(log.manualEntries, []);
});

test('addManualEntry appends and returns entry', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const entry = addStd(log, config);
  assert.equal(log.manualEntries.length, 1);
  assert.equal(entry.task, 'ATL-10');
  assert.equal(entry.minutes, 30);
  assert.equal(entry.description, 'Daily standup');
  assert.equal(entry.activity, 'Meeting');
  assert.ok(entry.id.length > 0);
  assert.ok(entry.createdAt);
});

test('two entries on same task are independent (own ids)', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const a = addStd(log, config, { minutes: 30, description: 'standup' });
  const b = addStd(log, config, { minutes: 15, description: 'grooming' });
  assert.equal(log.manualEntries.length, 2);
  assert.notEqual(a.id, b.id);
});

test('computeTotalManualEntryMs sums minutes', () => {
  const config = makeConfig();
  const log = makeLog(config);
  addStd(log, config, { minutes: 30 });
  addStd(log, config, { minutes: 45 });
  assert.equal(computeTotalManualEntryMs(log), 75 * 60_000);
});

test('computeTotalClaimedMs includes manual entries', () => {
  const config = makeConfig();
  const log = makeLog(config);
  addStd(log, config, { minutes: 60 });
  assert.equal(computeTotalClaimedMs(log), 60 * 60_000);
});

test('rejects non-key garbage (shape guard)', () => {
  const config = makeConfig();
  const log = makeLog(config);
  assert.throws(() => addStd(log, config, { task: 'nonsense' }), /not a valid Jira key/);
  assert.throws(() => addStd(log, config, { task: 'fix ATL-10 stuff' }), /not a valid Jira key/);
  assert.equal(log.manualEntries.length, 0);
});

test('accepts any project prefix — logging is not scoped to taskPattern', () => {
  const config = makeConfig(); // taskPattern ATL-\d+ governs git tracking, not logging
  const log = makeLog(config);
  assert.equal(addStd(log, config, { task: 'WEB-10' }).task, 'WEB-10');
  assert.equal(addStd(log, config, { task: 'IN-66' }).task, 'IN-66');
  assert.equal(addStd(log, config, { task: 'PROJ-123' }).task, 'PROJ-123');
  assert.equal(log.manualEntries.length, 3);
});

test('rejects case mismatch and malformed keys', () => {
  const config = makeConfig();
  const log = makeLog(config);
  assert.throws(() => addStd(log, config, { task: 'atl-10' }), /not a valid Jira key/);  // lowercase
  assert.throws(() => addStd(log, config, { task: 'ATL-10X' }), /not a valid Jira key/); // suffix junk
  assert.throws(() => addStd(log, config, { task: 'ATL-' }), /not a valid Jira key/);    // no number
  assert.throws(() => addStd(log, config, { task: '10-20' }), /not a valid Jira key/);   // no letter prefix
  assert.equal(log.manualEntries.length, 0);
});

test('taskPattern does not gate logging (git-tracking scope only)', () => {
  const config = makeConfig({ taskPattern: 'WEB-\\d+' }); // git tracks WEB; logging unaffected
  const log = makeLog(config);
  assert.equal(addStd(log, config, { task: 'ATL-10' }).task, 'ATL-10'); // still loggable
  assert.equal(addStd(log, config, { task: 'IN-66' }).task, 'IN-66');
});

test('rejects non-positive and oversized minutes', () => {
  const config = makeConfig();
  const log = makeLog(config);
  assert.throws(() => addStd(log, config, { minutes: 0 }), /positive/);
  assert.throws(() => addStd(log, config, { minutes: -5 }), /positive/);
  assert.throws(() => addStd(log, config, { minutes: 481 }), /Max is 480/);
});

test('rejects empty description', () => {
  const config = makeConfig();
  const log = makeLog(config);
  assert.throws(() => addStd(log, config, { description: '   ' }), /Description is required/);
});

test('add on pushed day unseals back to Draft', () => {
  const config = makeConfig();
  const log = makeLog(config);
  log.status = DayStatus.Pushed;
  const entry = addStd(log, config);
  assert.equal(log.manualEntries.length, 1);
  assert.equal(entry.task, 'ATL-10');
  assert.equal(log.status, DayStatus.Draft); // pushed day reverts so next push re-syncs
});

test('edit on pushed day unseals back to Draft', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const e = addStd(log, config, { minutes: 30 });
  log.status = DayStatus.Pushed;
  editManualEntry(log, e.id, { minutes: 45 }, config);
  assert.equal(findManualEntry(log, e.id)!.minutes, 45);
  assert.equal(log.status, DayStatus.Draft);
});

test('budget v2: 24h window fits exactly, +1m overflows', () => {
  const config = makeConfig();
  const log = makeLog(config);
  // Window is the full day (24h = 1440m), regardless of sessions.
  addStd(log, config, { minutes: 480 });
  addStd(log, config, { minutes: 480 });
  addStd(log, config, { minutes: 480 });         // ok: exactly 1440m (check is strict >)
  assert.throws(() => addStd(log, config, { minutes: 1 }), /Exceeds 24h day window/);
});

test('session-born entry: forced Development, empty description, marker kept', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const e = addManualEntry(log, {
    task: 'ATL-10', minutes: 30, description: 'ignored', activity: 'CodeReview',
    sourceSessionId: 'sess1',
  }, config);
  assert.equal(e.activity, 'Development');
  assert.equal(e.description, '');
  assert.equal(e.sourceSessionId, 'sess1');
});

test('session-born entry is not editable', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const e = addManualEntry(log, {
    task: 'ATL-10', minutes: 30, description: '', activity: '',
    sourceSessionId: 'sess1',
  }, config);
  assert.throws(() => editManualEntry(log, e.id, { minutes: 60 }, config), /not editable/);
});

test('budget v2: late-day entries fit the full window', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const e = addStd(log, config, { minutes: 480 }); // v1 git-anchored window would reject
  assert.equal(e.minutes, 480);
});

test('findManualEntry by id', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const e = addStd(log, config);
  assert.equal(findManualEntry(log, e.id)?.id, e.id);
  assert.equal(findManualEntry(log, 'nope'), undefined);
});

test('resolveManualEntryTarget by #index and id', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const a = addStd(log, config, { description: 'first' });
  const b = addStd(log, config, { description: 'second' });
  assert.equal(resolveManualEntryTarget(log, '#1')?.id, a.id);
  assert.equal(resolveManualEntryTarget(log, '2')?.id, b.id);
  assert.equal(resolveManualEntryTarget(log, a.id)?.id, a.id);
  assert.equal(resolveManualEntryTarget(log, '#9'), null);
});

// Regression: an 8-hex id can start with digits (randomBytes), and parseInt
// reads "3cfb58a5" as index 3 — an edit/delete by id would land on entries[2]
// (the next row) instead. The id must always win over the index parse.
test('resolveManualEntryTarget: digit-leading id wins over index', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const a = addStd(log, config, { description: 'first' });
  const b = addStd(log, config, { description: 'second' });
  const c = addStd(log, config, { description: 'third' });
  a.id = 'aaaaaaaa';
  b.id = '3cfb58a5'; // parseInt → 3, which used to hit entries[2] (c)
  c.id = 'cccccccc';
  assert.equal(resolveManualEntryTarget(log, '3cfb58a5')?.id, b.id);
  assert.equal(resolveManualEntryTarget(log, '3cfb58a5')?.description, 'second');
  // Explicit #index and a bare numeric (no id collision) still resolve by index.
  assert.equal(resolveManualEntryTarget(log, '#3')?.id, c.id);
  assert.equal(resolveManualEntryTarget(log, '2')?.id, b.id);
});

test('editManualEntry sets provided fields', () => {
  const config = makeConfig();
  const log = makeLog(config);
  const e = addStd(log, config, { minutes: 30 });
  editManualEntry(log, e.id, { minutes: 45, description: 'updated', activity: 'CodeReview' }, config);
  const after = findManualEntry(log, e.id)!;
  assert.equal(after.minutes, 45);
  assert.equal(after.description, 'updated');
  assert.equal(after.activity, 'CodeReview');
});

test('editManualEntry budget re-check on increase; shrink always ok', () => {
  const config = makeConfig();
  const log = makeLog(config);
  // Fill the 24h window to 1410m, leaving 30m of headroom.
  addStd(log, config, { minutes: 480 });
  addStd(log, config, { minutes: 480 });
  addStd(log, config, { minutes: 450 });
  const e = addStd(log, config, { minutes: 30 });
  // 30 → 31 would cross the 24h window.
  assert.throws(() => editManualEntry(log, e.id, { minutes: 31 }, config), /Exceeds 24h day window/);
  editManualEntry(log, e.id, { minutes: 10 }, config);
  assert.equal(findManualEntry(log, e.id)!.minutes, 10);
});

test('editManualEntry rejects unknown id', () => {
  const config = makeConfig();
  const log = makeLog(config);
  assert.throws(() => editManualEntry(log, 'nope', { minutes: 10 }, config), /not found/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
