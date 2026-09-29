/**
 * Unit tests for deleting the day's last fact through the tracker: the file
 * must go with it, or the deleted fact comes back from disk on the next load
 * (restart, rollover) and rides the next push. A pushed day keeps its file —
 * the push marker — without the deleted fact.
 *
 * Run: npx tsx tests/unit/lazy-day-delete.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { getDailyLogPath, readDailyLog } from '../../src/core/daily-log.js';
import { computeWorkingDate, getDataDir } from '../../src/core/config.js';
import type { AppConfig } from '../../src/core/types.js';

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
  sensitivity: { default: 'normal' },
} as unknown as AppConfig;

const TODAY = computeWorkingDate(Date.now(), 4, 'UTC');
const LOG_PATH = getDailyLogPath(TODAY);

function freshDay(): SessionTracker {
  rmSync(getDataDir(), { recursive: true, force: true });
  return new SessionTracker(config);
}

function restart(): SessionTracker {
  return new SessionTracker(config, readDailyLog(TODAY) ?? undefined);
}

function logEntry(tracker: SessionTracker): string {
  const added = tracker.addManualEntry({ task: 'ATL-1', minutes: 15, description: 'Standup', activity: 'Meeting' });
  assert.ok(added.ok, added.error);
  tracker.flush();
  assert.ok(existsSync(LOG_PATH), 'the entry materializes the day');
  return added.entry!.id;
}

console.log('The day\'s last fact deleted:');

test('fresh day: the only entry deleted → no file, a restart finds nothing', () => {
  const tracker = freshDay();
  const id = logEntry(tracker);
  const result = tracker.deleteManualEntry(id);
  tracker.flush();
  assert.equal(result.dayFileDeleted, true);
  assert.ok(!existsSync(LOG_PATH));
  assert.equal(restart().getDailyLog().manualEntries.length, 0);
});

test('fresh day: manual added set to 0 → no file', () => {
  const tracker = freshDay();
  assert.ok(tracker.setAddedMinutes('ATL-1', 30).ok);
  tracker.flush();
  assert.ok(existsSync(LOG_PATH));
  assert.equal(tracker.setAddedMinutes('ATL-1', 0).dayFileDeleted, true);
  tracker.flush();
  assert.ok(!existsSync(LOG_PATH));
});

test('a day loaded from disk: its last entry deleted → no file', () => {
  const id = logEntry(freshDay());
  const tracker = restart();
  tracker.deleteManualEntry(id);
  tracker.flush();
  assert.ok(!existsSync(LOG_PATH));
});

test('a day with other facts keeps its file', () => {
  const tracker = freshDay();
  const id = logEntry(tracker);
  logEntry(tracker);
  assert.equal(tracker.deleteManualEntry(id).dayFileDeleted, false);
  tracker.flush();
  assert.equal(readDailyLog(TODAY)!.manualEntries.length, 1);
});

test('pushed in this run: the last entry deleted → the file stays as the push marker, without it', () => {
  const tracker = freshDay();
  const id = logEntry(tracker);
  tracker.markPushed(new Date().toISOString());
  tracker.flush();
  assert.equal(tracker.deleteManualEntry(id).dayFileDeleted, false);
  tracker.flush();
  const stored = readDailyLog(TODAY)!;
  assert.equal(stored.manualEntries.length, 0);
  assert.ok(stored.pushedAt);
});

test('rollover after the delete leaves nothing behind', () => {
  const tracker = freshDay();
  const id = logEntry(tracker);
  tracker.deleteManualEntry(id);
  const { materialized } = tracker.handleDayBoundary();
  assert.equal(materialized, false);
  assert.ok(!existsSync(LOG_PATH));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
