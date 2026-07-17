/**
 * Unit tests for meeting suggestions: the derived pipeline (entry filters,
 * covered via sourceRef, dismissed, pushed-day silencing), the dismissed-only
 * state store with its prune rules, and the sourceRef plumbing through
 * manual-entry creation (including the accept→delete→revive invariant).
 *
 * Run: npx tsx tests/unit/suggestions.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { deriveSuggestions, meetingSourceRef } from '../../src/core/suggestions.js';
import {
  dismissSuggestionKey,
  loadSuggestionsState,
  pruneSuggestionsState,
  suggestionKey,
  type SuggestionsState,
} from '../../src/core/suggestions-state.js';
import {
  addManualEntry,
  createEmptyLog,
  writeDailyLog,
  readDailyLog,
} from '../../src/core/daily-log.js';
import { addEntryOnDate, deleteEntryOnDate } from '../../src/core/day-edit.js';
import { SensitivityLevel, SuggestionsDayState, type AppConfig, type CalendarInstance, type DailyLog } from '../../src/core/types.js';

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
    repos: [],
    boundaryHour: 0,
    timezone: 'UTC',
    tracking: { projectKeys: ['ATL'], branchOwners: [] },
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
  } as AppConfig;
}

const DATE = '2026-07-16';
const NOW = Date.parse('2026-07-16T15:00:00.000Z'); // after every fixture meeting

function makeInstance(over: Partial<CalendarInstance> = {}): CalendarInstance {
  return {
    uid: 'ev-1',
    date: DATE,
    start: '2026-07-16T10:00:00.000Z',
    end: '2026-07-16T10:30:00.000Z',
    title: 'Standup',
    busyStatus: 'BUSY',
    allDay: false,
    cancelled: false,
    recurring: false,
    ...over,
  };
}

function derive(
  instances: CalendarInstance[],
  over: Partial<{ log: DailyLog | null; dismissedKeys: Set<string>; hidePrivate: boolean; nowMs: number; date: string }> = {},
): ReturnType<typeof deriveSuggestions> {
  return deriveSuggestions({
    date: over.date ?? DATE,
    instances,
    log: over.log ?? null,
    dismissedKeys: over.dismissedKeys ?? new Set(),
    hidePrivate: over.hidePrivate ?? false,
    nowMs: over.nowMs ?? NOW,
  });
}

console.log('Derivation — entry filters');

test('only BUSY instances become suggestions', () => {
  const day = derive([
    makeInstance({ uid: 'busy' }),
    makeInstance({ uid: 'tent', busyStatus: 'TENTATIVE' }),
    makeInstance({ uid: 'free', busyStatus: 'FREE' }),
    makeInstance({ uid: 'oof', busyStatus: 'OOF' }),
  ]);
  assert.deepEqual(day.suggestions.map(s => s.uid), ['busy']);
});

test('cancelled and all-day instances are filtered out', () => {
  const day = derive([
    makeInstance({ uid: 'ok' }),
    makeInstance({ uid: 'cancelled', cancelled: true }),
    makeInstance({ uid: 'allday', allDay: true }),
  ]);
  assert.deepEqual(day.suggestions.map(s => s.uid), ['ok']);
});

test('a row is born at DTSTART: not-yet-started meetings stay hidden', () => {
  const now = Date.parse('2026-07-16T10:15:00.000Z');
  const day = derive([
    makeInstance({ uid: 'started' }),
    makeInstance({ uid: 'future', start: '2026-07-16T11:00:00.000Z', end: '2026-07-16T11:30:00.000Z' }),
  ], { nowMs: now });
  assert.deepEqual(day.suggestions.map(s => s.uid), ['started']);
  assert.equal(day.suggestions[0].ongoing, true);
});

test('ongoing flips off after DTEND; plannedMinutes = full duration', () => {
  const day = derive([makeInstance()]);
  assert.equal(day.suggestions[0].ongoing, false);
  assert.equal(day.suggestions[0].plannedMinutes, 30);
});

test('private is offered (flagged) by default, hidden with hidePrivate', () => {
  const instances = [makeInstance({ uid: 'priv', isPrivate: true }), makeInstance({ uid: 'pub' })];
  const shown = derive(instances);
  assert.deepEqual(shown.suggestions.map(s => [s.uid, s.isPrivate]), [['priv', true], ['pub', false]]);
  const hidden = derive(instances, { hidePrivate: true });
  assert.deepEqual(hidden.suggestions.map(s => s.uid), ['pub']);
});

test('instances of other dates are ignored; output is sorted by start', () => {
  const day = derive([
    makeInstance({ uid: 'later', start: '2026-07-16T12:00:00.000Z', end: '2026-07-16T12:30:00.000Z' }),
    makeInstance({ uid: 'other-day', date: '2026-07-15' }),
    makeInstance({ uid: 'earlier' }),
  ]);
  assert.deepEqual(day.suggestions.map(s => s.uid), ['earlier', 'later']);
});

console.log('');
console.log('Derivation — covered, dismissed, pushed');

test('an entry carrying the sourceRef covers the suggestion; others do not', () => {
  const config = makeConfig();
  const log = createEmptyLog(DATE, config);
  addManualEntry(log, { task: 'ATL-1', minutes: 30, description: 'Standup', activity: 'Other', sourceRef: meetingSourceRef('ev-1', DATE) }, config);
  addManualEntry(log, { task: 'ATL-2', minutes: 30, description: 'Unrelated', activity: 'Other' }, config);
  const day = derive([makeInstance(), makeInstance({ uid: 'ev-2' })], { log });
  assert.deepEqual(day.suggestions.map(s => s.uid), ['ev-2']);
});

test('dismissed keys are excluded', () => {
  const day = derive(
    [makeInstance(), makeInstance({ uid: 'ev-2' })],
    { dismissedKeys: new Set([suggestionKey('ev-1', DATE)]) },
  );
  assert.deepEqual(day.suggestions.map(s => s.uid), ['ev-2']);
});

test('a pushed day is silenced entirely', () => {
  const config = makeConfig();
  const log = createEmptyLog(DATE, config);
  log.pushedAt = '2026-07-16T18:00:00.000Z';
  const day = derive([makeInstance()], { log });
  assert.equal(day.state, SuggestionsDayState.Pushed);
  assert.equal(day.suggestions.length, 0);
});

console.log('');
console.log('State store — prune rules');

test('prune drops keys older than the calendar window', () => {
  const state: SuggestionsState = {
    dismissed: {
      [suggestionKey('a', '2026-03-01')]: { dismissedAt: '2026-03-01T10:00:00.000Z' },
      [suggestionKey('b', DATE)]: { dismissedAt: '2026-07-16T10:00:00.000Z' },
    },
  };
  const pruned = pruneSuggestionsState(state, NOW, () => false);
  assert.deepEqual(Object.keys(pruned.dismissed), [suggestionKey('b', DATE)]);
});

test('prune drops keys of pushed days', () => {
  const state: SuggestionsState = {
    dismissed: {
      [suggestionKey('a', '2026-07-14')]: { dismissedAt: '2026-07-14T10:00:00.000Z' },
      [suggestionKey('b', DATE)]: { dismissedAt: '2026-07-16T10:00:00.000Z' },
    },
  };
  const pruned = pruneSuggestionsState(state, NOW, date => date === '2026-07-14');
  assert.deepEqual(Object.keys(pruned.dismissed), [suggestionKey('b', DATE)]);
});

test('the key date survives uids containing colons', () => {
  const uid = 'weird:uid:with:colons';
  const state: SuggestionsState = {
    dismissed: { [suggestionKey(uid, '2026-03-01')]: { dismissedAt: '2026-03-01T10:00:00.000Z' } },
  };
  const pruned = pruneSuggestionsState(state, NOW, () => false);
  assert.deepEqual(Object.keys(pruned.dismissed), []);
});

console.log('');
console.log('State store — disk round-trip');

test('dismiss writes, reload sees the key, dismiss is idempotent', () => {
  dismissSuggestionKey('ev-io', DATE, NOW);
  dismissSuggestionKey('ev-io', DATE, NOW);
  const state = loadSuggestionsState(NOW);
  assert.deepEqual(Object.keys(state.dismissed), [suggestionKey('ev-io', DATE)]);
});

test('load prunes keys whose day log is pushed on disk', () => {
  const config = makeConfig();
  const pushedDate = '2026-07-10';
  const log = createEmptyLog(pushedDate, config);
  log.pushedAt = '2026-07-10T18:00:00.000Z';
  writeDailyLog(log);
  dismissSuggestionKey('ev-pushed', pushedDate, NOW);
  // dismiss-then-push order: the key exists, then the day gets pushed —
  // simulate by re-reading; prune happens on the next load.
  const state = loadSuggestionsState(NOW);
  assert.equal(state.dismissed[suggestionKey('ev-pushed', pushedDate)], undefined);
});

console.log('');
console.log('sourceRef plumbing & the revive invariant');

test('standalone entry carries sourceRef; session-born ignores it', () => {
  const config = makeConfig();
  const log = createEmptyLog(DATE, config);
  const standalone = addManualEntry(log, { task: 'ATL-1', minutes: 10, description: 'x', activity: 'Other', sourceRef: 'meeting:u:2026-07-16' }, config);
  assert.equal(standalone.sourceRef, 'meeting:u:2026-07-16');
  const sessionBorn = addManualEntry(log, { task: 'ATL-1', minutes: 10, description: '', activity: 'Development', sourceSessionId: 's1', sourceRef: 'meeting:u:2026-07-16' }, config);
  assert.equal(sessionBorn.sourceRef, undefined);
});

test('accept → covered; delete the entry → the suggestion revives', () => {
  const config = makeConfig();
  const acceptDate = '2026-07-13';
  const instance = makeInstance({ date: acceptDate, start: '2026-07-13T10:00:00.000Z', end: '2026-07-13T10:30:00.000Z' });
  const ref = meetingSourceRef(instance.uid, acceptDate);

  const { entry } = addEntryOnDate(acceptDate, { task: 'ATL-9', minutes: 30, description: 'Standup', activity: 'Other', sourceRef: ref }, config);
  const covered = derive([instance], { date: acceptDate, log: readDailyLog(acceptDate) });
  assert.equal(covered.suggestions.length, 0);
  assert.equal(readDailyLog(acceptDate)?.manualEntries?.[0]?.sourceRef, ref);

  deleteEntryOnDate(acceptDate, entry.id);
  const revived = derive([instance], { date: acceptDate, log: readDailyLog(acceptDate) });
  assert.deepEqual(revived.suggestions.map(s => s.uid), [instance.uid]);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
