/**
 * Unit tests for the logged-panel pending row — the optimistic Log. A Log
 * cloud entry stands in the feed (its card born when the ticket has none)
 * and in every total the moment it is sent; the daemon may take a second
 * (closed-month check in Tempo, issue check in Jira). The fresh id comes
 * back ahead of the refresh that carries the entry: the row must hold
 * through that gap, hand over to the landed entry, and go when the action
 * ends without it. The Add time draft rides the same row.
 *
 * Headless: fake clock + fake timer queue, null-returning host stub.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/logged-panel-pending.test.ts
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

function advance(ms: number): void {
  const target = nowMs + ms;
  for (let guard = 0; guard < 10_000; guard++) {
    const due = timerQueue.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timerQueue = timerQueue.filter(t => t.id !== due.id);
    nowMs = Math.max(nowMs, due.at);
    due.fn();
  }
  nowMs = target;
}

(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s };

const change = (currentValue: unknown): { previousValue: null; currentValue: unknown; firstChange: false } =>
  ({ previousValue: null, currentValue, firstChange: false });
await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { LoggedPanelComponent } = await import(
  '../../tray-app/src/app/views/day-view/logged-panel/logged-panel.component');
const { DEVELOPMENT_ACTIVITY } = await import('../../tray-app/src/app/models/workday.models');
import type { ManualEntry, ManualEntryInput } from '../../tray-app/src/app/models/workday.models';

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

function entry(id: string, task: string, minutes: number,
  activity = 'Other', description = 'sprint sync'): ManualEntry {
  return { id, task, minutes, description, activity, createdAt: new Date(nowMs).toISOString() };
}

function added(id: string, task: string, minutes: number): ManualEntry {
  return { ...entry(id, task, minutes, DEVELOPMENT_ACTIVITY, ''), added: true };
}

const input = (task: string, minutes: number, activity = 'Other', description = 'sprint sync'): ManualEntryInput =>
  ({ task, minutes, activity, description });

type Panel = InstanceType<typeof LoggedPanelComponent>;
interface Internals {
  landedId: string | null;
  popDelayMs: Map<string, number>;
  draftTask: string | null;
  draftMerging: boolean;
  editMinutes: number;
  editActivity: string;
  editDescription: string;
  saveForm(e: null): void;
}

interface Harness {
  comp: Panel;
  inner: Internals;
  /** Tray poll / the refresh inside runAction. */
  refresh: (entries: readonly ManualEntry[], actionDone?: boolean) => void;
  /** The app's gate flips on with the emit. */
  actionStarts: () => void;
  /** POST answered: the id lands ahead of the refresh. */
  freshId: (id: string) => void;
  lastDiff: () => number;
}

function makePanel(entries: readonly ManualEntry[] = []): Harness {
  const host = { nativeElement: { querySelector: () => null } };
  const cdr = { markForCheck(): void {}, detectChanges(): void {} };
  const comp = new LoggedPanelComponent(host as never, cdr as never, {} as never);
  comp.issueSummaries = {};
  let diff = 0;
  comp.liveDiffChanged.subscribe((d: number) => { diff = d; });
  const refresh = (next: readonly ManualEntry[], actionDone = false): void => {
    comp.entries = next;
    const changes: Record<string, unknown> = { entries: change(next) };
    if (actionDone) {
      comp.actionPending = false;
      changes['actionPending'] = change(false);
    }
    comp.ngOnChanges(changes as never);
  };
  refresh(entries);
  return {
    comp,
    inner: comp as never as Internals,
    refresh,
    actionStarts: () => {
      comp.actionPending = true;
      comp.ngOnChanges({ actionPending: change(true) } as never);
    },
    freshId: (id: string) => {
      comp.freshEntryId = id;
      comp.ngOnChanges({ freshEntryId: change(id) } as never);
    },
    lastDiff: () => diff,
  };
}

const blockOf = (h: Harness, task: string) => h.comp.feedBlocks.find(b => b.task === task);

// ─── Log cloud: a new ticket ──────────────────────────────────────────────

test('cloud pick: the card is born at once, named, counted', () => {
  const h = makePanel([entry('old', 'ATL-1', 45)]);
  advance(60_000);
  h.comp.holdLanding(input('ATL-8778', 30), 'Phase 4 - Add custom fields');
  h.actionStarts();

  const b = blockOf(h, 'ATL-8778');
  assert.ok(b, 'card born for a ticket with nothing today');
  assert.equal(b.rowCount, 1, 'the pending row is the card\'s row');
  assert.equal(b.totalMs, 30 * 60_000, 'lid Σ moves at once');
  assert.equal(h.comp.summaryOfTask('ATL-8778'), 'Phase 4 - Add custom fields');
  assert.equal(h.lastDiff(), 30, 'Day total moves at once');
  assert.equal(h.comp.feedBlocks[0].task, 'ATL-8778', 'newest card on top of the history');
  assert.equal(h.comp.pendingEnters, true, 'enters like a landed row');
});

test('cloud pick: the row holds between the id and the refresh (no blink)', () => {
  const h = makePanel();
  h.comp.holdLanding(input('ATL-8778', 30), 'Phase 4');
  h.actionStarts();
  advance(900); // daemon asks Tempo + Jira

  h.freshId('n1'); // POST answered, the refresh still in flight
  assert.ok(h.comp.draftPending, 'pending row still shown');
  assert.equal(blockOf(h, 'ATL-8778')?.rowCount, 1);
  assert.equal(h.lastDiff(), 30);

  h.refresh([entry('n1', 'ATL-8778', 30)], true);
  assert.equal(h.comp.draftPending, null, 'the entry took its place');
  assert.equal(blockOf(h, 'ATL-8778')?.rowCount, 1, 'one row, not two');
  assert.equal(h.inner.landedId, 'n1', 'landed in place — no second entrance');
  assert.equal(h.lastDiff(), 0, 'Day total settles without a jump');
});

test('cloud pick, warm daemon: the entry finishes the row-in', () => {
  const h = makePanel();
  h.comp.holdLanding(input('ATL-8778', 30), 'Phase 4');
  h.actionStarts();
  advance(20);
  h.freshId('n1');
  advance(15);
  h.refresh([entry('n1', 'ATL-8778', 30)], true);
  assert.equal(h.comp.draftPending, null);
  assert.equal(h.inner.landedId, null, 'fresh row-in plays on…');
  assert.equal(h.inner.popDelayMs.get('n1'), -35, '…from where the pending row was');

  advance(5_000); // draft window over
  assert.equal(h.inner.popDelayMs.has('n1'), false, 'offset cleared with the window');
});

test('cloud pick: a failed add lets the row and its time go', () => {
  const h = makePanel([entry('old', 'ATL-1', 45)]);
  h.comp.holdLanding(input('ATL-8778', 30), 'Phase 4');
  h.actionStarts();
  advance(1_200);
  h.refresh([entry('old', 'ATL-1', 45)], true); // runAction ended, toast shown
  assert.equal(h.comp.draftPending, null);
  assert.equal(blockOf(h, 'ATL-8778'), undefined, 'the born card goes too');
  assert.equal(h.lastDiff(), 0);
});

test('cloud pick: a stale poll without the entry keeps the row', () => {
  const h = makePanel();
  h.comp.holdLanding(input('ATL-8778', 30), 'Phase 4');
  h.actionStarts();
  h.freshId('n1');
  h.refresh([]); // tray poll sent before the POST
  assert.ok(h.comp.draftPending);
  assert.equal(h.lastDiff(), 30);
});

test('cloud pick onto a ticket with a card: the row joins it', () => {
  const h = makePanel([entry('e1', 'ATL-8778', 45, 'Other', 'review')]);
  h.comp.holdLanding(input('ATL-8778', 30), 'Phase 4');
  h.actionStarts();
  const b = blockOf(h, 'ATL-8778');
  assert.equal(h.comp.feedBlocks.filter(x => x.task === 'ATL-8778').length, 1);
  assert.equal(b?.rowCount, 2);
  assert.equal(b?.totalMs, 75 * 60_000);
});

// ─── Log cloud: bare Development ──────────────────────────────────────────

test('cloud bare Development, no manual added yet: a manual added row', () => {
  const h = makePanel();
  h.comp.holdLanding(input('ATL-8778', 30, DEVELOPMENT_ACTIVITY, ''), 'Phase 4');
  h.actionStarts();
  assert.ok(h.comp.draftPending);
  assert.equal(h.comp.pendingBare, true, 'reads as manual added');
  assert.equal(h.comp.pendingEnters, false, 'manual added rows have no entrance');
  assert.equal(h.lastDiff(), 30);
  h.freshId('m1');
  h.refresh([added('m1', 'ATL-8778', 30)], true);
  assert.equal(h.comp.draftPending, null);
  assert.equal(blockOf(h, 'ATL-8778')?.rowCount, 1);
  assert.equal(h.lastDiff(), 0);
});

test('cloud bare Development onto manual added: the record grows at once', () => {
  const h = makePanel([added('m1', 'ATL-8778', 60)]);
  h.comp.holdLanding(input('ATL-8778', 30, DEVELOPMENT_ACTIVITY, ''), 'Phase 4');
  h.actionStarts();
  assert.equal(h.comp.draftPending, null, 'no row of its own');
  assert.equal(blockOf(h, 'ATL-8778')?.totalMs, 90 * 60_000);
  assert.equal(h.lastDiff(), 30);
  h.freshId('m1'); // same id — the record it poured into
  h.refresh([added('m1', 'ATL-8778', 90)], true);
  assert.equal(blockOf(h, 'ATL-8778')?.totalMs, 90 * 60_000);
  assert.equal(h.lastDiff(), 0);
});

test('cloud bare Development onto manual added: a failure takes the time back', () => {
  const h = makePanel([added('m1', 'ATL-8778', 60)]);
  h.comp.holdLanding(input('ATL-8778', 30, DEVELOPMENT_ACTIVITY, ''), 'Phase 4');
  h.actionStarts();
  h.refresh([added('m1', 'ATL-8778', 60)], true);
  assert.equal(blockOf(h, 'ATL-8778')?.totalMs, 60 * 60_000);
  assert.equal(h.lastDiff(), 0);
});

// ─── Add time (the card's own draft) ──────────────────────────────────────

function saveDraft(h: Harness, task: string, minutes: number, activity: string, description: string): void {
  h.inner.draftTask = task;
  h.inner.editMinutes = minutes;
  h.inner.editActivity = activity;
  h.inner.editDescription = description;
  h.inner.saveForm(null);
  h.actionStarts();
}

test('Add time: the saved draft holds, counts, and lands in place', () => {
  const h = makePanel([entry('e1', 'ATL-5', 45, 'Other', 'review')]);
  saveDraft(h, 'ATL-5', 30, 'Other', 'demo prep');
  assert.equal(h.comp.pendingEnters, false, 'it replaces the form row — no entrance');
  assert.equal(blockOf(h, 'ATL-5')?.totalMs, 75 * 60_000);
  assert.equal(h.lastDiff(), 30);
  h.freshId('e2');
  assert.ok(h.comp.draftPending, 'holds through the gap');
  h.refresh([entry('e1', 'ATL-5', 45, 'Other', 'review'), entry('e2', 'ATL-5', 30, 'Other', 'demo prep')], true);
  assert.equal(h.comp.draftPending, null);
  assert.equal(h.inner.landedId, 'e2');
  assert.equal(h.lastDiff(), 0);
});

test('Add time bare Development onto manual added: folds once the record grew', () => {
  const h = makePanel([added('m1', 'ATL-5', 60), entry('e1', 'ATL-5', 45, 'Other', 'review')]);
  saveDraft(h, 'ATL-5', 30, DEVELOPMENT_ACTIVITY, '');
  assert.equal(h.comp.pendingBare, false, 'folding into the record, not a row of its own');
  assert.equal(h.lastDiff(), 30);
  h.freshId('m1'); // the record's own id, data not refreshed yet
  assert.equal(h.inner.draftMerging, false, 'no fold before the record grows');
  assert.equal(h.lastDiff(), 30);
  h.refresh([added('m1', 'ATL-5', 90), entry('e1', 'ATL-5', 45, 'Other', 'review')], true);
  assert.equal(h.inner.draftMerging, true, 'folds as the record takes the time');
  assert.equal(h.lastDiff(), 0, 'counted once');
  advance(300);
  assert.equal(h.comp.draftPending, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
