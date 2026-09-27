/**
 * Unit tests for resolving one conflict (tempo-resolve.ts): every conflict
 * kind (edited, moved, deleted, ticket) × both sides (Mine, Tempo), checked
 * against the month model afterwards; a closed month is refused.
 *
 * Run: npx tsx tests/unit/tempo-resolve.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { APPROVAL_CACHE_FILE } from '../../src/core/constants.js';
import { createEmptyLog, readDailyLog, writeDailyLog } from '../../src/core/daily-log.js';
import { resolveConflict, resolveOnSnapshot } from '../../src/push/tempo-resolve.js';
import { readMonthModel } from '../../src/push/tempo-sync.js';
import { loadPushLog, loadTombstones, pushLogKey, savePushLog } from '../../src/push/push-log.js';
import { loadMonthSnapshot, saveMonthSnapshot } from '../../src/push/tempo-snapshot.js';
import { ConflictKind, DayStatus, MonthSyncState, ResolveSide, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, PushLogEntry, TempoMonthSnapshot, TempoWorklog } from '../../src/core/types.js';

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

const TODAY = '2026-09-20';
const opts = { config, today: TODAY, live: null };

// One month per scenario: an entry pushed as 30m 'Plan' Meeting on day 10,
// the local and Tempo sides shaped by the caller.
function scenario(month: number, local: { minutes: number }, tempo: TempoWorklog[], ownId = 100 + month): { date: string; key: string } {
  const mm = String(month).padStart(2, '0');
  const date = `2026-${mm}-10`;
  const log = createEmptyLog(date, config);
  log.manualEntries.push({ id: `e${month}`, task: 'ATL-1', minutes: local.minutes, description: 'Plan', activity: 'Meeting', createdAt: 'x' });
  log.status = DayStatus.Pushed;
  log.pushedAt = `${date}T18:00:00.000Z`;
  writeDailyLog(log);
  const key = pushLogKey(date, 'ATL-1', `e${month}`);
  const own: PushLogEntry = { tempoWorklogId: ownId, timeSpentSeconds: 1800, pushedAt: 'x', description: 'Plan', activity: 'Meeting' };
  savePushLog({ ...loadPushLog(), [key]: own });
  const snapshot: TempoMonthSnapshot = { month: `2026-${mm}`, accountId: 'acc', fetchedAt: 'x', worklogs: tempo, issueKeys: { '1': 'ATL-1', '3': 'ATL-3' } };
  saveMonthSnapshot(snapshot);
  return { date, key };
}

function wl(id: number, month: number, day: number, seconds: number, issueId = 1): TempoWorklog {
  const mm = String(month).padStart(2, '0');
  return { tempoWorklogId: id, issueId, startDate: `2026-${mm}-${String(day).padStart(2, '0')}`, timeSpentSeconds: seconds, description: 'Plan', activity: 'Meeting' };
}

function loadSnap(month: number): TempoMonthSnapshot | null {
  return loadMonthSnapshot(2026, month);
}

function dayState(month: number, date: string): { state: MonthSyncState; conflicts: number } {
  const d = readMonthModel(loadSnap(month)!, config).days.get(date)!;
  return { state: d.state, conflicts: d.conflicts.length };
}

console.log('Resolve — edited');

await test('edited on both sides → Mine: the base takes Tempo, our version goes out', () => {
  const { date, key } = scenario(1, { minutes: 40 }, [wl(101, 1, 10, 3600)]);
  const r = resolveOnSnapshot(date, 'e1', ResolveSide.Mine, opts);
  assert.equal(r.kind, ConflictKind.Edited);
  assert.equal(loadPushLog()[key].timeSpentSeconds, 3600);
  assert.equal(readDailyLog(date)!.manualEntries[0].minutes, 40);
  assert.equal(readDailyLog(date)!.status, DayStatus.Draft);
  assert.deepEqual(dayState(1, date), { state: MonthSyncState.Unpushed, conflicts: 0 });
});

await test('edited on both sides → Tempo: the entry takes Tempo, in sync', () => {
  const { date, key } = scenario(2, { minutes: 40 }, [wl(102, 2, 10, 3600)]);
  const r = resolveOnSnapshot(date, 'e2', ResolveSide.Tempo, opts);
  assert.equal(r.entryIdAfter, 'e2');
  assert.equal(readDailyLog(date)!.manualEntries[0].minutes, 60);
  assert.equal(loadPushLog()[key].timeSpentSeconds, 3600);
  assert.deepEqual(dayState(2, date), { state: MonthSyncState.Pushed, conflicts: 0 });
});

console.log('\nResolve — moved to another day');

await test('moved + time edited here → Mine: the base remembers Tempo\'s day, the push moves it back', () => {
  const { date, key } = scenario(3, { minutes: 45 }, [wl(103, 3, 11, 1800)]);
  const r = resolveOnSnapshot(date, 'e3', ResolveSide.Mine, opts);
  assert.equal(r.kind, ConflictKind.Moved);
  assert.equal(loadPushLog()[key].startDate, '2026-03-11');
  assert.deepEqual(dayState(3, date), { state: MonthSyncState.Unpushed, conflicts: 0 });
});

await test('moved + time edited here → Tempo: the entry moves to Tempo\'s day with its values', () => {
  const { date, key } = scenario(4, { minutes: 45 }, [wl(104, 4, 11, 1800)]);
  const r = resolveOnSnapshot(date, 'e4', ResolveSide.Tempo, opts);
  assert.equal(r.dateAfter, '2026-04-11');
  assert.ok(r.entryIdAfter && r.entryIdAfter !== 'e4');
  assert.equal(readDailyLog(date)!.manualEntries.length, 0);
  const moved = readDailyLog('2026-04-11')!.manualEntries[0];
  assert.equal(moved.id, r.entryIdAfter);
  assert.equal(moved.minutes, 30);
  assert.equal(loadPushLog()[key], undefined);
  assert.equal(loadPushLog()[pushLogKey('2026-04-11', 'ATL-1', moved.id)].tempoWorklogId, 104);
  assert.deepEqual(dayState(4, '2026-04-11'), { state: MonthSyncState.Pushed, conflicts: 0 });
});

console.log('\nResolve — deleted in Tempo');

await test('deleted → Mine: ownership dropped, the push recreates it', () => {
  const { date, key } = scenario(5, { minutes: 30 }, []);
  resolveOnSnapshot(date, 'e5', ResolveSide.Mine, opts);
  assert.equal(loadPushLog()[key], undefined);
  assert.equal(readDailyLog(date)!.manualEntries.length, 1);
  assert.deepEqual(dayState(5, date), { state: MonthSyncState.Unpushed, conflicts: 0 });
});

await test('deleted → Tempo: deleted here too, no tombstone', () => {
  const { date, key } = scenario(6, { minutes: 30 }, []);
  const tombs = loadTombstones().length;
  const r = resolveOnSnapshot(date, 'e6', ResolveSide.Tempo, opts);
  assert.equal(r.entryIdAfter, null);
  assert.equal(loadPushLog()[key], undefined);
  assert.equal(loadTombstones().length, tombs);
  assert.equal(readDailyLog(date)!.manualEntries.length, 0);
});

console.log('\nResolve — moved to another ticket');

await test('ticket → Mine: Tempo\'s copy is tombstoned, ours is created anew', () => {
  const { date, key } = scenario(7, { minutes: 45 }, [wl(117, 7, 10, 1800, 3)]);
  const r = resolveOnSnapshot(date, 'e7', ResolveSide.Mine, opts);
  assert.equal(r.kind, ConflictKind.Ticket);
  assert.equal(loadPushLog()[key], undefined);
  assert.ok(loadTombstones().some(t => t.tempoWorklogId === 117 && t.task === 'ATL-3'));
  const model = readMonthModel(loadSnap(7)!, config);
  assert.equal(model.days.get(date)!.state, MonthSyncState.Unpushed);
  assert.ok(!model.foreign.some(w => w.tempoWorklogId === 117));
});

await test('ticket → Tempo: the entry moves to the other ticket and owns the new worklog', () => {
  const { date, key } = scenario(8, { minutes: 30 }, [wl(118, 8, 10, 1800, 3)]);
  const r = resolveOnSnapshot(date, 'e8', ResolveSide.Tempo, opts);
  assert.equal(r.taskAfter, 'ATL-3');
  const entries = readDailyLog(date)!.manualEntries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].task, 'ATL-3');
  assert.equal(loadPushLog()[key], undefined);
  assert.equal(loadPushLog()[pushLogKey(date, 'ATL-3', entries[0].id)].tempoWorklogId, 118);
  assert.deepEqual(dayState(8, date), { state: MonthSyncState.Pushed, conflicts: 0 });
});

console.log('\nResolve — refusals');

await test('no conflict on the entry → refused', () => {
  assert.throws(() => resolveOnSnapshot('2026-02-10', 'e2', ResolveSide.Mine, opts), /No conflict/);
});

await test('a month that is not OPEN → refused', async () => {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(join(getDataDir(), APPROVAL_CACHE_FILE), JSON.stringify({
    '2026-01': { fetchedAt: new Date().toISOString(), period: null, statusKey: 'IN_REVIEW', requiredSeconds: 0, timeSpentSeconds: 0, canSubmit: false },
  }));
  const secrets = { Jira_Email: 'a@b.c', Jira_BaseUrl: 'https://example.atlassian.net', Jira_Token: 't', Tempo_Token: 't' };
  await assert.rejects(resolveConflict('2026-01-10', 'e1', ResolveSide.Tempo, secrets, opts), /not open/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
