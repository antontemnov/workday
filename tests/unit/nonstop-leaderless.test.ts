/**
 * Unit tests for the Nonstop (always_on) leaderless fix: a Superseded pause
 * requires a live leader. An Always-on session drained to zero on a leaderless
 * tick keeps accruing — and a stuck Superseded pause from the pre-fix era is
 * closed on the first leaderless tick (self-heal).
 *
 * Run: npx tsx tests/unit/nonstop-leaderless.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { createEmptyLog, createEmptyEvidence } from '../../src/core/daily-log.js';
import { computeWorkingDate } from '../../src/core/config.js';
import { SessionState, PauseSource } from '../../src/core/types.js';
import type { AppConfig, PollResult, Session } from '../../src/core/types.js';

const POLL_SECONDS = 30;

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

function makeConfig(perRepo: Record<string, string>): AppConfig {
  return {
    repos: ['/tmp/repoA', '/tmp/repoB'],
    boundaryHour: 4,
    timezone: 'UTC',
    tracking: { projectKeys: ['ATL'], branchOwners: [] },
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
    sensitivity: { default: 'normal', perRepo },
  } as unknown as AppConfig;
}

const TODAY = computeWorkingDate(Date.now(), 4, 'UTC');

interface PollSpec {
  repo?: string;
  branch?: string;
  task?: string;
  dyn?: boolean;
}

function poll(spec: PollSpec = {}): PollResult {
  const branch = spec.branch ?? 'atemnov/ATL-1-feature';
  return {
    repoPath: spec.repo ?? '/tmp/repoA',
    branch,
    task: spec.task ?? 'ATL-1',
    snapshot: {
      branch,
      trackedLines: { added: 0, removed: 0 },
      trackedFileCount: 0,
      untrackedCount: 0,
      timestamp: Date.now(),
      churnFiles: new Map(),
    },
    delta: {
      addedDelta: spec.dyn ? 1 : 0,
      removedDelta: 0,
      untrackedDelta: 0,
      hasDynamics: spec.dyn ?? false,
      magnitude: spec.dyn ? 4 : 0,
    },
    newReflogEntries: [],
    currentHead: 'head1',
    evidenceSnapshot: null,
    evidenceBasis: null,
    mergeBaseSha: null,
    prevEvidenceSnapshot: null,
    ledgerUpdate: null,
    foreignCheckouts: [],
  };
}

function pollB(spec: PollSpec = {}): PollResult {
  return poll({ repo: '/tmp/repoB', branch: 'atemnov/ATL-2-fix', task: 'ATL-2', ...spec });
}

function makeHarness(perRepo: Record<string, string>, initialLog?: ReturnType<typeof createEmptyLog>) {
  const tracker = new SessionTracker(makeConfig(perRepo), initialLog);
  const evaluator = new ActivityEvaluator(POLL_SECONDS);
  tracker.onSessionClosed = (id) => evaluator.removeSession(id);
  const tick = (results: PollResult[]): void => {
    for (const r of results) tracker.processPollResult(r);
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs(results)));
  };
  return { tracker, evaluator, tick };
}

console.log('Nonstop on a leaderless tick');

test('always_on: drained to zero with no competitor → never pauses', () => {
  const { tracker, tick } = makeHarness({ repoA: 'always_on' });
  tick([poll({ dyn: true })]); // activate
  const session = tracker.getOpenSessions()[0];
  assert.ok(session, 'session activated');

  // Way past the touch-floor drain (~23 ticks) and the full ceiling (90 ticks)
  for (let i = 0; i < 150; i++) {
    tick([poll({})]);
    assert.equal(tracker.hasOpenPause(session), false, `paused at idle tick ${i + 1}`);
  }
  assert.equal(session.pauses.length, 0, 'no pause was ever opened');
  assert.equal(session.closedBy, null, 'still open');
});

test('normal sensitivity still idle-pauses after the drain (regression guard)', () => {
  const { tracker, tick } = makeHarness({});
  tick([poll({ dyn: true })]);
  const session = tracker.getOpenSessions()[0];
  for (let i = 0; i < 300 && !tracker.hasOpenPause(session); i++) tick([poll({})]);
  assert.ok(tracker.hasOpenPause(session), 'drained into a pause');
  assert.equal(session.pauses[session.pauses.length - 1].source, PauseSource.IdleTimeout);
});

test('two idle always_on sessions accrue in parallel (honest double tracking)', () => {
  const { tracker, tick } = makeHarness({ repoA: 'always_on', repoB: 'always_on' });
  tick([poll({ dyn: true }), pollB({})]); // A activates, leads
  // B works long enough to take leadership and promote
  for (let i = 0; i < 10; i++) tick([poll({}), pollB({ dyn: true })]);
  assert.equal(tracker.getOpenSessions().length, 2, 'both sessions in the log');

  // Everything goes silent: both drain to zero, leader disappears
  for (let i = 0; i < 150; i++) tick([poll({}), pollB({})]);
  for (const s of tracker.getOpenSessions()) {
    assert.equal(tracker.hasOpenPause(s), false, `${s.repo} paused while leaderless`);
  }
});

console.log('\nSupersession by a live leader still works');

test('always_on yields to an active leader, resumes when the leader drains', () => {
  const { tracker, tick } = makeHarness({ repoA: 'always_on' });
  tick([poll({ dyn: true })]); // A activates, leads
  const sessionA = tracker.getOpenSessions()[0];

  // B (normal) works tick after tick → takes leadership, A is superseded
  for (let i = 0; i < 10; i++) tick([poll({}), pollB({ dyn: true })]);
  const sessionB = tracker.getOpenSessions().find(s => s.repo === 'repoB');
  assert.ok(sessionB, 'B promoted');
  assert.ok(tracker.hasOpenPause(sessionA), 'A paused while B leads');
  assert.equal(sessionA.pauses[sessionA.pauses.length - 1].source, PauseSource.Superseded);

  // B goes silent too: it drains into IdleTimeout, the leader disappears —
  // and the leaderless tick resumes A
  for (let i = 0; i < 300 && !tracker.hasOpenPause(sessionB!); i++) tick([poll({}), pollB({})]);
  assert.ok(tracker.hasOpenPause(sessionB!), 'B drained into a pause');
  assert.equal(sessionB!.pauses[sessionB!.pauses.length - 1].source, PauseSource.IdleTimeout);
  assert.equal(tracker.hasOpenPause(sessionA), false, 'A resumed on the leaderless tick');
});

console.log('\nSelf-heal of a stuck pre-fix pause');

test('open superseded pause on an always_on session closes on the first leaderless tick', () => {
  const log = createEmptyLog(TODAY, makeConfig({ repoA: 'always_on' }));
  const nowIso = new Date().toISOString();
  const stuck: Session = {
    id: 'stuck001',
    repo: 'repoA',
    task: 'ATL-1',
    branch: 'atemnov/ATL-1-feature',
    state: SessionState.Active,
    startedAt: nowIso,
    activatedAt: nowIso,
    lastSeenAt: nowIso,
    closedBy: null,
    evidence: createEmptyEvidence(),
    pauses: [{ from: nowIso, to: null, source: PauseSource.Superseded }],
    baseSha: null,
    mergeBaseSha: null,
    evidenceBaseline: null,
    lastBranchCommits: null,
    ledger: null,
  };
  log.sessions.push(stuck);

  const { tracker, tick } = makeHarness({ repoA: 'always_on' }, log);
  const session = tracker.getOpenSessions()[0];
  assert.ok(tracker.hasOpenPause(session), 'stuck pause loaded');

  tick([poll({})]); // no activity anywhere — leaderless
  assert.equal(tracker.hasOpenPause(session), false, 'stuck pause closed');
  assert.ok(session.pauses[0].to, 'pause got an end timestamp');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
