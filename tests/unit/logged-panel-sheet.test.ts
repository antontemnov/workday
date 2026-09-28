/**
 * Unit tests for the logged panel's sheet mode — the Timesheets card of one
 * day: Σ is what Tempo gets (tracked time rounded), taskless sessions stay
 * out, what needs the user opens its ticket once, a conflict side taken
 * burns a 3s undo before the resolve goes out, a closed month offers no
 * side, a read-only day opens no menu. The day view (sheet off) keeps its
 * own sums and blocks.
 *
 * The component runs headless: fake clock + fake timer queue, the host
 * element is a null-returning stub.
 *
 * Run: npx tsx tests/unit/logged-panel-sheet.test.ts
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
const { ConflictField, ConflictKind, DEVELOPMENT_ACTIVITY, ResolveSide } = await import('../../tray-app/src/app/models/workday.models');
import type { EntryConflict, ManualEntry, MonthDayTask, PushFailure, SessionDetail } from '../../tray-app/src/app/models/workday.models';

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

const DATE = '2026-09-23';

function entry(id: string, task: string, minutes: number, activity = 'Meeting', description = 'Sprint planning'): ManualEntry {
  return { id, task, minutes, description, activity, createdAt: new Date(nowMs).toISOString() };
}

function added(id: string, task: string, minutes: number): ManualEntry {
  return { ...entry(id, task, minutes, DEVELOPMENT_ACTIVITY, ''), added: true };
}

function session(id: string, task: string | null, minutes: number): SessionDetail {
  return {
    id, repo: 'app-backend', task, branch: `${task}-work`, state: 'active',
    startedAt: new Date(nowMs - minutes * 60_000).toISOString(),
    activatedAt: new Date(nowMs - minutes * 60_000).toISOString(),
    lastSeenAt: new Date(nowMs).toISOString(),
    paused: false, pauseSource: null, effectiveDurationMs: minutes * 60_000,
    score: 0, normalizedScore: 0, pauseEtaMs: null, isLeader: false, sensitivity: 'normal',
    closedBy: 'idle', evidence: { commits: 1, reflogEvents: 1, linesAdded: 10, linesRemoved: 2, filesChanged: 1 },
    pauseCount: 0, totalPauseDurationMs: 0,
  } as SessionDetail;
}

interface Harness {
  comp: InstanceType<typeof LoggedPanelComponent>;
  set: (over: { entries?: readonly ManualEntry[]; sessions?: readonly SessionDetail[]; conflicts?: readonly EntryConflict[];
                refusals?: readonly PushFailure[]; foreign?: readonly MonthDayTask[] }) => void;
  resolved: { entryId: string; side: string }[];
  totals: number[];
}

function makePanel(sheet = true): Harness {
  const host = { nativeElement: { querySelector: () => null } };
  const cdr = { markForCheck(): void {}, detectChanges(): void {} };
  const comp = new LoggedPanelComponent(host as never, cdr as never, {} as never);
  comp.sheet = sheet;
  comp.date = DATE;
  comp.roundingMinutes = 15;
  const resolved: { entryId: string; side: string }[] = [];
  const totals: number[] = [];
  comp.resolveCommitted.subscribe((r: { entryId: string; side: string }) => resolved.push(r));
  comp.dayTotalChanged.subscribe((ms: number) => totals.push(ms));
  const set: Harness['set'] = over => {
    const changes: Record<string, unknown> = {};
    if (over.entries) { comp.entries = over.entries; changes['entries'] = change(over.entries); }
    if (over.sessions) { comp.closedSessions = over.sessions; changes['closedSessions'] = change(over.sessions); }
    if (over.conflicts) { comp.conflicts = over.conflicts; changes['conflicts'] = change(over.conflicts); }
    if (over.refusals) { comp.refusals = over.refusals; changes['refusals'] = change(over.refusals); }
    if (over.foreign) { comp.foreign = over.foreign; changes['foreign'] = change(over.foreign); }
    comp.ngOnChanges(changes as never);
  };
  return { comp, set, resolved, totals };
}

const blockOf = (h: Harness, task: string) => h.comp.feedBlocks.find(b => b.task === task);
const click = { stopPropagation(): void {} } as MouseEvent;
const MIN = 60_000;

const edited: EntryConflict = {
  entryId: 'e1', task: 'ATL-8839', kind: ConflictKind.Edited,
  fields: [ConflictField.Time, ConflictField.Description],
  tempo: { task: 'ATL-8839', date: DATE, seconds: 2700, description: 'Refund review', activity: 'Meeting' },
};

console.log('Sheet — sums and blocks');

test('Σ = tracked rounded to the block + entries exact', () => {
  const h = makePanel();
  h.set({ entries: [added('m1', 'ATL-8624', 5), entry('e1', 'ATL-8624', 150, 'Development', 'Idempotency keys')], sessions: [session('s1', 'ATL-8624', 56)] });
  // 56m + 5m = 61m → 60m; + 150m
  assert.equal(blockOf(h, 'ATL-8624')!.totalMs, 210 * MIN);
});

test('the day view keeps raw sums', () => {
  const h = makePanel(false);
  h.set({ entries: [added('m1', 'ATL-8624', 5)], sessions: [session('s1', 'ATL-8624', 56)] });
  assert.equal(blockOf(h, 'ATL-8624')!.totalMs, 61 * MIN);
});

test('tracked time never rounds below one block', () => {
  const h = makePanel();
  h.set({ sessions: [session('s1', 'ATL-8657', 4)] });
  assert.equal(blockOf(h, 'ATL-8657')!.totalMs, 15 * MIN);
});

test('taskless sessions stay out of the card, the day view keeps them', () => {
  const sheet = makePanel();
  sheet.set({ sessions: [session('s1', null, 30), session('s2', 'ATL-1', 30)] });
  assert.deepEqual(sheet.comp.feedBlocks.map(b => b.task), ['ATL-1']);
  const day = makePanel(false);
  day.set({ sessions: [session('s1', null, 30)] });
  assert.equal(blockOf(day, '—')?.task, '—');
});

test('foreign worklogs are rows of their ticket and count in Σ', () => {
  const h = makePanel();
  h.set({ foreign: [{ task: 'ATL-7090', seconds: 3600, kind: 'foreign', sessionCount: 0, description: 'Architecture review', activity: 'Meeting' }] });
  const b = blockOf(h, 'ATL-7090')!;
  assert.equal(b.foreign.length, 1);
  assert.equal(b.totalMs, 60 * MIN);
});

test('the day total follows the card', () => {
  const h = makePanel();
  h.set({ entries: [entry('e1', 'ATL-1', 30), entry('e2', 'ATL-2', 45)] });
  assert.equal(h.totals.at(-1), 75 * MIN);
});

console.log('\nSheet — tickets open and close');

test('a ticket starts closed; the lid opens it', () => {
  const h = makePanel();
  h.set({ entries: [entry('e1', 'ATL-1', 30)] });
  const b = blockOf(h, 'ATL-1')!;
  assert.equal(h.comp.isOpen(b), false);
  h.comp.onLidClick(b, { target: null } as unknown as MouseEvent);
  assert.equal(h.comp.isOpen(b), true);
});

test('Add time opens the ticket and the saved row lands in sight', () => {
  const h = makePanel();
  h.set({ entries: [entry('e1', 'ATL-1', 30)] });
  (h.comp as unknown as { openDraft(task: string): void }).openDraft('ATL-1');
  h.comp.editDescription = 'Code review';
  h.comp.saveForm(null);
  assert.equal(h.comp.isOpen(blockOf(h, 'ATL-1')!), true);
});

test('an entry logged from ＋Log opens its ticket when it lands', () => {
  const h = makePanel();
  h.set({ entries: [entry('e1', 'ATL-1', 30)] });
  h.comp.freshEntryId = 'e2';
  h.comp.ngOnChanges({ freshEntryId: change('e2') } as never);
  assert.equal(h.comp.isTaskOpen('ATL-2'), false);
  h.set({ entries: [entry('e1', 'ATL-1', 30), entry('e2', 'ATL-2', 45)] });
  assert.equal(h.comp.isTaskOpen('ATL-2'), true);
  assert.equal(h.comp.isOpen(blockOf(h, 'ATL-2')!), true);
  assert.equal(h.comp.isTaskOpen('ATL-1'), false);
});

test('a conflict opens its ticket once; closed by hand it stays closed', () => {
  const h = makePanel();
  h.set({ entries: [entry('e1', 'ATL-8839', 60, 'Other', 'Refund edge cases review')], conflicts: [edited] });
  const b = blockOf(h, 'ATL-8839')!;
  assert.equal(h.comp.isOpen(b), true);
  assert.equal(h.comp.isRedGlass(b), true);
  h.comp.onLidClick(b, { target: null } as unknown as MouseEvent);
  h.set({ conflicts: [{ ...edited }] });
  assert.equal(h.comp.isOpen(b), false);
});

test('a refusal opens its ticket on red glass and says why', () => {
  const h = makePanel();
  h.set({ entries: [entry('e1', 'ATL-8839', 60, 'Other', 'Refund path')],
          refusals: [{ date: DATE, task: 'ATL-8839', kind: 'manual', entryId: 'e1', action: 'create', reason: 'The issue is closed for time logging' }] });
  const b = blockOf(h, 'ATL-8839')!;
  assert.equal(h.comp.isOpen(b), true);
  assert.equal(h.comp.isRedGlass(b), true);
  assert.equal(h.comp.refusalsOf('ATL-8839')[0].reason, 'The issue is closed for time logging');
});

console.log('\nSheet — conflicts');

test('fields named in words', () => {
  const h = makePanel();
  assert.equal(h.comp.conflictSay(edited), 'Time and description differ');
  assert.equal(h.comp.conflictSay({ ...edited, kind: ConflictKind.Ticket, fields: [ConflictField.Ticket, ConflictField.Time] }), 'Ticket and time differ');
  assert.equal(h.comp.conflictSay({ ...edited, kind: ConflictKind.Moved, fields: [ConflictField.Date] }), 'Date differs');
  assert.equal(h.comp.conflictSay({ ...edited, kind: ConflictKind.Deleted, fields: [], tempo: null }), 'Deleted in Tempo');
});

test('the sides: differing fields lit, Tempo\'s day and ticket shown where they part', () => {
  const h = makePanel();
  const e = entry('e1', 'ATL-7081', 90, 'Meeting', 'Sprint review');
  const moved: EntryConflict = { entryId: 'e1', task: 'ATL-7081', kind: ConflictKind.Moved, fields: [ConflictField.Date, ConflictField.Time],
    tempo: { task: 'ATL-7081', date: '2026-09-17', seconds: 3600, description: 'Sprint review', activity: 'Meeting' } };
  const mine = h.comp.conflictSide(e, moved, 'mine');
  const tempo = h.comp.conflictSide(e, moved, 'tempo');
  assert.equal(mine.date, '23 Sep');
  assert.equal(tempo.date, '17 Sep');
  assert.equal(mine.task, null);
  assert.equal(mine.duration, '1h 30m');
  assert.equal(tempo.duration, '1h 00m');
  assert.equal(mine.litDuration, true);
  assert.equal(mine.litDescription, false);
  const gone = h.comp.conflictSide(e, { ...moved, kind: ConflictKind.Deleted, fields: [], tempo: null }, 'tempo');
  assert.equal(gone.gone, true);
  assert.equal(h.comp.conflictSide(e, { ...moved, kind: ConflictKind.Deleted, fields: [], tempo: null }, 'mine').litType, true);
});

test('a side taken: the note burns 3s, then the resolve goes out once', () => {
  const h = makePanel();
  const e = entry('e1', 'ATL-8839', 60, 'Other', 'Refund edge cases review');
  h.set({ entries: [e], conflicts: [edited] });
  h.comp.pickSide(e, edited, ResolveSide.Mine, click);
  assert.equal(h.comp.openConflict(e), null);
  assert.equal(h.comp.resolvedNote(e), '✓ mine — the push overwrites Tempo');
  advance(2_900);
  assert.equal(h.resolved.length, 0);
  advance(200);
  assert.deepEqual(h.resolved, [{ entryId: 'e1', side: 'mine' }]);
  // Resolving: still the note, no undo, until the data drops the conflict.
  assert.equal(h.comp.isPicked(e), false);
  assert.equal(h.comp.resolvedNote(e), '✓ mine — the push overwrites Tempo');
  h.set({ conflicts: [] });
  assert.equal(h.comp.resolvedNote(e), null);
});

test('↩ undo takes the side back — nothing goes out', () => {
  const h = makePanel();
  const e = entry('e1', 'ATL-8839', 60, 'Other', 'Refund edge cases review');
  h.set({ entries: [e], conflicts: [edited] });
  h.comp.pickSide(e, edited, ResolveSide.Tempo, click);
  h.comp.unpick(e, click);
  advance(4_000);
  assert.equal(h.resolved.length, 0);
  assert.equal(h.comp.openConflict(e)?.entryId, 'e1');
});

test('a lost resolve returns the conflict after the TTL', () => {
  const h = makePanel();
  const e = entry('e1', 'ATL-8839', 60, 'Other', 'Refund edge cases review');
  h.set({ entries: [e], conflicts: [edited] });
  h.comp.pickSide(e, edited, ResolveSide.Tempo, click);
  advance(3_100);
  h.set({ conflicts: [edited] });
  assert.equal(h.comp.openConflict(e), null);
  advance(46_000);
  h.set({ conflicts: [edited] });
  assert.equal(h.comp.openConflict(e)?.entryId, 'e1');
});

test('the notes say what the side does', () => {
  const h = makePanel();
  const e = entry('e2', 'ATL-8434', 45);
  const ticket: EntryConflict = { entryId: 'e2', task: 'ATL-8434', kind: ConflictKind.Ticket, fields: [ConflictField.Ticket],
    tempo: { task: 'ATL-8657', date: DATE, seconds: 2700, description: 'Sprint planning', activity: 'Meeting' } };
  h.set({ entries: [e], conflicts: [ticket] });
  h.comp.pickSide(e, ticket, ResolveSide.Tempo, click);
  assert.equal(h.comp.resolvedNote(e), '✓ Tempo — moves to ATL-8657');
  h.comp.unpick(e, click);
  h.comp.pickSide(e, ticket, ResolveSide.Mine, click);
  assert.equal(h.comp.resolvedNote(e), '✓ mine — the push moves it back');
});

test('a side taken leaves the navigator\'s count at once; undo gives it back', () => {
  const h = makePanel();
  const pending: string[][] = [];
  h.comp.sidesPendingChanged.subscribe((ids: readonly string[]) => pending.push([...ids]));
  const e = entry('e1', 'ATL-8839', 60, 'Other', 'Refund edge cases review');
  h.set({ entries: [e], conflicts: [edited] });
  h.comp.pickSide(e, edited, ResolveSide.Mine, click);
  assert.deepEqual(pending.at(-1), ['e1']);
  h.comp.unpick(e, click);
  assert.deepEqual(pending.at(-1), []);
  h.comp.pickSide(e, edited, ResolveSide.Mine, click);
  advance(3_100);
  // Resolving: still taken until the data drops the conflict.
  assert.deepEqual(pending.at(-1), ['e1']);
  const before = pending.length;
  h.set({ conflicts: [] });
  assert.deepEqual(pending.at(-1), []);
  assert.equal(pending.length, before + 1);
});

test('a closed month shows the sides and offers none', () => {
  const h = makePanel();
  h.comp.locked = true;
  h.comp.readOnly = true;
  const e = entry('e1', 'ATL-8839', 60, 'Other', 'Refund edge cases review');
  h.set({ entries: [e], conflicts: [edited] });
  h.comp.pickSide(e, edited, ResolveSide.Mine, click);
  advance(4_000);
  assert.equal(h.resolved.length, 0);
  assert.equal(h.comp.openConflict(e)?.entryId, 'e1');
});

console.log('\nSheet — read-only');

test('a read-only day opens no menu and no form', () => {
  const h = makePanel();
  h.comp.readOnly = true;
  const e = entry('e1', 'ATL-1', 30);
  h.set({ entries: [e, added('m1', 'ATL-1', 15)] });
  assert.equal(h.comp.entryMenuReady(e), false);
  assert.equal(h.comp.addedMenuReady(blockOf(h, 'ATL-1')!), false);
  h.comp.onRowDblClick(e);
  assert.equal(h.comp.editingId, null);
});

test('an open day edits as on the Day tab', () => {
  const h = makePanel();
  const e = entry('e1', 'ATL-1', 30);
  h.set({ entries: [e] });
  assert.equal(h.comp.entryMenuReady(e), true);
  h.comp.onRowDblClick(e);
  assert.equal(h.comp.editingId, 'e1');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
