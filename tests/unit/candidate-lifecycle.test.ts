/**
 * Unit tests for lazy sessions (package A): candidate lifecycle, promotion,
 * score-drain evaporation, day materialization, rollover and watching-card
 * synthesis.
 *
 * Run: npx tsx tests/unit/candidate-lifecycle.test.ts
 *
 * In-memory poll results drive the full SessionTracker + ActivityEvaluator
 * loop (the daemon tick minus git). Disk writes go to a temp WORKDAY_HOME.
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { isDayMaterialized } from '../../src/core/day-lifecycle.js';
import { createEmptyLog, getDailyLogPath, writeDailyLog } from '../../src/core/daily-log.js';
import { computeWorkingDate, getDataDir } from '../../src/core/config.js';
import { selectWatchingRepos, buildWatchingCard } from '../../src/http-server.js';
import { SessionState, ClosedBy, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, PollResult, EvidenceSnapshot, DailyLog, WatchingRepo } from '../../src/core/types.js';

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

const config = {
  repos: ['/tmp/repoA', '/tmp/repoB'],
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

const TODAY = computeWorkingDate(Date.now(), 4, 'UTC');

function wipeDataDir(): void {
  rmSync(getDataDir(), { recursive: true, force: true });
}

// ─── Poll builders ───────────────────────────────────────────────────────

interface PollSpec {
  repo?: string;
  task?: string | null;
  branch?: string;
  dyn?: boolean;
  commit?: boolean;
  checkout?: boolean;
  snap?: EvidenceSnapshot | null;
  prevSnap?: EvidenceSnapshot | null;
  mergeBase?: string | null;
  head?: string;
}

function poll(spec: PollSpec = {}): PollResult {
  const branch = spec.branch ?? 'atemnov/ATL-1-feature';
  const entries = [];
  if (spec.commit) entries.push({ ts: Date.now(), type: 'commit' as const, message: 'commit: x' });
  if (spec.checkout) entries.push({ ts: Date.now(), type: 'checkout' as const, message: 'checkout: moving' });
  return {
    repoPath: spec.repo ?? '/tmp/repoA',
    branch,
    task: spec.task === undefined ? 'ATL-1' : spec.task,
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
    newReflogEntries: entries,
    currentHead: spec.head ?? 'head1',
    evidenceSnapshot: spec.snap ?? null,
    evidenceBasis: spec.snap ? 'merge_base' : null,
    mergeBaseSha: spec.mergeBase !== undefined ? spec.mergeBase : 'mb1',
    prevEvidenceSnapshot: spec.prevSnap ?? null,
    ledgerUpdate: null,
  };
}

function pollB(spec: PollSpec = {}): PollResult {
  return poll({ repo: '/tmp/repoB', branch: 'atemnov/ATL-2-fix', task: 'ATL-2', ...spec });
}

function snap(commits: number, added: number, removed: number, files: number): EvidenceSnapshot {
  return { commits, linesAdded: added, linesRemoved: removed, filesChanged: files };
}

// ─── Harness: the daemon tick minus git ──────────────────────────────────

function makeHarness(initialLog?: DailyLog) {
  const tracker = new SessionTracker(config, initialLog);
  const evaluator = new ActivityEvaluator(POLL_SECONDS);
  tracker.onSessionClosed = (id) => evaluator.removeSession(id);
  const tick = (results: PollResult[]): void => {
    for (const r of results) tracker.processPollResult(r);
    tracker.applyEvaluatorResult(evaluator.processAllTicks(tracker.buildTickInputs(results)));
  };
  return { tracker, evaluator, tick };
}

// ─── Birth rules ─────────────────────────────────────────────────────────

console.log('Birth rules (sessions are born from activity)');

test('presence of a task branch alone births nothing', () => {
  const { tracker, tick } = makeHarness();
  for (let i = 0; i < 3; i++) tick([poll({})]);
  assert.equal(tracker.getCandidates().length, 0);
  assert.equal(tracker.getOpenSessions().length, 0);
});

test('checkout signal alone births nothing (not activity)', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ checkout: true })]);
  assert.equal(tracker.getCandidates().length, 0);
  assert.equal(tracker.getOpenSessions().length, 0);
});

test('foreign branch never births anything, even with activity', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ task: null, dyn: true, commit: true })]);
  assert.equal(tracker.getCandidates().length, 0);
  assert.equal(tracker.getOpenSessions().length, 0);
});

test('first active tick births and activates in one tick when the repo leads (parity)', () => {
  wipeDataDir();
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]);
  const open = tracker.getOpenSessions();
  assert.equal(open.length, 1, 'promoted same tick');
  assert.equal(open[0].state, SessionState.Active);
  assert.ok(open[0].activatedAt, 'activatedAt set');
  assert.equal(tracker.getCandidates().length, 0, 'candidate consumed by promotion');
  assert.ok(existsSync(getDailyLogPath(TODAY)), 'promotion materializes the day on disk');
  const written = JSON.parse(readFileSync(getDailyLogPath(TODAY), 'utf-8')) as DailyLog;
  assert.equal(written.sessions.length, 1);
});

test('commit on a cold repo activates the same tick', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ commit: true })]);
  assert.equal(tracker.getOpenSessions().length, 1);
  assert.equal(tracker.getOpenSessions()[0].state, SessionState.Active);
});

// ─── Candidate without leadership ────────────────────────────────────────

console.log('\nCandidate lifecycle (no leadership)');

test('activity in repo B while A leads → candidate, not in the log', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]); // A activates
  for (let i = 0; i < 3; i++) tick([poll({ dyn: true }), pollB({ dyn: true })]);
  assert.equal(tracker.getOpenSessions().length, 1, 'only A in the log');
  assert.equal(tracker.getOpenSessions()[0].repo, 'repoA');
  const candidates = tracker.getCandidates();
  assert.equal(candidates.length, 1, 'B is a candidate');
  assert.equal(candidates[0].repo, 'repoB');
  assert.equal(candidates[0].state, SessionState.Pending);
});

test('candidate survives while active, evaporates when the score drains — no traces', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]);
  tick([poll({ dyn: true }), pollB({ dyn: true })]);
  assert.equal(tracker.getCandidates().length, 1);

  // a short think-gap does not kill the candidate (A stays leader throughout)
  for (let i = 0; i < 5; i++) tick([poll({ dyn: true }), pollB({})]);
  assert.equal(tracker.getCandidates().length, 1, 'short silence — alive');

  // sustained silence drains the stamina to zero → evaporation
  let goneAt = -1;
  for (let i = 1; i <= 200; i++) {
    tick([poll({ dyn: true }), pollB({})]);
    if (tracker.getCandidates().length === 0) { goneAt = i; break; }
  }
  assert.ok(goneAt > 0, 'candidate evaporated after the score drained');
  assert.ok(goneAt <= 120, `evaporated within the stamina window (tick ${goneAt})`);
  assert.ok(
    tracker.getDailyLog().sessions.every(s => s.repo !== 'repoB'),
    'no trace of B in the log',
  );
});

test('candidate promotes after taking leadership; startedAt stays the birth signal', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]); // A activates, leads
  tick([poll({ dyn: true }), pollB({ dyn: true })]); // B born as candidate
  const birthStartedAt = tracker.getCandidates()[0].startedAt;

  // A goes idle, B works — leadership hands over within ~5 ticks
  let promotedAt = -1;
  for (let i = 1; i <= 10; i++) {
    tick([poll({}), pollB({ dyn: true })]);
    if (tracker.getOpenSessions().some(s => s.repo === 'repoB')) { promotedAt = i; break; }
  }
  assert.ok(promotedAt > 0 && promotedAt <= 6, `promoted at tick ${promotedAt}, expected <= 6`);
  const sessionB = tracker.getOpenSessions().find(s => s.repo === 'repoB')!;
  assert.equal(sessionB.state, SessionState.Active);
  assert.equal(sessionB.startedAt, birthStartedAt, 'honest startedAt = first signal');
  assert.ok(sessionB.activatedAt, 'activatedAt set at promotion');
});

test('branch change resets the candidate; new one needs fresh activity', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]); // A leads
  tick([poll({ dyn: true }), pollB({ dyn: true })]); // B candidate on ATL-2
  assert.equal(tracker.getCandidates()[0].task, 'ATL-2');

  // checkout to another task branch, no activity → candidate dropped, nothing born
  tick([poll({ dyn: true }), pollB({ task: 'ATL-3', branch: 'atemnov/ATL-3-new', checkout: true })]);
  assert.equal(tracker.getCandidates().length, 0);

  // activity on the new branch → new candidate with the new task
  tick([poll({ dyn: true }), pollB({ task: 'ATL-3', branch: 'atemnov/ATL-3-new', dyn: true })]);
  assert.equal(tracker.getCandidates().length, 1);
  assert.equal(tracker.getCandidates()[0].task, 'ATL-3');
});

test('checkout to a foreign branch evaporates the candidate', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]); // A leads
  tick([poll({ dyn: true }), pollB({ dyn: true })]);
  assert.equal(tracker.getCandidates().length, 1);
  tick([poll({ dyn: true }), pollB({ task: null, branch: 'master' })]);
  assert.equal(tracker.getCandidates().length, 0);
});

// ─── A-3: birth burst seeding ────────────────────────────────────────────

console.log('\nA-3: prev-snapshot seeding of the birth burst');

test('the burst that births a session lands in linesAdded (same branch)', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ snap: snap(0, 0, 0, 0) })]); // settle tick, nothing born
  // burst: 30 lines appear this tick; GitTracker hands the previous snapshot
  tick([poll({ dyn: true, snap: snap(0, 30, 0, 2), prevSnap: snap(0, 0, 0, 0) })]);
  const s = tracker.getOpenSessions()[0];
  assert.ok(s, 'session born and promoted');
  assert.equal(s.evidence.linesAdded, 30, `linesAdded = ${s.evidence.linesAdded}`);
  assert.equal(s.evidence.filesChanged, 2);
});

test('birth right after checkout: baseline from the current tick (branch-guard)', () => {
  const { tracker, tick } = makeHarness();
  // branch changed this tick → GitTracker nulls prevEvidenceSnapshot; the
  // 40 lines that "moved" with the checkout must NOT count as work
  tick([poll({ dyn: true, snap: snap(0, 40, 0, 3), prevSnap: null })]);
  const s = tracker.getOpenSessions()[0];
  assert.ok(s, 'session born and promoted');
  assert.equal(s.evidence.linesAdded, 0, `linesAdded = ${s.evidence.linesAdded}`);
});

// ─── Materialization ─────────────────────────────────────────────────────

console.log('\nMaterialization (lazy day)');

test('flush is a no-op on a day without facts (signals only)', () => {
  wipeDataDir();
  const { tracker, tick } = makeHarness();
  tick([poll({ task: null, commit: true })]); // foreign-branch commit → signal only
  assert.ok(tracker.getDailyLog().signals.length > 0, 'signal captured in draft');
  tracker.flush();
  assert.ok(!existsSync(getDailyLogPath(TODAY)), 'no file written');
});

test('manual entry materializes the day', () => {
  wipeDataDir();
  const { tracker } = makeHarness();
  const res = tracker.addManualEntry({ task: 'ATL-10', minutes: 30, description: 'meeting', activity: 'Other' });
  assert.ok(res.ok, res.error);
  tracker.flush();
  assert.ok(existsSync(getDailyLogPath(TODAY)), 'file written');
  const written = JSON.parse(readFileSync(getDailyLogPath(TODAY), 'utf-8')) as DailyLog;
  assert.equal(written.manualEntries.length, 1);
  assert.equal(written.sessions.length, 0);
});

test('a day loaded from disk keeps being written even when empty', () => {
  wipeDataDir();
  const log = createEmptyLog(TODAY, config);
  writeDailyLog(log);
  const { tracker } = makeHarness(log);
  wipeDataDir();
  tracker.flush();
  assert.ok(existsSync(getDailyLogPath(TODAY)), 'loaded day is always flushed');
});

test('isDayMaterialized truth table', () => {
  const log = createEmptyLog(TODAY, config);
  assert.equal(isDayMaterialized(log, false), false);
  assert.equal(isDayMaterialized(log, true), true);
  log.manualEntries.push({ id: 'm1', task: 'ATL-1', minutes: 10, description: 'd', activity: 'Other', createdAt: new Date().toISOString() });
  assert.equal(isDayMaterialized(log, false), true);
});

// ─── Rollover ────────────────────────────────────────────────────────────

console.log('\nRollover (A-9)');

test('empty day rollover: not materialized, no sessions, candidates dropped', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ task: null, commit: true })]); // just a signal
  const { oldLog, materialized } = tracker.handleDayBoundary();
  assert.equal(materialized, false);
  assert.equal(oldLog.sessions.length, 0);
  assert.equal(tracker.getDailyLog().sessions.length, 0, 'fresh draft');
});

test('materialized rollover: sessions closed by day_boundary, candidates evaporate', () => {
  const { tracker, tick } = makeHarness();
  tick([poll({ dyn: true })]); // A activates
  tick([poll({ dyn: true }), pollB({ dyn: true })]); // B candidate
  assert.equal(tracker.getCandidates().length, 1);

  const { oldLog, materialized } = tracker.handleDayBoundary();
  assert.equal(materialized, true);
  assert.equal(oldLog.sessions.length, 1);
  assert.equal(oldLog.sessions[0].closedBy, ClosedBy.DayBoundary);
  assert.equal(tracker.getCandidates().length, 0, 'candidates reset at boundary');
  assert.equal(tracker.getDailyLog().sessions.length, 0, 'fresh draft');
});

// ─── Quiet-window gate (A-8) ─────────────────────────────────────────────

console.log('\nQuiet-window gate (A-8)');

test('a live candidate counts as active work', () => {
  const { tracker, tick } = makeHarness();
  assert.equal(tracker.hasActiveWork(), false);
  tick([poll({ dyn: true })]); // A activates
  tick([poll({ dyn: true }), pollB({ dyn: true })]); // B candidate
  assert.equal(tracker.hasActiveWork(), true);
  tracker.pauseAllSessions(); // pauses A; the candidate still blocks restarts
  assert.equal(tracker.hasActiveWork(), true);
  tracker.resumeAllSessions();

  // B stays silent while A keeps leading → B drains and evaporates
  for (let i = 0; i < 200 && tracker.getCandidates().length > 0; i++) {
    tick([poll({ dyn: true }), pollB({})]);
  }
  assert.equal(tracker.getCandidates().length, 0, 'candidate drained away');
  tracker.pauseAllSessions();
  assert.equal(tracker.hasActiveWork(), false, 'paused session + no candidates = quiet');
});

// ─── Watching-card synthesis (A-6) ──────────────────────────────────────

console.log('\nWatching-card synthesis (A-6)');

test('selectWatchingRepos filters repos occupied by a session or candidate', () => {
  const watching: WatchingRepo[] = [
    { repoName: 'repoA', branch: 'atemnov/ATL-1-feature', task: 'ATL-1' },
    { repoName: 'repoB', branch: 'atemnov/ATL-2-fix', task: 'ATL-2' },
  ];
  const filtered = selectWatchingRepos(watching, new Set(['repoA']));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].repoName, 'repoB');
  assert.equal(selectWatchingRepos(watching, new Set()).length, 2);
});

test('buildWatchingCard: synthetic PENDING card with zeros and real sensitivity', () => {
  const now = new Date().toISOString();
  const card = buildWatchingCard(
    { repoName: 'repoB', branch: 'atemnov/ATL-2-fix', task: 'ATL-2' },
    SensitivityLevel.Patient,
    now,
  );
  assert.equal(card.id, 'watch:repoB');
  assert.equal(card.state, 'pending');
  assert.equal(card.task, 'ATL-2');
  assert.equal(card.branch, 'atemnov/ATL-2-fix');
  assert.equal(card.effectiveDurationMs, 0);
  assert.equal(card.score, 0);
  assert.equal(card.activatedAt, null);
  assert.equal(card.closedBy, null);
  assert.equal(card.sensitivity, SensitivityLevel.Patient);
  assert.equal(card.evidence.commits, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
