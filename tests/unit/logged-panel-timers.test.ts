/**
 * Unit tests for manual timers on the feed's records. A record a timer
 * feeds wears ▶ / ⏸ at its time and keeps that slot even alone on its card;
 * a running timer moves the record's minutes and the Day total at every
 * crossed minute, ahead of the daemon's data; the record's menu starts a
 * timer where there is none and removes one saying how much goes; a record
 * on its way out stops its live timer first; and under a timer the form's
 * number counts as edited only against what the form showed when it opened.
 *
 * Headless: fake clock + fake timer queue, null-returning host stub.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/logged-panel-timers.test.ts
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

// The clock alone: the panel's own timeouts (undo windows, overrides) stay put.
function tick(ms: number): void {
  nowMs += ms;
}

(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s };

const change = (currentValue: unknown): { previousValue: null; currentValue: unknown; firstChange: false } =>
  ({ previousValue: null, currentValue, firstChange: false });
await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { LoggedPanelComponent } = await import(
  '../../tray-app/src/app/views/day-view/logged-panel/logged-panel.component');
const { DEVELOPMENT_ACTIVITY, TimerState } = await import('../../tray-app/src/app/models/workday.models');
import type { ManualEntry, ManualEntryPatch, TimerView } from '../../tray-app/src/app/models/workday.models';

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
const iso = (): string => new Date(nowMs).toISOString();

function entry(id: string, task: string, minutes: number, description = 'incident call'): ManualEntry {
  return { id, task, minutes, description, activity: 'Other', createdAt: iso() };
}

function added(id: string, task: string, minutes: number): ManualEntry {
  return { id, task, minutes, description: '', activity: DEVELOPMENT_ACTIVITY, added: true, createdAt: iso() };
}

// A timer on a record: `total` is the record's whole time, `share` the timer's part of it.
function timerOn(
  id: string, e: ManualEntry, state: TimerView['state'], totalMs: number, shareMs: number,
): TimerView {
  return {
    id, state, entryId: e.id, task: e.task, activity: e.activity, added: e.added === true,
    description: e.description, totalMs, shareMs,
    handMinutes: Math.floor((totalMs - shareMs) / MINUTE), hidden: false, touchedAt: iso(),
  };
}

interface MenuItem { readonly label: string; readonly hint?: string; action(): void }
type Panel = InstanceType<typeof LoggedPanelComponent>;
interface Internals {
  editingId: string | null;
  editMinutes: number;
  editDescription: string;
  saveForm(e: ManualEntry | null): void;
  startTimerItems(e: ManualEntry): readonly MenuItem[];
  removeTimerItems(e: ManualEntry): readonly MenuItem[];
  deleteEntry(e: ManualEntry): void;
  deleteTaskCard(task: string): void;
}

interface Harness {
  comp: Panel;
  inner: Internals;
  /** The day's refresh: records and timers of one moment. */
  refresh: (entries: readonly ManualEntry[], timers: readonly TimerView[]) => void;
  /** A timer action's answer — the timers alone, ahead of the day. */
  timersOnly: (timers: readonly TimerView[]) => void;
  lastDiff: () => number;
  toggled: TimerView[];
  paused: string[];
  started: string[];
  removed: string[];
  patches: { id: string; patch: ManualEntryPatch }[];
}

function makePanel(entries: readonly ManualEntry[], timers: readonly TimerView[] = []): Harness {
  const host = { nativeElement: { querySelector: () => null } };
  const cdr = { markForCheck(): void {}, detectChanges(): void {} };
  const comp = new LoggedPanelComponent(host as never, cdr as never, {} as never);
  comp.issueSummaries = {};
  let diff = 0;
  const toggled: TimerView[] = [];
  const paused: string[] = [];
  const started: string[] = [];
  const removed: string[] = [];
  const patches: { id: string; patch: ManualEntryPatch }[] = [];
  comp.liveDiffChanged.subscribe((d: number) => { diff = d; });
  comp.timerToggled.subscribe((t: TimerView) => toggled.push(t));
  comp.timerPauseRequested.subscribe((id: string) => paused.push(id));
  comp.timerStartRequested.subscribe((id: string) => started.push(id));
  comp.timerRemoveRequested.subscribe((id: string) => removed.push(id));
  comp.patchCommitted.subscribe((p: { id: string; patch: ManualEntryPatch }) => patches.push(p));
  const timersOnly = (next: readonly TimerView[]): void => {
    comp.timers = next;
    comp.timersAsOf = iso();
    comp.ngOnChanges({ timers: change(next) } as never);
  };
  const refresh = (nextEntries: readonly ManualEntry[], nextTimers: readonly TimerView[]): void => {
    comp.entries = nextEntries;
    comp.timers = nextTimers;
    comp.timersAsOf = iso();
    comp.ngOnChanges({ entries: change(nextEntries), timers: change(nextTimers) } as never);
  };
  refresh(entries, timers);
  return { comp, inner: comp as never as Internals, refresh, timersOnly, lastDiff: () => diff, toggled, paused, started, removed, patches };
}

const blockOf = (h: Harness, task: string) => {
  const block = h.comp.feedBlocks.find(b => b.task === task);
  assert.ok(block, `card of ${task}`);
  return block;
};

const click = (): { stopped: boolean; stopPropagation(): void } =>
  ({ stopped: false, stopPropagation(): void { this.stopped = true; } });

// ─── The time slot ────────────────────────────────────────────────────────

test('a record with a timer keeps its own time slot, even alone on its card', () => {
  const e = entry('e1', 'ATL-10', 47);
  const plain = makePanel([e]);
  assert.equal(plain.comp.timerOf(e), null);
  assert.equal(plain.comp.blockHasTimer(blockOf(plain, 'ATL-10')), false);
  assert.equal(plain.comp.showEntryDur(blockOf(plain, 'ATL-10'), e), false, 'one row: the number lives in the lid');

  const h = makePanel([e], [timerOn('t1', e, TimerState.Paused, 47 * MINUTE, 12 * MINUTE)]);
  assert.equal(h.comp.timerOf(e)?.id, 't1');
  assert.equal(h.comp.blockHasTimer(blockOf(h, 'ATL-10')), true);
  assert.equal(h.comp.showEntryDur(blockOf(h, 'ATL-10'), e), true, 'the ▶ needs its slot');
});

test('the manual added record keeps its slot under a timer too', () => {
  const m = added('m1', 'ATL-10', 60);
  const h = makePanel([m], [timerOn('t1', m, TimerState.Paused, 60 * MINUTE, 20 * MINUTE)]);
  assert.equal(h.comp.blockHasTimer(blockOf(h, 'ATL-10')), true);
  assert.equal(h.comp.showFoldedDur(blockOf(h, 'ATL-10')), true);
});

test('row state: running, waiting (a session counts), at rest', () => {
  const e = entry('e1', 'ATL-10', 47);
  const state = (s: TimerView['state']): Harness => makePanel([e], [timerOn('t1', e, s, 47 * MINUTE, 12 * MINUTE)]);
  const running = state(TimerState.Running);
  assert.equal(running.comp.timerRunning(e), true);
  assert.equal(running.comp.timerLive(running.comp.timers[0]), true);
  assert.equal(running.comp.timerDim(running.comp.timers[0]), false);
  const waiting = state(TimerState.Waiting);
  assert.equal(waiting.comp.timerWaiting(e), true);
  assert.equal(waiting.comp.timerLive(waiting.comp.timers[0]), true, '⏸ stays — the timer is switched on');
  assert.equal(waiting.comp.timerDim(waiting.comp.timers[0]), true);
  const rest = state(TimerState.Paused);
  assert.equal(rest.comp.timerLive(rest.comp.timers[0]), false);
});

// ─── Minutes under a running timer ────────────────────────────────────────

test('a running timer moves the record and the Day total at the crossed minute', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  assert.equal(h.comp.displayMinutes(e), 47);
  tick(29 * SECOND);
  assert.equal(h.comp.displayMinutes(e), 47);
  tick(SECOND);
  assert.equal(h.comp.displayMinutes(e), 48, 'ahead of the daemon\'s data');
  h.comp.onTimerMinute(); // the time node tells of the minute
  assert.equal(h.lastDiff(), 1, 'the Day total moves in the same instant');
  assert.equal(blockOf(h, 'ATL-10').totalMs, 48 * MINUTE, 'and the card\'s lid');

  const landed = entry('e1', 'ATL-10', 48);
  h.refresh([landed], [timerOn('t1', landed, TimerState.Running, 48 * MINUTE + 2 * SECOND, 13 * MINUTE + 2 * SECOND)]);
  assert.equal(h.comp.displayMinutes(landed), 48);
  assert.equal(h.lastDiff(), 0, 'counted once');
});

test('a waiting timer does not count', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Waiting, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  tick(5 * MINUTE);
  assert.equal(h.comp.displayMinutes(e), 47);
  assert.equal(h.lastDiff(), 0);
});

test('a pause that lands ahead of the day\'s refresh takes no minute back', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  tick(35 * SECOND);
  h.comp.onTimerMinute();
  assert.equal(h.comp.displayMinutes(e), 48);

  // ⏸: the action's answer carries the timers; the records are still the old ones.
  h.timersOnly([timerOn('t1', e, TimerState.Paused, 48 * MINUTE + 5 * SECOND, 13 * MINUTE + 5 * SECOND)]);
  assert.equal(h.comp.displayMinutes(e), 48, 'no step back to 47');
  assert.equal(h.lastDiff(), 1);

  const landed = entry('e1', 'ATL-10', 48);
  h.refresh([landed], [timerOn('t1', landed, TimerState.Paused, 48 * MINUTE + 5 * SECOND, 13 * MINUTE + 5 * SECOND)]);
  assert.equal(h.comp.displayMinutes(landed), 48);
  assert.equal(h.lastDiff(), 0);
});

test('a timer taken off the record leaves the record\'s own minutes', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  tick(40 * SECOND);
  h.comp.onTimerMinute();
  assert.equal(h.lastDiff(), 1);
  const without = entry('e1', 'ATL-10', 35);
  h.refresh([without], []); // Remove timer: its 13m went
  assert.equal(h.comp.displayMinutes(without), 35);
  assert.equal(h.lastDiff(), 0);
});

// ─── ▶ / ⏸ on the row ─────────────────────────────────────────────────────

test('▶ / ⏸ hands the timer up; not while the daemon answers, not on a read-only day', () => {
  const e = entry('e1', 'ATL-10', 47);
  const t = timerOn('t1', e, TimerState.Running, 47 * MINUTE, 12 * MINUTE);
  const h = makePanel([e], [t]);
  const ev = click();
  h.comp.onTimerToggle(t, ev as never);
  assert.deepEqual(h.toggled.map(x => x.id), ['t1']);
  assert.equal(ev.stopped, true, 'the row\'s own click stays out of it');

  h.comp.actionPending = true;
  h.comp.onTimerToggle(t, click() as never);
  h.comp.actionPending = false;
  h.comp.readOnly = true;
  h.comp.onTimerToggle(t, click() as never);
  assert.equal(h.toggled.length, 1);
});

// ─── The record's menu ────────────────────────────────────────────────────

test('menu: Start timer only where the row has no ▶ of its own', () => {
  const plain = entry('e1', 'ATL-10', 30);
  const fed = entry('e2', 'ATL-10', 47);
  const h = makePanel([plain, fed], [timerOn('t1', fed, TimerState.Paused, 47 * MINUTE, 12 * MINUTE)]);
  const items = h.inner.startTimerItems(plain);
  assert.deepEqual(items.map(i => i.label), ['Start timer']);
  items[0].action();
  assert.deepEqual(h.started, ['e1'], 'the record, not a timer — it has none yet');
  assert.deepEqual(h.inner.startTimerItems(fed), []);
});

test('menu: the Timesheets card starts no timers', () => {
  const plain = entry('e1', 'ATL-10', 30);
  const h = makePanel([plain]);
  h.comp.sheet = true;
  assert.deepEqual(h.inner.startTimerItems(plain), []);
});

test('menu: Remove timer says how much goes', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Paused, 47 * MINUTE, 12 * MINUTE)]);
  const items = h.inner.removeTimerItems(e);
  assert.deepEqual(items.map(i => `${i.label} ${i.hint}`), ['Remove timer −12m']);
  items[0].action();
  assert.deepEqual(h.removed, ['e1']);
});

test('menu: under a running timer the sum is the one of this moment', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  tick(35 * SECOND);
  assert.equal(h.inner.removeTimerItems(e)[0].hint, '−13m');
});

test('menu: a share under a minute goes without a sum', () => {
  const e = entry('e1', 'ATL-10', 45);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Paused, 45 * MINUTE + 3 * SECOND, 3 * SECOND)]);
  const items = h.inner.removeTimerItems(e);
  assert.equal(items.length, 1);
  assert.equal(items[0].hint, undefined);
});

test('menu: nothing typed by hand — no Remove timer, the record goes by Delete', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Paused, 47 * MINUTE, 47 * MINUTE)]);
  assert.deepEqual(h.inner.removeTimerItems(e), []);
  assert.deepEqual(h.inner.removeTimerItems(entry('e9', 'ATL-10', 5)), [], 'no timer — no item');
});

// ─── A record on its way out ──────────────────────────────────────────────

test('deleting a record stops its live timer first', () => {
  const fed = entry('e1', 'ATL-10', 47);
  const other = entry('e2', 'ATL-10', 30, 'sprint sync');
  const h = makePanel([fed, other], [timerOn('t1', fed, TimerState.Running, 47 * MINUTE, 12 * MINUTE)]);
  h.inner.deleteEntry(fed);
  assert.deepEqual(h.paused, ['t1'], 'nothing ticks under the undo window');
  assert.equal(h.comp.isDeleted(fed), true);
});

test('deleting a record with a timer at rest asks for nothing', () => {
  const fed = entry('e1', 'ATL-10', 47);
  const other = entry('e2', 'ATL-10', 30, 'sprint sync');
  const h = makePanel([fed, other], [timerOn('t1', fed, TimerState.Paused, 47 * MINUTE, 12 * MINUTE)]);
  h.inner.deleteEntry(fed);
  assert.deepEqual(h.paused, []);
});

test('the card\'s last record: its delete is the card\'s — the timer stops once', () => {
  const fed = entry('e1', 'ATL-10', 47);
  const h = makePanel([fed], [timerOn('t1', fed, TimerState.Waiting, 47 * MINUTE, 12 * MINUTE)]);
  h.inner.deleteEntry(fed);
  assert.deepEqual(h.paused, ['t1']);
  assert.equal(h.comp.taskDeleted('ATL-10'), true);
});

test('deleting a card stops the live timer of its records only', () => {
  const fed = entry('e1', 'ATL-10', 47);
  const rest = entry('e2', 'ATL-10', 30, 'sprint sync');
  const elsewhere = entry('e3', 'ATL-20', 15, 'demo prep');
  const h = makePanel([fed, rest, elsewhere], [
    timerOn('t1', fed, TimerState.Paused, 47 * MINUTE, 12 * MINUTE),
    timerOn('t2', rest, TimerState.Paused, 30 * MINUTE, 5 * MINUTE),
    timerOn('t3', elsewhere, TimerState.Running, 15 * MINUTE, 15 * MINUTE),
  ]);
  h.inner.deleteTaskCard('ATL-10');
  assert.deepEqual(h.paused, [], 'another ticket\'s timer runs on');
  h.inner.deleteTaskCard('ATL-20');
  assert.deepEqual(h.paused, ['t3']);
});

// ─── The form under a timer ───────────────────────────────────────────────

test('edit under a running timer: the time that moved on is not an edit', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  h.comp.onRowDblClick(e);
  assert.equal(h.inner.editMinutes, 47);
  tick(45 * SECOND); // the record reads 48m by now
  h.inner.editDescription = 'incident call, part two';
  h.inner.saveForm(e);
  assert.deepEqual(h.patches, [{ id: 'e1', patch: { description: 'incident call, part two' } }],
    'no minutes: the timer\'s share stays the timer\'s');
});

test('edit under a timer: nothing changed — nothing sent', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  h.comp.onRowDblClick(e);
  tick(3 * MINUTE);
  h.inner.saveForm(e);
  assert.deepEqual(h.patches, []);
  assert.equal(h.inner.editingId, null);
});

test('edit under a timer: a typed number is the record\'s time from here', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e], [timerOn('t1', e, TimerState.Running, 47 * MINUTE + 30 * SECOND, 12 * MINUTE + 30 * SECOND)]);
  h.comp.onRowDblClick(e);
  h.inner.editMinutes = 60;
  h.inner.saveForm(e);
  assert.deepEqual(h.patches, [{ id: 'e1', patch: { minutes: 60 } }]);
  assert.equal(h.comp.displayMinutes(e), 60, 'the typed number holds until the daemon answers');
});

test('a record without a timer edits as before', () => {
  const e = entry('e1', 'ATL-10', 47);
  const h = makePanel([e]);
  h.comp.onRowDblClick(e);
  h.inner.saveForm(e);
  assert.deepEqual(h.patches, []);
  h.comp.onRowDblClick(e);
  h.inner.editMinutes = 30;
  h.inner.saveForm(e);
  assert.deepEqual(h.patches, [{ id: 'e1', patch: { minutes: 30 } }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
