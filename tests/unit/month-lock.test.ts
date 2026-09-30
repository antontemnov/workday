/**
 * Unit tests for the closed-month lock (month-lock.ts + SessionTracker): the
 * submit window (last 3 working days), the cut at the moment the month
 * closed (sessions after it go, sessions across it end there, entries
 * created after it go unless they own a Tempo worklog), and the tracker
 * lock (no candidates, open sessions end at their last seen activity).
 *
 * Run: npx tsx tests/unit/month-lock.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { createEmptyLog, computeEffectiveDuration } from '../../src/core/daily-log.js';
import { cutDayAt, inSubmissionWindow, isEmptyCut, monthDates, submissionWindowStart } from '../../src/core/month-lock.js';
import { ClosedBy, PauseSource, SessionState, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, DailyLog, ManualEntry, Pause, PollResult, Session } from '../../src/core/types.js';

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

const config: AppConfig = {
  repos: ['/tmp/repoA'],
  boundaryHour: 4,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: [] },
  genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5],
  holidays: [],
  apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal },
};

// ─── Submit window ────────────────────────────────────────────────────────

console.log('Submit window');

test('September 2026 ends on Wednesday → the window opens Monday 28', () => {
  assert.equal(submissionWindowStart(2026, 9, config), '2026-09-28');
  assert.equal(inSubmissionWindow('2026-09-27', config), false);
  assert.equal(inSubmissionWindow('2026-09-28', config), true);
  assert.equal(inSubmissionWindow('2026-09-30', config), true);
});

test('weekends inside the window do not count as working days, but stay in it', () => {
  // August 2026: Mon 31, Fri 28, Thu 27.
  assert.equal(submissionWindowStart(2026, 8, config), '2026-08-27');
  assert.equal(inSubmissionWindow('2026-08-29', config), true);
  assert.equal(inSubmissionWindow('2026-08-26', config), false);
});

test('every date of a month', () => {
  assert.equal(monthDates('2026-02').length, 28);
  assert.equal(monthDates('2026-09').at(-1), '2026-09-30');
});

test('a day off at the end of the month moves the window earlier', () => {
  assert.equal(submissionWindowStart(2026, 8, { ...config, holidays: ['2026-08-31'] }), '2026-08-26');
});

// ─── Cut ──────────────────────────────────────────────────────────────────

console.log('\nCut at the moment the month closed');

const CUT = '2026-09-30T11:55:07.000Z';
const TEMPO_CUT = '2026-09-30T11:55:07Z';
const at = (hhmm: string): string => `2026-09-30T${hhmm}:00.000Z`;

function session(id: string, activatedAt: string | null, lastSeenAt: string, closedBy: ClosedBy | null, pauses: Pause[] = [], startedAt?: string): Session {
  return {
    id, repo: 'repoA', task: 'ATL-1', branch: 'b', state: activatedAt ? SessionState.Active : SessionState.Pending,
    startedAt: startedAt ?? activatedAt ?? lastSeenAt, activatedAt, lastSeenAt, closedBy, pauses,
  } as unknown as Session;
}

function entry(id: string, createdAt: string): ManualEntry {
  return { id, task: 'ATL-1', minutes: 60, description: 'x', activity: 'Other', createdAt };
}

function day(sessions: Session[], entries: ManualEntry[] = []): DailyLog {
  const log = createEmptyLog('2026-09-30', config);
  log.sessions = sessions;
  log.manualEntries = entries;
  return log;
}

const none = (): boolean => false;

test('a session over before the submit stays as it is', () => {
  const log = day([session('a', at('09:00'), at('11:00'), ClosedBy.IdleTimeout)]);
  const cut = cutDayAt(log, CUT, none);
  assert.equal(isEmptyCut(cut), true);
  assert.equal(log.sessions[0].lastSeenAt, at('11:00'));
});

test('a session activated after the submit is removed', () => {
  const log = day([session('a', at('12:00'), at('12:30'), ClosedBy.DaemonStop)]);
  const cut = cutDayAt(log, CUT, none);
  assert.deepEqual(cut.removedSessionIds, ['a']);
  assert.equal(log.sessions.length, 0);
});

test('a pending session born after the submit is removed', () => {
  const log = day([session('p', null, at('12:05'), ClosedBy.DaemonStop, [], at('12:00'))]);
  assert.deepEqual(cutDayAt(log, CUT, none).removedSessionIds, ['p']);
});

test('an open session across the submit ends there, closed by the month', () => {
  const log = day([session('a', at('11:00'), at('12:20'), null)]);
  const cut = cutDayAt(log, CUT, none);
  assert.deepEqual(cut.closedSessionIds, ['a']);
  assert.equal(log.sessions[0].lastSeenAt, CUT);
  assert.equal(log.sessions[0].closedBy, ClosedBy.MonthClosed);
  assert.equal(computeEffectiveDuration(log.sessions[0]), (55 * 60 + 7) * 1000);
});

test('a closed session across the submit ends there, its own close reason kept', () => {
  const log = day([session('a', at('11:00'), at('12:20'), ClosedBy.DaemonStop)]);
  cutDayAt(log, TEMPO_CUT, none);
  assert.equal(log.sessions[0].lastSeenAt, CUT);
  assert.equal(log.sessions[0].closedBy, ClosedBy.DaemonStop);
});

test('a pause running at the submit is where the session really ended', () => {
  const pauses: Pause[] = [
    { from: at('10:00'), to: at('10:10'), source: PauseSource.IdleTimeout },
    { from: at('11:40'), to: at('12:10'), source: PauseSource.IdleTimeout },
    { from: at('12:15'), to: null, source: PauseSource.IdleTimeout },
  ];
  const log = day([session('a', at('09:00'), at('12:30'), null, pauses)]);
  cutDayAt(log, CUT, none);
  assert.equal(log.sessions[0].lastSeenAt, at('11:40'));
  assert.deepEqual(log.sessions[0].pauses.map(p => p.from), [at('10:00')]);
});

test('entries created after the submit go, unless they own a Tempo worklog', () => {
  const log = day([], [entry('before', at('11:50')), entry('after', at('12:00')), entry('taken', at('12:03'))]);
  const cut = cutDayAt(log, CUT, e => e.id === 'taken');
  assert.deepEqual(cut.removedEntries.map(e => e.id), ['after']);
  assert.deepEqual(log.manualEntries.map(e => e.id), ['before', 'taken']);
});

// ─── Tracker lock ─────────────────────────────────────────────────────────

console.log('\nTracker lock');

function poll(dyn: boolean): PollResult {
  const branch = 'atemnov/ATL-1-feature';
  return {
    repoPath: '/tmp/repoA', branch, task: 'ATL-1',
    snapshot: { branch, trackedLines: { added: 0, removed: 0 }, trackedFileCount: 0, untrackedCount: 0, timestamp: Date.now(), evidenceBase: null, churnFiles: new Map() },
    delta: { addedDelta: dyn ? 1 : 0, removedDelta: 0, untrackedDelta: 0, hasDynamics: dyn, magnitude: dyn ? 4 : 0 },
    newReflogEntries: [], currentHead: 'head1', evidenceSnapshot: null, evidenceBasis: null, mergeBaseSha: null,
    prevEvidenceSnapshot: null, ledgerUpdate: null, farewellLedgerUpdate: null, reanchored: false,
    uncommitted: { linesAdded: 0, linesRemoved: 0, filesChanged: 0 }, prevUncommitted: null, foreignCheckouts: [],
  };
}

function harness() {
  const tracker = new SessionTracker({ ...config, workDays: [1, 2, 3, 4, 5, 6, 7] });
  const evaluator = new ActivityEvaluator(30);
  tracker.onSessionClosed = id => evaluator.removeSession(id);
  const tick = (dyn: boolean): void => {
    tracker.processPollResult(poll(dyn));
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs([poll(dyn)])));
  };
  return { tracker, tick };
}

test('locked: activity births nothing', () => {
  const h = harness();
  h.tracker.setMonthLock(true);
  for (let i = 0; i < 5; i++) h.tick(true);
  assert.equal(h.tracker.getCandidates().length, 0);
  assert.equal(h.tracker.getOpenSessions().length, 0);
  assert.equal(h.tracker.getDailyLog().signals.length, 0);
});

test('lock on: the open session ends at its last seen activity, candidates evaporate', () => {
  const h = harness();
  h.tick(true);
  const open = h.tracker.getOpenSessions()[0];
  assert.ok(open, 'session activated');
  const lastSeen = open.lastSeenAt;
  h.tracker.setMonthLock(true);
  assert.equal(h.tracker.isMonthLocked(), true);
  assert.equal(open.closedBy, ClosedBy.MonthClosed);
  assert.equal(open.lastSeenAt, lastSeen);
  assert.equal(h.tracker.getOpenSessions().length, 0);
});

test('lock off: tracking comes back', () => {
  const h = harness();
  h.tracker.setMonthLock(true);
  h.tracker.setMonthLock(false);
  h.tick(true);
  assert.equal(h.tracker.getOpenSessions().length, 1);
});

test('applyMonthCut cuts today in memory', () => {
  const h = harness();
  h.tick(true);
  const open = h.tracker.getOpenSessions()[0];
  const cut = h.tracker.applyMonthCut(new Date(Date.parse(open.activatedAt!) - 1000).toISOString(), none);
  assert.deepEqual(cut.removedSessionIds, [open.id]);
  assert.equal(h.tracker.getDailyLog().sessions.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
