/**
 * Unit tests for the report-side clamp: an open session on a PAST day ends
 * at lastSeenAt in the report, never at Date.now() (hard-killed daemon
 * pushed before the next start / orphans older than recovery lookback).
 *
 * Run: npx tsx tests/unit/report-clamp.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { buildReport } from '../../src/push/report-builder.js';
import { createEmptyLog, writeDailyLog } from '../../src/core/daily-log.js';
import { computeWorkingDate } from '../../src/core/config.js';
import { SessionState, PauseSource } from '../../src/core/types.js';
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

const config = {
  repos: [],
  boundaryHour: 4,
  timezone: 'UTC',
  taskPattern: 'ATL-\\d+',
  genericBranches: [],
  session: {
    diffPollSeconds: 30,
    signalDeduplicationSeconds: 300,
    dayBoundaryCheckSeconds: 60,
    reflogCount: 20,
  },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  sensitivity: { default: 'normal', perRepo: {} },
} as unknown as AppConfig;

const NOW = Date.now();
const HOUR = 3_600_000;
const TODAY = computeWorkingDate(NOW, 4, 'UTC');
const YESTERDAY = computeWorkingDate(NOW - 24 * HOUR, 4, 'UTC');

function session(over: Partial<Session>): Session {
  return {
    id: over.id ?? 's1',
    repo: 'repoA',
    task: over.task ?? 'ATL-9',
    branch: 'atemnov/ATL-9-x',
    state: SessionState.Active,
    startedAt: over.startedAt ?? over.activatedAt ?? new Date(NOW).toISOString(),
    activatedAt: over.activatedAt ?? null,
    lastSeenAt: over.lastSeenAt ?? new Date(NOW).toISOString(),
    closedBy: over.closedBy ?? null,
    evidence: { commits: 0, reflogEvents: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    pauses: over.pauses ?? [],
    manualAdjustments: [],
    baseSha: null,
    mergeBaseSha: null,
    evidenceBaseline: null,
    lastBranchCommits: null,
    ledger: null,
  };
}

console.log('Report-side clamp for open sessions of past days');

test('yesterday\'s open session (hard kill, no open pause) ends at lastSeenAt', () => {
  const log = createEmptyLog(YESTERDAY, config);
  // activated 26h ago, last poll 24h ago → honest 2h; without the clamp the
  // report would count all the way to Date.now() (~26h)
  log.sessions.push(session({
    activatedAt: new Date(NOW - 26 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 24 * HOUR).toISOString(),
  }));
  writeDailyLog(log);

  const entries = buildReport(YESTERDAY, YESTERDAY, config);
  const entry = entries.find(e => e.task === 'ATL-9');
  assert.ok(entry, 'entry exists');
  assert.equal(entry.totalSeconds, 2 * 3600, `totalSeconds = ${entry.totalSeconds}, expected 7200`);
});

test('yesterday\'s open session with an open pause: pause also ends at lastSeenAt', () => {
  const log = createEmptyLog(YESTERDAY, config);
  // 10:00→12:00 with a pause open since 11:30 → 90 min of work
  log.sessions.push(session({
    task: 'ATL-11',
    activatedAt: new Date(NOW - 26 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 24 * HOUR).toISOString(),
    pauses: [{ from: new Date(NOW - 24.5 * HOUR).toISOString(), to: null, source: PauseSource.IdleTimeout }],
  }));
  writeDailyLog(log);

  const entries = buildReport(YESTERDAY, YESTERDAY, config);
  const entry = entries.find(e => e.task === 'ATL-11');
  assert.ok(entry, 'entry exists');
  assert.equal(entry.totalSeconds, 1.5 * 3600, `totalSeconds = ${entry.totalSeconds}, expected 5400`);
});

test('today\'s live open session still counts to now', () => {
  const log = createEmptyLog(TODAY, config);
  log.sessions.push(session({
    task: 'ATL-8',
    activatedAt: new Date(NOW - 1 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 30_000).toISOString(),
  }));
  writeDailyLog(log);

  const entries = buildReport(TODAY, TODAY, config);
  const entry = entries.find(e => e.task === 'ATL-8');
  assert.ok(entry, 'entry exists');
  // ~1h to now, rounded to 15-min blocks → exactly 3600
  assert.equal(entry.totalSeconds, 3600, `totalSeconds = ${entry.totalSeconds}, expected 3600`);
});

test('closed sessions of past days are untouched by the clamp', () => {
  const log = createEmptyLog(YESTERDAY, config);
  log.sessions.push(session({
    task: 'ATL-12',
    activatedAt: new Date(NOW - 27 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 26 * HOUR).toISOString(),
    closedBy: 'daemon_stop' as Session['closedBy'],
  }));
  writeDailyLog(log);

  const entries = buildReport(YESTERDAY, YESTERDAY, config);
  const entry = entries.find(e => e.task === 'ATL-12');
  assert.ok(entry, 'entry exists');
  assert.equal(entry.totalSeconds, 3600, `totalSeconds = ${entry.totalSeconds}, expected 3600`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
