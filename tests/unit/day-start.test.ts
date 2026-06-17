/**
 * Unit tests for setDayManualStart: the manual day-start bound.
 *
 * Run: npx tsx tests/unit/day-start.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Pure in-memory — no disk, no daemon.
 *
 * Regression guard: the upper bound must anchor to the earliest `activatedAt`
 * (first CONFIRMED work), NOT `startedAt`. A PENDING session's `startedAt` is
 * just when the daemon first saw the branch and must not block a later start.
 */
import assert from 'node:assert/strict';
import { createEmptyLog, setDayManualStart, resolveUiDayStart } from '../../src/core/daily-log.js';
import { SessionState, SensitivityLevel, type AppConfig, type DailyLog, type Session } from '../../src/core/types.js';

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

const DATE = '2026-06-13';

function makeConfig(startHour: number = 0): AppConfig {
  return {
    repos: [],
    schedule: { start: startHour, end: 4 },
    timezone: 'UTC',
    taskPattern: 'ATL-\\d+',
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
  };
}

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: over.id ?? 's1',
    repo: over.repo ?? 'repoA',
    task: over.task ?? 'ATL-1',
    branch: over.branch ?? 'ATL-1-feature',
    state: over.state ?? SessionState.Active,
    startedAt: over.startedAt ?? `${DATE}T09:00:00.000Z`,
    activatedAt: over.activatedAt ?? null,
    lastSeenAt: over.lastSeenAt ?? `${DATE}T12:00:00.000Z`,
    closedBy: over.closedBy ?? null,
    evidence: { commits: 0, reflogEvents: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    pauses: [],
    manualAdjustments: [],
    baseSha: null,
    mergeBaseSha: null,
    evidenceBaseline: null,
    lastBranchCommits: null,
  };
}

function makeLog(config: AppConfig, sessions: Session[] = []): DailyLog {
  const log = createEmptyLog(DATE, config);
  log.sessions.push(...sessions);
  return log;
}

console.log('Day start — setDayManualStart');

test('null clears the override', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ activatedAt: `${DATE}T10:00:00.000Z` })]);
  setDayManualStart(log, `${DATE}T09:30:00.000Z`, config);
  assert.equal(log.manualStart, `${DATE}T09:30:00.000Z`);
  setDayManualStart(log, null, config);
  assert.equal(log.manualStart, null);
});

test('REGRESSION: pending-only session does NOT block a later start', () => {
  // The user's bug: tracker launched at 09:00, session sits PENDING (no real
  // work). Old code anchored to startedAt and rejected anything after 09:00.
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ state: SessionState.Pending, startedAt: `${DATE}T09:00:00.000Z`, activatedAt: null })]);
  setDayManualStart(log, `${DATE}T10:00:00.000Z`, config); // after startedAt — must succeed now
  assert.equal(log.manualStart, `${DATE}T10:00:00.000Z`);
});

test('start between startedAt and activatedAt is allowed', () => {
  // Old code rejected this (startedAt bound); new code allows up to activatedAt.
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ startedAt: `${DATE}T09:00:00.000Z`, activatedAt: `${DATE}T10:00:00.000Z` })]);
  setDayManualStart(log, `${DATE}T09:30:00.000Z`, config);
  assert.equal(log.manualStart, `${DATE}T09:30:00.000Z`);
});

test('start exactly at activatedAt is allowed', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ activatedAt: `${DATE}T10:00:00.000Z` })]);
  setDayManualStart(log, `${DATE}T10:00:00.000Z`, config);
  assert.equal(log.manualStart, `${DATE}T10:00:00.000Z`);
});

test('start after first activatedAt throws', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ activatedAt: `${DATE}T10:00:00.000Z` })]);
  assert.throws(() => setDayManualStart(log, `${DATE}T10:30:00.000Z`, config), /after the first activity/);
  assert.equal(log.manualStart, null); // unchanged on rejection
});

test('bound is the EARLIEST activatedAt across sessions (pending skipped)', () => {
  const config = makeConfig();
  const log = makeLog(config, [
    makeSession({ id: 'a', repo: 'repoA', startedAt: `${DATE}T08:00:00.000Z`, activatedAt: `${DATE}T11:00:00.000Z` }),
    makeSession({ id: 'b', repo: 'repoB', state: SessionState.Pending, startedAt: `${DATE}T08:30:00.000Z`, activatedAt: null }),
    makeSession({ id: 'c', repo: 'repoC', startedAt: `${DATE}T09:00:00.000Z`, activatedAt: `${DATE}T10:00:00.000Z` }),
  ]);
  // Earliest activation is 10:00 (session c) — 10:30 must be rejected...
  assert.throws(() => setDayManualStart(log, `${DATE}T10:30:00.000Z`, config), /after the first activity/);
  // ...but 09:30 (before earliest activation) is fine.
  setDayManualStart(log, `${DATE}T09:30:00.000Z`, config);
  assert.equal(log.manualStart, `${DATE}T09:30:00.000Z`);
});

test('start before tracking-window lower bound throws', () => {
  const config = makeConfig(8); // schedule.start = 08:00
  const log = makeLog(config, [makeSession({ activatedAt: `${DATE}T10:00:00.000Z` })]);
  assert.throws(() => setDayManualStart(log, `${DATE}T07:00:00.000Z`, config), /Cannot start before 08:00/);
});

test('no sessions: a past start within the window is allowed', () => {
  const config = makeConfig();
  const log = makeLog(config, []);
  setDayManualStart(log, `${DATE}T09:00:00.000Z`, config); // DATE is in the past relative to now
  assert.equal(log.manualStart, `${DATE}T09:00:00.000Z`);
});

test('no activated sessions: a future start throws', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ state: SessionState.Pending, activatedAt: null })]);
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.throws(() => setDayManualStart(log, future, config), /in the future/);
});

console.log('\nDay start — resolveUiDayStart');

test('manualStart wins over sessions', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ activatedAt: `${DATE}T10:00:00.000Z` })]);
  log.manualStart = `${DATE}T09:00:00.000Z`;
  assert.equal(resolveUiDayStart(log), `${DATE}T09:00:00.000Z`);
});

test('null when no session has activated', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ state: SessionState.Pending, activatedAt: null })]);
  assert.equal(resolveUiDayStart(log), null);
});

test('REGRESSION: returns EARLIEST activatedAt, not sessions[0]', () => {
  // The real bug: sessions[0] (repo discovery order) activated late because
  // another repo held cross-repo leadership first. Must return the earliest.
  const config = makeConfig();
  const log = makeLog(config, [
    makeSession({ id: 'a', repo: 'atlas-frontend', activatedAt: `${DATE}T13:07:00.000Z` }),
    makeSession({ id: 'b', repo: 'appone-backend', activatedAt: `${DATE}T10:54:00.000Z` }),
  ]);
  assert.equal(resolveUiDayStart(log), `${DATE}T10:54:00.000Z`);
});

test('pending sessions are skipped when finding earliest', () => {
  const config = makeConfig();
  const log = makeLog(config, [
    makeSession({ id: 'a', state: SessionState.Pending, startedAt: `${DATE}T08:00:00.000Z`, activatedAt: null }),
    makeSession({ id: 'b', activatedAt: `${DATE}T11:00:00.000Z` }),
  ]);
  assert.equal(resolveUiDayStart(log), `${DATE}T11:00:00.000Z`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
