/**
 * Unit tests for favorites: manual-entry templates in favorites.json.
 *
 * Run: npx tsx tests/unit/favorites.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * test-home MUST be the first import — load/save touch WORKDAY_HOME.
 */
import '../helpers/test-home.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadFavorites,
  saveFavorites,
  addFavorite,
  removeFavorite,
  resolveFavoriteTarget,
} from '../../src/core/favorites.js';
import { getWorkdayHome } from '../../src/core/config.js';
import { FAVORITES_FILE_NAME, MAX_ENTRY_MINUTES } from '../../src/core/constants.js';
import { SensitivityLevel, type AppConfig, type Favorite } from '../../src/core/types.js';

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

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    repos: [],
    boundaryHour: 0,
    timezone: 'UTC',
    tracking: { projectKeys: ['ATL'], branchOwners: [] },
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
    ...overrides,
  };
}

type FavOverride = Partial<{ name: string; task: string; minutes: number; activity: string }>;

// config kept in the signature so call sites stay stable — addFavorite no
// longer validates against taskPattern (logging is not project-scoped).
function addStd(favorites: Favorite[], _config: AppConfig, over: FavOverride = {}): Favorite {
  return addFavorite(favorites, {
    name: over.name ?? 'standup',
    task: over.task ?? 'ATL-10',
    minutes: over.minutes ?? 15,
    activity: over.activity ?? 'Other',
  });
}

console.log('Favorites — templates in favorites.json');

test('loadFavorites returns [] when file is missing', () => {
  assert.equal(existsSync(join(getWorkdayHome(), FAVORITES_FILE_NAME)), false);
  assert.deepEqual(loadFavorites(), []);
});

test('addFavorite appends and returns the created template', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  const added = addStd(favorites, config);
  assert.equal(favorites.length, 1);
  assert.equal(added.task, 'ATL-10');
  assert.equal(added.name, 'standup');
  assert.equal(added.minutes, 15);
  assert.equal(added.activity, 'Other');
  assert.ok(added.id.length > 0);
  assert.ok(!isNaN(Date.parse(added.createdAt)));
});

test('save/load round-trip persists the list', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  addStd(favorites, config);
  addStd(favorites, config, { name: 'code review', task: 'ATL-6712', minutes: 30, activity: 'CodeReview' });
  saveFavorites(favorites);

  const loaded = loadFavorites();
  assert.deepEqual(loaded, favorites);
  // File shape is an object wrapper, not a bare array.
  const raw = JSON.parse(readFileSync(join(getWorkdayHome(), FAVORITES_FILE_NAME), 'utf-8'));
  assert.ok(Array.isArray(raw.favorites));
});

test('duplicate task+name+minutes is rejected (case/whitespace-insensitive)', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  addStd(favorites, config);
  assert.throws(() => addStd(favorites, config), /Already in favorites/);
  assert.throws(() => addStd(favorites, config, { name: '  STANDUP ' }), /Already in favorites/);
  assert.equal(favorites.length, 1);
});

test('same task+name with different minutes is a distinct template', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  addStd(favorites, config);
  addStd(favorites, config, { minutes: 60 });
  assert.equal(favorites.length, 2);
});

test('inner whitespace does not fork a template', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  addStd(favorites, config, { name: 'stand up' });
  assert.throws(() => addStd(favorites, config, { name: 'stand   up' }), /Already in favorites/);
  assert.equal(favorites.length, 1);
});

test('same name on a different task is allowed', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  addStd(favorites, config);
  addStd(favorites, config, { task: 'ATL-99' });
  assert.equal(favorites.length, 2);
});

test('task must look like a Jira key (any project allowed)', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  assert.equal(addStd(favorites, config, { task: 'FOO-1' }).task, 'FOO-1'); // any project ok
  assert.throws(() => addStd(favorites, config, { task: 'ATL-10-extra' }), /not a valid Jira key/);
  assert.throws(() => addStd(favorites, config, { task: 'nonsense' }), /not a valid Jira key/);
  assert.throws(() => addStd(favorites, config, { task: '' }), /Task is required/);
});

test('minutes must be positive and capped', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  assert.throws(() => addStd(favorites, config, { minutes: 0 }), /Minutes must be positive/);
  assert.throws(() => addStd(favorites, config, { minutes: -5 }), /Minutes must be positive/);
  assert.throws(() => addStd(favorites, config, { minutes: NaN }), /Minutes must be positive/);
  assert.throws(() => addStd(favorites, config, { minutes: MAX_ENTRY_MINUTES + 1 }), /Max is/);
  addStd(favorites, config, { minutes: MAX_ENTRY_MINUTES });
  assert.equal(favorites.length, 1);
});

test('name and activity are required (trimmed)', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  assert.throws(() => addStd(favorites, config, { name: '  ' }), /Name is required/);
  assert.throws(() => addStd(favorites, config, { activity: '  ' }), /Activity is required/);
});

test('resolveFavoriteTarget resolves #index and id', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  const first = addStd(favorites, config);
  const second = addStd(favorites, config, { name: 'planning', minutes: 60 });
  assert.equal(resolveFavoriteTarget(favorites, '#1'), first);
  assert.equal(resolveFavoriteTarget(favorites, '#2'), second);
  assert.equal(resolveFavoriteTarget(favorites, second.id), second);
  assert.equal(resolveFavoriteTarget(favorites, '#3'), null);
  assert.equal(resolveFavoriteTarget(favorites, 'nope'), null);
});

test('removeFavorite removes by index and id, throws when missing', () => {
  const config = makeConfig();
  const favorites: Favorite[] = [];
  const first = addStd(favorites, config);
  const second = addStd(favorites, config, { name: 'planning' });

  const removed = removeFavorite(favorites, '#1');
  assert.equal(removed, first);
  assert.deepEqual(favorites, [second]);

  removeFavorite(favorites, second.id);
  assert.equal(favorites.length, 0);

  assert.throws(() => removeFavorite(favorites, '#1'), /Favorite not found/);
});

test('loadFavorites throws a clear error on corrupt JSON', () => {
  const favorites: Favorite[] = [];
  addStd(favorites, makeConfig());
  saveFavorites(favorites);
  const filePath = join(getWorkdayHome(), FAVORITES_FILE_NAME);
  // Corrupt the file in place, then verify the error names the file.
  writeFileSync(filePath, '{ broken', 'utf-8');
  assert.throws(() => loadFavorites(), /favorites\.json is corrupted/);
  // Restore a valid state for any later tests.
  saveFavorites([]);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
