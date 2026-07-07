/**
 * Unit tests for the day-start label (resolveUiDayStart) and budget v2
 * (computeBudgetMs = full physical day window, independent of sessions).
 *
 * Run: npx tsx tests/unit/day-start.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Pure in-memory — no disk, no daemon.
 */
import assert from 'node:assert/strict';
import { createEmptyLog, resolveUiDayStart, computeBudgetMs } from '../../src/core/daily-log.js';
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

function makeConfig(): AppConfig {
  return {
    repos: [],
    boundaryHour: 4,
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

console.log('Day start — resolveUiDayStart');

test('null when no session has activated', () => {
  const config = makeConfig();
  const log = makeLog(config, [makeSession({ state: SessionState.Pending, activatedAt: null })]);
  assert.equal(resolveUiDayStart(log), null);
});

test('null on an empty day', () => {
  const config = makeConfig();
  const log = makeLog(config, []);
  assert.equal(resolveUiDayStart(log), null);
});

test('REGRESSION: returns EARLIEST activatedAt, not sessions[0]', () => {
  // The real bug: sessions[0] (repo discovery order) activated late because
  // another repo held cross-repo leadership first. Must return the earliest.
  const config = makeConfig();
  const log = makeLog(config, [
    makeSession({ id: 'a', repo: 'web-frontend', activatedAt: `${DATE}T13:07:00.000Z` }),
    makeSession({ id: 'b', repo: 'api-backend', activatedAt: `${DATE}T10:54:00.000Z` }),
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

console.log('\nBudget v2 — computeBudgetMs');

test('window is the full 24h day (UTC config)', () => {
  const config = makeConfig();
  const log = makeLog(config, []);
  assert.equal(computeBudgetMs(log, config), 24 * 3600_000);
});

test('window ignores sessions', () => {
  const config = makeConfig();
  const empty = makeLog(config, []);
  const busy = makeLog(config, [
    makeSession({ activatedAt: `${DATE}T18:00:00.000Z` }),
  ]);
  assert.equal(computeBudgetMs(busy, config), computeBudgetMs(empty, config));
  assert.equal(computeBudgetMs(busy, config), 24 * 3600_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
