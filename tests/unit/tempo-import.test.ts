/**
 * Unit tests for the mirror import (adopt foreign Tempo worklogs):
 * entry creation, ownership baseline, per-item errors, idempotency,
 * month-report integration (adopted row stops being foreign).
 *
 * Run: npx tsx tests/unit/tempo-import.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { readDailyLog } from '../../src/core/daily-log.js';
import { importFromSnapshot } from '../../src/push/tempo-import.js';
import { loadPushLog, savePushLog, saveTombstones, pushLogKey } from '../../src/push/push-log.js';
import { saveMonthSnapshot } from '../../src/push/tempo-snapshot.js';
import { buildMonthResponse } from '../../src/push/month-report.js';
import { MonthDayStatus, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, ManualEntry, TempoMonthSnapshot, TempoWorklog } from '../../src/core/types.js';

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
    taskPattern: 'ATL-\\d+',
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
  };
}

function wl(over: Partial<TempoWorklog> & { tempoWorklogId: number; issueId: number; startDate: string; timeSpentSeconds: number }): TempoWorklog {
  return { ...over };
}

const config = makeConfig();
const TODAY = '2026-06-20';

// June 2026 remote fixture. issue 1 = ATL-1, issue 2 = IN-2 (off-pattern),
// issue 3 = unresolved key.
const snapshot: TempoMonthSnapshot = {
  month: '2026-06',
  accountId: 'acc-1',
  fetchedAt: '2026-06-30T12:00:00.000Z',
  issueKeys: { '1': 'ATL-1', '2': 'IN-2' },
  worklogs: [
    wl({ tempoWorklogId: 901, issueId: 1, startDate: '2026-06-05', timeSpentSeconds: 3600, description: 'Working on work item ATL-1', activity: 'Development' }),
    wl({ tempoWorklogId: 902, issueId: 2, startDate: '2026-06-05', timeSpentSeconds: 1800, description: 'foreign project', activity: 'Meeting' }),
    wl({ tempoWorklogId: 903, issueId: 3, startDate: '2026-06-06', timeSpentSeconds: 900 }),
    wl({ tempoWorklogId: 904, issueId: 1, startDate: '2026-06-25', timeSpentSeconds: 600 }),
    wl({ tempoWorklogId: 905, issueId: 1, startDate: '2026-06-01', timeSpentSeconds: 3600 }),  // owned
    wl({ tempoWorklogId: 906, issueId: 1, startDate: '2026-06-02', timeSpentSeconds: 1800 }),  // tombstoned
    wl({ tempoWorklogId: 907, issueId: 1, startDate: '2026-06-07', timeSpentSeconds: 1234, description: 'Real work', activity: 'CodeReview' }),
    wl({ tempoWorklogId: 908, issueId: 1, startDate: TODAY, timeSpentSeconds: 600, activity: 'Development' }),
  ],
};

savePushLog({
  [pushLogKey('2026-06-01', 'ATL-1', 'aaa')]: { tempoWorklogId: 905, timeSpentSeconds: 3600, pushedAt: '2026-06-01T18:00:00.000Z' },
});
saveTombstones([
  { date: '2026-06-02', task: 'ATL-1', entryId: 'bbb', tempoWorklogId: 906, deletedAt: '2026-06-03T09:00:00.000Z' },
]);

const todayCalls: { task: string; minutes: number; description: string; activity: string }[] = [];
const addEntryToday = (input: { task: string; minutes: number; description: string; activity: string }): ManualEntry => {
  todayCalls.push(input);
  return { id: 'today-entry', task: input.task, minutes: input.minutes, description: input.description, activity: input.activity, createdAt: new Date().toISOString() };
};

const result = importFromSnapshot(snapshot, { config, today: TODAY, addEntryToday });

console.log('Tempo import — tempo-import');

test('imports every adoptable foreign worklog, reports the rest', () => {
  assert.equal(result.month, '2026-06');
  assert.equal(result.imported, 3);   // 901, 907, 908
  assert.equal(result.failed, 3);     // 902 pattern, 903 unresolved, 904 future
});

test('placeholder description imports as empty', () => {
  const log = readDailyLog('2026-06-05')!;
  assert.equal(log.manualEntries.length, 1);
  const entry = log.manualEntries[0];
  assert.equal(entry.task, 'ATL-1');
  assert.equal(entry.minutes, 60);
  assert.equal(entry.description, '');
  assert.equal(entry.activity, 'Development');
});

test('ownership baseline carries raw remote fields', () => {
  const log = readDailyLog('2026-06-05')!;
  const own = loadPushLog()[pushLogKey('2026-06-05', 'ATL-1', log.manualEntries[0].id)];
  assert.ok(own, 'ownership key recorded');
  assert.equal(own.tempoWorklogId, 901);
  assert.equal(own.timeSpentSeconds, 3600);
  assert.equal(own.description, 'Working on work item ATL-1');
  assert.equal(own.activity, 'Development');
});

test('odd seconds round to the nearest minute (within Tempo tolerance)', () => {
  const log = readDailyLog('2026-06-07')!;
  const entry = log.manualEntries[0];
  assert.equal(entry.minutes, 21);            // 1234s → 20.57m
  assert.equal(entry.description, 'Real work');
  assert.equal(entry.activity, 'CodeReview');
});

test('off-pattern task fails as an item, day file untouched by it', () => {
  const item = result.items.find(i => i.tempoWorklogId === 902)!;
  assert.match(item.error ?? '', /not a valid key/);
  assert.equal(item.task, 'IN-2');
  assert.equal(readDailyLog('2026-06-05')!.manualEntries.length, 1);
});

test('unresolved issue key fails as an item', () => {
  const item = result.items.find(i => i.tempoWorklogId === 903)!;
  assert.match(item.error ?? '', /unresolved/i);
  assert.equal(item.task, 'issue #3');
  assert.equal(readDailyLog('2026-06-06'), null);
});

test('future-dated worklog is refused', () => {
  const item = result.items.find(i => i.tempoWorklogId === 904)!;
  assert.match(item.error ?? '', /future/i);
  assert.equal(readDailyLog('2026-06-25'), null);
});

test("today's worklog goes through the live-tracker hook", () => {
  assert.equal(todayCalls.length, 1);
  assert.deepEqual(todayCalls[0], { task: 'ATL-1', minutes: 10, description: '', activity: 'Development' });
  const own = loadPushLog()[pushLogKey(TODAY, 'ATL-1', 'today-entry')];
  assert.equal(own?.tempoWorklogId, 908);
});

test('owned and tombstoned worklogs are never targets in all-mode', () => {
  assert.equal(result.items.find(i => i.tempoWorklogId === 905), undefined);
  assert.equal(result.items.find(i => i.tempoWorklogId === 906), undefined);
});

test('explicit ids get per-id feedback', () => {
  const byIds = importFromSnapshot(snapshot, { config, today: TODAY, worklogIds: [905, 906, 999] });
  assert.equal(byIds.imported, 0);
  assert.equal(byIds.failed, 3);
  assert.match(byIds.items.find(i => i.tempoWorklogId === 905)!.error ?? '', /already imported/i);
  assert.match(byIds.items.find(i => i.tempoWorklogId === 906)!.error ?? '', /pending local delete/i);
  assert.match(byIds.items.find(i => i.tempoWorklogId === 999)!.error ?? '', /not in the tempo snapshot/i);
});

test('re-import is a no-op (adopted worklogs are owned now)', () => {
  const again = importFromSnapshot(snapshot, { config, today: TODAY, addEntryToday });
  assert.equal(again.imported, 0);
  assert.equal(again.failed, 3);     // the same three unadoptable ones
  assert.equal(readDailyLog('2026-06-05')!.manualEntries.length, 1);
  assert.equal(todayCalls.length, 1);
});

test('date filter narrows the batch', () => {
  const byDate = importFromSnapshot(snapshot, { config, today: TODAY, date: '2026-06-06' });
  assert.equal(byDate.imported, 0);
  assert.equal(byDate.failed, 1);    // only 903 lives on 06-06
  assert.equal(byDate.items.length, 1);
});

test('day window overflow fails as an item', () => {
  const fat: TempoMonthSnapshot = {
    ...snapshot,
    worklogs: [wl({ tempoWorklogId: 950, issueId: 1, startDate: '2026-06-10', timeSpentSeconds: 25 * 3600 })],
  };
  const r = importFromSnapshot(fat, { config, today: TODAY });
  assert.equal(r.failed, 1);
  assert.match(r.items[0].error ?? '', /24h day window/);
  assert.equal(readDailyLog('2026-06-10'), null);
});

test('month report: adopted row is manual and in parity, not foreign', () => {
  saveMonthSnapshot(snapshot);
  const month = buildMonthResponse(2026, 6, config);
  const day = month.days.find(d => d.date === '2026-06-05')!;
  const manual = day.tasks.filter(t => t.kind === 'manual');
  const foreign = day.tasks.filter(t => t.kind === 'foreign');
  assert.equal(manual.length, 1);
  assert.equal(manual[0].seconds, 3600);
  assert.equal(foreign.length, 1);               // 902 stayed foreign
  assert.equal(foreign[0].tempoWorklogId, 902);
  assert.equal(day.status, MonthDayStatus.Pending);  // parity, but never sealed by a push
  assert.deepEqual(day.drift, []);
  assert.equal(day.reportedSeconds, 3600 + 1800);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
