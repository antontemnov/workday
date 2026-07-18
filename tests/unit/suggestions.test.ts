/**
 * Unit tests for suggestions: the derived pipeline (entry filters, covered
 * via sourceRef, dismissed, pushed-day silencing), review rows from
 * colleague-branch checkout facts, the dismissed-only state store with its
 * prune rules, and the sourceRef plumbing through manual-entry creation
 * (including the accept→delete→revive invariant).
 *
 * Run: npx tsx tests/unit/suggestions.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { deriveSuggestions, meetingSourceRef, parseMeetingSourceRef, reviewSourceRef } from '../../src/core/suggestions.js';
import { emptyMeetingAssociations, type MeetingAssociations } from '../../src/core/meeting-associations.js';
import {
  dismissSuggestionKey,
  loadSuggestionsState,
  pruneSuggestionsState,
  suggestionKey,
  type SuggestionsState,
} from '../../src/core/suggestions-state.js';
import {
  addManualEntry,
  addReviewCheckout,
  createEmptyLog,
  writeDailyLog,
  readDailyLog,
} from '../../src/core/daily-log.js';
import { addEntryOnDate, deleteEntryOnDate } from '../../src/core/day-edit.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { isDayMaterialized } from '../../src/core/day-lifecycle.js';
import { SensitivityLevel, SuggestionsDayState, type AppConfig, type CalendarInstance, type DailyLog, type ForeignCheckout, type PollResult } from '../../src/core/types.js';

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
  over: Partial<{ log: DailyLog | null; dismissedKeys: Set<string>; hidePrivate: boolean; nowMs: number; date: string; associations: MeetingAssociations }> = {},
): ReturnType<typeof deriveSuggestions> {
  return deriveSuggestions({
    date: over.date ?? DATE,
    instances,
    log: over.log ?? null,
    dismissedKeys: over.dismissedKeys ?? new Set(),
    hidePrivate: over.hidePrivate ?? false,
    nowMs: over.nowMs ?? NOW,
    associations: over.associations,
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
console.log('Derivation — learning integration');

test('muted series never surface', () => {
  const associations: MeetingAssociations = {
    ...emptyMeetingAssociations(),
    muted: { 'ev-1': { mutedAt: '2026-07-01T10:00:00.000Z' } },
  };
  const day = derive([makeInstance(), makeInstance({ uid: 'ev-2' })], { associations });
  assert.deepEqual(day.suggestions.map(s => s.uid), ['ev-2']);
});

test('rows carry resolved (uid tier) and candidates (titleKey conflict)', () => {
  const associations: MeetingAssociations = {
    ...emptyMeetingAssociations(),
    series: {
      'ev-1': { task: 'ATL-1', activity: 'Other', titleKey: 'standup', uses: 3, lastUsedAt: '2026-07-15T10:00:00.000Z' },
      'dead-a': { task: 'ATL-2', activity: 'Other', titleKey: 'grooming', uses: 1, lastUsedAt: '2026-07-10T10:00:00.000Z' },
      'dead-b': { task: 'ATL-3', activity: 'Meeting', titleKey: 'grooming', uses: 1, lastUsedAt: '2026-07-14T10:00:00.000Z' },
    },
  };
  const day = derive([makeInstance(), makeInstance({ uid: 'ev-2', title: 'Grooming' })], { associations });
  assert.equal(day.suggestions[0].resolved?.task, 'ATL-1');
  assert.equal(day.suggestions[0].resolved?.level, 'series');
  assert.equal(day.suggestions[1].resolved, undefined);
  assert.deepEqual(day.suggestions[1].candidates?.map(c => c.task), ['ATL-3', 'ATL-2']);
});

test('without associations rows stay plain (no resolved/candidates keys)', () => {
  const day = derive([makeInstance()]);
  assert.equal(day.suggestions[0].resolved, undefined);
  assert.equal(day.suggestions[0].candidates, undefined);
});

test('parseMeetingSourceRef inverts meetingSourceRef, colons in uids included', () => {
  const ref = meetingSourceRef('weird:uid:with:colons', DATE);
  assert.deepEqual(parseMeetingSourceRef(ref), { uid: 'weird:uid:with:colons', date: DATE });
  assert.equal(parseMeetingSourceRef('session:abc'), null);
  assert.equal(parseMeetingSourceRef('meeting:short'), null);
});

console.log('');
console.log('Review rows — colleague-branch checkout facts');

function logWithReviewCheckout(over: Partial<{ task: string; ts: number; branch: string }> = {}): DailyLog {
  const log = createEmptyLog(DATE, makeConfig());
  addReviewCheckout(log, {
    task: over.task ?? 'ATL-123',
    ts: over.ts ?? Date.parse('2026-07-16T11:40:00.000Z'),
    branch: over.branch ?? 'ATL-123-ivanov-feature',
    repo: 'web-frontend',
  });
  return log;
}

test('a checkout fact births a review row: static 30m, resolved by construction', () => {
  const day = derive([], { log: logWithReviewCheckout() });
  assert.equal(day.suggestions.length, 1);
  const row = day.suggestions[0];
  assert.equal(row.source, 'review');
  assert.equal(row.uid, 'ATL-123');
  assert.equal(row.title, 'ATL-123-ivanov-feature');
  assert.equal(row.plannedMinutes, 30);
  assert.equal(row.ongoing, false);
  assert.deepEqual(row.resolved, { task: 'ATL-123', activity: 'CodeReview', description: 'code review', level: 'source' });
});

test('addReviewCheckout dedups by task — repeats and other branches change nothing', () => {
  const log = logWithReviewCheckout();
  assert.equal(addReviewCheckout(log, { task: 'ATL-123', ts: 1, branch: 'ATL-123-ivanov-feature', repo: 'x' }), false);
  assert.equal(addReviewCheckout(log, { task: 'ATL-123', ts: 2, branch: 'ATL-123-ivanov-feature-fixes', repo: 'y' }), false);
  assert.equal(log.reviewCheckouts?.length, 1);
  assert.equal(log.reviewCheckouts?.[0].branch, 'ATL-123-ivanov-feature');
  assert.equal(addReviewCheckout(log, { task: 'ATL-9', ts: 3, branch: 'ATL-9-petrov-fix', repo: 'x' }), true);
  assert.equal(log.reviewCheckouts?.length, 2);
});

test('an entry with the review sourceRef covers the row; unrelated entries do not', () => {
  const config = makeConfig();
  const log = logWithReviewCheckout();
  addManualEntry(log, { task: 'ATL-123', minutes: 45, description: 'own work on the same ticket', activity: 'Other' }, config);
  assert.equal(derive([], { log }).suggestions.length, 1);
  addManualEntry(log, { task: 'ATL-123', minutes: 30, description: 'code review', activity: 'CodeReview', sourceRef: reviewSourceRef('ATL-123', DATE) }, config);
  assert.equal(derive([], { log }).suggestions.length, 0);
});

test('a dismissed review key hides the row', () => {
  const day = derive([], {
    log: logWithReviewCheckout(),
    dismissedKeys: new Set([suggestionKey('ATL-123', DATE)]),
  });
  assert.equal(day.suggestions.length, 0);
});

test('review rows merge with meetings, sorted by start', () => {
  const day = derive(
    [makeInstance({ uid: 'late', start: '2026-07-16T13:00:00.000Z', end: '2026-07-16T13:30:00.000Z' })],
    { log: logWithReviewCheckout() },  // checkout at 11:40 — before the meeting
  );
  assert.deepEqual(day.suggestions.map(s => [s.source, s.uid]), [['review', 'ATL-123'], ['meeting', 'late']]);
});

test('a pushed day silences review rows too', () => {
  const log = logWithReviewCheckout();
  log.pushedAt = '2026-07-16T18:00:00.000Z';
  const day = derive([], { log });
  assert.equal(day.state, SuggestionsDayState.Pushed);
  assert.equal(day.suggestions.length, 0);
});

test('review accept → covered; delete the entry → the row revives', () => {
  const config = makeConfig();
  const acceptDate = '2026-07-12';
  const log = createEmptyLog(acceptDate, config);
  addReviewCheckout(log, { task: 'ATL-77', ts: Date.parse('2026-07-12T10:00:00.000Z'), branch: 'ATL-77-sidorov-fix', repo: 'api' });
  writeDailyLog(log);

  const ref = reviewSourceRef('ATL-77', acceptDate);
  const { entry } = addEntryOnDate(acceptDate, { task: 'ATL-77', minutes: 30, description: 'code review', activity: 'CodeReview', sourceRef: ref }, config);
  const covered = derive([], { date: acceptDate, log: readDailyLog(acceptDate) });
  assert.equal(covered.suggestions.length, 0);

  deleteEntryOnDate(acceptDate, entry.id);
  const revived = derive([], { date: acceptDate, log: readDailyLog(acceptDate) });
  assert.deepEqual(revived.suggestions.map(s => s.uid), ['ATL-77']);
});

console.log('');
console.log('Review facts — day scoping (a quiet day stays silent)');

function makeForeignPoll(foreignCheckouts: ForeignCheckout[]): PollResult {
  return {
    repoPath: '/tmp/repoZ',
    branch: 'ATL-500-ivanov-x',
    task: null,
    snapshot: {
      branch: 'ATL-500-ivanov-x',
      trackedLines: { added: 0, removed: 0 },
      trackedFileCount: 0,
      untrackedCount: 0,
      timestamp: Date.now(),
      churnFiles: new Map(),
    },
    delta: { addedDelta: 0, removedDelta: 0, untrackedDelta: 0, hasDynamics: false, magnitude: 0 },
    newReflogEntries: [],
    currentHead: 'h',
    evidenceSnapshot: null,
    evidenceBasis: null,
    mergeBaseSha: null,
    prevEvidenceSnapshot: null,
    ledgerUpdate: null,
    foreignCheckouts,
  };
}

test('a stale checkout from a past day never lands in today\'s log', () => {
  const tracker = new SessionTracker(makeConfig());
  const now = Date.now();
  tracker.processPollResult(makeForeignPoll([
    { ts: now - 2 * 86_400_000, task: 'ATL-500', branch: 'ATL-500-ivanov-x' },  // Friday's checkout in the window
    { ts: now, task: 'ATL-501', branch: 'ATL-501-ivanov-y' },
  ]));
  assert.deepEqual(tracker.getDailyLog().reviewCheckouts?.map(rc => rc.task), ['ATL-501']);
});

test('the stale checkout alone does not materialize the day — no file, no noise', () => {
  const tracker = new SessionTracker(makeConfig());
  tracker.processPollResult(makeForeignPoll([
    { ts: Date.now() - 2 * 86_400_000, task: 'ATL-500', branch: 'ATL-500-ivanov-x' },
  ]));
  assert.equal(tracker.getDailyLog().reviewCheckouts, undefined);
  assert.equal(isDayMaterialized(tracker.getDailyLog(), false), false);
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
