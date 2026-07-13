/**
 * Unit tests for the notification center: last-working-day calendar math,
 * the timesheet-push delivery window, the pending→delivered→consumed state
 * machine (at-most-once per month, restart survival), memo behaviour and
 * test-notification injection.
 *
 * Run: npx tsx tests/unit/notification-center.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { NotificationCenter, lastWorkingDay } from '../../src/core/notification-center.js';
import { NOTIFICATIONS_STATE_FILE } from '../../src/core/constants.js';
import { NotificationStatus, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig } from '../../src/core/types.js';

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

function makeConfig(over?: { workDays?: number[]; holidays?: string[]; enabled?: boolean; notifyHour?: number }): AppConfig {
  return {
    repos: [],
    boundaryHour: 0,
    timezone: 'UTC',
    tracking: { projectKeys: ['ATL'], branchOwners: [] },
    genericBranches: [],
    session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
    report: { roundingMinutes: 15 },
    workDays: over?.workDays ?? [1, 2, 3, 4, 5],
    holidays: over?.holidays ?? [],
    apiPort: 9213,
    sensitivity: { default: SensitivityLevel.Normal, perRepo: {} },
    search: { projectKeys: [], knownProjects: [] },
    activities: { values: [] },
    notifications: { timesheetReminder: { enabled: over?.enabled ?? true, notifyHour: over?.notifyHour ?? 14 } },
  } as AppConfig;
}

/** UTC timestamp for "YYYY-MM-DD HH:00" — config timezone is UTC in tests. */
function at(date: string, hour: number): number {
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`);
}

interface CenterOptions {
  config?: AppConfig;
  unpushed?: number;
  freshState?: boolean;
}

function makeCenter(nowRef: { value: number }, over?: CenterOptions): { center: NotificationCenter; calls: { count: number } } {
  if (over?.freshState !== false) {
    rmSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE), { force: true });
  }
  const calls = { count: 0 };
  const config = over?.config ?? makeConfig();
  const center = new NotificationCenter({
    getConfig: () => config,
    flushToday: () => {},
    now: () => nowRef.value,
    getUnpushedDays: () => {
      calls.count++;
      return over?.unpushed ?? 3;
    },
  });
  return { center, calls };
}

// ─── lastWorkingDay ───────────────────────────────────────────────────────

test('lastWorkingDay: July 2026 → 31st (Friday, last calendar day)', () => {
  assert.equal(lastWorkingDay(2026, 7, makeConfig()), '2026-07-31');
});

test('lastWorkingDay: May 2026 → 29th (30th Sat, 31st Sun)', () => {
  assert.equal(lastWorkingDay(2026, 5, makeConfig()), '2026-05-29');
});

test('lastWorkingDay: holiday on the last working day shifts back', () => {
  assert.equal(lastWorkingDay(2026, 5, makeConfig({ holidays: ['2026-05-29'] })), '2026-05-28');
});

test('lastWorkingDay: consecutive holidays walk into the prior week', () => {
  const config = makeConfig({ holidays: ['2026-05-29', '2026-05-28', '2026-05-27'] });
  assert.equal(lastWorkingDay(2026, 5, config), '2026-05-26');
});

test('lastWorkingDay: Saturday counts when workDays includes 6', () => {
  assert.equal(lastWorkingDay(2026, 5, makeConfig({ workDays: [1, 2, 3, 4, 5, 6] })), '2026-05-30');
});

test('lastWorkingDay: month with zero working days → null', () => {
  assert.equal(lastWorkingDay(2026, 7, makeConfig({ workDays: [] })), null);
});

test('lastWorkingDay: leap February 2028 → 29th (Tuesday)', () => {
  assert.equal(lastWorkingDay(2028, 2, makeConfig()), '2028-02-29');
});

// ─── Delivery window gating ──────────────────────────────────────────────
// July 2026: last working day = Fri 31st.

test('window closed before notifyHour on the last working day', () => {
  const now = { value: at('2026-07-31', 13) };
  const { center } = makeCenter(now);
  assert.equal(center.getActive().length, 0);
});

test('window opens at notifyHour on the last working day', () => {
  const now = { value: at('2026-07-31', 14) };
  const { center } = makeCenter(now);
  const items = center.getActive();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'timesheet-push:2026-07');
  assert.equal(items[0].kind, 'timesheet-push');
  assert.equal(items[0].sticky, true);
  assert.equal(items[0].actions[0].view, 'sheet');
  assert.equal(items[0].title, 'Push July timesheets');
  assert.match(items[0].body, /Last working day/);
});

test('custom notifyHour is respected', () => {
  const now = { value: at('2026-07-31', 8) };
  const { center } = makeCenter(now, { config: makeConfig({ notifyHour: 8 }) });
  assert.equal(center.getActive().length, 1);
});

test('weekend tail after the last working day stays active (May 31 = Sunday)', () => {
  const now = { value: at('2026-05-31', 9) };
  const { center } = makeCenter(now);
  const items = center.getActive();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'timesheet-push:2026-05');
  assert.match(items[0].body, /May is ending/);
});

test('first day of the next month: nothing fires, old state pruned', () => {
  const now = { value: at('2026-05-31', 9) };
  const { center } = makeCenter(now);
  assert.equal(center.getActive().length, 1); // creates pending for 2026-05

  now.value = at('2026-06-01', 15) + 61_000; // past memo TTL
  assert.equal(center.getActive().length, 0);
  const state = JSON.parse(readFileSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE), 'utf-8'));
  assert.equal(state['timesheet-push:2026-05'], undefined);
});

test('disabled reminder never fires', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center, calls } = makeCenter(now, { config: makeConfig({ enabled: false }) });
  assert.equal(center.getActive().length, 0);
  assert.equal(calls.count, 0);
});

// ─── Unpushed condition ──────────────────────────────────────────────────

test('fully pushed month: no item, no state entry', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now, { unpushed: 0 });
  assert.equal(center.getActive().length, 0);
  assert.equal(existsSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE)), false);
});

test('unpushed days present: item served + pending persisted', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const items = center.getActive();
  assert.equal(items.length, 1);
  assert.match(items[0].body, /3 days unpushed/);
  const state = JSON.parse(readFileSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE), 'utf-8'));
  assert.equal(state['timesheet-push:2026-07'].status, NotificationStatus.Pending);
});

test('push mid-window retires a pending reminder', () => {
  const now = { value: at('2026-07-31', 15) };
  const over: { unpushed: number } = { unpushed: 2 };
  const calls = { count: 0 };
  rmSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE), { force: true });
  const config = makeConfig();
  const center = new NotificationCenter({
    getConfig: () => config,
    flushToday: () => {},
    now: () => now.value,
    getUnpushedDays: () => { calls.count++; return over.unpushed; },
  });
  assert.equal(center.getActive().length, 1);
  over.unpushed = 0;
  now.value += 61_000;
  assert.equal(center.getActive().length, 0);
});

// ─── State machine ───────────────────────────────────────────────────────

test('shown: pending → delivered, item stops being served', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const [item] = center.getActive();
  const ack = center.ack(item.id, 'shown');
  assert.equal(ack.ok, true);
  assert.equal(ack.status, NotificationStatus.Delivered);
  assert.equal(center.getActive().length, 0);
});

test('shown is idempotent on a delivered item', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const [item] = center.getActive();
  center.ack(item.id, 'shown');
  const second = center.ack(item.id, 'shown');
  assert.equal(second.ok, true);
  assert.equal(second.status, NotificationStatus.Delivered);
});

test('opened after shown → consumed with consumedBy', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const [item] = center.getActive();
  center.ack(item.id, 'shown');
  const ack = center.ack(item.id, 'opened');
  assert.equal(ack.status, NotificationStatus.Consumed);
  const state = JSON.parse(readFileSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE), 'utf-8'));
  assert.equal(state[item.id].consumedBy, 'opened');
});

test('hidden straight from pending → consumed (lost shown ack)', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const [item] = center.getActive();
  const ack = center.ack(item.id, 'hidden');
  assert.equal(ack.status, NotificationStatus.Consumed);
  assert.equal(center.getActive().length, 0);
});

test('unknown id → error', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const ack = center.ack('nope:2026-07', 'shown');
  assert.equal(ack.ok, false);
  assert.match(ack.error ?? '', /Unknown notification/);
});

test('restart survival: a new center instance keeps delivered suppressed', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const [item] = center.getActive();
  center.ack(item.id, 'shown');

  const { center: reborn } = makeCenter(now, { freshState: false });
  assert.equal(reborn.getActive().length, 0);
});

test('corrupt state file → fallback to empty, no throw', () => {
  const now = { value: at('2026-07-31', 15) };
  writeFileSync(join(getDataDir(), NOTIFICATIONS_STATE_FILE), '{broken', 'utf-8');
  const { center } = makeCenter(now, { freshState: false });
  assert.equal(center.getActive().length, 1);
});

test('no leftover .tmp files after persists', () => {
  const leftovers = readdirSync(getDataDir()).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

// ─── Memo ────────────────────────────────────────────────────────────────

test('memo: second getActive within TTL skips re-evaluation', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center, calls } = makeCenter(now);
  center.getActive();
  center.getActive();
  assert.equal(calls.count, 1);
});

test('memo: injectTest invalidates — new item visible within TTL', () => {
  const now = { value: at('2026-07-01', 12) }; // far from any real window
  const { center } = makeCenter(now);
  assert.equal(center.getActive().length, 0);
  center.injectTest(5);
  assert.equal(center.getActive().length, 1);
});

test('memo: ack makes the change visible within TTL', () => {
  const now = { value: at('2026-07-31', 15) };
  const { center } = makeCenter(now);
  const [item] = center.getActive();
  center.ack(item.id, 'hidden');
  assert.equal(center.getActive().length, 0); // stale memo would still serve it
});

// ─── Test injection ──────────────────────────────────────────────────────

test('injectTest: active immediately, gone after expiry', () => {
  const now = { value: at('2026-07-01', 12) }; // far from any real window
  const { center } = makeCenter(now);
  const injected = center.injectTest(1);
  assert.equal(injected.kind, 'test');
  const items = center.getActive();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, injected.id);

  now.value += 2 * 60_000;
  assert.equal(center.getActive().length, 0);
});

test('injectTest: shown ack stops serving, opened consumes', () => {
  const now = { value: at('2026-07-01', 12) };
  const { center } = makeCenter(now);
  const injected = center.injectTest(5);
  const ack = center.ack(injected.id, 'shown');
  assert.equal(ack.status, NotificationStatus.Delivered);
  assert.equal(center.getActive().length, 0);
  const consumed = center.ack(injected.id, 'opened');
  assert.equal(consumed.status, NotificationStatus.Consumed);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
