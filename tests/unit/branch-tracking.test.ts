/**
 * Unit tests for the git-tracking scope: task pattern derived from
 * tracking.projectKeys, strict token-based branch-owner matching, and the
 * tracking deep-merge in buildPatchedConfig.
 *
 * Run: npx tsx tests/unit/branch-tracking.test.ts
 */
import assert from 'node:assert/strict';
import { branchMatchesOwner, buildPatchedConfig, buildTaskPattern, extractForeignTask, extractTask } from '../../src/core/config.js';
import { SensitivityLevel, type AppConfig, type TrackingConfig } from '../../src/core/types.js';

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

function makeTracking(overrides: Partial<TrackingConfig> = {}): TrackingConfig {
  return { projectKeys: ['ATL'], branchOwners: ['atemnov'], ...overrides };
}

function makeConfig(): AppConfig {
  return {
    repos: ['/repo'],
    boundaryHour: 4,
    timezone: 'UTC',
    tracking: { projectKeys: ['ATL'], branchOwners: ['atemnov'] },
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 0 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
    search: { projectKeys: ['ATL'], knownProjects: [] },
    activities: { values: [] },
    notifications: { timesheetReminder: { enabled: true, notifyHour: 14 } },
    calendar: { enabled: true, hidePrivate: false },
  };
}

console.log('Task pattern from tracking.projectKeys');

test('single key', () => {
  assert.equal(buildTaskPattern(['ATL']), '(?:ATL)-\\d+');
  assert.equal('feature/ATL-123-x'.match(new RegExp(buildTaskPattern(['ATL'])))?.[0], 'ATL-123');
});

test('multiple keys', () => {
  const re = new RegExp(buildTaskPattern(['ATL', 'CNF']));
  assert.equal('CNF-9-fix'.match(re)?.[0], 'CNF-9');
  assert.equal('ATL-77'.match(re)?.[0], 'ATL-77');
  assert.equal('WEB-5-fix'.match(re), null);
});

console.log('');
console.log('Branch-owner matching — strict tokens between delimiters');

test('exact token matches, embedded substring does not', () => {
  assert.equal(branchMatchesOwner('ATL-5555-at-fix', ['at']), true);
  assert.equal(branchMatchesOwner('ATL-5555-asaliy-atribute-fix', ['at']), false);
});

test('a shorter owner never matches a longer name (atemn vs atemnov)', () => {
  assert.equal(branchMatchesOwner('feature/atemnov/ATL-1', ['atemn']), false);
  assert.equal(branchMatchesOwner('feature/atemn/ATL-1', ['atemn']), true);
  assert.equal(branchMatchesOwner('ATL-1-atemnova', ['atemnov']), false);
});

test('case is ignored', () => {
  assert.equal(branchMatchesOwner('feature/Atemnov/ATL-1', ['atemnov']), true);
  assert.equal(branchMatchesOwner('feature/atemnov/ATL-1', ['ATEMNOV']), true);
});

test('any delimiter separates tokens (/ - _ .)', () => {
  assert.equal(branchMatchesOwner('atemnov_ATL-1', ['atemnov']), true);
  assert.equal(branchMatchesOwner('fix.atemnov.ATL-1', ['atemnov']), true);
  assert.equal(branchMatchesOwner('atemnovATL-1', ['atemnov']), false); // no delimiter → one token
});

test('several owners — any of them matches', () => {
  const owners = ['atemnov', 'atemn'];
  assert.equal(branchMatchesOwner('ATL-1-atemn-fix', owners), true);
  assert.equal(branchMatchesOwner('ATL-1-atemnov-fix', owners), true);
  assert.equal(branchMatchesOwner('ATL-1-asaliy-fix', owners), false);
});

test('multi-token owner matches the same consecutive tokens', () => {
  assert.equal(branchMatchesOwner('feature/anton-temnov/ATL-1', ['anton-temnov']), true);
  assert.equal(branchMatchesOwner('feature/anton/x/temnov/ATL-1', ['anton-temnov']), false);
});

test('empty owner list tracks every branch', () => {
  assert.equal(branchMatchesOwner('ATL-1-whoever', []), true);
});

console.log('');
console.log('extractTask over the tracking scope');

test('own branch with a tracked key yields the task', () => {
  assert.equal(extractTask('atemnov/ATL-42-fix', makeTracking(), []), 'ATL-42');
});

test('foreign branch is skipped even with a tracked key', () => {
  assert.equal(extractTask('asaliy/ATL-42-fix', makeTracking(), []), null);
});

test('untracked project yields null', () => {
  assert.equal(extractTask('atemnov/WEB-42-fix', makeTracking(), []), null);
});

test('generic and detached-HEAD branches yield null', () => {
  assert.equal(extractTask('master', makeTracking({ branchOwners: [] }), ['master']), null);
  assert.equal(extractTask('a1b2c3d4e5f', makeTracking({ branchOwners: [] }), []), null);
});

console.log('');
console.log('extractForeignTask — the review-suggestion signal');

test('colleague branch with a tracked key yields the task', () => {
  assert.equal(extractForeignTask('ATL-123-ivanov-feature', makeTracking(), []), 'ATL-123');
});

test('own branch yields null (that is extractTask territory)', () => {
  assert.equal(extractForeignTask('ATL-123-atemnov-fixes', makeTracking(), []), null);
});

test('empty owner list silently disables the review source', () => {
  assert.equal(extractForeignTask('ATL-123-ivanov-feature', makeTracking({ branchOwners: [] }), []), null);
});

test('keyless, generic and untracked-project branches yield null', () => {
  assert.equal(extractForeignTask('ivanov/some-experiment', makeTracking(), []), null);
  assert.equal(extractForeignTask('develop', makeTracking(), ['develop']), null);
  assert.equal(extractForeignTask('WEB-9-ivanov-fix', makeTracking(), []), null);
});

console.log('');
console.log('Tracking config — buildPatchedConfig deep-merge');

test('patching projectKeys keeps branchOwners', () => {
  const merged = buildPatchedConfig(makeConfig(), { tracking: { projectKeys: ['ATL', 'CNF'] } as never });
  assert.deepEqual(merged.tracking.projectKeys, ['ATL', 'CNF']);
  assert.deepEqual(merged.tracking.branchOwners, ['atemnov']);
});

test('patching branchOwners keeps projectKeys', () => {
  const merged = buildPatchedConfig(makeConfig(), { tracking: { branchOwners: ['atemnov', 'atemn'] } as never });
  assert.deepEqual(merged.tracking.projectKeys, ['ATL']);
  assert.deepEqual(merged.tracking.branchOwners, ['atemnov', 'atemn']);
});

test('empty projectKeys is rejected', () => {
  assert.throws(() => buildPatchedConfig(makeConfig(), { tracking: { projectKeys: [] } as never }), /non-empty/);
});

test('lowercase project key is rejected', () => {
  assert.throws(() => buildPatchedConfig(makeConfig(), { tracking: { projectKeys: ['atl'] } as never }), /uppercase/);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
