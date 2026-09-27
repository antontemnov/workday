/**
 * Unit tests for the Tempo read = sync writer (tempo-sync.ts): identity
 * relinks, refreshed bases, fast-forward in place and across days,
 * adoption with its exclusions, ticket-move pairs left alone, today routed
 * through the live hooks, closed months never read.
 *
 * Run: npx tsx tests/unit/tempo-sync.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { createEmptyLog, readDailyLog, writeDailyLog } from '../../src/core/daily-log.js';
import { APPROVAL_CACHE_FILE } from '../../src/core/constants.js';
import { applyMonthSync, syncTempoMonth } from '../../src/push/tempo-sync.js';
import { loadPushLog, pushLogKey, savePushLog, saveTombstones } from '../../src/push/push-log.js';
import { saveMonthSnapshot } from '../../src/push/tempo-snapshot.js';
import { DayStatus, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, ManualEntry, PushLogEntry, TempoMonthSnapshot, TempoWorklog } from '../../src/core/types.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
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
  sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
};

const TODAY = '2026-05-20';

function entry(id: string, task: string, minutes: number, description: string, activity: string): ManualEntry {
  return { id, task, minutes, description, activity, createdAt: '2026-05-01T09:00:00.000Z' };
}

function day(date: string, entries: ManualEntry[], pushed = true): void {
  const log = createEmptyLog(date, config);
  log.manualEntries.push(...entries);
  if (pushed) {
    log.status = DayStatus.Pushed;
    log.pushedAt = `${date}T18:00:00.000Z`;
  }
  writeDailyLog(log);
}

function own(id: number, seconds: number, description: string, activity: string): PushLogEntry {
  return { tempoWorklogId: id, timeSpentSeconds: seconds, pushedAt: 'x', description, activity };
}

function wl(id: number, issueId: number, date: string, seconds: number, description: string, activity: string): TempoWorklog {
  return { tempoWorklogId: id, issueId, startDate: date, timeSpentSeconds: seconds, description, activity };
}

// May 2026: one fixture per behaviour, issue 1 = ATL-1, 2 = ATL-2, 3 = ATL-3, 9 = unresolved.
day('2026-05-04', [entry('e1', 'ATL-1', 30, 'Daily', 'Meeting')]);          // Tempo 30 → 45: fast-forward in place
day('2026-05-05', [entry('e2', 'ATL-1', 60, 'Review', 'Other')]);           // Tempo moved it to 05-06
day('2026-05-07', [entry('e3', 'ATL-1', 40, 'Plan', 'Meeting')]);           // both sides edited: conflict
day('2026-05-08', [entry('e4', 'ATL-2', 30, 'Sync', 'Meeting')], false);    // never pushed, twin in Tempo
day('2026-05-13', [entry('e5', 'ATL-1', 30, 'Demo', 'Meeting')]);           // Tempo moved it to the future
day('2026-05-14', [entry('e6', 'ATL-1', 30, 'Grooming', 'Meeting')]);       // Tempo moved it to ATL-3
day('2026-05-15', [entry('e7', 'ATL-1', 45, 'Retro', 'Meeting')]);          // same change on both sides

savePushLog({
  [pushLogKey('2026-05-04', 'ATL-1', 'e1')]: own(101, 1800, 'Daily', 'Meeting'),
  [pushLogKey('2026-05-05', 'ATL-1', 'e2')]: own(102, 3600, 'Review', 'Other'),
  [pushLogKey('2026-05-07', 'ATL-1', 'e3')]: own(103, 1800, 'Plan', 'Meeting'),
  [pushLogKey('2026-05-13', 'ATL-1', 'e5')]: own(109, 1800, 'Demo', 'Meeting'),
  [pushLogKey('2026-05-14', 'ATL-1', 'e6')]: own(110, 1800, 'Grooming', 'Meeting'),
  [pushLogKey('2026-05-15', 'ATL-1', 'e7')]: own(112, 1800, 'Retro', 'Meeting'),
});
saveTombstones([]);

const snapshot: TempoMonthSnapshot = {
  month: '2026-05',
  accountId: 'acc',
  fetchedAt: '2026-05-20T10:00:00.000Z',
  issueKeys: { '1': 'ATL-1', '2': 'ATL-2', '3': 'ATL-3' },
  worklogs: [
    wl(101, 1, '2026-05-04', 2700, 'Daily', 'Meeting'),
    wl(102, 1, '2026-05-06', 3600, 'Review', 'Other'),
    wl(103, 1, '2026-05-07', 3600, 'Plan', 'Meeting'),
    wl(104, 2, '2026-05-08', 1800, 'Sync', 'Meeting'),
    wl(105, 1, '2026-05-11', 3600, 'Tempo-born', 'Other'),
    wl(106, 9, '2026-05-12', 900, 'No key', 'Other'),
    wl(107, 1, '2026-05-25', 900, 'Ahead', 'Other'),
    wl(108, 1, TODAY, 1200, 'Today in Tempo', 'Other'),
    wl(109, 1, '2026-05-26', 1800, 'Demo', 'Meeting'),
    wl(111, 3, '2026-05-14', 1800, 'Grooming', 'Meeting'),
    wl(112, 1, '2026-05-15', 2700, 'Retro', 'Meeting'),
  ],
};
saveMonthSnapshot(snapshot);

const first = applyMonthSync(snapshot, { config, today: TODAY, live: null });
const log = loadPushLog();

console.log('Tempo sync — applyMonthSync');

await test('changed only in Tempo → taken in place, base follows, the day stays sealed', () => {
  const d = readDailyLog('2026-05-04')!;
  assert.equal(d.manualEntries[0].minutes, 45);
  assert.equal(d.status, DayStatus.Pushed);
  assert.equal(log[pushLogKey('2026-05-04', 'ATL-1', 'e1')].timeSpentSeconds, 2700);
});

await test('moved to another day only in Tempo → the entry moves, ownership follows', () => {
  assert.equal(readDailyLog('2026-05-05')!.manualEntries.length, 0);
  const moved = readDailyLog('2026-05-06')!.manualEntries[0];
  assert.equal(moved.task, 'ATL-1');
  assert.equal(moved.minutes, 60);
  assert.equal(moved.description, 'Review');
  assert.equal(log[pushLogKey('2026-05-05', 'ATL-1', 'e2')], undefined);
  assert.equal(log[pushLogKey('2026-05-06', 'ATL-1', moved.id)].tempoWorklogId, 102);
});

await test('both sides edited → nothing taken', () => {
  assert.equal(readDailyLog('2026-05-07')!.manualEntries[0].minutes, 40);
  assert.equal(log[pushLogKey('2026-05-07', 'ATL-1', 'e3')].timeSpentSeconds, 1800);
});

await test('never pushed with an exact twin → relinked, not adopted', () => {
  assert.equal(log[pushLogKey('2026-05-08', 'ATL-2', 'e4')].tempoWorklogId, 104);
  assert.equal(readDailyLog('2026-05-08')!.manualEntries.length, 1);
  assert.ok(!first.adopted.some(a => a.tempoWorklogId === 104));
});

await test('created in Tempo without us → adopted as an entry with ownership', () => {
  const adopted = first.adopted.find(a => a.tempoWorklogId === 105)!;
  assert.ok(adopted);
  assert.equal(adopted.date, '2026-05-11');
  const e = readDailyLog('2026-05-11')!.manualEntries.find(x => x.id === adopted.entryId)!;
  assert.equal(e.description, 'Tempo-born');
  assert.equal(log[pushLogKey('2026-05-11', 'ATL-1', adopted.entryId)].tempoWorklogId, 105);
});

await test('keyless, future and today without the live tracker → not adopted', () => {
  const ids = first.adopted.map(a => a.tempoWorklogId);
  assert.ok(!ids.includes(106));
  assert.ok(!ids.includes(107));
  assert.ok(!ids.includes(108));
  assert.equal(readDailyLog(TODAY), null);
});

await test('moved into the future in Tempo → left alone, still a conflict', () => {
  assert.equal(readDailyLog('2026-05-13')!.manualEntries[0].id, 'e5');
  assert.equal(log[pushLogKey('2026-05-13', 'ATL-1', 'e5')].tempoWorklogId, 109);
});

await test('moved to another ticket → the new worklog is paired, not adopted', () => {
  assert.ok(!first.adopted.some(a => a.tempoWorklogId === 111));
  assert.equal(readDailyLog('2026-05-14')!.manualEntries[0].task, 'ATL-1');
});

await test('the same change on both sides → the base catches up', () => {
  assert.equal(log[pushLogKey('2026-05-15', 'ATL-1', 'e7')].timeSpentSeconds, 2700);
});

await test('counts: 2 taken, 1 relinked, conflicts left for e3, e5, e6', () => {
  assert.equal(first.fastForwarded, 2);
  assert.equal(first.linked, 1);
  assert.equal(first.adopted.length, 1);
  assert.equal(first.conflicts, 3);
});

await test('a second read changes nothing', () => {
  const again = applyMonthSync(snapshot, { config, today: TODAY, live: null });
  assert.deepEqual(again.adopted, []);
  assert.equal(again.fastForwarded, 0);
  assert.equal(again.linked, 0);
  assert.equal(again.conflicts, 3);
});

await test('with the live tracker, today is adopted through its hooks', () => {
  const calls: string[] = [];
  const result = applyMonthSync(snapshot, {
    config,
    today: TODAY,
    live: {
      addEntry: input => { calls.push(input.description); return entry('live-1', input.task, input.minutes, input.description, input.activity); },
      overwriteEntry: () => { throw new Error('not expected'); },
      deleteEntry: () => { throw new Error('not expected'); },
    },
  });
  assert.deepEqual(calls, ['Today in Tempo']);
  assert.deepEqual(result.adopted.map(a => a.tempoWorklogId), [108]);
  assert.equal(loadPushLog()[pushLogKey(TODAY, 'ATL-1', 'live-1')].tempoWorklogId, 108);
});

console.log('\nTempo sync — closed months');

await test('a month that is not OPEN is never read', async () => {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(join(getDataDir(), APPROVAL_CACHE_FILE), JSON.stringify({
    '2026-04': { fetchedAt: new Date().toISOString(), period: { from: '2026-04-01', to: '2026-04-30' }, statusKey: 'APPROVED', requiredSeconds: 0, timeSpentSeconds: 0, canSubmit: false },
  }));
  const secrets = { Jira_Email: 'a@b.c', Jira_BaseUrl: 'https://example.atlassian.net', Jira_Token: 't', Tempo_Token: 't' };
  // Any network call would fail in the test home — a skip proves none happened.
  const result = await syncTempoMonth(2026, 4, secrets, { config, today: TODAY, live: null });
  assert.equal(result.skipped, 'closed');
  assert.deepEqual(result.adopted, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
