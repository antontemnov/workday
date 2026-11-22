/**
 * Simulation tests for "a session or a timer": a running manual timer sits
 * in the leader's seat of the ActivityEvaluator. A single stray edit never
 * takes the count from it, edits tick after tick do within about a minute,
 * and the timer gets the count back once every session has faded.
 *
 * Run: npx tsx tests/unit/timer-arbitration.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { createEmptyLog, createEmptyEvidence } from '../../src/core/daily-log.js';
import { TIMER_DEFENSE_ATTENTION } from '../../src/core/constants.js';
import { PauseSource, SensitivityLevel, SessionState, type AppConfig, type EvaluatorResult, type Session, type SessionScore } from '../../src/core/types.js';

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

// Normal sensitivity: the ceiling is 45 minutes whatever the poll interval.
const maxTicks = (pollSeconds: number): number => 45 * 60 / pollSeconds;

interface Sim {
  readonly evaluator: ActivityEvaluator;
  tick(edits: readonly string[], timerRunning: boolean): EvaluatorResult;
}

function simulate(pollSeconds: number, sessionIds: readonly string[] = ['s']): Sim {
  const evaluator = new ActivityEvaluator(pollSeconds);
  return {
    evaluator,
    tick: (edits, timerRunning) => evaluator.processAllTicks(
      sessionIds.map(sessionId => ({
        sessionId,
        signals: { hasDynamics: edits.includes(sessionId), hasCommit: false, deltaMagnitude: edits.includes(sessionId) ? 4 : 0 },
        maxTicks: maxTicks(pollSeconds),
      })),
      { timerRunning },
    ),
  };
}

// Ticks of edits in a row, from silence, until the session takes the count.
function ticksToTakeover(pollSeconds: number): number {
  const sim = simulate(pollSeconds);
  for (let tick = 1; tick <= 40; tick++) {
    if (sim.tick(['s'], true).leaderId === 's') return tick;
  }
  return Infinity;
}

console.log('Timer in the leader\'s seat');

test('without a timer the evaluator decides exactly as before', () => {
  const plain = new ActivityEvaluator(30);
  const withFlag = new ActivityEvaluator(30);
  const input = [{ sessionId: 's', signals: { hasDynamics: true, hasCommit: false, deltaMagnitude: 12 }, maxTicks: 90 }];
  for (let i = 0; i < 6; i++) {
    const a = plain.processAllTicks(input);
    const b = withFlag.processAllTicks(input, { timerRunning: false });
    assert.equal(a.leaderId, 's');
    assert.equal(b.leaderId, 's');
    assert.equal(a.timerLeads, undefined);
    assert.deepEqual(a.scores.get('s'), b.scores.get('s'));
  }
});

test('a running timer keeps the lead over a session that still has stamina', () => {
  const sim = simulate(30);
  for (let i = 0; i < 8; i++) sim.tick(['s'], false);
  sim.evaluator.resetAttention();
  const result = sim.tick([], true);
  assert.equal(result.leaderId, null);
  assert.equal(result.timerLeads, true);
  assert.ok(result.scores.get('s')!.score > 0, 'the stamina lives on under the timer');
});

test('one edit after silence never takes the count, at any poll interval', () => {
  for (const pollSeconds of [15, 30, 45, 60]) {
    const sim = simulate(pollSeconds);
    const result = sim.tick(['s'], true);
    assert.equal(result.leaderId, null, `${pollSeconds}s poll`);
    assert.equal(result.timerLeads, true, `${pollSeconds}s poll`);
    assert.ok(result.scores.get('s')!.score > 0, 'the session got its charge, not the lead');
  }
});

test('edits tick after tick take the count within about a minute', () => {
  assert.equal(ticksToTakeover(15), 6, '15s poll: 75s after the first edit');
  assert.equal(ticksToTakeover(30), 3, '30s poll: 60s');
  assert.equal(ticksToTakeover(45), 2, '45s poll: 45s');
  assert.equal(ticksToTakeover(60), 2, '60s poll: 60s');
});

test('a takeover hands the lead to the session and the timer no longer leads', () => {
  const sim = simulate(30);
  sim.tick(['s'], true);
  sim.tick(['s'], true);
  const result = sim.tick(['s'], true);
  assert.equal(result.leaderId, 's');
  assert.equal(result.timerLeads, false);
});

test('edits rarer than once in a minute and a half never take the count (30s poll)', () => {
  const sim = simulate(30);
  for (let tick = 0; tick < 240; tick++) {
    const result = sim.tick(tick % 3 === 0 ? ['s'] : [], true);
    assert.equal(result.leaderId, null, `tick ${tick}`);
  }
});

test('edits once a minute do take it, after a few of them (30s poll)', () => {
  const sim = simulate(30);
  let takenAt = -1;
  for (let tick = 0; tick < 40 && takenAt < 0; tick++) {
    if (sim.tick(tick % 2 === 0 ? ['s'] : [], true).leaderId === 's') takenAt = tick;
  }
  assert.equal(takenAt, 6, 'the fourth edit, three minutes in');
});

test('a takeover needs an edit on the tick itself', () => {
  const sim = simulate(30);
  for (let i = 0; i < 4; i++) sim.tick(['s'], false);
  assert.equal(sim.tick([], true).leaderId, null, 'high attention, but no edit on this tick');
  assert.equal(sim.tick(['s'], true).leaderId, 's');
});

test('a start by hand resets attention: the session that was just coding does not snap back', () => {
  const sim = simulate(30);
  for (let i = 0; i < 10; i++) sim.tick(['s'], false);
  sim.evaluator.resetAttention();
  assert.equal(sim.tick(['s'], true).leaderId, null);
  assert.equal(sim.tick(['s'], true).leaderId, null);
  assert.equal(sim.tick(['s'], true).leaderId, 's', 'dense edits still win it back');
});

test('the most attended of several edited sessions takes the count', () => {
  const sim = simulate(30, ['a', 'b']);
  sim.tick(['b'], true);
  sim.tick(['b'], true);
  const result = sim.tick(['a', 'b'], true);
  assert.equal(result.leaderId, 'b');
});

test('the threshold is one constant, above a single touch at polls up to a minute', () => {
  assert.equal(TIMER_DEFENSE_ATTENTION, 0.5);
  for (const pollSeconds of [15, 30, 45, 60]) {
    const attentionAlpha = pollSeconds / 120;
    assert.ok(attentionAlpha <= TIMER_DEFENSE_ATTENTION, `${pollSeconds}s poll`);
  }
});

console.log('Timer waiting, timer paused');

test('a waiting timer gets the count back when the session has faded to zero', () => {
  const sim = simulate(30);
  sim.tick(['s'], false);
  let quietTicks = 0;
  while (sim.tick([], false).leaderId === 's') quietTicks++;
  assert.ok(quietTicks >= 21 && quietTicks <= 24, `about 11 minutes of silence after one touch, got ${quietTicks} ticks`);
  assert.equal(sim.tick([], false).scores.get('s')!.isIdleTimeout, true);
});

test('reselect picks the leader again without moving time', () => {
  const sim = simulate(30);
  for (let i = 0; i < 5; i++) sim.tick(['s'], false);
  const before: SessionScore = sim.tick([], false).scores.get('s')!;

  sim.evaluator.resetAttention();
  const held = sim.evaluator.reselect({ timerRunning: true });
  assert.equal(held.leaderId, null);
  assert.equal(held.timerLeads, true);

  const released = sim.evaluator.reselect();
  assert.equal(released.leaderId, 's', 'stamina left — the session counts again');
  assert.deepEqual(released.scores.get('s'), before, 'no score, EMA or ETA moved');
});

test('reselect with every session faded leaves nobody counting', () => {
  const sim = simulate(30);
  sim.tick(['s'], false);
  for (let i = 0; i < 30; i++) sim.tick([], true);
  assert.equal(sim.evaluator.reselect().leaderId, null);
});

test('a closed session is out of the next reselect', () => {
  const sim = simulate(30);
  for (let i = 0; i < 5; i++) sim.tick(['s'], false);
  sim.evaluator.removeSession('s');
  assert.equal(sim.evaluator.reselect().leaderId, null);
  assert.equal(sim.evaluator.reselect().scores.size, 0);
});

console.log('Sessions under a timer');

const config: AppConfig = {
  repos: [],
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
} as unknown as AppConfig;

function activeSession(id: string): Session {
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id, repo: `repo-${id}`, task: 'ATL-1', branch: 'ATL-1-fix', state: SessionState.Active,
    startedAt, activatedAt: startedAt, lastSeenAt: new Date().toISOString(), closedBy: null,
    evidence: createEmptyEvidence(), pauses: [], baseSha: null, mergeBaseSha: null,
    evidenceBaseline: null, evidenceCarry: null, uncommittedBaseline: null,
    lastBranchCommits: null, ledger: null, sensitivity: null,
  };
}

const score = (value: number): SessionScore => ({
  score: value, maxScore: 90, normalizedScore: value / 90, ema: 0, etaTicks: value, isIdleTimeout: value === 0,
});

test('a session with stamina under a running timer is superseded, a faded one idles out', () => {
  const log = createEmptyLog(new Date().toISOString().slice(0, 10), config);
  log.sessions.push(activeSession('a'), activeSession('b'));
  const tracker = new SessionTracker(config, log);

  tracker.applyEvaluatorResult({
    scores: new Map([['a', score(16)], ['b', score(0)]]),
    leaderId: null,
    timerLeads: true,
  });
  assert.equal(log.sessions[0].pauses.at(-1)?.source, PauseSource.Superseded);
  assert.equal(log.sessions[0].pauses.at(-1)?.to, null);
  assert.equal(log.sessions[1].pauses.at(-1)?.source, PauseSource.IdleTimeout);
});

test('the session that takes the count from the timer resumes', () => {
  const log = createEmptyLog(new Date().toISOString().slice(0, 10), config);
  log.sessions.push(activeSession('a'));
  const tracker = new SessionTracker(config, log);
  tracker.applyEvaluatorResult({ scores: new Map([['a', score(16)]]), leaderId: null, timerLeads: true });
  tracker.applyEvaluatorResult({ scores: new Map([['a', score(30)]]), leaderId: 'a', timerLeads: false });
  assert.notEqual(log.sessions[0].pauses.at(-1)?.to, null, 'the superseded pause is closed');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
