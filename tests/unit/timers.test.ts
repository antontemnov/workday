/**
 * Unit tests for the manual timer model: a timer is a source of time for a
 * manual entry — it adds whole minutes to the entry and keeps its own share
 * apart. Covers every timer action, the entry ↔ timer invariants on the
 * existing entry paths (edit, absorb, collapse, delete), the day gates, the
 * month cut and the report.
 *
 * Run: npx tsx tests/unit/timers.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import {
  createEmptyLog,
  writeDailyLog,
  addManualEntry,
  editManualEntry,
  deleteManualEntry,
  setAddedMinutes,
  findAddedEntry,
  collapseAddedEntries,
  overwriteEntryFromTempo,
  bindTimer,
} from '../../src/core/daily-log.js';
import {
  getTimers,
  findEntryTimer,
  countedMs,
  shareMs,
  handMinutes,
  creditTimers,
  newTimer,
  startTimer,
  startEntryTimer,
  pauseTimer,
  yieldTimer,
  pauseAllTimers,
  describeTimer,
  deleteTimer,
  cancelNewTimer,
  hideTimer,
  removeEntryTimer,
  markTimersAlive,
  skipDowntime,
  stopTimersForDayEnd,
} from '../../src/core/timers.js';
import { isDayMaterialized } from '../../src/core/day-lifecycle.js';
import { isEmptyDayLog } from '../../src/core/janitor.js';
import { cutDayAt, isEmptyCut } from '../../src/core/month-lock.js';
import { deleteTaskOnDate } from '../../src/core/day-edit.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { buildReport } from '../../src/push/report-builder.js';
import { DayStatus, SensitivityLevel, TimerState, type AppConfig, type DailyLog, type ManualEntry, type Timer } from '../../src/core/types.js';

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

const config: AppConfig = {
  repos: [],
  boundaryHour: 4,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: [] },
  genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 0 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5],
  holidays: [],
  apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal },
} as unknown as AppConfig;

const MINUTE = 60_000;
const NOW = Date.now();
// A moment `minutes` (plus a few seconds, clear of a minute edge) before now.
const ago = (minutes: number, seconds = 15): string => new Date(NOW - minutes * MINUTE - seconds * 1000).toISOString();
const nowIso = (): string => new Date().toISOString();

const makeLog = (date = '2026-06-13'): DailyLog => createEmptyLog(date, config);
const described = (log: DailyLog, task: string, minutes: number, description = 'incident call'): ManualEntry =>
  addManualEntry(log, { task, minutes, description, activity: 'Meeting' }, config);
const bare = (log: DailyLog, task: string, minutes: number): ManualEntry =>
  addManualEntry(log, { task, minutes, description: '', activity: 'Development' }, config);
const only = (log: DailyLog): Timer => {
  assert.equal(getTimers(log).length, 1, 'exactly one timer');
  return getTimers(log)[0];
};

console.log('Timer — start, pause, one live at a time');

test('a new timer has no ticket and runs at once', () => {
  const log = makeLog();
  const { timer, displaced } = newTimer(log, '  deploy  ', ago(10));
  assert.equal(displaced, null);
  assert.equal(timer.entryId, null);
  assert.equal(timer.description, 'deploy');
  assert.equal(timer.state, TimerState.Running);
  assert.equal(timer.spans.length, 1);
  assert.equal(timer.spans[0].to, null);
  assert.ok(countedMs(timer, NOW) >= 10 * MINUTE);
});

test('starting a timer puts the live one on pause', () => {
  const log = makeLog();
  const first = newTimer(log, 'deploy', ago(30)).timer;
  const second = newTimer(log, 'call', ago(10));
  assert.deepEqual(second.displaced, { id: first.id, state: TimerState.Running });
  assert.equal(first.state, TimerState.Paused);
  assert.equal(first.spans[0].to, ago(10));
  assert.equal(countedMs(first, NOW), 20 * MINUTE);
  assert.equal(second.timer.state, TimerState.Running);
});

test('pause and start again: the pause is the gap between two stretches', () => {
  const log = makeLog();
  const timer = newTimer(log, '', ago(30)).timer;
  pauseTimer(log, timer, ago(20));
  assert.equal(timer.state, TimerState.Paused);
  assert.equal(timer.touchedAt, ago(20));
  startTimer(log, timer, ago(5));
  assert.equal(timer.spans.length, 2);
  assert.equal(countedMs(timer, Date.parse(ago(0))), 15 * MINUTE);
});

test('a session takes the count: the timer is paused, the mark of the hand stays where it was', () => {
  const log = makeLog();
  const timer = newTimer(log, '', ago(30)).timer;
  yieldTimer(log, timer, ago(20));
  assert.equal(timer.state, TimerState.Paused);
  assert.equal(timer.spans[0].to, ago(20));
  assert.equal(timer.touchedAt, ago(30), 'not a pause by hand');
  yieldTimer(log, timer, ago(10));
  assert.equal(timer.spans.length, 1, 'a paused timer has nothing to give');
  assert.equal(countedMs(timer, Date.parse(ago(0))), 10 * MINUTE);
});

test('a start by hand brings a timer paused by a session back to running', () => {
  const log = makeLog();
  const timer = newTimer(log, '', ago(30)).timer;
  yieldTimer(log, timer, ago(20));
  assert.equal(startTimer(log, timer, ago(5)), null);
  assert.equal(timer.state, TimerState.Running);
  assert.equal(timer.spans.length, 2);
});

console.log('Timer — feeding an entry');

test('a timer on an entry adds whole minutes on top of what was typed', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  const { timer } = startEntryTimer(log, entry.id, ago(47));
  assert.equal(timer.entryId, entry.id);
  assert.equal(creditTimers(log, NOW), true);
  assert.equal(entry.minutes, 167);
  assert.equal(timer.creditedMinutes, 47);
  assert.equal(handMinutes(log, entry), 120);
  assert.equal(creditTimers(log, NOW), false, 'nothing new within the same minute');
});

test('crediting a pushed day turns it back into a draft', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 30);
  startEntryTimer(log, entry.id, ago(0, 20));
  log.status = DayStatus.Pushed;
  creditTimers(log, NOW);
  assert.equal(log.status, DayStatus.Pushed, 'no whole minute yet — nothing changed');
  creditTimers(log, NOW + MINUTE);
  assert.equal(entry.minutes, 31);
  assert.equal(log.status, DayStatus.Draft);
});

test('an entry takes one timer: a second start runs the one it has', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 30);
  const first = startEntryTimer(log, entry.id, ago(20)).timer;
  pauseTimer(log, first, ago(10));
  const again = startEntryTimer(log, entry.id, ago(5)).timer;
  assert.equal(again, first);
  assert.equal(getTimers(log).length, 1);
  assert.throws(() => startEntryTimer(log, 'nope', nowIso()), /Manual entry not found/);
});

console.log('Timer — task? → Log');

test('a ticket turns the timer\'s time into a record; the timer keeps its state and place', () => {
  const log = makeLog();
  const paused = newTimer(log, 'old', ago(90)).timer;
  const timer = newTimer(log, 'incident call', ago(47)).timer;
  const { entry, timer: bound } = bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'incident call' }, config);
  assert.equal(bound, timer);
  assert.equal(entry.task, 'ATL-7');
  assert.equal(entry.minutes, 47);
  assert.equal(entry.added, undefined);
  assert.equal(timer.entryId, entry.id);
  assert.equal(timer.description, '');
  assert.equal(timer.state, TimerState.Running);
  assert.equal(handMinutes(log, entry), 0, 'grown from the timer alone');
  assert.deepEqual(getTimers(log).map(t => t.id), [paused.id, timer.id]);
});

test('bare Development lands on the ticket\'s manual added record', () => {
  const log = makeLog();
  bare(log, 'ATL-7', 30);
  const timer = newTimer(log, '', ago(12)).timer;
  pauseTimer(log, timer, ago(0));
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Development', description: '' }, config);
  assert.equal(entry, findAddedEntry(log, 'ATL-7'));
  assert.equal(entry.minutes, 42);
  assert.equal(handMinutes(log, entry), 30);
  assert.equal(timer.state, TimerState.Paused, 'a paused timer stays paused');
  assert.equal(log.manualEntries.length, 1);
});

test('bare Development on a ticket without a record creates the record', () => {
  const log = makeLog();
  const timer = newTimer(log, '', ago(3)).timer;
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-8', activity: 'Development', description: '' }, config);
  assert.equal(entry.added, true);
  assert.equal(entry.minutes, 3);
});

test('a bigger number in the form: the record gets it, the timer keeps what it counted', () => {
  const log = makeLog();
  const timer = newTimer(log, 'review', ago(47)).timer;
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-7', activity: 'CodeReview', description: 'review', minutes: 60 }, config);
  assert.equal(entry.minutes, 60);
  assert.equal(timer.creditedMinutes, 47);
  assert.equal(handMinutes(log, entry), 13);
  assert.equal(timer.spans.length, 1, 'the timer is not touched');
  assert.equal(timer.state, TimerState.Running);
  creditTimers(log, Date.now() + 2 * MINUTE);
  assert.equal(entry.minutes, 62);
});

test('a smaller number in the form cuts the timer down to it', () => {
  const log = makeLog();
  const timer = newTimer(log, 'review', ago(47)).timer;
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-7', activity: 'CodeReview', description: 'review', minutes: 30 }, config);
  assert.equal(entry.minutes, 30);
  assert.equal(timer.creditedMinutes, 30);
  assert.equal(handMinutes(log, entry), 0);
  const share = shareMs(timer, Date.now());
  assert.ok(share >= 30 * MINUTE && share < 31 * MINUTE, 'the timer reads the record\'s number');
  assert.ok(countedMs(timer, Date.now()) >= 47 * MINUTE, 'the history stays');
  assert.equal(timer.state, TimerState.Running);
  creditTimers(log, Date.now() + 2 * MINUTE);
  assert.equal(entry.minutes, 32);
});

test('a timer started a moment ago binds with zero minutes', () => {
  const log = makeLog();
  const timer = newTimer(log, 'call', ago(0, 5)).timer;
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'call', minutes: 0 }, config);
  assert.equal(entry.minutes, 0);
});

test('a record that already has a timer takes the bound one in and keeps its place', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-7', 10);
  const resident = startEntryTimer(log, record.id, ago(60)).timer;
  const stray = newTimer(log, '', ago(20)).timer;
  assert.equal(resident.state, TimerState.Paused);
  const { timer } = bindTimer(log, stray.id, { task: 'ATL-7', activity: 'Development', description: '' }, config);
  assert.equal(timer, resident);
  assert.equal(only(log), resident);
  assert.equal(resident.state, TimerState.Running, 'the live state comes over');
  assert.equal(record.minutes, 10 + 60, '40m of its own + 20m of the bound one');
  assert.equal(handMinutes(log, record), 10);
});

test('binding is validated before anything changes', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 30);
  const fed = startEntryTimer(log, entry.id, ago(5)).timer;
  const timer = newTimer(log, '', ago(3)).timer;
  assert.throws(() => bindTimer(log, 'nope', { task: 'ATL-7', activity: 'Meeting', description: 'x' }, config), /Timer not found/);
  assert.throws(() => bindTimer(log, fed.id, { task: 'ATL-7', activity: 'Meeting', description: 'x' }, config), /already has a ticket/);
  assert.throws(() => bindTimer(log, timer.id, { task: 'nope', activity: 'Meeting', description: 'x' }, config), /not a valid Jira key/);
  assert.throws(() => bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Meeting', description: '' }, config), /Description is required/);
  assert.throws(() => bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'x', minutes: 481 }, config), /Max is 480/);
  assert.throws(() => bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'x', minutes: -1 }, config), /zero or positive/);
  assert.equal(timer.entryId, null);
  assert.equal(log.manualEntries.length, 1);
});

console.log('Timer — a number typed into the entry');

test('a typed number does not touch what the timer counted', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  const timer = startEntryTimer(log, entry.id, ago(5)).timer;
  const { entry: edited } = editManualEntry(log, entry.id, { minutes: 240 }, config);
  assert.equal(edited.minutes, 240, 'the record is the number typed');
  assert.equal(timer.creditedMinutes, 5, 'the timer still reads five minutes');
  assert.equal(handMinutes(log, entry), 235);
  assert.equal(timer.state, TimerState.Running);
  assert.equal(timer.spans.length, 1);
  assert.equal(timer.spans[0].off, undefined);
  creditTimers(log, Date.now() + 3 * MINUTE);
  assert.equal(entry.minutes, 243);
});

test('a number below the entry but not below the timer leaves the timer whole', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  const timer = startEntryTimer(log, entry.id, ago(47)).timer;
  editManualEntry(log, entry.id, { minutes: 90 }, config);
  assert.equal(entry.minutes, 90);
  assert.equal(timer.creditedMinutes, 47);
  assert.equal(handMinutes(log, entry), 43);
  assert.equal(timer.spans.length, 1);
});

test('a number smaller than the timer cuts the timer down to it', () => {
  const log = makeLog();
  const timer = newTimer(log, 'call', ago(190)).timer;
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-1', activity: 'Meeting', description: 'call' }, config);
  assert.equal(entry.minutes, 190, 'the timer was left running for 3h 10m');
  editManualEntry(log, entry.id, { minutes: 150 }, config);
  assert.equal(entry.minutes, 150);
  assert.equal(timer.creditedMinutes, 150);
  assert.equal(handMinutes(log, entry), 0);
  const share = shareMs(timer, Date.now());
  assert.ok(share >= 150 * MINUTE && share < 151 * MINUTE, 'the timer reads 2h 30m too');
  assert.equal(timer.state, TimerState.Running, 'a running timer counts on');
  assert.equal(timer.spans.filter(span => span.off).length, 1, 'the latest stretch is cut off');
  assert.ok(countedMs(timer, Date.now()) >= 190 * MINUTE, 'the history stays');
  creditTimers(log, Date.now() + 3 * MINUTE);
  assert.equal(entry.minutes, 153);
});

test('the cut takes the latest stretches first and splits the one it falls into', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 10);
  const timer = startEntryTimer(log, entry.id, ago(100)).timer;
  pauseTimer(log, timer, ago(80));
  startTimer(log, timer, ago(60));
  pauseTimer(log, timer, ago(30));
  startTimer(log, timer, ago(10));
  pauseTimer(log, timer, ago(0));
  assert.equal(entry.minutes, 10 + 20 + 30 + 10);
  editManualEntry(log, entry.id, { minutes: 35 }, config);
  assert.equal(timer.creditedMinutes, 35);
  assert.equal(shareMs(timer, Date.now()), 35 * MINUTE);
  assert.deepEqual(timer.spans.map(span => span.off === true), [false, false, true, true]);
  assert.equal(timer.spans[1].to, timer.spans[2].from, 'the middle stretch is split at the cut');
  assert.equal(timer.state, TimerState.Paused, 'a paused timer stays paused');
  assert.equal(timer.spans.every(span => span.to !== null), true);
});

test('an unchanged number, or a description alone, leaves the timer untouched', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  const timer = startEntryTimer(log, entry.id, ago(47)).timer;
  editManualEntry(log, entry.id, { description: 'incident call, part 2' }, config);
  assert.equal(entry.minutes, 167);
  assert.equal(timer.creditedMinutes, 47);
  editManualEntry(log, entry.id, { minutes: 167 }, config);
  assert.equal(timer.creditedMinutes, 47);
  assert.equal(timer.spans.length, 1);
});

test('manual added: an absolute set keeps the timer, a bare add is typed on top', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-7', 30);
  const timer = startEntryTimer(log, record.id, ago(20)).timer;
  creditTimers(log, NOW);
  assert.equal(record.minutes, 50);

  bare(log, 'ATL-7', 15);
  assert.equal(record.minutes, 65);
  assert.equal(timer.creditedMinutes, 20, 'an add does not touch the timer');
  assert.equal(handMinutes(log, record), 45);

  setAddedMinutes(log, 'ATL-7', 40, config);
  assert.equal(record.minutes, 40);
  assert.equal(timer.creditedMinutes, 20);
  assert.equal(handMinutes(log, record), 20);

  setAddedMinutes(log, 'ATL-7', 12, config);
  assert.equal(record.minutes, 12);
  assert.equal(timer.creditedMinutes, 12, 'a total below the timer cuts it down');
  assert.equal(handMinutes(log, record), 0);
});

test('the 8h cap guards what is typed, not what the timer counted', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-7', 30);
  startEntryTimer(log, record.id, ago(500));
  creditTimers(log, NOW);
  assert.equal(record.minutes, 530);
  bare(log, 'ATL-7', 15);
  assert.equal(record.minutes, 545);
  assert.throws(() => bare(log, 'ATL-7', 440), /Max is 480/);
});

test('Tempo\'s number taken for an entry follows the same rule', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 60);
  const timer = startEntryTimer(log, entry.id, ago(10)).timer;
  pauseTimer(log, timer, ago(0));
  overwriteEntryFromTempo(log, entry.id, { minutes: 45, description: 'incident call', activity: 'Meeting' });
  assert.equal(entry.minutes, 45);
  assert.equal(timer.creditedMinutes, 10);
  assert.equal(handMinutes(log, entry), 35);
  overwriteEntryFromTempo(log, entry.id, { minutes: 45, description: 'renamed', activity: 'Meeting' });
  assert.equal(timer.spans.some(span => span.off), false);
  overwriteEntryFromTempo(log, entry.id, { minutes: 4, description: 'renamed', activity: 'Meeting' });
  assert.equal(entry.minutes, 4);
  assert.equal(timer.creditedMinutes, 4);
  assert.equal(shareMs(timer, Date.now()), 4 * MINUTE);
});

console.log('Timer — Remove timer, Delete');

test('Remove timer takes the timer\'s time out and leaves what was typed', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  startEntryTimer(log, entry.id, ago(47));
  const { removedMinutes } = removeEntryTimer(log, entry.id, nowIso());
  assert.equal(removedMinutes, 47);
  assert.equal(entry.minutes, 120);
  assert.equal(getTimers(log).length, 0);
  assert.equal(log.timers, undefined);
});

test('an entry grown from the timer alone has no Remove timer', () => {
  const log = makeLog();
  const timer = newTimer(log, 'call', ago(47)).timer;
  const { entry } = bindTimer(log, timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'call' }, config);
  assert.throws(() => removeEntryTimer(log, entry.id, nowIso()), /Nothing typed by hand/);
  assert.equal(timer.state, TimerState.Running, 'a refusal changes nothing');
  assert.throws(() => removeEntryTimer(log, 'nope', nowIso()), /No timer on entry/);
});

test('after an edit of the time Remove timer still takes out what the timer counted', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  startEntryTimer(log, entry.id, ago(47));
  editManualEntry(log, entry.id, { minutes: 150 }, config);
  const { removedMinutes } = removeEntryTimer(log, entry.id, nowIso());
  assert.equal(removedMinutes, 47);
  assert.equal(entry.minutes, 103);
});

test('an entry cut down to its timer has nothing typed by hand left', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 120);
  startEntryTimer(log, entry.id, ago(47));
  editManualEntry(log, entry.id, { minutes: 30 }, config);
  assert.throws(() => removeEntryTimer(log, entry.id, nowIso()), /Nothing typed by hand/);
});

test('deleting an entry deletes its timer', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 30);
  startEntryTimer(log, entry.id, ago(5));
  const stray = newTimer(log, 'keep', ago(1)).timer;
  deleteManualEntry(log, entry.id);
  assert.equal(only(log), stray);
});

test('deleting a ticket\'s tracked block deletes the timer of its manual added record', () => {
  const tracker = new SessionTracker(config, makeLog(new Date().toISOString().slice(0, 10)));
  const log = tracker.getDailyLog();
  const record = bare(log, 'ATL-7', 30);
  startEntryTimer(log, record.id, ago(5));
  assert.equal(tracker.deleteTask('ATL-7').ok, true);
  assert.equal(getTimers(log).length, 0);

  const past = makeLog('2026-06-10');
  const pastRecord = bare(past, 'ATL-7', 30);
  const pastTimer = startEntryTimer(past, pastRecord.id, '2026-06-10T10:00:00.000Z').timer;
  pauseTimer(past, pastTimer, '2026-06-10T10:20:00.000Z');
  described(past, 'ATL-9', 15);
  writeDailyLog(past);
  const { log: after } = deleteTaskOnDate('2026-06-10', 'ATL-7');
  assert.equal(getTimers(after).length, 0);
});

console.log('Timer — entries merging');

test('an entry retired into manual added with a smaller number brings a cut timer', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-7', 30);
  const entry = addManualEntry(log, { task: 'ATL-7', minutes: 20, description: 'spike', activity: 'Development' }, config);
  const timer = startEntryTimer(log, entry.id, ago(40)).timer;
  const { entry: target } = editManualEntry(log, entry.id, { description: '', minutes: 25 }, config);
  assert.equal(target, record);
  assert.equal(record.minutes, 55, '30 of the record + the 25 typed');
  assert.equal(timer.entryId, record.id);
  assert.equal(timer.creditedMinutes, 25);
  assert.equal(handMinutes(log, record), 30);
});

test('an entry edited down to bare Development hands its timer to manual added', () => {
  const log = makeLog();
  const record = bare(log, 'ATL-7', 30);
  const entry = addManualEntry(log, { task: 'ATL-7', minutes: 20, description: 'spike', activity: 'Development' }, config);
  const timer = startEntryTimer(log, entry.id, ago(10)).timer;
  const { entry: target, absorbed } = editManualEntry(log, entry.id, { description: '' }, config);
  assert.equal(target, record);
  assert.equal(absorbed?.id, entry.id);
  assert.equal(record.minutes, 60, '30 + 20 typed + 10 of the timer');
  assert.equal(only(log), timer);
  assert.equal(timer.entryId, record.id);
  assert.equal(timer.state, TimerState.Running);
  assert.equal(handMinutes(log, record), 50);
});

test('two records of one ticket collapse into one record with one timer', () => {
  const log = makeLog();
  const first: ManualEntry = { id: 'a1', task: 'ATL-7', minutes: 30, description: '', activity: 'Development', createdAt: ago(200), added: true };
  const second: ManualEntry = { id: 'b2', task: 'ATL-7', minutes: 10, description: '', activity: 'Development', createdAt: ago(100), added: true };
  log.manualEntries.push(first, second);
  const older = startEntryTimer(log, 'a1', ago(60)).timer;
  const newer = startEntryTimer(log, 'b2', ago(20)).timer;
  creditTimers(log, NOW);
  assert.equal(first.minutes + second.minutes, 30 + 40 + 10 + 20);

  assert.equal(collapseAddedEntries(log), 2);
  const record = findAddedEntry(log, 'ATL-7')!;
  assert.equal(record.id, 'a1');
  assert.equal(record.minutes, 100);
  const timer = only(log);
  assert.equal(timer, older);
  assert.equal(timer.entryId, 'a1');
  assert.equal(timer.creditedMinutes, 60);
  assert.equal(timer.state, TimerState.Running, 'the running one was absorbed');
  assert.equal(newer.state, TimerState.Running);
  assert.equal(handMinutes(log, record), 40);
});

console.log('Timer — no-ticket timers');

test('Esc right after New timer: the timer goes, the one it paused runs again', () => {
  const log = makeLog();
  const first = newTimer(log, 'deploy', ago(30)).timer;
  const fresh = newTimer(log, '', ago(1));
  cancelNewTimer(log, fresh.timer.id, fresh.displaced, ago(0));
  assert.equal(only(log), first);
  assert.equal(first.state, TimerState.Running);
  assert.equal(first.spans.length, 2);
  assert.equal(countedMs(first, Date.parse(ago(0))), 29 * MINUTE, 'the minute under the cancelled timer is nobody\'s');
});

test('a cancelled timer leaves one that a session paused on pause', () => {
  const log = makeLog();
  const first = newTimer(log, 'deploy', ago(30)).timer;
  yieldTimer(log, first, ago(10));
  const fresh = newTimer(log, '', ago(1));
  assert.equal(fresh.displaced, null);
  cancelNewTimer(log, fresh.timer.id, fresh.displaced, ago(0));
  assert.equal(first.state, TimerState.Paused);
  assert.equal(first.spans.length, 1);
});

test('only a fresh timer can be cancelled; a described one is deleted', () => {
  const log = makeLog();
  const timer = newTimer(log, '', ago(5)).timer;
  describeTimer(log, timer.id, ' call with ops ');
  assert.equal(timer.description, 'call with ops');
  assert.throws(() => cancelNewTimer(log, timer.id, null, nowIso()), /Only a fresh timer/);
  deleteTimer(log, timer.id);
  assert.equal(getTimers(log).length, 0);
});

test('a timer with a ticket is not described, deleted or cancelled on its own', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 30);
  const timer = startEntryTimer(log, entry.id, ago(5)).timer;
  assert.throws(() => describeTimer(log, timer.id, 'x'), /takes its description from the entry/);
  assert.throws(() => deleteTimer(log, timer.id), /removed from its entry/);
  assert.throws(() => cancelNewTimer(log, timer.id, null, nowIso()), /Only a fresh timer/);
});

test('only a paused timer leaves the widget; a start brings it back', () => {
  const log = makeLog();
  const timer = newTimer(log, '', ago(5)).timer;
  assert.throws(() => hideTimer(log, timer.id), /Only a paused timer/);
  pauseTimer(log, timer, ago(1));
  hideTimer(log, timer.id);
  assert.equal(timer.hidden, true);
  startTimer(log, timer, ago(0));
  assert.equal(timer.hidden, undefined);
});

console.log('Timer — sleep, daemon stop, day end');

test('downtime is nobody\'s: the running timer is cut where it was last seen and counts on', () => {
  const log = makeLog();
  const entry = described(log, 'ATL-1', 0 + 30);
  const timer = startEntryTimer(log, entry.id, ago(120)).timer;
  markTimersAlive(log, ago(90));
  assert.equal(skipDowntime(log, ago(10)), 1);
  assert.equal(timer.state, TimerState.Running);
  assert.equal(timer.spans.length, 2);
  assert.equal(timer.spans[0].to, ago(90));
  assert.equal(timer.spans[1].from, ago(10));
  assert.equal(timer.lastSeenAt, ago(10));
  creditTimers(log, Date.parse(ago(0)));
  assert.equal(entry.minutes, 30 + 30 + 10, '80 minutes of sleep are not counted');
});

test('a timer an older build left waiting comes back paused; a paused one is not touched', () => {
  const log = makeLog();
  const paused = newTimer(log, 'old', ago(200)).timer;
  const waiting = newTimer(log, 'deploy', ago(120)).timer;
  yieldTimer(log, waiting, ago(100));
  waiting.state = 'waiting' as TimerState;
  const seen = paused.lastSeenAt;
  assert.equal(skipDowntime(log, ago(10)), 0);
  assert.equal(waiting.state, TimerState.Paused);
  assert.equal(waiting.spans.length, 1);
  assert.equal(paused.lastSeenAt, seen);
});

test('a stop by hand pauses every live timer', () => {
  const log = makeLog();
  const timer = newTimer(log, 'deploy', ago(30)).timer;
  assert.equal(pauseAllTimers(log, ago(10)), 1);
  assert.equal(timer.state, TimerState.Paused);
  assert.equal(countedMs(timer, NOW), 20 * MINUTE);
  assert.equal(pauseAllTimers(log, ago(5)), 0);
});

test('the day ends: timers stop at the boundary, the unlinked one stays in the day', () => {
  const log = makeLog('2026-06-13');
  const entry = described(log, 'ATL-1', 30);
  const fed = startEntryTimer(log, entry.id, '2026-06-14T01:00:00.000Z').timer;
  const idle = newTimer(log, 'never ran', '2026-06-14T02:00:00.000Z').timer;
  pauseTimer(log, idle, '2026-06-14T02:00:00.000Z');
  const unlinked = newTimer(log, 'helped the ops team', '2026-06-14T03:00:00.000Z').timer;

  stopTimersForDayEnd(log, '2026-06-14T04:00:00.000Z');
  assert.deepEqual(getTimers(log).map(t => t.id), [fed.id, unlinked.id]);
  assert.equal(fed.state, TimerState.Paused);
  assert.equal(fed.spans[0].to, '2026-06-14T02:00:00.000Z');
  assert.equal(entry.minutes, 30 + 60);
  assert.equal(unlinked.entryId, null);
  assert.equal(unlinked.spans[0].to, '2026-06-14T04:00:00.000Z');
  assert.equal(countedMs(unlinked, Date.now()), 60 * MINUTE);
  assert.equal(idle.spans.length, 0);
});

console.log('Timer — the day\'s gates, month cut, report');

test('a timer is a fact of the day: the file is written and never swept away', () => {
  const log = makeLog();
  assert.equal(isDayMaterialized(log, false), false);
  assert.equal(isEmptyDayLog(log), true);
  const timer = newTimer(log, 'deploy', ago(5)).timer;
  assert.equal(isDayMaterialized(log, false), true);
  assert.equal(isEmptyDayLog(log), false);
  deleteTimer(log, timer.id);
  assert.equal(isEmptyDayLog(log), true);
});

test('a log written before timers existed reads as a day without timers', () => {
  const log = makeLog();
  described(log, 'ATL-1', 30);
  assert.equal(log.timers, undefined);
  assert.equal(getTimers(log).length, 0);
  assert.equal(creditTimers(log, NOW), false);
  assert.equal(skipDowntime(log, nowIso()), 0);
  assert.equal(findEntryTimer(log, log.manualEntries[0].id), undefined);
  assert.equal(isEmptyCut(cutDayAt(log, new Date(Date.now() + MINUTE).toISOString(), () => false)), true);
});

test('the month closed: a timer running across the moment ends there', () => {
  const log = makeLog('2026-06-30');
  const entry: ManualEntry = { id: 'e1', task: 'ATL-1', minutes: 30, description: 'call', activity: 'Meeting', createdAt: '2026-06-30T09:00:00.000Z' };
  log.manualEntries.push(entry);
  const timer = startEntryTimer(log, 'e1', '2026-06-30T10:00:00.000Z').timer;
  creditTimers(log, Date.parse('2026-06-30T12:00:00.000Z'));
  assert.equal(entry.minutes, 150);

  const cut = cutDayAt(log, '2026-06-30T11:00:00.000Z', () => false);
  assert.equal(cut.trimmedTimers, 1);
  assert.equal(isEmptyCut(cut), false);
  assert.equal(timer.state, TimerState.Paused);
  assert.equal(timer.spans[0].to, '2026-06-30T11:00:00.000Z');
  assert.equal(entry.minutes, 90, 'the hour after the submit leaves the entry');
});

test('the month closed: what was born after the moment goes, timers included', () => {
  const log = makeLog('2026-06-30');
  const before: ManualEntry = { id: 'e1', task: 'ATL-1', minutes: 30, description: 'call', activity: 'Meeting', createdAt: '2026-06-30T09:00:00.000Z' };
  const after: ManualEntry = { id: 'e2', task: 'ATL-2', minutes: 0, description: 'late', activity: 'Meeting', createdAt: '2026-06-30T12:00:00.000Z' };
  log.manualEntries.push(before, after);
  const early = startEntryTimer(log, 'e1', '2026-06-30T09:30:00.000Z').timer;
  pauseTimer(log, early, '2026-06-30T10:00:00.000Z');
  startEntryTimer(log, 'e2', '2026-06-30T12:00:00.000Z');
  newTimer(log, 'stray', '2026-06-30T12:30:00.000Z');

  const cut = cutDayAt(log, '2026-06-30T11:00:00.000Z', () => false);
  assert.deepEqual(cut.removedEntries.map(e => e.id), ['e2']);
  assert.equal(cut.trimmedTimers, 1, 'the stray one; the early timer ended before the moment');
  assert.equal(only(log), early);
  assert.equal(before.minutes, 30 + 30);
});

test('a record a timer has only begun to feed is not reported as a block', () => {
  const log = makeLog('2026-06-12');
  const timer = newTimer(log, '', '2026-06-12T10:00:00.000Z').timer;
  pauseTimer(log, timer, '2026-06-12T10:00:20.000Z');
  bindTimer(log, timer.id, { task: 'ATL-8', activity: 'Development', description: '' }, config);
  assert.equal(findAddedEntry(log, 'ATL-8')?.minutes, 0);
  writeDailyLog(log);
  assert.deepEqual(buildReport('2026-06-12', '2026-06-12', config), []);

  setAddedMinutes(log, 'ATL-8', 5, config);
  writeDailyLog(log);
  const report = buildReport('2026-06-12', '2026-06-12', config);
  assert.equal(report.length, 1);
  assert.equal(report[0].totalSeconds, 15 * 60, 'a real minute still rounds to a block, as before');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
