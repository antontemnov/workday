/**
 * Unit tests for package D: startup janitor (orphan close, never-activated
 * prune, empty-file purge) and manual session deletion (SessionTracker +
 * offline semantics via daily-log helpers).
 *
 * Run: npx tsx tests/unit/janitor.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { runStartupJanitor, isEmptyDayLog } from '../../src/core/janitor.js';
import {
  createEmptyLog,
  writeDailyLog,
  readDailyLog,
  getDailyLogPath,
  generateSessionId,
  createEmptyEvidence,
} from '../../src/core/daily-log.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { SessionState, ClosedBy, PauseSource, DayStatus } from '../../src/core/types.js';
import type { AppConfig, DailyLog, Session, PollResult } from '../../src/core/types.js';

const POLL_SECONDS = 30;
const CURRENT_DATE = '2026-07-04';

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
    repos: ['/tmp/repoA'],
    boundaryHour: 4,
    timezone: 'UTC',
    taskPattern: 'ATL-\\d+',
    genericBranches: [],
    session: {
      diffPollSeconds: POLL_SECONDS,
      signalDeduplicationSeconds: 300,
      dayBoundaryCheckSeconds: 60,
      reflogCount: 20,
      idleCloseHours: 3,
    },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5, 6, 7],
    holidays: [],
    sensitivity: { default: 'normal', perRepo: {} },
  } as unknown as AppConfig;
}

const CONFIG = makeConfig();

function makeSession(overrides: Partial<Session>): Session {
  const base = '2026-07-01T10:00:00.000Z';
  return {
    id: generateSessionId(),
    repo: 'repoA',
    task: 'ATL-1',
    branch: 'atemnov/ATL-1-x',
    state: SessionState.Active,
    startedAt: base,
    activatedAt: base,
    lastSeenAt: '2026-07-01T12:00:00.000Z',
    closedBy: ClosedBy.DayBoundary,
    evidence: createEmptyEvidence(),
    pauses: [],
    manualAdjustments: [],
    baseSha: null,
    mergeBaseSha: null,
    evidenceBaseline: null,
    lastBranchCommits: null,
    ledger: null,
    ...overrides,
  } as Session;
}

function writeDay(date: string, mutate?: (log: DailyLog) => void): DailyLog {
  const log = createEmptyLog(date, CONFIG);
  mutate?.(log);
  writeDailyLog(log);
  return log;
}

// ─── isEmptyDayLog ───────────────────────────────────────────────────────

console.log('isEmptyDayLog');

test('no sessions, no entries, never pushed → empty', () => {
  assert.equal(isEmptyDayLog(createEmptyLog('2026-06-01', CONFIG)), true);
});

test('a session makes the day non-empty', () => {
  const log = createEmptyLog('2026-06-01', CONFIG);
  log.sessions.push(makeSession({}));
  assert.equal(isEmptyDayLog(log), false);
});

test('a manual entry makes the day non-empty', () => {
  const log = createEmptyLog('2026-06-01', CONFIG);
  log.manualEntries.push({ id: 'm1', task: 'ATL-1', minutes: 30, description: 'x', activity: 'Other', createdAt: '2026-06-01T10:00:00Z' });
  assert.equal(isEmptyDayLog(log), false);
});

test('a pushed day is never empty (push marker preserved)', () => {
  const log = createEmptyLog('2026-06-01', CONFIG);
  log.pushedAt = '2026-06-02T10:00:00Z';
  assert.equal(isEmptyDayLog(log), false);
});

// ─── runStartupJanitor ───────────────────────────────────────────────────

console.log('\nrunStartupJanitor');

test('empty historical files are deleted, real ones survive', () => {
  writeDay('2026-06-10');
  writeDay('2026-06-11', log => { log.sessions.push(makeSession({})); });

  const result = runStartupJanitor(CURRENT_DATE);

  assert.ok(result.deletedFiles.includes('2026-06-10'));
  assert.equal(existsSync(getDailyLogPath('2026-06-10')), false, 'empty file gone');
  assert.equal(existsSync(getDailyLogPath('2026-06-10') + '.bak'), false, 'backup gone too');
  assert.ok(existsSync(getDailyLogPath('2026-06-11')), 'real day survives');
});

test('orphaned open session closes at its trimmed honest end', () => {
  const pauseFrom = '2026-06-12T15:00:00.000Z';
  writeDay('2026-06-12', log => {
    log.sessions.push(makeSession({
      closedBy: null,
      lastSeenAt: '2026-06-12T18:00:00.000Z',
      pauses: [{ from: pauseFrom, to: null, source: PauseSource.IdleTimeout }],
    }));
  });

  const result = runStartupJanitor(CURRENT_DATE);
  assert.equal(result.recoveredSessions, 1);

  const log = readDailyLog('2026-06-12')!;
  assert.equal(log.sessions[0].closedBy, ClosedBy.DaemonCrash);
  assert.equal(log.sessions[0].lastSeenAt, pauseFrom, 'end = where the pause chain began');
  assert.equal(log.sessions[0].pauses.length, 0);
});

test('never-activated sessions are pruned; emptied file is deleted', () => {
  writeDay('2026-06-13', log => {
    log.sessions.push(makeSession({ state: SessionState.Pending, activatedAt: null, closedBy: ClosedBy.DayBoundary }));
  });

  const result = runStartupJanitor(CURRENT_DATE);
  assert.equal(result.prunedSessions >= 1, true);
  assert.equal(existsSync(getDailyLogPath('2026-06-13')), false, 'file emptied by prune → deleted');
});

test('today and future dates are never touched', () => {
  writeDay(CURRENT_DATE);
  writeDay('2026-07-05');

  runStartupJanitor(CURRENT_DATE);

  assert.ok(existsSync(getDailyLogPath(CURRENT_DATE)), 'today untouched');
  assert.ok(existsSync(getDailyLogPath('2026-07-05')), 'future untouched');
});

test('idempotent: second run is a no-op', () => {
  const result = runStartupJanitor(CURRENT_DATE);
  assert.equal(result.recoveredSessions, 0);
  assert.equal(result.prunedSessions, 0);
  assert.equal(result.deletedFiles.length, 0);
});

// ─── SessionTracker.deleteSession ────────────────────────────────────────

console.log('\nSessionTracker.deleteSession');

function poll(dyn: boolean): PollResult {
  const branch = 'atemnov/ATL-1-feature';
  return {
    repoPath: '/tmp/repoA',
    branch,
    task: 'ATL-1',
    snapshot: {
      branch,
      trackedLines: { added: 0, removed: 0 },
      trackedFileCount: 0,
      untrackedCount: 0,
      timestamp: Date.now(),
      churnFiles: new Map(),
    },
    delta: {
      addedDelta: dyn ? 1 : 0,
      removedDelta: 0,
      untrackedDelta: 0,
      hasDynamics: dyn,
      magnitude: dyn ? 4 : 0,
    },
    newReflogEntries: [],
    currentHead: 'head1',
    evidenceSnapshot: null,
    evidenceBasis: null,
    mergeBaseSha: null,
    prevEvidenceSnapshot: null,
    ledgerUpdate: null,
  };
}

function makeTrackerWithSession() {
  const tracker = new SessionTracker(makeConfig());
  const evaluator = new ActivityEvaluator(POLL_SECONDS);
  tracker.onSessionClosed = (id) => evaluator.removeSession(id);
  const tick = (dyn: boolean): void => {
    tracker.processPollResult(poll(dyn));
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs([poll(dyn)])));
  };
  tick(true);
  const session = tracker.getOpenSessions()[0];
  assert.ok(session, 'session activated');
  return { tracker, tick, session };
}

test('delete removes the session and the emptied day file', () => {
  const { tracker, session } = makeTrackerWithSession();
  const date = tracker.getDailyLog().date;
  assert.ok(existsSync(getDailyLogPath(date)), 'day materialized on promotion');

  const result = tracker.deleteSession(session.id);
  assert.equal(result.ok, true);
  assert.equal(result.dayFileDeleted, true);
  assert.equal(tracker.getDailyLog().sessions.length, 0);
  assert.equal(existsSync(getDailyLogPath(date)), false, 'file gone with the last fact');
});

test('delete keeps the file while other facts remain', () => {
  const { tracker, session } = makeTrackerWithSession();
  tracker.addManualEntry({ task: 'ATL-9', minutes: 30, description: 'meeting', activity: 'Other' });
  tracker.flush();

  const result = tracker.deleteSession(session.id);
  assert.equal(result.ok, true);
  assert.equal(result.dayFileDeleted, false);
  const date = tracker.getDailyLog().date;
  assert.ok(existsSync(getDailyLogPath(date)), 'manual entry keeps the day');
});

test('delete by #index works and unknown target errors', () => {
  const { tracker } = makeTrackerWithSession();
  assert.equal(tracker.deleteSession('nope').ok, false);
  const result = tracker.deleteSession('#1');
  assert.equal(result.ok, true);
});

test('pushed day: file survives, status drops to Draft', () => {
  const { tracker, session } = makeTrackerWithSession();
  const log = tracker.getDailyLog();
  log.pushedAt = new Date().toISOString();
  log.status = DayStatus.Pushed;
  tracker.flush();

  const result = tracker.deleteSession(session.id);
  assert.equal(result.ok, true);
  assert.equal(result.dayFileDeleted, false, 'push marker preserved');
  assert.equal(log.status, DayStatus.Draft, 'unsealed for re-sync');
});

test('deleting an open session: next activity births a fresh one', () => {
  const { tracker, tick, session } = makeTrackerWithSession();
  tracker.deleteSession(session.id);
  tick(true);
  const open = tracker.getOpenSessions();
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, session.id);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
