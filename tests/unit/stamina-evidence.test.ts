/**
 * Unit tests for the stamina (ActivityEvaluator) scoring model and the
 * merge-base + baseline-delta evidence tracking in SessionTracker.
 *
 * Run: npx tsx tests/unit/stamina-evidence.test.ts
 *
 * Pure in-memory — no git repos, no daemon, no disk writes (flush is never
 * called on the SessionTracker).
 */
import assert from 'node:assert/strict';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { SnapshotParser } from '../../src/collectors/snapshot-parser.js';
import type {
  AppConfig,
  PollResult,
  EvidenceSnapshot,
  SessionScore,
  ReflogEntry,
  GitSnapshot,
  ChurnFile,
} from '../../src/core/types.js';

const POLL_SECONDS = 30;
// Normal sensitivity at 30s ticks: ceiling 45 min, touch floor = 90/4 = 22.5 ticks (11.25 min)
const MAX_TICKS = 90;

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

// ─── Evaluator helpers ───────────────────────────────────────────────────

interface TickSpec {
  dyn?: boolean;
  commit?: boolean;
  lines?: number;
}

function runTicks(evaluator: ActivityEvaluator, id: string, specs: readonly TickSpec[]): SessionScore {
  let last: SessionScore | undefined;
  for (const spec of specs) {
    const result = evaluator.processAllTicks([{
      sessionId: id,
      signals: {
        hasDynamics: spec.dyn ?? false,
        hasCommit: spec.commit ?? false,
        deltaMagnitude: spec.lines ?? 0,
      },
      maxTicks: MAX_TICKS,
      ignoreIdleTimeout: false,
    }]);
    last = result.scores.get(id);
  }
  return last!;
}

function repeat(spec: TickSpec, n: number): TickSpec[] {
  return Array.from({ length: n }, () => ({ ...spec }));
}

// ─── Stamina scoring ─────────────────────────────────────────────────────

console.log('Stamina (ActivityEvaluator)');

test('single 1-line touch lands near the floor, not half the bar', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const s = runTicks(ev, 'a', [{ dyn: true, lines: 1 }]);
  // floor 22.5 + tiny frequency/volume gains − decay ≈ 21.9 of 90
  assert.ok(s.normalizedScore > 0.2 && s.normalizedScore < 0.3,
    `normalized = ${s.normalizedScore.toFixed(3)}, expected ~0.24`);
});

test('floor guarantees a multi-minute leash after one touch (no 1-line = 1-minute noise)', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  let s = runTicks(ev, 'a', [{ dyn: true, lines: 1 }]);
  let idleTicks = 0;
  while (!s.isIdleTimeout && idleTicks < 100) {
    s = runTicks(ev, 'a', [{}]);
    idleTicks++;
  }
  // floor 22.5 ticks, EMA near zero so decay ≈ 1 → ~22 idle ticks ≈ 11 min
  assert.ok(idleTicks >= 18 && idleTicks <= 26, `idle ticks to pause = ${idleTicks}, expected ~22`);
});

test('asymmetric decay: a full bar after intense work drains in ~30 min, not 45', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  let s = runTicks(ev, 'a', repeat({ dyn: true, lines: 20 }, 60)); // EMA → 1, bar full
  assert.ok(s.normalizedScore >= 0.98, `precondition: bar full, got ${s.normalizedScore.toFixed(3)}`);
  let idleTicks = 0;
  while (!s.isIdleTimeout && idleTicks < 200) {
    s = runTicks(ev, 'a', [{}]);
    idleTicks++;
  }
  // decay = 1 + 2×EMA while EMA cools → ~59 ticks ≈ 30 min (plain decay would be 90).
  // Still asymmetric (a full bar fades faster than its 45-min ceiling), just
  // gentler than the old boost=4 (~15 min) so think gaps aren't punished.
  assert.ok(idleTicks >= 50 && idleTicks <= 68, `idle ticks to pause = ${idleTicks}, expected ~59`);
});

test('asymmetric decay: moderate work (mid bar) fades in ~18 min', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  // ~7 min of continuous 8-line ticks → mid bar (~0.5), EMA ~0.5
  let s = runTicks(ev, 'a', repeat({ dyn: true, lines: 8 }, 14));
  assert.ok(s.normalizedScore > 0.4 && s.normalizedScore < 0.7,
    `precondition: mid bar, got ${s.normalizedScore.toFixed(3)}`);
  let idleTicks = 0;
  while (!s.isIdleTimeout && idleTicks < 100) {
    s = runTicks(ev, 'a', [{}]);
    idleTicks++;
  }
  assert.ok(idleTicks >= 30 && idleTicks <= 44, `idle ticks to pause = ${idleTicks}, expected ~37`);
});

test('floor is shielded from the decay boost: leash never collapses at high EMA', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  // long intense run → EMA ≈ 1, then a stop and a single touch near the floor:
  // a naive boosted-from-floor drain would collapse the leash in ~2 min
  runTicks(ev, 'a', repeat({ dyn: true, lines: 20 }, 40));
  let s = runTicks(ev, 'a', repeat({}, 120)); // fade out completely
  assert.ok(s.isIdleTimeout, 'precondition: faded to pause');
  s = runTicks(ev, 'a', [{ dyn: true, lines: 1 }]); // single touch, EMA still warm
  let idleTicks = 0;
  while (!s.isIdleTimeout && idleTicks < 100) {
    s = runTicks(ev, 'a', [{}]);
    idleTicks++;
  }
  // below the floor decay is always 1/tick → ~22 ticks (11 min) guaranteed
  assert.ok(idleTicks >= 18, `idle ticks to pause = ${idleTicks}, expected >= 18 (~11 min)`);
});

test('Patient: full bar drains in ~70 min — under the 90-min plain fade, tolerant of long thinks', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const patientMax = 180; // 90 min at 30s ticks
  const tickOnce = (dyn: boolean): SessionScore => ev.processAllTicks([{
    sessionId: 'p',
    signals: { hasDynamics: dyn, hasCommit: false, deltaMagnitude: dyn ? 20 : 0 },
    maxTicks: patientMax,
    ignoreIdleTimeout: false,
  }]).scores.get('p')!;
  let s!: SessionScore;
  for (let i = 0; i < 120; i++) s = tickOnce(true); // fill the bar, EMA → 1
  assert.ok(s.score > patientMax * 0.95, `precondition: bar full, got ${s.score}`);
  let idleTicks = 0;
  while (!s.isIdleTimeout && idleTicks < 400) {
    s = tickOnce(false);
    idleTicks++;
  }
  // ~142 ticks ≈ 71 min: a long walk-away is still caught (faster than the
  // 180-tick / 90-min plain fade), but with boost=2 a full Patient bar
  // intentionally tolerates a long think before pausing.
  assert.ok(idleTicks >= 125 && idleTicks <= 160, `idle ticks to pause = ${idleTicks}, expected ~142`);
});

test('etaTicks matches the actual ticks-to-pause under asymmetric decay', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  let s = runTicks(ev, 'a', repeat({ dyn: true, lines: 20 }, 60));
  const predicted = s.etaTicks;
  let idleTicks = 0;
  while (!s.isIdleTimeout && idleTicks < 200) {
    s = runTicks(ev, 'a', [{}]);
    idleTicks++;
  }
  assert.ok(Math.abs(predicted - idleTicks) <= 1,
    `etaTicks = ${predicted}, actual = ${idleTicks}`);
});

test('two bulk-paste ticks no longer saturate the bar (old algorithm hit 100%)', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const s = runTicks(ev, 'a', repeat({ dyn: true, lines: 1000 }, 2));
  // ~0.41: floor + two volume-capped ticks, still far from the old 100% saturation
  assert.ok(s.normalizedScore < 0.45, `normalized = ${s.normalizedScore.toFixed(3)}, expected < 0.45`);
});

test('sporadic light edits hover at the floor and never climb', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  // 1-line touch every 6th tick for 60 ticks
  const specs: TickSpec[] = [];
  for (let i = 0; i < 60; i++) {
    specs.push(i % 6 === 0 ? { dyn: true, lines: 1 } : {});
  }
  const s = runTicks(ev, 'a', specs);
  assert.ok(s.normalizedScore < 0.25, `normalized = ${s.normalizedScore.toFixed(3)}, expected < 0.25`);
  assert.ok(s.score > 0, 'must not idle-timeout while touches keep arriving');
});

test('relentless every-tick stream of small edits saturates, but only after ~40 min', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const at20 = runTicks(ev, 'a', repeat({ dyn: true, lines: 2 }, 20));
  assert.ok(at20.normalizedScore < 0.5, `at 10 min: ${at20.normalizedScore.toFixed(3)}, expected < 0.5`);
  const at80 = runTicks(ev, 'a', repeat({ dyn: true, lines: 2 }, 60));
  assert.ok(at80.normalizedScore >= 0.9, `at 40 min: ${at80.normalizedScore.toFixed(3)}, expected >= 0.9`);
});

test('high volume (15 lines/tick) fills the bar in ~15 min, not instantly', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const at15 = runTicks(ev, 'a', repeat({ dyn: true, lines: 15 }, 15));
  assert.ok(at15.normalizedScore < 0.9, `at 7.5 min: ${at15.normalizedScore.toFixed(3)}, expected < 0.9`);
  const at30 = runTicks(ev, 'a', repeat({ dyn: true, lines: 15 }, 15));
  assert.ok(at30.normalizedScore >= 0.95, `at 15 min: ${at30.normalizedScore.toFixed(3)}, expected >= 0.95`);
});

test('commit adds its bonus on top of the floor', () => {
  const evCommit = new ActivityEvaluator(POLL_SECONDS);
  const withCommit = runTicks(evCommit, 'a', [{ dyn: true, commit: true, lines: 1 }]);
  const evPlain = new ActivityEvaluator(POLL_SECONDS);
  const plain = runTicks(evPlain, 'a', [{ dyn: true, lines: 1 }]);
  const bonusTicks = 240 / POLL_SECONDS;
  assert.ok(Math.abs((withCommit.score - plain.score) - bonusTicks) < 0.001,
    `commit bonus = ${(withCommit.score - plain.score).toFixed(2)}, expected ${bonusTicks}`);
});

test('score is capped at maxTicks regardless of intensity', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const s = runTicks(ev, 'a', repeat({ dyn: true, commit: true, lines: 10000 }, 200));
  assert.ok(s.score <= MAX_TICKS, `score = ${s.score}, expected <= ${MAX_TICKS}`);
  assert.ok(s.normalizedScore <= 1, `normalized = ${s.normalizedScore}`);
});

// ─── Leadership (attention EMA) ──────────────────────────────────────────

console.log('\nLeadership (attention EMA with takeover hysteresis)');

function tickPair(
  ev: ActivityEvaluator,
  aSpec: TickSpec,
  bSpec: TickSpec,
): string | null {
  const result = ev.processAllTicks([
    {
      sessionId: 'A',
      signals: { hasDynamics: aSpec.dyn ?? false, hasCommit: aSpec.commit ?? false, deltaMagnitude: aSpec.lines ?? 0 },
      maxTicks: MAX_TICKS, ignoreIdleTimeout: false,
    },
    {
      sessionId: 'B',
      signals: { hasDynamics: bSpec.dyn ?? false, hasCommit: bSpec.commit ?? false, deltaMagnitude: bSpec.lines ?? 0 },
      maxTicks: MAX_TICKS, ignoreIdleTimeout: false,
    },
  ]);
  return result.leaderId;
}

test('a single stray touch in another repo never steals leadership', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  // A works for 10 ticks, B silent
  for (let i = 0; i < 10; i++) tickPair(ev, { dyn: true, lines: 5 }, {});
  // stray save in B while A keeps working
  assert.equal(tickPair(ev, { dyn: true, lines: 5 }, { dyn: true, lines: 1 }), 'A');
  // stray save in B while A pauses to think for 3 ticks
  tickPair(ev, {}, {});
  tickPair(ev, {}, {});
  assert.equal(tickPair(ev, {}, { dyn: true, lines: 1 }), 'A');
});

test('a real switch hands leadership over within ~5 ticks (2.5 min)', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  // A works long enough to fill the bar substantially
  for (let i = 0; i < 40; i++) tickPair(ev, { dyn: true, lines: 15 }, {});
  // developer fully switches to B
  let switchedAt = -1;
  for (let i = 1; i <= 10; i++) {
    if (tickPair(ev, {}, { dyn: true, lines: 5 }) === 'B') { switchedAt = i; break; }
  }
  assert.ok(switchedAt > 1 && switchedAt <= 5, `leadership switched at tick ${switchedAt}, expected 2..5`);
});

test('leader keeps the lead while both repos are idle', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  // enough work that A's score survives 9 idle ticks of asymmetric decay
  for (let i = 0; i < 20; i++) tickPair(ev, { dyn: true, lines: 10 }, {});
  tickPair(ev, {}, { dyn: true, lines: 1 }); // stray B touch
  for (let i = 0; i < 8; i++) {
    assert.equal(tickPair(ev, {}, {}), 'A', `leader flapped on idle tick ${i}`);
  }
});

test('mixed sensitivities: Patient and Normal compete on equal terms', () => {
  const ev = new ActivityEvaluator(POLL_SECONDS);
  const tickMixed = (aDyn: boolean, bDyn: boolean): string | null => ev.processAllTicks([
    { sessionId: 'A', signals: { hasDynamics: aDyn, hasCommit: false, deltaMagnitude: aDyn ? 5 : 0 },
      maxTicks: 180, ignoreIdleTimeout: false }, // Patient
    { sessionId: 'B', signals: { hasDynamics: bDyn, hasCommit: false, deltaMagnitude: bDyn ? 5 : 0 },
      maxTicks: MAX_TICKS, ignoreIdleTimeout: false }, // Normal
  ]).leaderId;
  // Patient repo works → leads
  for (let i = 0; i < 10; i++) tickMixed(true, false);
  assert.equal(tickMixed(true, false), 'A');
  // genuine switch to the Normal repo → takes over within ~5 ticks despite
  // Patient's much larger score buffer (attention is sensitivity-agnostic)
  let switchedAt = -1;
  for (let i = 1; i <= 10; i++) {
    if (tickMixed(false, true) === 'B') { switchedAt = i; break; }
  }
  assert.ok(switchedAt > 1 && switchedAt <= 5, `switched at tick ${switchedAt}, expected 2..5`);
  // and back, symmetric
  let backAt = -1;
  for (let i = 1; i <= 10; i++) {
    if (tickMixed(true, false) === 'A') { backAt = i; break; }
  }
  assert.ok(backAt > 1 && backAt <= 5, `switched back at tick ${backAt}, expected 2..5`);
});

// ─── Churn magnitude (SnapshotParser.computeDelta) ──────────────────────

console.log('\nChurn magnitude (per-file deltas + content hashes + untracked)');

function churnSnap(files: Record<string, [number, number, string | null]>): GitSnapshot {
  const churnFiles = new Map<string, ChurnFile>(
    Object.entries(files).map(([p, [added, removed, hash]]) => [p, { added, removed, hash }]),
  );
  return {
    branch: 'b',
    trackedLines: { added: 0, removed: 0 },
    trackedFileCount: 0,
    untrackedCount: 0,
    timestamp: 0,
    churnFiles,
  };
}

test('rewrite-in-place: flat numbers + changed hash → IN_PLACE_CHURN_LINES', () => {
  const prev = churnSnap({ 'src/a.ts': [10, 5, 'h1'] });
  const cur = churnSnap({ 'src/a.ts': [10, 5, 'h2'] });
  const d = SnapshotParser.computeDelta(prev, cur);
  assert.equal(d.magnitude, 8);
  assert.equal(d.hasDynamics, true, 'in-place churn must count as activity');
});

test('cross-file movement is not netted out (totals would cancel)', () => {
  const prev = churnSnap({ 'a.ts': [40, 0, null], 'b.ts': [10, 0, null] });
  const cur = churnSnap({ 'a.ts': [10, 0, null], 'b.ts': [42, 0, null] });
  const d = SnapshotParser.computeDelta(prev, cur);
  assert.equal(d.magnitude, 62); // |40-10| + |42-10|; totals delta is just +2
});

test('a brand-new file counts whole (agent dumping hundreds of lines)', () => {
  const prev = churnSnap({});
  const cur = churnSnap({ 'new-module.ts': [300, 0, 'h'] });
  const d = SnapshotParser.computeDelta(prev, cur);
  assert.equal(d.magnitude, 300);
});

test('flat file with same hash contributes nothing', () => {
  const prev = churnSnap({ 'a.ts': [10, 5, 'h1'] });
  const cur = churnSnap({ 'a.ts': [10, 5, 'h1'] });
  const d = SnapshotParser.computeDelta(prev, cur);
  assert.equal(d.magnitude, 0);
  assert.equal(d.hasDynamics, false);
});

test('a file leaving the diff counts its last size (revert / re-anchor)', () => {
  const prev = churnSnap({ 'a.ts': [25, 5, null] });
  const cur = churnSnap({});
  const d = SnapshotParser.computeDelta(prev, cur);
  assert.equal(d.magnitude, 30);
});

// ─── Evidence tracking ───────────────────────────────────────────────────

console.log('\nEvidence (SessionTracker, merge-base + baseline-delta)');

const config = {
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
  },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  sensitivity: { default: 'normal', perRepo: {} },
} as unknown as AppConfig;

interface PollSpec {
  task?: string | null;
  snap?: EvidenceSnapshot | null;
  basis?: 'merge_base' | 'base_sha' | null;
  mergeBase?: string | null;
  head?: string;
  reflog?: ReflogEntry[];
  // Lazy sessions: the poll that births a session must carry activity.
  dyn?: boolean;
}

function poll(spec: PollSpec): PollResult {
  return {
    repoPath: '/tmp/repoA',
    branch: 'feature/dev/ATL-1',
    task: spec.task === undefined ? 'ATL-1' : spec.task,
    snapshot: {
      branch: 'feature/dev/ATL-1',
      trackedLines: { added: 0, removed: 0 },
      trackedFileCount: 0,
      untrackedCount: 0,
      timestamp: Date.now(),
      churnFiles: new Map(),
    },
    delta: { addedDelta: 0, removedDelta: 0, untrackedDelta: 0, hasDynamics: spec.dyn ?? false, magnitude: 0 },
    newReflogEntries: spec.reflog ?? [],
    currentHead: spec.head ?? 'head1',
    evidenceSnapshot: spec.snap ?? null,
    evidenceBasis: spec.snap ? (spec.basis ?? 'merge_base') : null,
    mergeBaseSha: spec.mergeBase !== undefined ? spec.mergeBase : 'mb1',
    prevEvidenceSnapshot: null,
    ledgerUpdate: null,
  };
}

function snap(commits: number, added: number, removed: number, files: number): EvidenceSnapshot {
  return { commits, linesAdded: added, linesRemoved: removed, filesChanged: files };
}

// Sessions here stay unpromoted candidates (the evaluator never runs) —
// candidate = a regular Session, all evidence mechanics are identical.
function openEvidence(tracker: SessionTracker) {
  const session = tracker.getOpenSessions()[0] ?? tracker.getCandidates()[0];
  assert.ok(session, 'expected an open session or candidate');
  return session.evidence;
}

test('first tick anchors the baseline — pre-existing branch totals are not counted', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(3, 100, 10, 5), dyn: true }));
  const ev = openEvidence(tracker);
  assert.deepEqual(
    [ev.commits, ev.linesAdded, ev.linesRemoved, ev.filesChanged],
    [0, 0, 0, 0],
    `evidence = ${JSON.stringify(ev)}`,
  );
});

test('work grows evidence as branch totals move past the baseline', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(3, 100, 10, 5), dyn: true }));
  tracker.processPollResult(poll({ snap: snap(5, 150, 20, 7) }));
  const ev = openEvidence(tracker);
  assert.deepEqual([ev.commits, ev.linesAdded, ev.linesRemoved, ev.filesChanged], [2, 50, 10, 2]);
});

test('rebase: merge-base advances, totals stay — evidence survives intact', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(3, 100, 10, 5), dyn: true }));
  tracker.processPollResult(poll({ snap: snap(5, 150, 20, 7) }));
  // rebase onto newer master: new merge-base, rewritten commits, same branch diff
  tracker.processPollResult(poll({
    snap: snap(5, 150, 20, 7),
    mergeBase: 'mb2',
    head: 'head-rebased',
    reflog: [{ ts: Date.now(), type: 'rebase', message: 'rebase (finish)' }],
  }));
  const ev = openEvidence(tracker);
  assert.deepEqual([ev.commits, ev.linesAdded, ev.linesRemoved, ev.filesChanged], [2, 50, 10, 2],
    `evidence after rebase = ${JSON.stringify(ev)}`);
});

test('squash in Rider: commit count drop is ignored, next commit counts again', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(3, 100, 10, 5), dyn: true }));
  tracker.processPollResult(poll({ snap: snap(5, 150, 20, 7) })); // commits evidence = 2
  tracker.processPollResult(poll({ snap: snap(1, 150, 20, 7) })); // squash 5 → 1
  assert.equal(openEvidence(tracker).commits, 2, 'squash must not erase counted commits');
  tracker.processPollResult(poll({ snap: snap(2, 160, 20, 7) })); // one new commit
  assert.equal(openEvidence(tracker).commits, 3, 'commits after squash must keep counting');
});

test('own work merged upstream: baseline ratchets down, counters restart from zero', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(3, 100, 10, 5), dyn: true }));
  tracker.processPollResult(poll({ snap: snap(5, 150, 20, 7) }));
  // PR squash-merged into master; rebase leaves only fresh work on the branch
  tracker.processPollResult(poll({ snap: snap(0, 20, 5, 3), mergeBase: 'mb3' }));
  const ev = openEvidence(tracker);
  assert.deepEqual([ev.linesAdded, ev.linesRemoved, ev.filesChanged], [0, 0, 0]);
  assert.equal(ev.commits, 2, 'already-counted commits stay');
  // new work counts from the lowered baseline
  tracker.processPollResult(poll({ snap: snap(1, 50, 5, 4), mergeBase: 'mb3' }));
  assert.equal(openEvidence(tracker).linesAdded, 30);
  assert.equal(openEvidence(tracker).commits, 3);
});

test('amend does not double-count (branch commit count unchanged)', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(0, 0, 0, 0), dyn: true }));
  tracker.processPollResult(poll({ snap: snap(1, 30, 0, 2) }));
  assert.equal(openEvidence(tracker).commits, 1);
  tracker.processPollResult(poll({ snap: snap(1, 35, 0, 2), head: 'head-amended' }));
  assert.equal(openEvidence(tracker).commits, 1, 'amend rewrites the tip, count stays 1');
});

test('reopening the same task later today starts a clean session (no inheritance)', () => {
  const tracker = new SessionTracker(config);
  tracker.processPollResult(poll({ snap: snap(3, 100, 10, 5), dyn: true }));
  tracker.processPollResult(poll({ snap: snap(5, 150, 20, 7) })); // commits 2, +50
  tracker.processPollResult(poll({ task: null, snap: null }));    // checkout away → close
  assert.equal(tracker.getOpenSessions().length, 0);
  assert.equal(tracker.getCandidates().length, 0);
  tracker.processPollResult(poll({ snap: snap(6, 160, 25, 8), dyn: true })); // back on the task + activity
  const ev = openEvidence(tracker);
  // Counters are session-scoped: the new session anchors a fresh baseline
  // at the current branch state and counts from zero.
  assert.deepEqual([ev.commits, ev.linesAdded, ev.linesRemoved, ev.filesChanged], [0, 0, 0, 0],
    `evidence after reopen = ${JSON.stringify(ev)}`);
  tracker.processPollResult(poll({ snap: snap(7, 180, 30, 9) })); // work in the new session
  const ev2 = openEvidence(tracker);
  assert.deepEqual([ev2.commits, ev2.linesAdded], [1, 20],
    `evidence after new work = ${JSON.stringify(ev2)}`);
});

test('fallback mode (no default branch): snapshot applied as-is, rebase re-anchors and zeroes', () => {
  const tracker = new SessionTracker(config);
  // first tick: anchor baseSha, snapshot not yet available
  tracker.processPollResult(poll({ snap: null, basis: null, mergeBase: null, dyn: true }));
  tracker.processPollResult(poll({ snap: snap(2, 40, 5, 2), basis: 'base_sha', mergeBase: null }));
  let ev = openEvidence(tracker);
  assert.deepEqual([ev.commits, ev.linesAdded], [2, 40]);
  tracker.processPollResult(poll({
    snap: snap(9, 400, 50, 20), // stale anchor counts upstream churn after rebase…
    basis: 'base_sha',
    mergeBase: null,
    head: 'head-rebased',
    reflog: [{ ts: Date.now(), type: 'rebase', message: 'rebase (finish)' }],
  }));
  ev = openEvidence(tracker);
  // …so the legacy path re-anchors and zeroes instead of showing unreal numbers
  assert.deepEqual([ev.commits, ev.linesAdded, ev.linesRemoved, ev.filesChanged], [0, 0, 0, 0]);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
