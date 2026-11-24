/**
 * Simulation tests for "a session or a timer": a running manual timer sits
 * in the leader's seat of the ActivityEvaluator. The bar is the touch floor
 * of the session's own mode: an edit that leaves its stamina above the floor.
 * A rival — a session on other work than the timer's — takes the count with
 * it; a session on the timer's own work is only confirmed and goes on waiting.
 *
 * Run: npx tsx tests/unit/timer-arbitration.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { createEmptyLog, createEmptyEvidence } from '../../src/core/daily-log.js';
import { STAMINA_FLOOR_RATIO, STAMINA_LINES_PER_MINUTE } from '../../src/core/constants.js';
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
// Lines that outweigh one tick of decay at the given poll interval.
const tickOfLines = (pollSeconds: number): number => STAMINA_LINES_PER_MINUTE * pollSeconds / 60;

interface Edit {
  readonly lines?: number;
  readonly commit?: boolean;
}

interface Sim {
  readonly evaluator: ActivityEvaluator;
  // No timer runs.
  free(edits?: Readonly<Record<string, Edit>>): EvaluatorResult;
  // A timer runs; `rivals` are the sessions on other work than its own.
  timed(edits: Readonly<Record<string, Edit>>, rivals?: readonly string[]): EvaluatorResult;
}

function simulate(pollSeconds: number, sessionIds: readonly string[] = ['s']): Sim {
  const evaluator = new ActivityEvaluator(pollSeconds);
  const inputs = (edits: Readonly<Record<string, Edit>>) => sessionIds.map(sessionId => ({
    sessionId,
    signals: {
      hasDynamics: (edits[sessionId]?.lines ?? 0) > 0,
      hasCommit: edits[sessionId]?.commit === true,
      deltaMagnitude: edits[sessionId]?.lines ?? 0,
    },
    maxTicks: maxTicks(pollSeconds),
  }));
  return {
    evaluator,
    free: (edits = {}) => evaluator.processAllTicks(inputs(edits)),
    timed: (edits, rivals = sessionIds) => evaluator.processAllTicks(inputs(edits), { timerRunning: true, timerRivals: new Set(rivals) }),
  };
}

const floorOf = (result: EvaluatorResult, id = 's'): number => result.scores.get(id)!.maxScore * STAMINA_FLOOR_RATIO;

console.log('Timer in the leader\'s seat');

test('without a timer the evaluator decides exactly as before', () => {
  const plain = new ActivityEvaluator(30);
  const withFlag = new ActivityEvaluator(30);
  const input = [{ sessionId: 's', signals: { hasDynamics: true, hasCommit: false, deltaMagnitude: 12 }, maxTicks: 90 }];
  for (let i = 0; i < 6; i++) {
    const a = plain.processAllTicks(input);
    const b = withFlag.processAllTicks(input, { timerRunning: false, timerRivals: new Set(['s']) });
    assert.equal(a.leaderId, 's');
    assert.equal(b.leaderId, 's');
    assert.equal(a.timerLeads, undefined);
    assert.equal(a.confirmedIds, undefined);
    assert.deepEqual(a.scores.get('s'), b.scores.get('s'));
  }
});

test('a running timer keeps the lead over a session that still has stamina', () => {
  const sim = simulate(30);
  for (let i = 0; i < 8; i++) sim.free({ s: { lines: 12 } });
  const result = sim.timed({});
  assert.equal(result.leaderId, null);
  assert.equal(result.timerLeads, true);
  assert.deepEqual(result.confirmedIds, []);
  assert.ok(result.scores.get('s')!.score > floorOf(result), 'the stamina lives on under the timer');
});

test('a stray touch of a cold session never takes the count, at any poll interval', () => {
  for (const pollSeconds of [15, 30, 45, 60]) {
    const sim = simulate(pollSeconds);
    const result = sim.timed({ s: { lines: 1 } });
    assert.equal(result.leaderId, null, `${pollSeconds}s poll`);
    assert.equal(result.timerLeads, true, `${pollSeconds}s poll`);
    const score = result.scores.get('s')!.score;
    assert.ok(score > 0 && score < floorOf(result), 'the session got its leash, the decay took it below the floor');
  }
});

test('a save worth a tick of decay takes the count on the spot, at any poll interval', () => {
  for (const pollSeconds of [15, 30, 45, 60]) {
    const result = simulate(pollSeconds).timed({ s: { lines: tickOfLines(pollSeconds) } });
    assert.equal(result.leaderId, 's', `${pollSeconds}s poll`);
    assert.equal(result.timerLeads, false);
    assert.deepEqual(result.confirmedIds, []);
  }
  assert.equal(simulate(30).timed({ s: { lines: 3 } }).leaderId, null, '3 lines at a 30s poll are still a touch');
});

test('a commit takes the count on the spot', () => {
  assert.equal(simulate(30).timed({ s: { commit: true } }).leaderId, 's');
});

test('small edits tick after tick take it once the stamina climbs over the floor', () => {
  const sim = simulate(30);
  let takenAt = 0;
  for (let tick = 1; tick <= 40 && takenAt === 0; tick++) {
    if (sim.timed({ s: { lines: 2 } }).leaderId === 's') takenAt = tick;
  }
  assert.equal(takenAt, 6, 'three minutes of steady typing');
});

test('touches rarer than once in a minute and a half never take the count', () => {
  const sim = simulate(30);
  for (let tick = 0; tick < 240; tick++) {
    const result = sim.timed(tick % 3 === 0 ? { s: { lines: 1 } } : {});
    assert.equal(result.leaderId, null, `tick ${tick}`);
  }
});

test('a takeover needs an edit on the tick itself; a warm session takes it with any edit', () => {
  const sim = simulate(30);
  for (let i = 0; i < 10; i++) sim.free({ s: { lines: 12 } });
  assert.equal(sim.timed({}).leaderId, null, 'stamina well above the floor, but no edit on this tick');
  assert.equal(sim.timed({ s: { lines: 1 } }).leaderId, 's');
});

test('a warm session cools down: past the floor a touch takes nothing again', () => {
  const sim = simulate(30);
  for (let i = 0; i < 10; i++) sim.free({ s: { lines: 12 } });
  let quiet = 0;
  while (sim.timed({}).scores.get('s')!.score > maxTicks(30) * STAMINA_FLOOR_RATIO) quiet++;
  for (let i = 0; i < 12; i++) sim.timed({});
  assert.ok(quiet > 0);
  assert.equal(sim.timed({ s: { lines: 1 } }).leaderId, null);
});

console.log('The timer\'s own work');

test('the same edit by a session on the timer\'s own work leaves the timer counting', () => {
  const sim = simulate(30);
  const result = sim.timed({ s: { lines: 40, commit: true } }, []);
  assert.equal(result.leaderId, null);
  assert.equal(result.timerLeads, true);
  assert.deepEqual(result.confirmedIds, ['s'], 'real work under the timer — a fact of the day');
});

test('dense work on the timer\'s own ticket never takes the count', () => {
  const sim = simulate(30);
  for (let tick = 0; tick < 120; tick++) {
    assert.equal(sim.timed({ s: { lines: 12 } }, []).leaderId, null, `tick ${tick}`);
  }
});

test('a touch on the timer\'s own work confirms nothing', () => {
  assert.deepEqual(simulate(30).timed({ s: { lines: 1 } }, []).confirmedIds, []);
});

test('with no rivals given the timer yields to nobody', () => {
  const evaluator = new ActivityEvaluator(30);
  const input = [{ sessionId: 's', signals: { hasDynamics: true, hasCommit: true, deltaMagnitude: 40 }, maxTicks: 90 }];
  const result = evaluator.processAllTicks(input, { timerRunning: true });
  assert.equal(result.leaderId, null);
  assert.deepEqual(result.confirmedIds, ['s']);
});

test('own work and a rival edited on one tick: the rival takes the count, own work is confirmed', () => {
  const sim = simulate(30, ['own', 'rival']);
  const result = sim.timed({ own: { lines: 12 }, rival: { lines: 12 } }, ['rival']);
  assert.equal(result.leaderId, 'rival');
  assert.deepEqual(result.confirmedIds, ['own']);
});

test('the most attended of several rivals takes the count, the other is confirmed', () => {
  const sim = simulate(30, ['a', 'b']);
  sim.timed({ b: { lines: 1 } });
  sim.timed({ b: { lines: 1 } });
  const result = sim.timed({ a: { lines: 12 }, b: { lines: 12 } });
  assert.equal(result.leaderId, 'b');
  assert.deepEqual(result.confirmedIds, ['a']);
});

console.log('Timer paused');

test('one touch buys about 11 minutes: then the session has faded to zero', () => {
  const sim = simulate(30);
  sim.free({ s: { lines: 4 } });
  let quietTicks = 0;
  while (sim.free().leaderId === 's') quietTicks++;
  assert.ok(quietTicks >= 21 && quietTicks <= 24, `about 11 minutes of silence after one touch, got ${quietTicks} ticks`);
  assert.equal(sim.free().scores.get('s')!.isIdleTimeout, true);
});

test('reselect picks the leader again without moving time', () => {
  const sim = simulate(30);
  for (let i = 0; i < 5; i++) sim.free({ s: { lines: 4 } });
  const before: SessionScore = sim.free().scores.get('s')!;

  const held = sim.evaluator.reselect({ timerRunning: true, timerRivals: new Set(['s']) });
  assert.equal(held.leaderId, null, 'a started timer holds the lead: a takeover needs an edit');
  assert.equal(held.timerLeads, true);

  const released = sim.evaluator.reselect();
  assert.equal(released.leaderId, 's', 'stamina left — the session counts again');
  assert.deepEqual(released.scores.get('s'), before, 'no score, EMA or ETA moved');
});

test('reselect with every session faded leaves nobody counting', () => {
  const sim = simulate(30);
  sim.free({ s: { lines: 4 } });
  for (let i = 0; i < 30; i++) sim.timed({});
  assert.equal(sim.evaluator.reselect().leaderId, null);
});

test('a closed session is out of the next reselect', () => {
  const sim = simulate(30);
  for (let i = 0; i < 5; i++) sim.free({ s: { lines: 4 } });
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

test('a session confirmed under the timer stays superseded', () => {
  const log = createEmptyLog(new Date().toISOString().slice(0, 10), config);
  log.sessions.push(activeSession('a'));
  const tracker = new SessionTracker(config, log);
  tracker.applyEvaluatorResult({ scores: new Map([['a', score(40)]]), leaderId: null, timerLeads: true, confirmedIds: ['a'] });
  assert.equal(log.sessions[0].pauses.length, 1);
  assert.equal(log.sessions[0].pauses[0].source, PauseSource.Superseded);
  assert.equal(log.sessions[0].pauses[0].to, null);
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
