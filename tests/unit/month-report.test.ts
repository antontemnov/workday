/**
 * Unit tests for the month aggregate (timesheets tab backend):
 * status derivation, task lines, totals, lastPushAt.
 *
 * Run: npx tsx tests/unit/month-report.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { createEmptyLog, writeDailyLog } from '../../src/core/daily-log.js';
import { buildMonthResponse, getMonthRange, parseYearMonth } from '../../src/push/month-report.js';
import { savePushLog } from '../../src/push/push-log.js';
import { saveMonthSnapshot } from '../../src/push/tempo-snapshot.js';
import { DayStatus, MonthDayStatus, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, DailyLog, ManualEntry, TempoWorklog } from '../../src/core/types.js';

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

function makeEntry(over: Partial<ManualEntry> & { task: string; minutes: number }): ManualEntry {
  return {
    id: over.id ?? Math.random().toString(16).slice(2),
    task: over.task,
    minutes: over.minutes,
    description: over.description ?? 'Daily standup',
    activity: over.activity ?? 'Meeting',
    createdAt: '2026-06-10T09:00:00.000Z',
    ...(over.sourceSessionId ? { sourceSessionId: over.sourceSessionId } : {}),
  };
}

function writeDay(config: AppConfig, date: string, mutate: (log: DailyLog) => void): void {
  const log = createEmptyLog(date, config);
  mutate(log);
  writeDailyLog(log);
}

const config = makeConfig();

// June 2026 fixture:
//  02 — pending (draft, never pushed): standalone 30m + session-born 50m on ATL-2
//  03 — pushed (status pushed, pushedAt set)
//  04 — outdated (draft, but pushedAt set)
//  rest — no data
writeDay(config, '2026-06-02', log => {
  log.manualEntries.push(makeEntry({ task: 'ATL-1', minutes: 30 }));
  log.manualEntries.push(makeEntry({ task: 'ATL-2', minutes: 50, sourceSessionId: 'dead-beef', description: '', activity: 'Development' }));
});
writeDay(config, '2026-06-03', log => {
  log.manualEntries.push(makeEntry({ task: 'ATL-1', minutes: 60 }));
  log.status = DayStatus.Pushed;
  log.pushedAt = '2026-06-03T18:00:00.000Z';
});
writeDay(config, '2026-06-04', log => {
  log.manualEntries.push(makeEntry({ task: 'ATL-3', minutes: 45 }));
  log.status = DayStatus.Draft;
  log.pushedAt = '2026-06-04T19:30:00.000Z';
});

const month = buildMonthResponse(2026, 6, config);
const byDate = new Map(month.days.map(d => [d.date, d]));

console.log('Month report — month-report');

test('getMonthRange handles month lengths', () => {
  assert.deepEqual(getMonthRange(2026, 6), { from: '2026-06-01', to: '2026-06-30' });
  assert.deepEqual(getMonthRange(2026, 7), { from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(getMonthRange(2024, 2), { from: '2024-02-01', to: '2024-02-29' });
});

test('parseYearMonth accepts YYYY-MM only', () => {
  assert.deepEqual(parseYearMonth('2026-06'), { year: 2026, month: 6 });
  assert.equal(parseYearMonth('2026-13'), null);
  assert.equal(parseYearMonth('2026-6'), null);
  assert.equal(parseYearMonth('junk'), null);
});

test('full calendar month, oldest first', () => {
  assert.equal(month.days.length, 30);
  assert.equal(month.days[0].date, '2026-06-01');
  assert.equal(month.days[29].date, '2026-06-30');
});

test('day without data → none', () => {
  const day = byDate.get('2026-06-01')!;
  assert.equal(day.status, MonthDayStatus.None);
  assert.equal(day.dayType, null);
  assert.equal(day.taskCount, 0);
  assert.equal(day.claimedMs, 0);
});

test('draft never pushed → pending', () => {
  assert.equal(byDate.get('2026-06-02')!.status, MonthDayStatus.Pending);
});

test('status pushed → pushed', () => {
  assert.equal(byDate.get('2026-06-03')!.status, MonthDayStatus.Pushed);
});

test('draft with pushedAt → outdated', () => {
  assert.equal(byDate.get('2026-06-04')!.status, MonthDayStatus.Outdated);
});

test('session-born entry folds into a rounded session line', () => {
  const day = byDate.get('2026-06-02')!;
  // 50m session-born → rounded to 45m (15m blocks); standalone 30m exact.
  const session = day.tasks.find(t => t.kind === 'session');
  const manual = day.tasks.find(t => t.kind === 'manual');
  assert.equal(session?.task, 'ATL-2');
  assert.equal(session?.seconds, 45 * 60);
  assert.equal(manual?.task, 'ATL-1');
  assert.equal(manual?.seconds, 30 * 60);
  assert.equal(day.taskCount, 2);
  assert.equal(day.reportedSeconds, 75 * 60);
  assert.equal(day.claimedMs, 80 * 60_000); // raw, unrounded
});

test('totals count statuses and sum hours', () => {
  assert.equal(month.totals.daysWithData, 3);
  assert.equal(month.totals.pendingDays, 1);
  assert.equal(month.totals.pushedDays, 1);
  assert.equal(month.totals.outdatedDays, 1);
  assert.equal(month.totals.reportedSeconds, (75 + 60 + 45) * 60);
});

test('lastPushAt is the max pushedAt across the month', () => {
  assert.equal(month.lastPushAt, '2026-06-04T19:30:00.000Z');
});

test('no snapshot → legacy statuses, no drift field, syncedAt null', () => {
  assert.equal(month.syncedAt, null);
  assert.equal(byDate.get('2026-06-03')!.drift, undefined);
});

// ─── Diff-based statuses: July has a Tempo snapshot on disk ─────────────
//  01 — pushed flag, parity            → pushed
//  02 — draft flag + pushedAt, parity  → pushed (stuck-OUTDATED self-heal)
//  03 — pushed flag, remote time edit  → outdated + drift line
//  04 — never pushed                   → pending, drift "not pushed"

writeDay(config, '2026-07-01', log => {
  log.manualEntries.push(makeEntry({ id: 'm1', task: 'ATL-1', minutes: 30 }));
  log.status = DayStatus.Pushed;
  log.pushedAt = '2026-07-01T18:00:00.000Z';
});
writeDay(config, '2026-07-02', log => {
  log.manualEntries.push(makeEntry({ id: 'm2', task: 'ATL-1', minutes: 30 }));
  log.status = DayStatus.Draft; // edited-then-reverted: flag says outdated
  log.pushedAt = '2026-07-02T18:00:00.000Z';
});
writeDay(config, '2026-07-03', log => {
  log.manualEntries.push(makeEntry({ id: 'm3', task: 'ATL-1', minutes: 30 }));
  log.status = DayStatus.Pushed; // flag says pushed, Tempo says otherwise
  log.pushedAt = '2026-07-03T18:00:00.000Z';
});
writeDay(config, '2026-07-04', log => {
  log.manualEntries.push(makeEntry({ id: 'm4', task: 'ATL-1', minutes: 30 }));
});

savePushLog({
  '2026-07-01|ATL-1|m:m1': { tempoWorklogId: 900, timeSpentSeconds: 1800, pushedAt: 'x', description: 'Daily standup', activity: 'Meeting' },
  '2026-07-02|ATL-1|m:m2': { tempoWorklogId: 901, timeSpentSeconds: 1800, pushedAt: 'x', description: 'Daily standup', activity: 'Meeting' },
  '2026-07-03|ATL-1|m:m3': { tempoWorklogId: 902, timeSpentSeconds: 1800, pushedAt: 'x', description: 'Daily standup', activity: 'Meeting' },
});

function snapWl(id: number, date: string, seconds: number): TempoWorklog {
  return { tempoWorklogId: id, issueId: 1, startDate: date, timeSpentSeconds: seconds, description: 'Daily standup', activity: 'Meeting' };
}

saveMonthSnapshot({
  month: '2026-07',
  accountId: 'acc',
  fetchedAt: '2026-07-07T10:00:00.000Z',
  worklogs: [
    snapWl(900, '2026-07-01', 1800),
    snapWl(901, '2026-07-02', 1800),
    snapWl(902, '2026-07-03', 7200), // remote edit: 0.5h → 2h
  ],
});

const july = buildMonthResponse(2026, 7, config);
const julyByDate = new Map(july.days.map(d => [d.date, d]));

console.log('');
console.log('Month report — diff-based statuses (snapshot present)');

test('syncedAt carries the snapshot fetchedAt', () => {
  assert.equal(july.syncedAt, '2026-07-07T10:00:00.000Z');
});

test('parity + pushed flag → pushed, empty drift', () => {
  const day = julyByDate.get('2026-07-01')!;
  assert.equal(day.status, MonthDayStatus.Pushed);
  assert.deepEqual(day.drift, []);
});

test('parity heals a stuck-OUTDATED flag → pushed', () => {
  const day = julyByDate.get('2026-07-02')!;
  assert.equal(day.status, MonthDayStatus.Pushed);
  assert.deepEqual(day.drift, []);
});

test('remote time edit overrides a pushed flag → outdated + drift line', () => {
  const day = julyByDate.get('2026-07-03')!;
  assert.equal(day.status, MonthDayStatus.Outdated);
  assert.equal(day.drift?.length, 1);
  assert.match(day.drift![0], /2\.0h in Tempo vs 0\.5h local/);
});

test('never-pushed day → pending with "not pushed" drift', () => {
  const day = julyByDate.get('2026-07-04')!;
  assert.equal(day.status, MonthDayStatus.Pending);
  assert.equal(day.drift?.length, 1);
  assert.match(day.drift![0], /not pushed/);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
