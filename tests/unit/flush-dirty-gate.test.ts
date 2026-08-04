/**
 * Unit tests for the flush dirty-gate: an unchanged daily log is not
 * rewritten on every flush; a changed one is; an externally deleted file
 * self-heals; the lazy-day no-op is preserved.
 *
 * Run: npx tsx tests/unit/flush-dirty-gate.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { getDailyLogPath } from '../../src/core/daily-log.js';
import { computeWorkingDate, getDataDir } from '../../src/core/config.js';
import type { AppConfig, DailyLog } from '../../src/core/types.js';

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
  repos: ['/tmp/repoA'],
  boundaryHour: 4,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: [] },
  session: {
    diffPollSeconds: 30,
    signalDeduplicationSeconds: 300,
    dayBoundaryCheckSeconds: 60,
    reflogCount: 20,
  },
  workDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  sensitivity: { default: 'normal', perRepo: {} },
} as unknown as AppConfig;

const TODAY = computeWorkingDate(Date.now(), 4, 'UTC');
const LOG_PATH = getDailyLogPath(TODAY);
const SENTINEL = '{"sentinel":true}';

function wipeDataDir(): void {
  rmSync(getDataDir(), { recursive: true, force: true });
}

function readLog(): DailyLog {
  return JSON.parse(readFileSync(LOG_PATH, 'utf-8')) as DailyLog;
}

console.log('flush dirty-gate:');

test('lazy day: flush before materialization writes nothing', () => {
  wipeDataDir();
  const tracker = new SessionTracker(config);
  tracker.flush();
  assert.ok(!existsSync(LOG_PATH), 'no file for a factless day');
});

test('unchanged state: repeat flush skips the write', () => {
  wipeDataDir();
  const tracker = new SessionTracker(config);
  const added = tracker.addManualEntry({ task: 'ATL-1', minutes: 30, description: '', activity: 'Development' });
  assert.ok(added.ok, added.error);
  tracker.flush();
  assert.ok(existsSync(LOG_PATH), 'first flush writes');

  writeFileSync(LOG_PATH, SENTINEL, 'utf-8');
  tracker.flush();
  assert.equal(readFileSync(LOG_PATH, 'utf-8'), SENTINEL, 'clean flush must not rewrite the file');
});

test('changed state: flush writes again', () => {
  wipeDataDir();
  const tracker = new SessionTracker(config);
  tracker.addManualEntry({ task: 'ATL-1', minutes: 30, description: '', activity: 'Development' });
  tracker.flush();

  writeFileSync(LOG_PATH, SENTINEL, 'utf-8');
  tracker.addManualEntry({ task: 'ATL-2', minutes: 15, description: '', activity: 'Development' });
  tracker.flush();
  const log = readLog();
  assert.equal(log.manualEntries?.length, 2, 'dirty flush rewrites with both entries');
});

test('externally deleted file: clean flush self-heals', () => {
  wipeDataDir();
  const tracker = new SessionTracker(config);
  tracker.addManualEntry({ task: 'ATL-1', minutes: 30, description: '', activity: 'Development' });
  tracker.flush();

  unlinkSync(LOG_PATH);
  tracker.flush();
  assert.ok(existsSync(LOG_PATH), 'file restored despite unchanged state');
  assert.equal(readLog().manualEntries?.length, 1);
});

test('day boundary: gate resets, new day writes on its first fact', () => {
  wipeDataDir();
  const tracker = new SessionTracker(config);
  tracker.addManualEntry({ task: 'ATL-1', minutes: 30, description: '', activity: 'Development' });
  tracker.flush();

  const { materialized } = tracker.handleDayBoundary();
  assert.ok(materialized, 'old day had facts');

  // Fresh draft (same synthetic date) is lazy again.
  unlinkSync(LOG_PATH);
  tracker.flush();
  assert.ok(!existsSync(LOG_PATH), 'fresh draft stays lazy');

  tracker.addManualEntry({ task: 'ATL-3', minutes: 10, description: '', activity: 'Development' });
  tracker.flush();
  assert.ok(existsSync(LOG_PATH), 'first fact of the new day writes');
  assert.equal(readLog().manualEntries?.[0]?.task, 'ATL-3');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
