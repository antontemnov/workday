/**
 * Unit tests for search config merging — buildPatchedConfig must deep-merge
 * `search` so a selection change keeps the cached catalog and vice versa.
 *
 * Run: npx tsx tests/unit/search-config.test.ts
 */
import assert from 'node:assert/strict';
import { buildPatchedConfig } from '../../src/core/config.js';
import { SensitivityLevel, type AppConfig } from '../../src/core/types.js';

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

function makeConfig(): AppConfig {
  return {
    repos: ['/repo'],
    boundaryHour: 4,
    timezone: 'UTC',
    tracking: { projectKeys: ['ATL'], branchOwners: [] },
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 0 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
    search: {
      projectKeys: ['ATL'],
      knownProjects: [{ key: 'ATL', name: 'Core Platform', id: '10001' }, { key: 'WEB', name: 'Web Portal', id: '10002' }],
    },
    activities: { values: ['Development', 'CodeReview'] },
    notifications: { timesheetReminder: { enabled: true, notifyHour: 14 } },
    calendar: { enabled: true },
  };
}

console.log('Search config — buildPatchedConfig deep-merge');

test('patching projectKeys keeps the cached catalog', () => {
  const merged = buildPatchedConfig(makeConfig(), { search: { projectKeys: ['ATL', 'CNF'] } as never });
  assert.deepEqual(merged.search.projectKeys, ['ATL', 'CNF']);
  assert.equal(merged.search.knownProjects.length, 2); // catalog untouched
});

test('refreshing the catalog keeps the selection', () => {
  const merged = buildPatchedConfig(makeConfig(), {
    search: { knownProjects: [{ key: 'ATL', name: 'Core Platform', id: '10001' }] } as never,
  });
  assert.deepEqual(merged.search.projectKeys, ['ATL']); // selection untouched
  assert.equal(merged.search.knownProjects.length, 1);
});

test('a patch without search leaves it intact', () => {
  const merged = buildPatchedConfig(makeConfig(), { boundaryHour: 6 });
  assert.deepEqual(merged.search.projectKeys, ['ATL']);
  assert.equal(merged.search.knownProjects.length, 2);
});

test('patching activities.values replaces the allow-list', () => {
  const merged = buildPatchedConfig(makeConfig(), { activities: { values: ['Other'] } });
  assert.deepEqual(merged.activities.values, ['Other']);
  assert.deepEqual(merged.search.projectKeys, ['ATL']); // search untouched
});

test('a patch without activities leaves the allow-list intact', () => {
  const merged = buildPatchedConfig(makeConfig(), { boundaryHour: 6 });
  assert.deepEqual(merged.activities.values, ['Development', 'CodeReview']);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
