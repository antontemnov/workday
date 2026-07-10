/**
 * Unit tests for the month aggregate (timesheets tab backend):
 * status derivation, task lines, totals, lastPushAt.
 *
 * Run: npx tsx tests/unit/month-report.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { createEmptyLog, writeDailyLog, readDailyLog } from '../../src/core/daily-log.js';
import { buildMonthResponse, getMonthRange, parseYearMonth } from '../../src/push/month-report.js';
import { savePushLog, saveTombstones } from '../../src/push/push-log.js';
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

test('manual task line carries its entryId — the timesheets edit handle', () => {
  const manual = byDate.get('2026-06-03')!.tasks.find(t => t.kind === 'manual');
  const entry = readDailyLog('2026-06-03')!.manualEntries[0];
  assert.equal(manual?.entryId, entry.id);
});

test('session-born entry folds into a rounded session line', () => {
  const day = byDate.get('2026-06-02')!;
  // 50m session-born → rounded to 45m (15m blocks); standalone 30m exact.
  const session = day.tasks.find(t => t.kind === 'session');
  const manual = day.tasks.find(t => t.kind === 'manual');
  assert.equal(session?.task, 'ATL-2');
  assert.equal(session?.seconds, 45 * 60);
  assert.equal(session?.entryId, undefined);
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

function snapWl(id: number, date: string, seconds: number, over: Partial<TempoWorklog> = {}): TempoWorklog {
  return { tempoWorklogId: id, issueId: 1, startDate: date, timeSpentSeconds: seconds, description: 'Daily standup', activity: 'Meeting', ...over };
}

// 905 was pushed then deleted locally — pending delete, must not render as foreign.
saveTombstones([{ date: '2026-07-05', task: 'ATL-1', entryId: 'dead', tempoWorklogId: 905, deletedAt: 'x' }]);

saveMonthSnapshot({
  month: '2026-07',
  accountId: 'acc',
  fetchedAt: '2026-07-07T10:00:00.000Z',
  worklogs: [
    snapWl(900, '2026-07-01', 1800),
    snapWl(901, '2026-07-02', 1800),
    snapWl(902, '2026-07-03', 7200), // remote edit: 0.5h → 2h
    // Foreign rows: created directly in Tempo, we own none of these.
    snapWl(903, '2026-07-05', 7200, { issueId: 2, description: 'code review', activity: 'CodeReview' }),
    snapWl(904, '2026-07-01', 1800, { issueId: 2 }),
    snapWl(905, '2026-07-05', 600),  // tombstoned — excluded
    snapWl(906, '2026-07-06', 900, { issueId: 99 }), // unknown issue id
  ],
  issueKeys: { '1': 'ATL-1', '2': 'IN-2' },
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
console.log('Month report — foreign worklogs (Tempo-only rows)');

test('foreign worklog on an empty day → row + hours, no local lines', () => {
  const day = julyByDate.get('2026-07-05')!;
  assert.equal(day.tasks.length, 1);
  assert.equal(day.tasks[0].kind, 'foreign');
  assert.equal(day.tasks[0].task, 'IN-2');
  assert.equal(day.tasks[0].description, 'code review');
  assert.equal(day.tasks[0].activity, 'CodeReview');
  assert.equal(day.reportedSeconds, 7200);
});

test('fully-cleared pushed day (alive tombstone, no file) → outdated with drift', () => {
  // 07-05 has no day file, but tombstone 905 still lives in Tempo — the
  // pending remote delete must surface (and count into the push badge).
  const day = julyByDate.get('2026-07-05')!;
  assert.equal(day.status, MonthDayStatus.Outdated);
  assert.equal(day.drift?.length, 1);
  assert.match(day.drift![0], /pending delete in Tempo/);
});

test('foreign worklog joins a day with local data, status unaffected', () => {
  const day = julyByDate.get('2026-07-01')!;
  assert.equal(day.status, MonthDayStatus.Pushed);
  assert.deepEqual(day.drift, []);
  const foreign = day.tasks.filter(t => t.kind === 'foreign');
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].task, 'IN-2');
  assert.equal(day.reportedSeconds, 1800 + 1800);
});

test('tombstoned worklog is pending delete, not a foreign row', () => {
  const day = julyByDate.get('2026-07-05')!;
  assert.ok(!day.tasks.some(t => t.seconds === 600));
});

test('unresolved issue id falls back to issue #id', () => {
  const day = julyByDate.get('2026-07-06')!;
  assert.equal(day.tasks.length, 1);
  assert.equal(day.tasks[0].kind, 'foreign');
  assert.equal(day.tasks[0].task, 'issue #99');
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
