/**
 * Unit tests for the meeting→ticket learning memory: titleKey normalization,
 * the four resolver outcomes (uid / unanimous title / conflicting title /
 * nothing), learning side effects (accept, edit, the description deviation
 * rule), manual mute (timed / forever), and load-time pruning.
 *
 * Run: npx tsx tests/unit/meeting-associations.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import {
  emptyMeetingAssociations,
  learnFromAccept,
  learnFromEdit,
  loadMeetingAssociations,
  muteSeries,
  normalizeTitleKey,
  pruneMeetingAssociations,
  resolveSuggestion,
  unmuteAllSeries,
  unmuteSeries,
  type MeetingAssociation,
  type MeetingAssociations,
} from '../../src/core/meeting-associations.js';

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

const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function assoc(over: Partial<MeetingAssociation> = {}): MeetingAssociation {
  return {
    task: 'ATL-100',
    activity: 'Other',
    titleKey: 'review sprint',
    uses: 1,
    lastUsedAt: '2026-07-10T10:00:00.000Z',
    ...over,
  };
}

function withSeries(series: Record<string, MeetingAssociation>): MeetingAssociations {
  return { ...emptyMeetingAssociations(), series };
}

console.log('normalizeTitleKey');

test('lowercases, drops digits/punctuation/emoji, sorts tokens', () => {
  assert.equal(normalizeTitleKey('Sprint Review #42 🚀'), 'review sprint');
  assert.equal(normalizeTitleKey('review SPRINT'), 'review sprint');
});

test('word order and separators do not matter', () => {
  assert.equal(normalizeTitleKey('Payments weekly sync'), normalizeTitleKey('Weekly sync — Payments'));
});

test('duplicate tokens collapse; cyrillic survives', () => {
  assert.equal(normalizeTitleKey('sync sync sync'), 'sync');
  assert.equal(normalizeTitleKey('Планёрка Команды 2'), 'команды планёрка');
});

test('letterless titles give an empty key', () => {
  assert.equal(normalizeTitleKey('1:1'), '');
  assert.equal(normalizeTitleKey(''), '');
});

console.log('');
console.log('resolveSuggestion — four outcomes');

test('uid hit resolves at series level, learned description included', () => {
  const all = withSeries({ 'u1': assoc({ description: 'Дейли' }) });
  const r = resolveSuggestion('u1', 'whatever', false, all);
  assert.deepEqual(r.resolved, { task: 'ATL-100', activity: 'Other', description: 'Дейли', level: 'series' });
  assert.equal(r.candidates, undefined);
});

test('unanimous titleKey resolves at title level from the freshest match', () => {
  const all = withSeries({
    'u-old': assoc({ activity: 'Meeting', lastUsedAt: '2026-07-01T10:00:00.000Z' }),
    'u-new': assoc({ activity: 'Other', lastUsedAt: '2026-07-15T10:00:00.000Z' }),
  });
  const r = resolveSuggestion('u-unknown', 'Sprint Review #43', false, all);
  assert.deepEqual(r.resolved, { task: 'ATL-100', activity: 'Other', level: 'title' });
});

test('conflicting titleKey yields candidates only — distinct tasks, recency order', () => {
  const all = withSeries({
    'u-a': assoc({ task: 'ATL-100', lastUsedAt: '2026-07-01T10:00:00.000Z' }),
    'u-b': assoc({ task: 'ATL-200', activity: 'Meeting', lastUsedAt: '2026-07-15T10:00:00.000Z' }),
    'u-c': assoc({ task: 'ATL-200', lastUsedAt: '2026-07-10T10:00:00.000Z' }),
  });
  const r = resolveSuggestion('u-unknown', 'Sprint Review', false, all);
  assert.equal(r.resolved, undefined);
  assert.deepEqual(r.candidates, [
    { task: 'ATL-200', activity: 'Meeting', lastUsedAt: '2026-07-15T10:00:00.000Z' },
    { task: 'ATL-100', activity: 'Other', lastUsedAt: '2026-07-01T10:00:00.000Z' },
  ]);
});

test('no match and empty titleKey give nothing', () => {
  const all = withSeries({ 'u1': assoc() });
  assert.deepEqual(resolveSuggestion('u-x', 'Architecture kata', false, all), {});
  assert.deepEqual(resolveSuggestion('u-x', '1:1', false, all), {});
});

test('private instances skip the title tier (masked titles would cross-associate)', () => {
  const all = withSeries({ 'u1': assoc({ titleKey: normalizeTitleKey('Private appointment') }) });
  assert.deepEqual(resolveSuggestion('u-x', 'Private appointment', true, all), {});
  // ...but the uid tier still works for private series
  const direct = resolveSuggestion('u1', 'Private appointment', true, all);
  assert.equal(direct.resolved?.level, 'series');
});

console.log('');
console.log('learnFromAccept — deviation rule, last-write-wins');

test('first accept stores the association; default description is NOT stored', () => {
  learnFromAccept({ uid: 'a1', title: 'Daily standup', isPrivate: false, task: 'ATL-1', activity: 'Other', description: 'Daily standup', nowMs: NOW });
  const stored = loadMeetingAssociations(NOW).series['a1'];
  assert.equal(stored.task, 'ATL-1');
  assert.equal(stored.uses, 1);
  assert.equal(stored.titleKey, 'daily standup');
  assert.equal(stored.description, undefined);
});

test('custom description is stored; re-accept bumps uses and rewrites (last-write-wins)', () => {
  learnFromAccept({ uid: 'a2', title: 'Grooming', isPrivate: false, task: 'ATL-1', activity: 'Other', description: 'Грумим бэклог', nowMs: NOW });
  learnFromAccept({ uid: 'a2', title: 'Grooming', isPrivate: false, task: 'ATL-2', activity: 'Meeting', description: 'Грумим бэклог', nowMs: NOW + 1000 });
  const stored = loadMeetingAssociations(NOW).series['a2'];
  assert.equal(stored.task, 'ATL-2');
  assert.equal(stored.activity, 'Meeting');
  assert.equal(stored.uses, 2);
  assert.equal(stored.description, 'Грумим бэклог');
});

test('re-accepting the default description clears the learned one (follow the live title again)', () => {
  learnFromAccept({ uid: 'a3', title: 'Retro', isPrivate: false, task: 'ATL-1', activity: 'Other', description: 'своё описание', nowMs: NOW });
  learnFromAccept({ uid: 'a3', title: 'Retro', isPrivate: false, task: 'ATL-1', activity: 'Other', description: 'Retro', nowMs: NOW + 1000 });
  assert.equal(loadMeetingAssociations(NOW).series['a3'].description, undefined);
});

test('private accept gets an empty titleKey (uid tier only)', () => {
  learnFromAccept({ uid: 'a4', title: 'Private appointment', isPrivate: true, task: 'ATL-1', activity: 'Other', description: 'терапия', nowMs: NOW });
  const stored = loadMeetingAssociations(NOW).series['a4'];
  assert.equal(stored.titleKey, '');
  assert.equal(stored.description, 'терапия');
});

console.log('');
console.log('learnFromEdit');

test('edit re-learns activity and description by the deviation rule', () => {
  learnFromAccept({ uid: 'e1', title: 'Design sync', isPrivate: false, task: 'ATL-1', activity: 'Other', description: 'Design sync', nowMs: NOW });
  learnFromEdit({ uid: 'e1', task: 'ATL-1', activity: 'Meeting', description: 'обсуждали макеты', title: 'Design sync', isPrivate: false, nowMs: NOW + 1000 });
  const stored = loadMeetingAssociations(NOW).series['e1'];
  assert.equal(stored.activity, 'Meeting');
  assert.equal(stored.description, 'обсуждали макеты');
});

test('edit with a pruned instance (title null) keeps the stored description untouched', () => {
  learnFromAccept({ uid: 'e2', title: 'Planning', isPrivate: false, task: 'ATL-1', activity: 'Other', description: 'спринт-планирование', nowMs: NOW });
  learnFromEdit({ uid: 'e2', task: 'ATL-1', activity: 'Meeting', description: 'что-то новое', title: null, isPrivate: false, nowMs: NOW + 1000 });
  const stored = loadMeetingAssociations(NOW).series['e2'];
  assert.equal(stored.activity, 'Meeting');
  assert.equal(stored.description, 'спринт-планирование');
});

test('edit recreates a lost association from the entry', () => {
  learnFromEdit({ uid: 'e3', task: 'ATL-7', activity: 'Meeting', description: 'ревью дизайна', title: 'Design review', isPrivate: false, nowMs: NOW });
  const stored = loadMeetingAssociations(NOW).series['e3'];
  assert.equal(stored.task, 'ATL-7');
  assert.equal(stored.titleKey, 'design review');
  assert.equal(stored.uses, 1);
});

console.log('');
console.log('manual mute → unmute');

const DAY_MS = 86_400_000;

test('timed mute stores until + title snapshot and expires on load', () => {
  muteSeries({ uid: 'm1', days: 7, title: 'Daily standup', nowMs: NOW });
  const m = loadMeetingAssociations(NOW).muted['m1'];
  assert.ok(m);
  assert.equal(m.title, 'Daily standup');
  assert.equal(m.until, new Date(NOW + 7 * DAY_MS).toISOString());
  assert.ok(loadMeetingAssociations(NOW + 7 * DAY_MS - 1000).muted['m1'], 'still muted just before until');
  assert.equal(loadMeetingAssociations(NOW + 7 * DAY_MS + 1000).muted['m1'], undefined, 'expired after until');
});

test('mute without days is forever', () => {
  muteSeries({ uid: 'm2', title: 'Retro', nowMs: NOW });
  const m = loadMeetingAssociations(NOW + 365 * DAY_MS).muted['m2'];
  assert.ok(m);
  assert.equal(m.until, undefined);
});

test('re-mute replaces the window (last-write-wins)', () => {
  muteSeries({ uid: 'm3', days: 7, nowMs: NOW });
  muteSeries({ uid: 'm3', nowMs: NOW + 1000 });
  assert.equal(loadMeetingAssociations(NOW).muted['m3'].until, undefined);
});

test('unmute releases the series; a second call is a no-op', () => {
  muteSeries({ uid: 'm4', nowMs: NOW });
  assert.equal(unmuteSeries('m4'), true);
  assert.equal(loadMeetingAssociations(NOW).muted['m4'], undefined);
  assert.equal(unmuteSeries('m4'), false);
});

test('unmuteAllSeries clears every mute and returns the released uids', () => {
  muteSeries({ uid: 'm5', days: 30, nowMs: NOW });
  muteSeries({ uid: 'm6', nowMs: NOW });
  const released = unmuteAllSeries();
  assert.ok(released.includes('m5') && released.includes('m6'));
  assert.deepEqual(loadMeetingAssociations(NOW).muted, {});
  assert.deepEqual(unmuteAllSeries(), []);
});

console.log('');
console.log('prune');

test('idle series expire after the retention window; fresh ones survive', () => {
  const all = withSeries({
    'stale': assoc({ lastUsedAt: '2025-12-01T10:00:00.000Z' }),
    'fresh': assoc({ lastUsedAt: '2026-07-01T10:00:00.000Z' }),
  });
  const pruned = pruneMeetingAssociations(all, NOW);
  assert.deepEqual(Object.keys(pruned.series), ['fresh']);
});

test('expired mutes drop; future and forever mutes survive', () => {
  const all: MeetingAssociations = {
    series: {},
    muted: {
      'expired': { mutedAt: '2026-07-01T10:00:00.000Z', until: '2026-07-08T10:00:00.000Z' },
      'future': { mutedAt: '2026-07-17T10:00:00.000Z', until: '2026-08-17T10:00:00.000Z' },
      'forever': { mutedAt: '2025-01-01T10:00:00.000Z' },
    },
  };
  const pruned = pruneMeetingAssociations(all, NOW);
  assert.deepEqual(Object.keys(pruned.muted).sort(), ['forever', 'future']);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
