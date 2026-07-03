/**
 * Unit tests for the manual-stop marker (package E): the tray watchdog
 * contract — explicit stop writes it, start clears it.
 *
 * Run: npx tsx tests/unit/stop-marker.test.ts
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_HOME } from '../helpers/test-home.js';
import { writeStopMarker, clearStopMarker, hasStopMarker } from '../../src/core/stop-marker.js';
import { STOP_MARKER_FILE_NAME } from '../../src/core/constants.js';

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

console.log('stop-marker');

test('absent by default', () => {
  assert.equal(hasStopMarker(), false);
});

test('write → present at the expected path', () => {
  writeStopMarker();
  assert.equal(hasStopMarker(), true);
  assert.ok(existsSync(join(TEST_HOME, STOP_MARKER_FILE_NAME)), 'lives in WORKDAY_HOME root');
});

test('clear → absent; clearing twice is safe', () => {
  clearStopMarker();
  assert.equal(hasStopMarker(), false);
  clearStopMarker();
  assert.equal(hasStopMarker(), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
