/**
 * Unit tests for package B (honest session end): trailing-pause trim on all
 * close paths and idle auto-close (session.idleCloseHours).
 *
 * Run: npx tsx tests/unit/honest-session-end.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { trimTrailingPauses, computeEffectiveDuration } from '../../src/core/daily-log.js';
import { ClosedBy, PauseSource } from '../../src/core/types.js';
import type { AppConfig, PollResult, Session, Pause } from '../../src/core/types.js';

const POLL_SECONDS = 30;
const HOUR_MS = 3_600_000;

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

function makeConfig(idleCloseHours: number): AppConfig {
  return {
    repos: ['/tmp/repoA'],
    schedule: { start: 10, end: 4 },
    timezone: 'UTC',
    taskPattern: 'ATL-\\d+',
    genericBranches: [],
    session: {
      diffPollSeconds: POLL_SECONDS,
      signalDeduplicationSeconds: 300,
      dayBoundaryCheckSeconds: 60,
      reflogCount: 20,
      idleCloseHours,
    },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5, 6, 7],
    holidays: [],
    sensitivity: { default: 'normal', perRepo: {} },
  } as unknown as AppConfig;
}

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

function makeHarness(idleCloseHours = 3) {
  const tracker = new SessionTracker(makeConfig(idleCloseHours));
  const evaluator = new ActivityEvaluator(POLL_SECONDS);
  tracker.onSessionClosed = (id) => evaluator.removeSession(id);
  const tick = (dyn: boolean): void => {
    tracker.processPollResult(poll(dyn));
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs([poll(dyn)])));
  };
  return { tracker, evaluator, tick };
}

/** Activate a session, then drain it into an open IdleTimeout pause. */
function makeIdleSession(idleCloseHours = 3) {
  const h = makeHarness(idleCloseHours);
  h.tick(true);
  const session = h.tracker.getOpenSessions()[0];
  assert.ok(session, 'session activated');
  for (let i = 0; i < 300 && !h.tracker.hasOpenPause(session); i++) h.tick(false);
  assert.ok(h.tracker.hasOpenPause(session), 'drained into a pause');
  const pause = session.pauses[session.pauses.length - 1];
  assert.equal(pause.source, PauseSource.IdleTimeout);
  return { ...h, session, pause };
}

function pauseAt(fromMs: number, toMs: number | null, source: PauseSource): Pause {
  return {
    from: new Date(fromMs).toISOString(),
    to: toMs === null ? null : new Date(toMs).toISOString(),
    source,
  } as Pause;
}

// ─── trimTrailingPauses (pure mechanics) ─────────────────────────────────

console.log('trimTrailingPauses');

const T0 = Date.parse('2026-07-04T10:00:00.000Z');

function bareSession(pauses: Pause[]): Session {
  return { pauses } as unknown as Session;
}

test('no pauses → nothing to trim', () => {
  const s = bareSession([]);
  assert.equal(trimTrailingPauses(s), null);
});

test('closed trailing pause (activity followed) → nothing to trim', () => {
  const s = bareSession([pauseAt(T0, T0 + HOUR_MS, PauseSource.IdleTimeout)]);
  assert.equal(trimTrailingPauses(s), null);
  assert.equal(s.pauses.length, 1, 'record untouched');
});

test('single open pause → end = pause start, pause dropped', () => {
  const s = bareSession([pauseAt(T0, null, PauseSource.IdleTimeout)]);
  assert.equal(trimTrailingPauses(s), new Date(T0).toISOString());
  assert.equal(s.pauses.length, 0);
});

test('back-to-back chain (Superseded → IdleTimeout) trims to chain start', () => {
  const s = bareSession([
    pauseAt(T0, T0 + HOUR_MS, PauseSource.Superseded),
    pauseAt(T0 + HOUR_MS, null, PauseSource.IdleTimeout),
  ]);
  assert.equal(trimTrailingPauses(s), new Date(T0).toISOString());
  assert.equal(s.pauses.length, 0);
});

test('mid-session pause survives, only the trailing chain goes', () => {
  const mid = pauseAt(T0 - 2 * HOUR_MS, T0 - HOUR_MS, PauseSource.IdleTimeout); // resumed → gap after
  const s = bareSession([mid, pauseAt(T0, null, PauseSource.IdleTimeout)]);
  assert.equal(trimTrailingPauses(s), new Date(T0).toISOString());
  assert.deepEqual(s.pauses, [mid]);
});

test('open manual tail is trimmed too', () => {
  const s = bareSession([pauseAt(T0, null, PauseSource.Manual)]);
  assert.equal(trimTrailingPauses(s), new Date(T0).toISOString());
  assert.equal(s.pauses.length, 0);
});

// ─── Close paths trim ────────────────────────────────────────────────────

console.log('\nClose paths use the trimmed end');

test('rollover: evening idle session ends at the pause start, not 04:00', () => {
  const { tracker, session, pause } = makeIdleSession();
  const { oldLog } = tracker.handleDayBoundary();
  const closed = oldLog.sessions.find(s => s.id === session.id)!;
  assert.equal(closed.closedBy, ClosedBy.DayBoundary);
  assert.equal(closed.lastSeenAt, pause.from, 'end = last activity');
  assert.equal(closed.pauses.length, 0, 'trailing pause gone from the record');
});

test('manually built Superseded→IdleTimeout chain: end = chain start', () => {
  const { tracker, session } = makeIdleSession();
  const open = session.pauses[session.pauses.length - 1];
  const openFromMs = Date.parse(open.from);
  session.pauses = [
    pauseAt(openFromMs - HOUR_MS, openFromMs, PauseSource.Superseded),
    open,
  ];
  const { oldLog } = tracker.handleDayBoundary();
  const closed = oldLog.sessions.find(s => s.id === session.id)!;
  assert.equal(closed.lastSeenAt, new Date(openFromMs - HOUR_MS).toISOString());
});

test('crash recovery trims the same way', () => {
  const { tracker, session, pause } = makeIdleSession();
  tracker.closeCrashedSessions();
  assert.equal(session.closedBy, ClosedBy.DaemonCrash);
  assert.equal(session.lastSeenAt, pause.from);
  assert.equal(session.pauses.length, 0);
});

test('crash recovery without a pause keeps the saved lastSeenAt', () => {
  const { tracker, tick } = makeHarness();
  tick(true);
  const session = tracker.getOpenSessions()[0];
  const savedLastSeen = session.lastSeenAt;
  tracker.closeCrashedSessions();
  assert.equal(session.closedBy, ClosedBy.DaemonCrash);
  assert.equal(session.lastSeenAt, savedLastSeen);
});

test('effective duration is unchanged by the trim', () => {
  const { tracker, session, pause } = makeIdleSession();
  tracker.handleDayBoundary();
  const expected = Date.parse(pause.from) - Date.parse(session.activatedAt!);
  assert.equal(computeEffectiveDuration(session), expected);
});

// ─── Idle auto-close ─────────────────────────────────────────────────────

console.log('\nIdle auto-close (session.idleCloseHours)');

test('pause older than the threshold → closed as idle_timeout with honest end', () => {
  const { tracker, session, pause } = makeIdleSession(3);
  tracker.closeIdleSessions(Date.parse(pause.from) + 3 * HOUR_MS + 60_000);
  assert.equal(session.closedBy, ClosedBy.IdleTimeout);
  assert.equal(session.lastSeenAt, pause.from);
  assert.equal(session.pauses.length, 0);
});

test('pause younger than the threshold → session stays open', () => {
  const { tracker, session, pause } = makeIdleSession(3);
  tracker.closeIdleSessions(Date.parse(pause.from) + 2 * HOUR_MS);
  assert.equal(session.closedBy, null);
});

test('new activity after auto-close births a fresh session (lazy machinery)', () => {
  const { tracker, tick, session, pause } = makeIdleSession(3);
  tracker.closeIdleSessions(Date.parse(pause.from) + 4 * HOUR_MS);
  assert.equal(session.closedBy, ClosedBy.IdleTimeout);
  tick(true);
  const open = tracker.getOpenSessions();
  assert.equal(open.length, 1, 'new session born and promoted');
  assert.notEqual(open[0].id, session.id);
});

test('manual pause is never auto-closed', () => {
  const { tracker, tick } = makeHarness(3);
  tick(true);
  const session = tracker.getOpenSessions()[0];
  tracker.pauseAllSessions();
  tracker.closeIdleSessions(Date.now() + 10 * HOUR_MS);
  assert.equal(session.closedBy, null, 'frozen session waits for the user');
});

test('idleCloseHours: 0 disables auto-close', () => {
  const { tracker, session, pause } = makeIdleSession(0);
  tracker.closeIdleSessions(Date.parse(pause.from) + 24 * HOUR_MS);
  assert.equal(session.closedBy, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
