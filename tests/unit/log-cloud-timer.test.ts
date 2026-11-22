/**
 * Unit tests for the Log cloud's two timer roles. task? in the island opens
 * the cloud as a pure ticket picker for that timer: any pick leads to the
 * one-button form with the timer's minutes and description, and Log binds
 * the timer — the number goes along only when it was changed, so the record
 * otherwise takes the timer's own time. Outside that, a text typed into the
 * filter can become a timer without a ticket (Start timer «text»).
 *
 * The duration field under the form: a number it was given stays as it is —
 * a timer may have counted fewer minutes than a typed entry can have.
 *
 * Headless: fake clock + fake timer queue, stub API.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/log-cloud-timer.test.ts
 */
import assert from 'node:assert/strict';

// ─── Fake clock + timers (installed before the component module loads) ────
let nowMs = 1_700_000_000_000;
Date.now = () => nowMs;

interface FakeTimer { id: number; fn: () => void; at: number }
let timerSeq = 1;
let timerQueue: FakeTimer[] = [];
(globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0): number => {
  timerQueue.push({ id: timerSeq, fn, at: nowMs + ms });
  return timerSeq++;
};
(globalThis as { clearTimeout: unknown }).clearTimeout = (id: number): void => {
  timerQueue = timerQueue.filter(t => t.id !== id);
};

await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { LogCloudComponent } = await import(
  '../../tray-app/src/app/views/day-view/log-cloud/log-cloud.component');
const { DurationInputDirective } = await import(
  '../../tray-app/src/app/views/day-view/duration-field/duration-input.directive');
const { DEVELOPMENT_ACTIVITY } = await import('../../tray-app/src/app/models/workday.models');
import type { Favorite, JiraSearchHit, TimerBindInput } from '../../tray-app/src/app/models/workday.models';
import type { TimerPickTarget } from '../../tray-app/src/app/views/day-view/log-cloud/log-cloud.component';

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

const fav = (id: string, name: string, task: string, minutes: number, activity: string): Favorite =>
  ({ id, name, task, minutes, activity, createdAt: new Date(nowMs).toISOString() });

const STANDUP = fav('f1', 'daily standup', 'ATL-101', 15, 'Other');
const REVIEW = fav('f2', 'PR review', 'ATL-205', 30, 'CodeReview');
const HIT: JiraSearchHit = { key: 'ATL-10', summary: 'Payment retry: dedupe keys' };
const NO_EVENT = {} as never;

type Cloud = InstanceType<typeof LogCloudComponent>;
interface Harness {
  comp: Cloud;
  bound: TimerBindInput[];
  startedTexts: string[];
  instantLogs: () => number;
  formLogs: () => number;
}

function makeCloud(target: TimerPickTarget | null): Harness {
  const api = { getJiraInProgress: async (): Promise<{ ok: false }> => ({ ok: false }) };
  const comp = new LogCloudComponent(api as never);
  comp.open = true;
  comp.activityTypes = [
    { value: DEVELOPMENT_ACTIVITY, name: 'Development' },
    { value: 'Other', name: 'Other' },
    { value: 'CodeReview', name: 'Code Review' },
  ];
  comp.favorites = [STANDUP, REVIEW];
  comp.timerTarget = target;
  const bound: TimerBindInput[] = [];
  const startedTexts: string[] = [];
  let instantLogs = 0;
  let formLogs = 0;
  comp.timerBound.subscribe((b: TimerBindInput) => bound.push(b));
  comp.timerStartRequested.subscribe((text: string) => startedTexts.push(text));
  comp.chipPicked.subscribe(() => { instantLogs++; });
  comp.formSubmitted.subscribe(() => { formLogs++; });
  return { comp, bound, startedTexts, instantLogs: () => instantLogs, formLogs: () => formLogs };
}

const TIMER: TimerPickTarget = { id: 't1', description: 'incident call', minutes: 47 };
const NAMELESS: TimerPickTarget = { id: 't2', description: '', minutes: 3 };

// ─── task? — a ticket for the timer ───────────────────────────────────────

test('task?: the cloud only picks a ticket, and says for which timer', () => {
  const h = makeCloud(TIMER);
  assert.equal(h.comp.isTimerMode, true);
  assert.equal(h.comp.isPickerMode, true, 'batch and instant log go dark, as for a suggestion');
  assert.ok(h.comp.filterPlaceholder.includes('«incident call»'));
  assert.equal(h.comp.favTitle(STANDUP), '', 'no collect hint on a chip that only picks');
  assert.ok(makeCloud(NAMELESS).comp.filterPlaceholder.includes('«timer»'));
  assert.equal(makeCloud(null).comp.isPickerMode, false);
});

test('a favorite gives its ticket and activity; minutes and description are the timer\'s', () => {
  const h = makeCloud(TIMER);
  h.comp.pickFavorite(STANDUP, NO_EVENT);
  assert.equal(h.comp.mode, 'form');
  assert.equal(h.comp.formTask, 'ATL-101');
  assert.equal(h.comp.formActivity, 'Other');
  assert.equal(h.comp.formMinutes, 47, 'not the favorite\'s 15m');
  assert.equal(h.comp.formDescription, 'incident call', 'not the favorite\'s name');
  assert.equal(h.instantLogs(), 0, 'a favorite is no instant log here');
});

test('a nameless timer takes the favorite\'s name', () => {
  const h = makeCloud(NAMELESS);
  h.comp.pickFavorite(STANDUP, NO_EVENT);
  assert.equal(h.comp.formDescription, 'daily standup');
  assert.equal(h.comp.formMinutes, 3);
});

test('a Jira ticket: Development, the timer\'s description', () => {
  const h = makeCloud(TIMER);
  h.comp.pickJira(HIT, NO_EVENT);
  assert.equal(h.comp.mode, 'form');
  assert.equal(h.comp.formTask, 'ATL-10');
  assert.equal(h.comp.formSummary, 'Payment retry: dedupe keys');
  assert.equal(h.comp.formActivity, DEVELOPMENT_ACTIVITY);
  assert.equal(h.comp.formActivityNeeded, false);
  assert.equal(h.comp.formDescription, 'incident call');
});

test('an activity outside the allowed list has to be picked', () => {
  const h = makeCloud(TIMER);
  h.comp.activityAllowed = ['Other'];
  h.comp.pickJira(HIT, NO_EVENT);
  assert.equal(h.comp.formActivity, '');
  assert.equal(h.comp.formActivityNeeded, true);
  h.comp.submitForm();
  assert.equal(h.bound.length, 0);
  h.comp.formActivity = 'Other';
  h.comp.submitForm();
  assert.equal(h.bound.length, 1);
});

test('Enter in the filter picks the first chip — for the timer', () => {
  const h = makeCloud(TIMER);
  h.comp.filter = 'standup';
  h.comp.onFilterEnter();
  assert.equal(h.comp.mode, 'form');
  assert.equal(h.comp.formTask, 'ATL-101');
  assert.equal(h.comp.formMinutes, 47);
  assert.equal(h.instantLogs(), 0);
});

test('Log with the number untouched sends no minutes — the record takes the timer\'s time', () => {
  const h = makeCloud(TIMER);
  h.comp.pickFavorite(STANDUP, NO_EVENT);
  h.comp.formDescription = '  incident call ';
  h.comp.submitForm();
  assert.deepEqual(h.bound, [{ task: 'ATL-101', activity: 'Other', description: 'incident call' }]);
  assert.equal('minutes' in h.bound[0], false);
  assert.equal(h.formLogs(), 0, 'it binds the timer — no entry of its own');
});

test('Log with a changed number sends it', () => {
  const h = makeCloud(TIMER);
  h.comp.pickJira(HIT, NO_EVENT);
  h.comp.formMinutes = 30;
  h.comp.submitForm();
  assert.deepEqual(h.bound, [{ task: 'ATL-10', activity: DEVELOPMENT_ACTIVITY, description: 'incident call', minutes: 30 }]);
});

test('a nameless timer: Development may go without a description, another activity may not', () => {
  const h = makeCloud(NAMELESS);
  h.comp.pickJira(HIT, NO_EVENT);
  h.comp.formActivity = 'Other';
  h.comp.submitForm();
  assert.equal(h.bound.length, 0, 'description first');
  h.comp.formActivity = DEVELOPMENT_ACTIVITY;
  h.comp.submitForm();
  assert.deepEqual(h.bound, [{ task: 'ATL-10', activity: DEVELOPMENT_ACTIVITY, description: '' }]);
});

test('Log waits while the daemon answers', () => {
  const h = makeCloud(TIMER);
  h.comp.pickFavorite(STANDUP, NO_EVENT);
  h.comp.actionPending = true;
  h.comp.submitForm();
  assert.equal(h.bound.length, 0);
});

test('without a timer the cloud logs as before', () => {
  const h = makeCloud(null);
  h.comp.pickJira(HIT, NO_EVENT);
  assert.equal(h.comp.formMinutes, 30);
  assert.equal(h.comp.formDescription, '');
  h.comp.formActivity = DEVELOPMENT_ACTIVITY;
  h.comp.submitForm();
  assert.equal(h.formLogs(), 1);
  assert.equal(h.bound.length, 0);
});

// ─── Start timer «text» ───────────────────────────────────────────────────

test('Start timer «text»: the filter\'s text names a timer without a ticket', () => {
  const h = makeCloud(null);
  assert.equal(h.comp.canStartTimer, false, 'nothing typed — nothing to name it');
  h.comp.filter = '  review notes ';
  assert.equal(h.comp.canStartTimer, true);
  h.comp.startTimerFromFilter();
  assert.deepEqual(h.startedTexts, ['review notes']);
  assert.equal(h.instantLogs() + h.formLogs(), 0);
});

test('Start timer is offered only over the plain chip list', () => {
  const picker = makeCloud(TIMER);
  picker.comp.filter = 'review notes';
  assert.equal(picker.comp.canStartTimer, false, 'the cloud is picking a ticket for another timer');

  const batch = makeCloud(null);
  batch.comp.filter = 'review notes';
  batch.comp.batch = true;
  assert.equal(batch.comp.canStartTimer, false);

  const form = makeCloud(null);
  form.comp.filter = 'review notes';
  form.comp.pickJira(HIT, NO_EVENT);
  assert.equal(form.comp.canStartTimer, false);
  form.comp.startTimerFromFilter();
  assert.deepEqual(form.startedTexts, []);
});

test('Start timer waits while the daemon answers', () => {
  const h = makeCloud(null);
  h.comp.filter = 'review notes';
  h.comp.actionPending = true;
  h.comp.startTimerFromFilter();
  assert.deepEqual(h.startedTexts, []);
});

// ─── The duration field ───────────────────────────────────────────────────

interface FieldHarness {
  field: { value: string };
  dir: InstanceType<typeof DurationInputDirective>;
  emitted: number[];
}

function makeField(minutes: number, text: string): FieldHarness {
  const field = { value: text };
  const dir = new DurationInputDirective({ nativeElement: field } as never);
  dir.minutes = minutes;
  const emitted: number[] = [];
  dir.minutesChange.subscribe((m: number) => emitted.push(m));
  return { field, dir, emitted };
}

test('duration: a timer\'s 3m left untouched stays 3m and is no edit', () => {
  const h = makeField(3, '3m');
  h.dir.onBlur();
  assert.equal(h.field.value, '3m');
  assert.deepEqual(h.emitted, []);
  h.dir.onEnter();
  assert.deepEqual(h.emitted, []);
});

test('duration: a typed number still keeps to 5m..12h', () => {
  const low = makeField(3, '2m');
  low.dir.onBlur();
  assert.deepEqual(low.emitted, [5]);
  assert.equal(low.field.value, '5m');

  const high = makeField(47, '900m');
  high.dir.onBlur();
  assert.deepEqual(high.emitted, [720]);

  const typed = makeField(47, '1h 15m');
  typed.dir.onBlur();
  assert.deepEqual(typed.emitted, [75]);
});

test('duration: garbage puts the last good value back', () => {
  const h = makeField(47, 'soon');
  h.dir.onBlur();
  assert.equal(h.field.value, '47m');
  assert.deepEqual(h.emitted, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
