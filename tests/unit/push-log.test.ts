/**
 * Unit tests for push-log persistence — ownership map + deletion tombstones.
 *
 * Run: npx tsx tests/unit/push-log.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { PUSH_LOG_FILE, PUSH_TOMBSTONES_FILE, TMP_EXTENSION } from '../../src/core/constants.js';
import {
  pushLogKey,
  loadPushLog,
  savePushLog,
  loadTombstones,
  saveTombstones,
  recordEntryDeletion,
} from '../../src/push/push-log.js';
import type { PushLogEntry } from '../../src/core/types.js';

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

const DATE = '2026-07-01';
const TASK = 'ATL-10';

function logEntry(worklogId: number): PushLogEntry {
  return { tempoWorklogId: worklogId, timeSpentSeconds: 1800, pushedAt: '2026-07-01T10:00:00Z' };
}

console.log('push-log — persistence');

test('pushLogKey: session vs manual shapes', () => {
  assert.equal(pushLogKey(DATE, TASK), `${DATE}|${TASK}`);
  assert.equal(pushLogKey(DATE, TASK, 'e1'), `${DATE}|${TASK}|m:e1`);
});

test('load on missing file → empty', () => {
  assert.deepEqual(loadPushLog(), {});
  assert.deepEqual(loadTombstones(), []);
});

test('save/load round-trip, no leftover tmp', () => {
  const log = { [pushLogKey(DATE, TASK, 'e1')]: logEntry(100) };
  savePushLog(log);
  assert.deepEqual(loadPushLog(), log);
  assert.ok(!existsSync(join(getDataDir(), PUSH_LOG_FILE + TMP_EXTENSION)));

  const raw = readFileSync(join(getDataDir(), PUSH_LOG_FILE), 'utf-8');
  assert.doesNotThrow(() => JSON.parse(raw));
});

console.log('\npush-log — recordEntryDeletion');

test('pushed entry → key dropped, tombstone written', () => {
  savePushLog({
    [pushLogKey(DATE, TASK, 'e1')]: logEntry(100),
    [pushLogKey(DATE, TASK)]: logEntry(200),
  });
  saveTombstones([]);

  const recorded = recordEntryDeletion(DATE, TASK, 'e1');
  assert.equal(recorded, true);

  const log = loadPushLog();
  assert.equal(log[pushLogKey(DATE, TASK, 'e1')], undefined);
  assert.ok(log[pushLogKey(DATE, TASK)]); // session key untouched

  const tombstones = loadTombstones();
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].tempoWorklogId, 100);
  assert.equal(tombstones[0].entryId, 'e1');
  assert.equal(tombstones[0].date, DATE);
  assert.ok(tombstones[0].deletedAt);
});

test('unpushed entry → no-op, no tombstone', () => {
  savePushLog({});
  saveTombstones([]);
  assert.equal(recordEntryDeletion(DATE, TASK, 'never-pushed'), false);
  assert.deepEqual(loadTombstones(), []);
});

test('second deletion accumulates tombstones', () => {
  savePushLog({
    [pushLogKey(DATE, TASK, 'e1')]: logEntry(100),
    [pushLogKey(DATE, TASK, 'e2')]: logEntry(101),
  });
  saveTombstones([]);
  recordEntryDeletion(DATE, TASK, 'e1');
  recordEntryDeletion(DATE, TASK, 'e2');

  const tombstones = loadTombstones();
  assert.deepEqual(tombstones.map(t => t.tempoWorklogId).sort(), [100, 101]);
  assert.deepEqual(loadPushLog(), {});
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
