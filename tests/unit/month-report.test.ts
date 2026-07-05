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
import { DayStatus, MonthDayStatus, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, DailyLog, ManualEntry } from '../../src/core/types.js';

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

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
