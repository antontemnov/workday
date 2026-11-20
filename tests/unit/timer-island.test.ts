/**
 * Unit tests for the manual timer's own tray parts: the clock math every
 * timer surface shares, the self-ticking time node, and the island — the
 * day's timers under the header chip. The daemon gives a timer's numbers as
 * of one moment; a running one counts on from there, in the chip, the island
 * and its record alike. The island's description is a plain field: Enter or
 * a click away keeps it, Esc puts it back, a poll never touches the text
 * under the caret; Esc on a fresh timer's empty field takes the timer back.
 *
 * Headless: fake clock + fake timeout / interval queue, stub host element.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/timer-island.test.ts
 */
import assert from 'node:assert/strict';

// ─── Fake clock + timers (installed before the component modules load) ────
let nowMs = 1_700_000_000_000;
Date.now = () => nowMs;

interface FakeTimer { id: number; fn: () => void; at: number; every: number | null }
let timerSeq = 1;
let timerQueue: FakeTimer[] = [];
(globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0): number => {
  timerQueue.push({ id: timerSeq, fn, at: nowMs + ms, every: null });
  return timerSeq++;
};
(globalThis as { setInterval: unknown }).setInterval = (fn: () => void, ms: number): number => {
  timerQueue.push({ id: timerSeq, fn, at: nowMs + ms, every: ms });
  return timerSeq++;
};
const clearFake = (id: number): void => {
  timerQueue = timerQueue.filter(t => t.id !== id);
};
(globalThis as { clearTimeout: unknown }).clearTimeout = clearFake;
(globalThis as { clearInterval: unknown }).clearInterval = clearFake;

function advance(ms: number): void {
  const target = nowMs + ms;
  for (let guard = 0; guard < 100_000; guard++) {
    const due = timerQueue.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    nowMs = Math.max(nowMs, due.at);
    if (due.every === null) timerQueue = timerQueue.filter(t => t.id !== due.id);
    else due.at += due.every;
    due.fn();
  }
  nowMs = target;
}

const change = (currentValue: unknown): { previousValue: null; currentValue: unknown; firstChange: false } =>
  ({ previousValue: null, currentValue, firstChange: false });
await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { TimerState } = await import('../../tray-app/src/app/models/workday.models');
const {
  currentTimer, formatMinutes, formatRecordTime, formatTicking, formatTimerTime, liveMinutes, liveShareMs, liveTotalMs,
} = await import('../../tray-app/src/app/timer/timer-clock.util');
const { TimerTimeComponent } = await import('../../tray-app/src/app/timer/timer-time.component');
const { TimerIslandComponent } = await import('../../tray-app/src/app/timer/timer-island.component');
import type { TimerView } from '../../tray-app/src/app/models/workday.models';

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

const SECOND = 1000;
const MINUTE = 60_000;
const iso = (offsetMs = 0): string => new Date(nowMs + offsetMs).toISOString();

function timer(id: string, state: TimerView['state'], over: Partial<TimerView> = {}): TimerView {
  return {
    id, state, entryId: null, task: null, activity: null, added: false, description: '',
    totalMs: 0, shareMs: 0, handMinutes: 0, hidden: false, touchedAt: iso(), ...over,
  };
}

// ─── The clock ────────────────────────────────────────────────────────────

test('a running timer counts on from the daemon\'s moment', () => {
  const asOf = nowMs;
  const t = timer('t1', TimerState.Running, { entryId: 'e1', totalMs: 47 * MINUTE, shareMs: 12 * MINUTE });
  assert.equal(liveTotalMs(t, asOf, asOf + 90 * SECOND), 47 * MINUTE + 90 * SECOND);
  assert.equal(liveShareMs(t, asOf, asOf + 90 * SECOND), 12 * MINUTE + 90 * SECOND);
  assert.equal(liveMinutes(t, asOf, asOf + 90 * SECOND), 48, 'whole minutes of the record');
});

test('a waiting or a paused timer stands still', () => {
  const asOf = nowMs;
  for (const state of [TimerState.Waiting, TimerState.Paused]) {
    const t = timer('t1', state, { totalMs: 47 * MINUTE, shareMs: 12 * MINUTE });
    assert.equal(liveTotalMs(t, asOf, asOf + 90 * SECOND), 47 * MINUTE, state);
    assert.equal(liveShareMs(t, asOf, asOf + 90 * SECOND), 12 * MINUTE, state);
  }
});

test('a clock behind the daemon\'s moment never takes time back', () => {
  const t = timer('t1', TimerState.Running, { totalMs: 47 * MINUTE });
  assert.equal(liveTotalMs(t, nowMs + 5 * SECOND, nowMs), 47 * MINUTE);
});

test('time text: whole minutes, and seconds for what ticks', () => {
  assert.equal(formatMinutes(0), '0m');
  assert.equal(formatMinutes(47 * MINUTE + 59 * SECOND), '47m');
  assert.equal(formatMinutes(62 * MINUTE), '1h 02m');
  assert.equal(formatMinutes(-5 * MINUTE), '0m');
  assert.equal(formatTicking(0), '0m 00s');
  assert.equal(formatTicking(47 * MINUTE + 15 * SECOND), '47m 15s');
  assert.equal(formatTicking(62 * MINUTE + 5 * SECOND), '1h 02m 05s', 'seconds stay past the hour');
});

test('the row prints the timer\'s own time, not its record\'s', () => {
  const at = nowMs;
  const t = timer('a', TimerState.Running, { entryId: 'e1', totalMs: 4 * 60 * MINUTE + 5 * MINUTE, shareMs: 5 * MINUTE, handMinutes: 240 });
  assert.equal(formatTimerTime(t, at, at), '5m 00s', 'four hours typed into the record are not the timer\'s');
  assert.equal(formatTimerTime(t, at, at + 61 * SECOND), '6m 01s');
  assert.equal(liveMinutes(t, at, at + 61 * SECOND), 246, 'the record\'s whole minutes move with it');
});

test('a card prints the record\'s whole time while its timer is on', () => {
  const at = nowMs;
  // 1h 14m typed by hand, 3m 36s counted by the timer.
  const t = timer('a', TimerState.Running, { entryId: 'e1', totalMs: 77 * MINUTE + 36 * SECOND, shareMs: 3 * MINUTE + 36 * SECOND, handMinutes: 74 });
  assert.equal(formatRecordTime(t, at, at), '1h 17m 36s');
  assert.equal(formatRecordTime(t, at, at + 24 * SECOND), '1h 18m 00s');
  assert.equal(formatTimerTime(t, at, at), '3m 36s', 'the island, the chip and the widget keep the timer\'s own');
  const waiting = { ...t, state: TimerState.Waiting };
  assert.equal(formatRecordTime(waiting, at, at + MINUTE), '1h 17m 36s', 'a timer that waits does not count');
});

test('a record at rest reads in minutes; whatever is on, and a loose timer, keeps seconds', () => {
  const ms = 47 * MINUTE + 15 * SECOND;
  const at = nowMs;
  assert.equal(formatTimerTime(timer('a', TimerState.Paused, { entryId: 'e1', shareMs: ms }), at, at), '47m');
  assert.equal(formatTimerTime(timer('b', TimerState.Running, { entryId: 'e1', shareMs: ms }), at, at), '47m 15s');
  assert.equal(formatTimerTime(timer('c', TimerState.Waiting, { entryId: 'e1', shareMs: ms }), at, at), '47m 15s');
  assert.equal(formatTimerTime(timer('d', TimerState.Paused, { shareMs: ms }), at, at), '47m 15s');
});

test('the chip shows the running timer, else the waiting one, else the last touched', () => {
  const old = timer('old', TimerState.Paused, { touchedAt: iso(-30 * MINUTE) });
  const recent = timer('recent', TimerState.Paused, { touchedAt: iso(-2 * MINUTE) });
  const waiting = timer('waiting', TimerState.Waiting, { touchedAt: iso(-50 * MINUTE) });
  const running = timer('running', TimerState.Running, { touchedAt: iso(-60 * MINUTE) });
  assert.equal(currentTimer([]), null);
  assert.equal(currentTimer([recent, old])?.id, 'recent');
  assert.equal(currentTimer([old, recent, waiting])?.id, 'waiting');
  assert.equal(currentTimer([old, waiting, recent, running])?.id, 'running');
});

// ─── The ticking time node ────────────────────────────────────────────────

interface TimeHarness {
  comp: InstanceType<typeof TimerTimeComponent>;
  minutes: () => number;
  repaints: () => number;
  set: (t: TimerView) => void;
}

function makeTime(t: TimerView, whole = false): TimeHarness {
  let repaints = 0;
  let minutes = 0;
  const zone = { runOutsideAngular: (fn: () => void): void => fn(), run: (fn: () => void): void => fn() };
  const cdr = { detectChanges: (): void => { repaints++; }, markForCheck(): void {} };
  const comp = new TimerTimeComponent(zone as never, cdr as never);
  comp.whole = whole;
  comp.minuteChanged.subscribe(() => { minutes++; });
  const set = (next: TimerView): void => {
    comp.timer = next;
    comp.asOf = iso();
    comp.ngOnChanges();
  };
  set(t);
  return { comp, minutes: () => minutes, repaints: () => repaints, set };
}

test('time node: a running timer ticks by itself and tells of every crossed minute', () => {
  const h = makeTime(timer('t1', TimerState.Running, { totalMs: 58 * SECOND, shareMs: 58 * SECOND }));
  assert.equal(h.comp.text, '0m 58s');
  advance(SECOND);
  assert.equal(h.comp.text, '0m 59s');
  assert.equal(h.minutes(), 0);
  advance(SECOND);
  assert.equal(h.comp.text, '1m 00s');
  assert.equal(h.minutes(), 1, 'the minute is told once');
  advance(MINUTE);
  assert.equal(h.comp.text, '2m 00s');
  assert.equal(h.minutes(), 2);
  assert.equal(h.repaints(), 62, 'one repaint a second, not one a tick');
  h.comp.ngOnDestroy();
});

test('time node: in a card it ticks the record\'s time, elsewhere the timer\'s', () => {
  const fed = timer('t1', TimerState.Running, { entryId: 'e1', totalMs: 77 * MINUTE + 36 * SECOND, shareMs: 3 * MINUTE + 36 * SECOND, handMinutes: 74 });
  const card = makeTime(fed, true);
  const island = makeTime(fed);
  assert.equal(card.comp.text, '1h 17m 36s');
  assert.equal(island.comp.text, '3m 36s');
  advance(24 * SECOND);
  assert.equal(card.comp.text, '1h 18m 00s');
  assert.equal(island.comp.text, '4m 00s');
  assert.equal(card.minutes(), 1, 'the minute the sums move on is the record\'s');
  card.comp.ngOnDestroy();
  island.comp.ngOnDestroy();
});

test('time node: nothing ticks at rest, a pause stops the clock', () => {
  timerQueue = [];
  const h = makeTime(timer('t1', TimerState.Paused, { shareMs: 5 * MINUTE }));
  assert.equal(timerQueue.length, 0, 'no interval for a paused timer');
  h.set(timer('t1', TimerState.Running, { shareMs: 5 * MINUTE }));
  assert.equal(timerQueue.length, 1);
  h.set(timer('t1', TimerState.Running, { shareMs: 5 * MINUTE }));
  assert.equal(timerQueue.length, 1, 'a poll does not start a second clock');
  advance(3 * SECOND);
  assert.equal(h.comp.text, '5m 03s');
  h.set(timer('t1', TimerState.Waiting, { shareMs: 5 * MINUTE + 3 * SECOND }));
  assert.equal(timerQueue.length, 0, 'a session took the count — the clock stops');
  advance(10 * SECOND);
  assert.equal(h.comp.text, '5m 03s');
});

test('time node: a leaving node takes its clock along; a pinned box follows the text', () => {
  timerQueue = [];
  const h = makeTime(timer('t1', TimerState.Running, { shareMs: 9 * MINUTE + 59 * SECOND }));
  assert.equal(h.comp.pinnedWidth, null);
  h.comp.pinWidth = true;
  assert.equal(h.comp.pinnedWidth, '9m 59s'.length);
  advance(SECOND);
  assert.equal(h.comp.pinnedWidth, '10m 00s'.length);
  h.comp.ngOnDestroy();
  assert.equal(timerQueue.length, 0);
});

// ─── The island ───────────────────────────────────────────────────────────

interface FakeField { value: string; blurred: number; focused: number; blur(): void; focus(): void }
interface FakeKey { key: string; target: FakeField; prevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }

function field(value: string): FakeField {
  return { value, blurred: 0, focused: 0, blur(): void { this.blurred++; }, focus(): void { this.focused++; } };
}

function key(name: string, target: FakeField): FakeKey {
  return {
    key: name, target, prevented: false, stopped: false,
    preventDefault(): void { this.prevented = true; },
    stopPropagation(): void { this.stopped = true; },
  };
}

interface IslandHarness {
  comp: InstanceType<typeof TimerIslandComponent>;
  described: { id: string; description: string }[];
  cancelled: string[];
  settled: () => number;
  /** A tray poll. */
  refresh: (timers: readonly TimerView[]) => void;
  birth: (id: string | null) => void;
  hostField: FakeField;
  lastSelector: () => string;
}

function makeIsland(timers: readonly TimerView[]): IslandHarness {
  const hostField = field('');
  let lastSelector = '';
  const host = { nativeElement: { querySelector: (selector: string): FakeField => { lastSelector = selector; return hostField; } } };
  const comp = new TimerIslandComponent(host as never);
  const described: { id: string; description: string }[] = [];
  const cancelled: string[] = [];
  let settled = 0;
  comp.described.subscribe((d: { id: string; description: string }) => described.push(d));
  comp.cancelled.subscribe((id: string) => cancelled.push(id));
  comp.birthSettled.subscribe(() => { settled++; });
  const refresh = (next: readonly TimerView[]): void => {
    comp.timers = next;
    comp.asOf = iso();
    comp.ngOnChanges({ timers: change(next) } as never);
  };
  refresh(timers);
  return {
    comp, described, cancelled, settled: () => settled, refresh, hostField, lastSelector: () => lastSelector,
    birth: (id: string | null) => {
      comp.birthId = id;
      comp.ngOnChanges({ birthId: change(id) } as never);
    },
  };
}

const loose = (id: string, description: string, state: TimerView['state'] = TimerState.Paused): TimerView =>
  timer(id, state, { description, shareMs: 12 * MINUTE });

test('island: every timer of the day; task? leaves only its own row', () => {
  const h = makeIsland([loose('a', 'ops help'), loose('b', 'incident call', TimerState.Running)]);
  assert.deepEqual(h.comp.rows.map(t => t.id), ['a', 'b']);
  h.comp.anchorId = 'b';
  assert.deepEqual(h.comp.rows.map(t => t.id), ['b'], 'the cloud hangs under one row');
  assert.equal(h.comp.isLive(h.comp.rows[0]), true);
  assert.equal(h.comp.isLive(loose('a', '')), false);
  assert.equal(h.comp.isLive(loose('c', '', TimerState.Waiting)), true, 'waiting is switched on too');
});

test('island description: Enter keeps what was typed and leaves the field', () => {
  const t = loose('a', 'ops help');
  const h = makeIsland([t]);
  const input = field('ops help');
  h.comp.onDescFocus(t);
  input.value = '  incident call ';
  h.comp.onDescInput(t, input.value);
  const enter = key('Enter', input);
  h.comp.onDescKeydown(t, enter as never);
  assert.deepEqual(h.described, [{ id: 'a', description: 'incident call' }]);
  assert.equal(input.blurred, 1);
  assert.equal(enter.prevented, true);
  h.comp.onDescBlur(t); // the blur that follows
  assert.equal(h.described.length, 1, 'sent once');
});

test('island description: the sent text holds until the daemon\'s data carries it', () => {
  const t = loose('a', 'ops help');
  const h = makeIsland([t]);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, 'incident call');
  h.comp.onDescBlur(t); // a click away keeps it too
  assert.equal(h.described.length, 1);
  assert.equal(h.comp.descriptionOf(t), 'incident call', 'no flash of the old text');
  h.refresh([t]); // a poll sent before the action
  assert.equal(h.comp.descriptionOf(t), 'incident call');
  const landed = loose('a', 'incident call');
  h.refresh([landed]);
  h.refresh([loose('a', 'renamed elsewhere')]);
  assert.equal(h.comp.descriptionOf(loose('a', 'renamed elsewhere')), 'renamed elsewhere', 'the data rules again');
});

test('island description: a poll never touches the text under the caret', () => {
  const t = loose('a', 'ops help', TimerState.Running);
  const h = makeIsland([t]);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, 'ops he');
  const polled = loose('a', 'ops help', TimerState.Running);
  h.refresh([polled]);
  assert.equal(h.comp.descriptionOf(polled), 'ops he');
  assert.equal(h.comp.trackById(0, polled), 'a', 'the row keeps its node');
  assert.equal(h.described.length, 0);
});

test('island description: Esc puts the text back and keeps nothing', () => {
  const t = loose('a', 'ops help');
  const h = makeIsland([t]);
  const input = field('ops help');
  h.comp.onDescFocus(t);
  input.value = 'something else';
  h.comp.onDescInput(t, input.value);
  const esc = key('Escape', input);
  h.comp.onDescKeydown(t, esc as never);
  assert.equal(input.value, 'ops help');
  assert.equal(esc.stopped, true, 'Esc ends the edit, not the island');
  h.comp.onDescBlur(t);
  assert.equal(h.described.length, 0);
  assert.equal(h.cancelled.length, 0, 'an old timer is never taken back by Esc');
  assert.equal(h.comp.descriptionOf(t), 'ops help');
});

test('island description: the same text is not sent', () => {
  const t = loose('a', 'ops help');
  const h = makeIsland([t]);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, 'ops help ');
  h.comp.onDescBlur(t);
  assert.equal(h.described.length, 0);
});

test('island description: a field that never took the caret keeps nothing on blur', () => {
  const t = loose('a', 'ops help');
  const h = makeIsland([t]);
  h.comp.onDescBlur(t);
  assert.equal(h.described.length, 0);
});

test('New timer: the caret waits in the fresh timer\'s description', () => {
  const h = makeIsland([loose('a', 'ops help'), loose('n', '', TimerState.Running)]);
  h.birth('n');
  assert.equal(h.hostField.focused, 0);
  advance(0);
  assert.equal(h.hostField.focused, 1);
  assert.ok(h.lastSelector().includes('data-id="n"'), 'the fresh row, not the first one');
});

test('New timer: Esc on the still-empty description takes the timer back', () => {
  const fresh = loose('n', '', TimerState.Running);
  const h = makeIsland([loose('a', 'ops help'), fresh]);
  h.birth('n');
  const input = field('');
  h.comp.onDescFocus(fresh);
  const esc = key('Escape', input);
  h.comp.onDescKeydown(fresh, esc as never);
  assert.deepEqual(h.cancelled, ['n']);
  assert.equal(esc.stopped, true);
  assert.equal(h.described.length, 0);
  h.comp.onDescBlur(fresh);
  assert.equal(h.described.length, 0, 'nothing is kept for a timer on its way out');
});

test('New timer: Esc with text typed only puts the text back — the timer stays', () => {
  const fresh = loose('n', '', TimerState.Running);
  const h = makeIsland([fresh]);
  h.birth('n');
  const input = field('');
  h.comp.onDescFocus(fresh);
  input.value = 'incident';
  h.comp.onDescInput(fresh, input.value);
  h.comp.onDescKeydown(fresh, key('Escape', input) as never);
  assert.equal(h.cancelled.length, 0);
  assert.equal(input.value, '');
  assert.equal(h.settled(), 1, 'it is an ordinary timer from here');
  assert.equal(h.described.length, 0);
});

test('New timer: Enter names it and ends the birth', () => {
  const fresh = loose('n', '', TimerState.Running);
  const h = makeIsland([fresh]);
  h.birth('n');
  const input = field('');
  h.comp.onDescFocus(fresh);
  input.value = 'incident call';
  h.comp.onDescInput(fresh, input.value);
  h.comp.onDescKeydown(fresh, key('Enter', input) as never);
  assert.deepEqual(h.described, [{ id: 'n', description: 'incident call' }]);
  assert.equal(h.settled(), 1);
});

test('New timer: a click away with nothing typed ends the birth, sends nothing', () => {
  const fresh = loose('n', '', TimerState.Running);
  const h = makeIsland([fresh]);
  h.birth('n');
  h.comp.onDescFocus(fresh);
  h.comp.onDescBlur(fresh);
  assert.equal(h.settled(), 1);
  assert.equal(h.described.length, 0);
  assert.equal(h.cancelled.length, 0);
});

const ticketed = (id: string, description: string, over: Partial<TimerView> = {}): TimerView =>
  timer(id, TimerState.Running, { entryId: 'e-' + id, task: 'ATL-6712', activity: 'Other', description, shareMs: 12 * MINUTE, ...over });

test('island: a timer with a ticket edits its record\'s description from its row', () => {
  const t = ticketed('a', 'release notes');
  const h = makeIsland([t]);
  assert.equal(h.comp.isDescribable(t), true);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, 'release notes, part 2');
  h.comp.onDescBlur(t);
  assert.deepEqual(h.described, [{ id: 'a', description: 'release notes, part 2' }]);
  assert.equal(h.comp.descriptionOf(t), 'release notes, part 2');
});

test('island: an emptied description of a record is put back, never sent', () => {
  const t = ticketed('a', 'release notes');
  const h = makeIsland([t]);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, '   ');
  const emptied = field('   ');
  h.comp.onDescKeydown(t, key('Enter', emptied) as never);
  assert.equal(h.described.length, 0);
  assert.equal(emptied.value, 'release notes', 'put back at once');
  assert.equal(h.comp.descriptionOf(t), 'release notes');

  const blurred = field('');
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, '');
  h.comp.onDescBlur(t, blurred as never); // a click away
  assert.equal(h.described.length, 0);
  assert.equal(blurred.value, 'release notes');

  const own = loose('b', 'ops help');
  h.refresh([t, own]);
  h.comp.onDescFocus(own);
  h.comp.onDescInput(own, '');
  h.comp.onDescBlur(own);
  assert.deepEqual(h.described, [{ id: 'b', description: '' }], 'a no-ticket timer may lose its text');
});

test('island: a description the daemon refused goes back to the stored text', () => {
  const t = ticketed('a', 'release notes');
  const h = makeIsland([t]);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, 'release notes, part 2');
  h.comp.onDescBlur(t);
  assert.equal(h.comp.descriptionOf(t), 'release notes, part 2');
  h.comp.forgetSent('a');
  assert.equal(h.comp.descriptionOf(t), 'release notes');
});

test('island: manual added has no text to edit; a closed month freezes a record\'s row', () => {
  const added = ticketed('a', '', { added: true });
  const record = ticketed('b', 'release notes');
  const own = loose('c', 'ops help');
  const h = makeIsland([added, record, own]);
  assert.equal(h.comp.isDescribable(added), false);
  assert.equal(h.comp.isFrozen(record), false);
  h.comp.locked = true;
  assert.equal(h.comp.isFrozen(record), true, 'Remove and the text act on the record');
  assert.equal(h.comp.isDescribable(record), false);
  assert.equal(h.comp.isFrozen(own), false, 'a no-ticket timer touches no record');
  assert.equal(h.comp.isDescribable(own), true);
});

test('island: a description sent for a timer that is gone is forgotten', () => {
  const t = loose('a', 'ops help');
  const h = makeIsland([t]);
  h.comp.onDescFocus(t);
  h.comp.onDescInput(t, 'incident call');
  h.comp.onDescBlur(t);
  h.refresh([]); // deleted meanwhile
  const reborn = loose('a', 'ops help');
  h.refresh([reborn]);
  assert.equal(h.comp.descriptionOf(reborn), 'ops help');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
