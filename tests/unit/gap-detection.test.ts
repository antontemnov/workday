/**
 * Unit tests for package C (gap detection): observation gaps from PC
 * sleep/hibernate — pure checkGap math and the SessionTracker reaction
 * (retroactive idle pauses, candidate drop, interplay with idle auto-close).
 *
 * Run: npx tsx tests/unit/gap-detection.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { checkGap, gapThresholdMs } from '../../src/core/gap-detector.js';
import { computeEffectiveDuration } from '../../src/core/daily-log.js';
import { ClosedBy, PauseSource } from '../../src/core/types.js';
import type { AppConfig, PollResult } from '../../src/core/types.js';

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

function makeConfig(repos: string[], idleCloseHours = 3): AppConfig {
  return {
    repos,
    boundaryHour: 4,
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

function poll(repoPath: string, task: string, dyn: boolean): PollResult {
  const branch = `atemnov/${task}-feature`;
  return {
    repoPath,
    branch,
    task,
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

/** Single-repo harness with an activated (leader) session. */
function makeActiveSession(idleCloseHours = 3) {
  const tracker = new SessionTracker(makeConfig(['/tmp/repoA'], idleCloseHours));
  const evaluator = new ActivityEvaluator(POLL_SECONDS);
  tracker.onSessionClosed = (id) => evaluator.removeSession(id);
  const tick = (dyn: boolean): void => {
    const p = poll('/tmp/repoA', 'ATL-1', dyn);
    tracker.processPollResult(p);
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs([p])));
  };
  tick(true);
  const session = tracker.getOpenSessions()[0];
  assert.ok(session, 'session activated');
  assert.equal(tracker.hasOpenPause(session), false, 'active, no pause');
  return { tracker, evaluator, tick, session };
}

// ─── checkGap (pure math) ────────────────────────────────────────────────

console.log('checkGap');

test('threshold: floor dominates short polls, multiplier dominates long ones', () => {
  assert.equal(gapThresholdMs(30), 120_000);  // 3×30 = 90s < 120s floor
  assert.equal(gapThresholdMs(60), 180_000);  // 3×60 = 180s > floor
});

test('normal cadence → none', () => {
  const r = checkGap(1_000_000 + 30_000, 1_000_000, POLL_SECONDS);
  assert.equal(r.kind, 'none');
});

test('gap at exactly the threshold → gap', () => {
  const r = checkGap(1_000_000 + 120_000, 1_000_000, POLL_SECONDS);
  assert.equal(r.kind, 'gap');
  assert.equal(r.gapMs, 120_000);
});

test('eight-hour sleep → gap', () => {
  const r = checkGap(1_000_000 + 8 * HOUR_MS, 1_000_000, POLL_SECONDS);
  assert.equal(r.kind, 'gap');
});

test('clock jumped backwards → clock_jump_back, negative gapMs', () => {
  const r = checkGap(1_000_000 - 5_000, 1_000_000, POLL_SECONDS);
  assert.equal(r.kind, 'clock_jump_back');
  assert.ok(r.gapMs < 0);
});

// ─── applyGapPauses ──────────────────────────────────────────────────────

console.log('\napplyGapPauses');

test('active session gets a retro IdleTimeout pause at its pre-gap lastSeenAt', () => {
  const { tracker, session } = makeActiveSession();
  const preGapLastSeen = session.lastSeenAt;
  const paused = tracker.applyGapPauses();
  assert.equal(paused, 1);
  const pause = session.pauses[session.pauses.length - 1];
  assert.equal(pause.source, PauseSource.IdleTimeout);
  assert.equal(pause.from, preGapLastSeen, 'pause opens where observation stopped');
  assert.equal(pause.to, null);
});

test('already-paused session is left alone (pause spans the gap naturally)', () => {
  const { tracker, tick, session } = makeActiveSession();
  for (let i = 0; i < 300 && !tracker.hasOpenPause(session); i++) tick(false);
  assert.ok(tracker.hasOpenPause(session), 'drained into a pause');
  const pausesBefore = session.pauses.length;
  const paused = tracker.applyGapPauses();
  assert.equal(paused, 0);
  assert.equal(session.pauses.length, pausesBefore);
});

test('manual pause is never touched', () => {
  const { tracker, session } = makeActiveSession();
  tracker.pauseAllSessions();
  const paused = tracker.applyGapPauses();
  assert.equal(paused, 0);
  assert.equal(session.pauses[session.pauses.length - 1].source, PauseSource.Manual);
});

test('closed session is skipped', () => {
  const { tracker, session } = makeActiveSession();
  tracker.closeAllSessions(ClosedBy.DaemonStop);
  const paused = tracker.applyGapPauses();
  assert.equal(paused, 0);
  assert.equal(session.pauses.length, 0);
});

// ─── Gap + idle auto-close interplay ─────────────────────────────────────

console.log('\nGap + idle auto-close');

test('long gap (≥ idleCloseHours): session closes at the pre-gap end', () => {
  const { tracker, session } = makeActiveSession(3);
  const preGapLastSeen = session.lastSeenAt;
  tracker.applyGapPauses();
  tracker.closeIdleSessions(Date.parse(preGapLastSeen) + 8 * HOUR_MS);
  assert.equal(session.closedBy, ClosedBy.IdleTimeout);
  assert.equal(session.lastSeenAt, preGapLastSeen, 'honest end = last pre-sleep activity');
  assert.equal(session.pauses.length, 0, 'retro pause trimmed away');
});

test('long gap: the sleep never counts into effective duration', () => {
  const { tracker, session } = makeActiveSession(3);
  const preGapLastSeen = session.lastSeenAt;
  tracker.applyGapPauses();
  tracker.closeIdleSessions(Date.parse(preGapLastSeen) + 8 * HOUR_MS);
  const expected = Date.parse(preGapLastSeen) - Date.parse(session.activatedAt!);
  assert.equal(computeEffectiveDuration(session), expected);
});

test('short gap (< idleCloseHours): session survives, pause stays open', () => {
  const { tracker, session } = makeActiveSession(3);
  tracker.applyGapPauses();
  tracker.closeIdleSessions(Date.parse(session.lastSeenAt) + 1 * HOUR_MS);
  assert.equal(session.closedBy, null);
  assert.ok(tracker.hasOpenPause(session));
});

test('short gap: fresh activity resumes the same session', () => {
  const { tracker, tick, session } = makeActiveSession(3);
  tracker.applyGapPauses();
  tick(true); // wake-up activity — evaluator state was reset in real flow, but touch floor re-earns leadership either way
  assert.equal(session.closedBy, null);
  assert.equal(tracker.hasOpenPause(session), false, 'gap pause closed by resume');
  assert.equal(tracker.getOpenSessions()[0].id, session.id, 'same session continues');
});

test('long gap then activity births a NEW session', () => {
  const { tracker, tick, session } = makeActiveSession(3);
  const preGapLastSeen = session.lastSeenAt;
  tracker.applyGapPauses();
  tracker.closeIdleSessions(Date.parse(preGapLastSeen) + 8 * HOUR_MS);
  tick(true);
  const open = tracker.getOpenSessions();
  assert.equal(open.length, 1);
  assert.notEqual(open[0].id, session.id, 'stale session stays closed; new one born');
});

// ─── Candidates across a gap ─────────────────────────────────────────────

console.log('\nCandidates across a gap');

test('gap drops candidates (stale score must not promote after wake-up)', () => {
  const tracker = new SessionTracker(makeConfig(['/tmp/repoA', '/tmp/repoB']));
  const evaluator = new ActivityEvaluator(POLL_SECONDS);
  tracker.onSessionClosed = (id) => evaluator.removeSession(id);
  const tick = (dynA: boolean, dynB: boolean): void => {
    const pA = poll('/tmp/repoA', 'ATL-1', dynA);
    const pB = poll('/tmp/repoB', 'ATL-2', dynB);
    tracker.processPollResult(pA);
    tracker.processPollResult(pB);
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs([pA, pB])));
  };
  // A earns leadership, then B stirs — B becomes a candidate behind A's hysteresis
  for (let i = 0; i < 5; i++) tick(true, false);
  tick(false, true);
  assert.ok(tracker.getCandidates().length > 0, 'candidate B exists');

  tracker.dropAllCandidates();
  evaluator.clear();
  assert.equal(tracker.getCandidates().length, 0, 'candidates evaporated');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
