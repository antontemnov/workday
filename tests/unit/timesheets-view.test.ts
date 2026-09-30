/**
 * Unit tests for the Timesheets tab (canon v2): the Push navigator leads to
 * what blocks a push (conflicts, then rows new from Tempo), the badge counts
 * UNPUSHED days, a live today turns Push into a choice, the push range
 * follows the choice, a read of Tempo that fails says so, a refusal stays
 * with its day until the day goes out, the gap counts closed days only, and
 * the day rows follow the read-only rules (today, a closed month).
 *
 * The component runs headless on a fake API and a fixed clock (25 Sep 2026);
 * the template is not rendered — the cards (seek) are out of scope here.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/timesheets-view.test.ts
 */
import assert from 'node:assert/strict';

// ─── Fixed clock: 25 Sep 2026, noon (installed before the component loads) ─
const RealDate = Date;
const FIXED = new RealDate(2026, 8, 25, 12, 0, 0).getTime();
class FixedDate extends RealDate {
  public constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED);
    else super(...(args as [number]));
  }

  public static override now(): number { return FIXED; }
}
(globalThis as { Date: DateConstructor }).Date = FixedDate as unknown as DateConstructor;

await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { TimesheetsViewComponent } = await import('../../tray-app/src/app/views/timesheets-view/timesheets-view.component');
const { PushStateService } = await import('../../tray-app/src/app/services/push-state.service');
const { MonthDayStatus, MonthSyncState, ConflictKind, ConflictField } = await import('../../tray-app/src/app/models/workday.models');
import type {
  ApiResponse, EntryConflict, MonthDaySummary, MonthDayTask, MonthResponse, PushResponse, TempoApprovalResponse, TempoScheduleResponse,
  TempoSyncResponse,
} from '../../tray-app/src/app/models/workday.models';
import type { SheetAction } from '../../tray-app/src/app/views/timesheets-view/timesheets-view.component';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));

// ─── Fixture: September 2026 ──────────────────────────────────────────────

const task = (t: string, seconds: number): MonthDayTask => ({ task: t, seconds, kind: 'manual', sessionCount: 0 });

function day(date: string, state: MonthSyncState, hours: number, extra: Partial<MonthDaySummary> = {}): MonthDaySummary {
  return {
    date, dayType: hours > 0 ? 'workday' : null, status: MonthDayStatus.Pending, claimedMs: 0,
    reportedSeconds: hours * 3600, taskCount: hours > 0 ? 1 : 0, tasks: hours > 0 ? [task('ATL-1', hours * 3600)] : [],
    pushedAt: null, syncState: state, conflicts: [], sessions: [], entries: [], ...extra,
  };
}

const conflict = (entryId: string): EntryConflict => ({
  entryId, task: 'ATL-2', kind: ConflictKind.Edited, fields: [ConflictField.Time],
  tempo: { task: 'ATL-2', date: '2026-09-23', seconds: 1800, description: 'Daily', activity: 'Other' },
});

function september(over: Record<string, Partial<MonthDaySummary> & { state?: MonthSyncState; hours?: number }> = {}): MonthResponse {
  const days: MonthDaySummary[] = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const dow = new RealDate(2026, 8, d).getDay();
    const working = dow !== 0 && dow !== 6 && d <= 25;
    const o = over[date] ?? {};
    const state = o.state ?? (working ? MonthSyncState.Pushed : MonthSyncState.None);
    const hours = o.hours ?? (working ? 8 : 0);
    days.push(day(date, state, hours, o));
  }
  return {
    year: 2026, month: 9, from: '2026-09-01', to: '2026-09-30', days,
    totals: { claimedMs: 0, reportedSeconds: 0, daysWithData: 0, pendingDays: 0, outdatedDays: 0, pushedDays: 0 },
    lastPushAt: '2026-09-23T14:42:00.000Z', roundingMinutes: 15,
  };
}

function schedule(): TempoScheduleResponse {
  const days = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, '0')}`;
    const dow = new RealDate(2026, 8, d).getDay();
    days.push({ date, requiredSeconds: dow !== 0 && dow !== 6 ? 8 * 3600 : 0, type: dow !== 0 && dow !== 6 ? 'WORKING_DAY' : 'NON_WORKING_DAY', holidayName: null });
  }
  return { available: true, days, requiredSecondsTotal: 0, fromCache: true } as TempoScheduleResponse;
}

const approval = (statusKey: string, closed?: boolean): TempoApprovalResponse => ({
  available: true, period: null, statusKey, ...(closed !== undefined ? { closed } : {}),
  requiredSeconds: null, timeSpentSeconds: null, canSubmit: false, fromCache: true,
} as TempoApprovalResponse);

// ─── Harness ──────────────────────────────────────────────────────────────

interface FakeApi {
  pushes: { from: string; to: string; stopTracking: boolean }[];
  pushAnswer: ApiResponse<PushResponse>;
  syncAnswer: ApiResponse<TempoSyncResponse>;
  approvalAnswer: ApiResponse<TempoApprovalResponse>;
  approvalAsks: boolean[];
  month: MonthResponse;
}

function harness(month: MonthResponse = september()) {
  const fake: FakeApi = {
    pushes: [],
    pushAnswer: { ok: true, data: { dryRun: false, plan: [] } },
    syncAnswer: { ok: true, data: { month: '2026-09', syncedAt: '', worklogCount: 0, adopted: [] } },
    approvalAnswer: { ok: true, data: approval('OPEN') },
    approvalAsks: [],
    month,
  };
  const api = {
    getMonth: async () => ({ ok: true, data: fake.month }),
    getTempoSchedule: async () => ({ ok: true, data: schedule() }),
    getTempoApproval: async (_year: number, _month: number, fresh?: boolean) => {
      fake.approvalAsks.push(fresh === true);
      return fake.approvalAnswer;
    },
    syncTempo: async () => fake.syncAnswer,
    pushToTempo: async (from: string, to: string, _force: boolean, stopTracking: boolean) => {
      fake.pushes.push({ from, to, stopTracking });
      return fake.pushAnswer;
    },
    resolveConflict: async () => ({ ok: false, error: 'lost' }),
  };
  const pushState = new PushStateService();
  const host = { nativeElement: { getBoundingClientRect: () => ({ top: 0, left: 0, height: 800 }) } };
  const cdr = { detectChanges(): void {} };
  const zone = { run: (fn: () => void) => fn() };
  const comp = new TimesheetsViewComponent(api as never, pushState, host as never, cdr as never, zone as never);
  comp.monthData = month;
  comp.schedule = schedule();
  comp.approval = approval('OPEN');
  comp.loading = false;
  const actions: SheetAction[] = [];
  comp.action.subscribe((a: SheetAction) => actions.push(a));
  // The app's gate: run the call, then report back.
  const drain = async (): Promise<void> => {
    while (actions.length > 0) {
      const a = actions.shift()!;
      const res = await a.run();
      a.done(res.ok);
    }
    await tick();
  };
  return { comp, fake, pushState, actions, drain };
}

const click = { stopPropagation(): void {}, currentTarget: null } as unknown as MouseEvent;
const rowOf = (h: ReturnType<typeof harness>, date: string) => h.comp.weeks.flatMap(w => w.rows).find(r => r.date === date)!;

// ─── The Push navigator ──────────────────────────────────────────────────

console.log('Push navigator');

await test('badge = the number of UNPUSHED days', () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed }, '2026-09-24': { state: MonthSyncState.Unpushed } }));
  assert.deepEqual(h.comp.pushView, { kind: 'push', count: 2 });
});

await test('nothing unpushed → nothing to push', () => {
  const h = harness();
  assert.equal(h.comp.pushView.kind, 'nothing');
});

await test('conflicts come first, then new rows from Tempo, then the push', () => {
  const h = harness(september({
    '2026-09-23': { state: MonthSyncState.Conflict, conflicts: [conflict('e1'), conflict('e2')] },
    '2026-09-22': { state: MonthSyncState.Unpushed },
  }));
  assert.deepEqual(h.comp.pushView, { kind: 'resolve', count: 2 });
  h.comp.monthData = september({ '2026-09-22': { state: MonthSyncState.Unpushed } });
  h.pushState.unseen.set('n1', { date: '2026-09-24', task: 'ATL-7', entryId: 'n1', tempoWorklogId: 1 });
  assert.deepEqual(h.comp.pushView, { kind: 'review', count: 1 });
  h.comp.toggleDay(rowOf(h, '2026-09-24'));
  assert.deepEqual(h.comp.pushView, { kind: 'push', count: 1 });
});

await test('a side taken leaves the count at once; a lost resolve gives it back', async () => {
  const h = harness(september({ '2026-09-23': { state: MonthSyncState.Conflict, conflicts: [conflict('e1'), conflict('e2')] } }));
  h.comp.onSidesPending('2026-09-23', ['e1']);
  await tick();
  assert.deepEqual(h.comp.pushView, { kind: 'resolve', count: 1 });
  h.comp.onPanelResolve('2026-09-23', { entryId: 'e1', side: 'mine' as never });
  await h.drain();
  assert.deepEqual(h.comp.pushView, { kind: 'resolve', count: 2 });
});

await test('a closed month has no Push at all; unknown status reads as open', () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  h.comp.approval = approval('IN_REVIEW', true);
  assert.equal(h.comp.pushView.kind, 'none');
  h.comp.approval = approval('APPROVED');
  assert.equal(h.comp.monthClosed, true);
  h.comp.approval = approval('REJECTED');
  assert.equal(h.comp.monthClosed, false);
  h.comp.approval = { ...approval('OPEN'), available: false, statusKey: null };
  assert.equal(h.comp.monthClosed, false);
  assert.equal(h.comp.periodStatus, null);
});

await test('the month tag: the status in words', () => {
  const h = harness();
  h.comp.approval = approval('IN_REVIEW', true);
  assert.deepEqual(h.comp.periodStatus, { cls: 'in_review', label: 'in review' });
});

// ─── Push ranges ─────────────────────────────────────────────────────────

console.log('\nPush — what goes');

await test('a plain push takes the month up to today', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  h.comp.onPush(click);
  assert.equal(h.comp.pushView.kind, 'busy');
  await h.drain();
  assert.deepEqual(h.fake.pushes, [{ from: '2026-09-01', to: '2026-09-25', stopTracking: false }]);
  assert.equal(h.pushState.pushing(), false);
});

await test('today tracking: Push without today stops at yesterday, Stop tracking takes today', async () => {
  const h = harness(september({
    '2026-09-22': { state: MonthSyncState.Unpushed },
    '2026-09-25': { state: MonthSyncState.Tracking },
  }));
  const menu = h.comp.pushMenu(1).filter((i): i is { label: string; action: () => void } => 'label' in i);
  assert.deepEqual(menu.map(i => i.label), ['Push without today', 'Stop tracking & push all']);
  menu[0].action();
  await h.drain();
  menu[1].action();
  await h.drain();
  assert.deepEqual(h.fake.pushes, [
    { from: '2026-09-01', to: '2026-09-24', stopTracking: false },
    { from: '2026-09-01', to: '2026-09-25', stopTracking: true },
  ]);
});

await test('nothing else unpushed: the choice is only Stop tracking', () => {
  const h = harness(september({ '2026-09-25': { state: MonthSyncState.Tracking } }));
  assert.deepEqual(h.comp.pushView, { kind: 'push', count: 0 });
  const labels = h.comp.pushMenu(0).filter((i): i is { label: string; action: () => void } => 'label' in i).map(i => i.label);
  assert.deepEqual(labels, ['Stop tracking & push all']);
});

await test('↗ Push of an open day pushes that day alone', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  const row = rowOf(h, '2026-09-22');
  h.comp.toggleDay(row);
  assert.equal(h.comp.showDayPush(row), true);
  h.comp.onPushDay(row, click);
  await h.drain();
  assert.deepEqual(h.fake.pushes, [{ from: '2026-09-22', to: '2026-09-22', stopTracking: false }]);
});

await test('a past month pushes whole', async () => {
  const aug = { ...september({ '2026-09-22': { state: MonthSyncState.Unpushed } }), year: 2026, month: 8, from: '2026-08-01', to: '2026-08-31' };
  const h = harness(aug);
  h.comp.year = 2026;
  h.comp.month = 8;
  h.comp.onPush(click);
  await h.drain();
  assert.deepEqual(h.fake.pushes, [{ from: '2026-08-01', to: '2026-08-31', stopTracking: false }]);
});

// ─── Push outcomes ───────────────────────────────────────────────────────

console.log('\nPush — what came back');

await test('Tempo unreachable: said in red, nothing went out', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  h.fake.pushAnswer = { ok: false, error: 'fetch failed' };
  h.comp.onPush(click);
  await h.drain();
  assert.equal(h.comp.tempoUnreachable, true);
  assert.equal(h.comp.toastOn, false);
});

await test('the read adopted rows: nothing sent, the tab leads to the new row', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  h.fake.pushAnswer = { ok: true, data: { dryRun: false, plan: [], blockedByAdoption: true, adopted: [{ date: '2026-09-24', task: 'ATL-7', entryId: 'n1', tempoWorklogId: 9 }] } };
  h.comp.onPush(click);
  await h.drain();
  assert.equal(h.comp.toastOn, false);
  // Shown: its day is open, the next click pushes.
  assert.equal(h.comp.isOpen(rowOf(h, '2026-09-24')), true);
  assert.equal(h.pushState.unseen.has('n1'), false);
  assert.deepEqual(h.comp.pushView, { kind: 'push', count: 1 });
});

await test('rows adopted by the read after a push wait for Review', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  h.fake.pushAnswer = { ok: true, data: { dryRun: false, plan: [], result: { posted: 1, updated: 0, deleted: 0, skipped: 0, failed: 0 }, adopted: [{ date: '2026-09-24', task: 'ATL-7', entryId: 'n2', tempoWorklogId: 9 }] } };
  h.comp.onPush(click);
  await h.drain();
  assert.deepEqual(h.comp.pushView, { kind: 'review', count: 1 });
});

await test('out: "pushed N days" counts the days Tempo was asked to change', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed } }));
  const entry = (date: string, action: string) => ({ date, task: 'ATL-1', kind: 'manual', action, detail: '' });
  h.fake.pushAnswer = { ok: true, data: { dryRun: false, plan: [entry('2026-09-21', 'create'), entry('2026-09-21', 'update'), entry('2026-09-22', 'delete'), entry('2026-09-23', 'skip')] as never, result: { posted: 1, updated: 1, deleted: 1, skipped: 1, failed: 0 } } };
  h.comp.onPush(click);
  await h.drain();
  assert.equal(h.comp.toastText, 'pushed 2 days');
  assert.equal(h.comp.toastOn, true);
});

await test('a refusal stays with its day until the day goes out whole', async () => {
  const h = harness(september({ '2026-09-22': { state: MonthSyncState.Unpushed }, '2026-09-24': { state: MonthSyncState.Unpushed } }));
  const refusal = (date: string) => ({ date, task: 'ATL-1', kind: 'manual' as const, entryId: 'e9', action: 'create' as const, reason: 'The issue is closed for time logging' });
  h.fake.pushAnswer = { ok: true, data: { dryRun: false, plan: [], result: { posted: 0, updated: 0, deleted: 0, skipped: 0, failed: 2 }, failures: [refusal('2026-09-22'), refusal('2026-09-24')] } };
  h.comp.onPush(click);
  await h.drain();
  assert.equal(h.comp.refusalsFor('2026-09-22')[0]?.reason, 'The issue is closed for time logging');
  const before = h.comp.refusalsFor('2026-09-24');
  h.fake.pushAnswer = { ok: true, data: { dryRun: false, plan: [], result: { posted: 1, updated: 0, deleted: 0, skipped: 0, failed: 0 } } };
  h.comp.onPushDay(rowOf(h, '2026-09-22'), click);
  await h.drain();
  assert.equal(h.comp.refusalsFor('2026-09-22').length, 0);
  assert.deepEqual(h.comp.refusalsFor('2026-09-24'), before);
});

// ─── Fetch ───────────────────────────────────────────────────────────────

console.log('\nFetch');

await test('a read adopts: the rows are new until their day is opened', async () => {
  const h = harness();
  h.fake.syncAnswer = { ok: true, data: { month: '2026-09', syncedAt: '', worklogCount: 1, adopted: [{ date: '2026-09-24', task: 'ATL-7', entryId: 'n1', tempoWorklogId: 9 }] } };
  h.comp.onFetch();
  assert.equal(h.comp.fetching, true);
  await tick();
  await tick();
  assert.equal(h.comp.fetching, false);
  assert.equal(h.comp.unseenFor('2026-09-24').has('n1'), true);
  h.comp.toggleDay(rowOf(h, '2026-09-24'));
  assert.equal(h.comp.unseenFor('2026-09-24').size, 0);
});

await test('a failed read says Tempo unreachable; the next good one clears it', async () => {
  const h = harness();
  h.fake.syncAnswer = { ok: false, error: 'fetch failed' };
  h.comp.onFetch();
  await tick();
  assert.equal(h.comp.tempoUnreachable, true);
  h.fake.syncAnswer = { ok: true, data: { month: '2026-09', syncedAt: '', worklogCount: 0 } };
  h.comp.onFetch();
  await tick();
  assert.equal(h.comp.tempoUnreachable, false);
});

await test('submitted on the site after a push: Fetch shows the new period status', async () => {
  const h = harness();
  h.fake.approvalAnswer = { ok: true, data: approval('IN_REVIEW', true) };
  h.fake.syncAnswer = { ok: true, data: { month: '2026-09', syncedAt: '', worklogCount: 0, adopted: [], skipped: 'closed' } };
  h.comp.onFetch();
  await tick();
  await tick();
  assert.equal(h.comp.periodStatus?.label, 'in review');
  assert.equal(h.comp.monthClosed, true);
});

await test('a failed approval call keeps the last known status', async () => {
  const h = harness();
  h.fake.approvalAnswer = { ok: false, error: 'daemon offline' };
  h.comp.onFetch();
  await tick();
  await tick();
  assert.equal(h.comp.periodStatus?.label, 'open');
});

await test('the status tag asks Tempo now: sent back → the month opens', async () => {
  const h = harness();
  h.comp.approval = approval('IN_REVIEW', true);
  h.fake.approvalAnswer = { ok: true, data: approval('REJECTED', false) };
  const click = h.comp.refreshApproval();
  assert.equal(h.comp.approvalRefreshing, true);
  void h.comp.refreshApproval(); // a second click while asking sends nothing
  await click;
  assert.deepEqual(h.fake.approvalAsks, [true]);
  assert.equal(h.comp.approvalRefreshing, false);
  assert.equal(h.comp.periodStatus?.label, 'rejected');
  assert.equal(h.comp.monthClosed, false);
});

// ─── Header ──────────────────────────────────────────────────────────────

console.log('\nHeader');

await test('the gap: closed days only, a word only when there is one', () => {
  // 18 working days up to 24 Sep × 8h required; logged 8h each → on schedule.
  const h = harness();
  assert.equal(h.comp.gap, null);
  h.comp.monthData = september({ '2026-09-24': { hours: 1 }, '2026-09-25': { hours: 0 } });
  assert.deepEqual(h.comp.gap, { amount: '7h 00m', word: 'behind' });
  h.comp.monthData = september({ '2026-09-24': { hours: 11, state: MonthSyncState.Unpushed } });
  assert.deepEqual(h.comp.gap, { amount: '3h 00m', word: 'ahead' });
});

await test('weeks newest first, labelled "21 — 27"; no future days', () => {
  const h = harness();
  assert.equal(h.comp.weeks[0].label, '21 — 27');
  assert.equal(h.comp.weeks[0].rows[0].date, '2026-09-25');
  assert.equal(h.comp.weeks.at(-1)!.label, '1 — 6');
});

// ─── Day rows ────────────────────────────────────────────────────────────

console.log('\nDay rows');

await test('today only reads; an empty past day opens; a closed month opens only days with content', () => {
  const h = harness();
  const today = rowOf(h, '2026-09-25');
  const empty = rowOf(h, '2026-09-20');
  assert.equal(h.comp.readOnlyDay(today), true);
  assert.equal(h.comp.canOpen(empty), true);
  h.comp.toggleDay(empty);
  assert.equal(h.comp.showLog(empty), true);
  assert.equal(h.comp.hoursLabel(empty), '—');
  h.comp.approval = approval('APPROVED', true);
  assert.equal(h.comp.canOpen(empty), false);
  assert.equal(h.comp.showLog(rowOf(h, '2026-09-22')), false);
});

await test('the open day\'s hours follow its card (undo windows included)', async () => {
  const h = harness();
  const row = rowOf(h, '2026-09-22');
  h.comp.toggleDay(row);
  assert.equal(h.comp.hoursLabel(row), '8h 00m');
  h.comp.onDayTotal('2026-09-22', 7.5 * 3600_000);
  await tick();
  assert.equal(h.comp.hoursLabel(row), '7h 30m');
  assert.equal(h.comp.totalLabel.endsWith('30m'), true);
});

await test('a daemon without the day word: the flags say pushed or not', () => {
  const legacy = september();
  const days = legacy.days.map(d => d.date === '2026-09-22'
    ? { ...d, syncState: undefined, status: MonthDayStatus.Outdated }
    : d.date === '2026-09-21' ? { ...d, syncState: undefined, status: MonthDayStatus.Pushed } : d);
  const h = harness({ ...legacy, days });
  assert.equal(rowOf(h, '2026-09-22').state, MonthSyncState.Unpushed);
  assert.equal(rowOf(h, '2026-09-21').state, MonthSyncState.Pushed);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
