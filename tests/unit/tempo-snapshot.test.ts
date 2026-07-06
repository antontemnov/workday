/**
 * Unit tests for the Tempo month snapshot — worklog mapping (full fields)
 * and cache persistence/invalidation. No network: fetchMonthSnapshot itself
 * is exercised manually via `workday tempo-sync`.
 *
 * Run: npx tsx tests/unit/tempo-snapshot.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mapTempoWorklog, type RawTempoWorklog } from '../../src/push/tempo-client.js';
import {
  loadMonthSnapshot,
  saveMonthSnapshot,
  invalidateSnapshotsInRange,
  getSnapshotPath,
} from '../../src/push/tempo-snapshot.js';
import { ACTIVITY_ATTRIBUTE_KEY, TMP_EXTENSION } from '../../src/core/constants.js';
import type { TempoMonthSnapshot, TempoWorklog } from '../../src/core/types.js';

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

console.log('mapTempoWorklog — full-field mapping');

test('maps description, activity, updatedAt', () => {
  const raw: RawTempoWorklog = {
    tempoWorklogId: 100,
    issue: { id: 67890 },
    startDate: '2026-07-01',
    timeSpentSeconds: 1800,
    description: 'Daily standup',
    updatedAt: '2026-07-01T12:00:00Z',
    attributes: { values: [{ key: ACTIVITY_ATTRIBUTE_KEY, value: 'Other' }] },
  };
  const wl = mapTempoWorklog(raw);
  assert.equal(wl.tempoWorklogId, 100);
  assert.equal(wl.issueId, 67890);
  assert.equal(wl.description, 'Daily standup');
  assert.equal(wl.activity, 'Other');
  assert.equal(wl.updatedAt, '2026-07-01T12:00:00Z');
});

test('bare worklog (no optional fields) → optional fields absent', () => {
  const wl = mapTempoWorklog({
    tempoWorklogId: 101, issueId: 67890, startDate: '2026-07-01', timeSpentSeconds: 900,
  });
  assert.equal(wl.issueId, 67890);           // flat issueId fallback
  assert.ok(!('description' in wl));
  assert.ok(!('activity' in wl));
  assert.ok(!('updatedAt' in wl));
});

test('foreign attributes without _Activity_ → no activity', () => {
  const wl = mapTempoWorklog({
    tempoWorklogId: 102, issue: { id: 1 }, startDate: '2026-07-01', timeSpentSeconds: 900,
    attributes: { values: [{ key: '_Account_', value: 'X' }] },
  });
  assert.equal(wl.activity, undefined);
});

console.log('\ntempo-snapshot — cache persistence');

function snapshot(month: string, worklogs: TempoWorklog[] = []): TempoMonthSnapshot {
  return { month, accountId: 'acc-1', fetchedAt: '2026-07-07T10:00:00Z', worklogs };
}

test('load on missing cache → null', () => {
  assert.equal(loadMonthSnapshot(2026, 1), null);
});

test('save/load round-trip, no leftover tmp', () => {
  const wl: TempoWorklog = {
    tempoWorklogId: 100, issueId: 67890, startDate: '2026-07-01',
    timeSpentSeconds: 1800, description: 'standup', activity: 'Other',
  };
  saveMonthSnapshot(snapshot('2026-07', [wl]));
  const loaded = loadMonthSnapshot(2026, 7);
  assert.ok(loaded);
  assert.equal(loaded.worklogs.length, 1);
  assert.equal(loaded.worklogs[0].activity, 'Other');
  assert.ok(!existsSync(getSnapshotPath(2026, 7) + TMP_EXTENSION));
});

test('invalidate range drops intersecting months only', () => {
  saveMonthSnapshot(snapshot('2026-05'));
  saveMonthSnapshot(snapshot('2026-06'));
  saveMonthSnapshot(snapshot('2026-07'));
  invalidateSnapshotsInRange('2026-05-15', '2026-06-02');
  assert.equal(loadMonthSnapshot(2026, 5), null);
  assert.equal(loadMonthSnapshot(2026, 6), null);
  assert.ok(loadMonthSnapshot(2026, 7));
});

test('invalidate crosses a year boundary', () => {
  saveMonthSnapshot(snapshot('2026-12'));
  saveMonthSnapshot(snapshot('2027-01'));
  invalidateSnapshotsInRange('2026-12-20', '2027-01-05');
  assert.equal(loadMonthSnapshot(2026, 12), null);
  assert.equal(loadMonthSnapshot(2027, 1), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
