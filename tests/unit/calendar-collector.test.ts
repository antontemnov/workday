/**
 * Unit tests for the calendar collector: cache write/reconciliation (the
 * DTEND watershed — vanished-after-end freezes, vanished-before-end drops,
 * feed authoritative per uid+date), fetch-failure resilience and the
 * morning/base fetch cadence.
 *
 * Run: npx tsx tests/unit/calendar-collector.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { CalendarCollector, reconcileInstances } from '../../src/collectors/calendar-collector.js';
import { CALENDAR_CACHE_FILE } from '../../src/core/constants.js';
import { SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, CalendarInstance } from '../../src/core/types.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await fn();
      passed++;
      console.log(`  PASS ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL ${name}`);
      console.error(`       ${(err as Error).message}`);
    }
  };
  queue = queue.then(run);
  return queue;
}
let queue: Promise<void> = Promise.resolve();

function makeConfig(over?: { enabled?: boolean }): AppConfig {
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
    search: { projectKeys: [], knownProjects: [] },
    activities: { values: [] },
    notifications: { timesheetReminder: { enabled: true, notifyHour: 14 } },
    calendar: { enabled: over?.enabled ?? true },
  } as AppConfig;
}

function ics(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
}

function busyEvent(uid: string, startUtc: string, endUtc: string): string {
  return [
    'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:Event ${uid}`,
    'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
    `DTSTART:${startUtc}Z`, `DTEND:${endUtc}Z`,
    'END:VEVENT',
  ].join('\r\n');
}

interface Harness {
  collector: CalendarCollector;
  feed: { text: string; error: string | null };
  nowRef: { value: number };
  fetches: { count: number };
}

function makeCollector(over?: { enabled?: boolean; url?: string | null }): Harness {
  rmSync(join(getDataDir(), CALENDAR_CACHE_FILE), { force: true });
  const feed = { text: ics(), error: null as string | null };
  const nowRef = { value: Date.UTC(2026, 6, 16, 12, 0, 0) }; // 2026-07-16 12:00Z
  const fetches = { count: 0 };
  const config = makeConfig(over);
  const collector = new CalendarCollector({
    getConfig: () => config,
    getIcsUrl: () => over?.url === undefined ? 'https://example.invalid/calendar.ics' : over.url,
    now: () => nowRef.value,
    fetchIcs: async () => {
      fetches.count++;
      if (feed.error) throw new Error(feed.error);
      return feed.text;
    },
  });
  return { collector, feed, nowRef, fetches };
}

// ─── reconcileInstances (pure) ───────────────────────────────────────────

function inst(uid: string, date: string, start: string, end: string, frozen?: boolean): CalendarInstance {
  return { uid, date, start, end, title: uid, busyStatus: 'BUSY', allDay: false, cancelled: false, recurring: false, ...(frozen ? { frozen } : {}) };
}

const NOW = Date.UTC(2026, 6, 16, 12, 0, 0);
const WINDOW_START = NOW - 90 * 86_400_000;

void test('reconcile: vanished after DTEND → frozen fact', () => {
  const prev = [inst('a', '2026-07-16', '2026-07-16T08:00:00.000Z', '2026-07-16T09:00:00.000Z')];
  const out = reconcileInstances(prev, [], NOW, WINDOW_START);
  assert.equal(out.length, 1);
  assert.equal(out[0].frozen, true);
});

void test('reconcile: vanished before DTEND → cancellation, dropped', () => {
  const prev = [inst('b', '2026-07-16', '2026-07-16T14:00:00.000Z', '2026-07-16T15:00:00.000Z')];
  const out = reconcileInstances(prev, [], NOW, WINDOW_START);
  assert.equal(out.length, 0);
});

void test('reconcile: feed authoritative per uid+date (reschedule wins, no freeze)', () => {
  const prev = [inst('c', '2026-07-16', '2026-07-16T08:00:00.000Z', '2026-07-16T09:00:00.000Z')];
  const fresh = [inst('c', '2026-07-16', '2026-07-16T09:30:00.000Z', '2026-07-16T10:30:00.000Z')];
  const out = reconcileInstances(prev, fresh, NOW, WINDOW_START);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, '2026-07-16T09:30:00.000Z');
  assert.equal(out[0].frozen, undefined);
});

void test('reconcile: frozen instance survives later reconciles, ages out of window', () => {
  const frozen = inst('d', '2026-07-01', '2026-07-01T08:00:00.000Z', '2026-07-01T09:00:00.000Z', true);
  const kept = reconcileInstances([frozen], [], NOW, WINDOW_START);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].frozen, true);
  const agedOut = reconcileInstances([frozen], [], NOW, Date.UTC(2026, 6, 10));
  assert.equal(agedOut.length, 0);
});

// ─── Collector refresh + cache ───────────────────────────────────────────

void test('refresh: expands feed, writes cache, status reflects it', async () => {
  const h = makeCollector();
  h.feed.text = ics(busyEvent('ev-1', '20260716T100000', '20260716T110000'));
  const result = await h.collector.refresh();
  assert.equal(result.instanceCount, 1);
  assert.ok(existsSync(join(getDataDir(), CALENDAR_CACHE_FILE)));
  const instances = h.collector.getInstances();
  assert.equal(instances[0].uid, 'ev-1');
  assert.equal(instances[0].date, '2026-07-16');
  assert.equal(instances[0].busyStatus, 'BUSY');
  const status = h.collector.getStatus();
  assert.equal(status.configured, true);
  assert.equal(status.lastError, null);
  assert.equal(status.instanceCount, 1);
  assert.ok(status.lastFetchAt);
});

void test('refresh: DTEND watershed across fetches (past freezes, future drops)', async () => {
  const h = makeCollector();
  h.feed.text = ics(
    busyEvent('past', '20260716T080000', '20260716T090000'),
    busyEvent('future', '20260716T140000', '20260716T150000'),
  );
  await h.collector.refresh();
  h.feed.text = ics(); // both vanish
  const result = await h.collector.refresh();
  assert.equal(result.instanceCount, 1);
  const instances = h.collector.getInstances();
  assert.equal(instances[0].uid, 'past');
  assert.equal(instances[0].frozen, true);
});

void test('refresh failure: error surfaces in status, cache untouched', async () => {
  const h = makeCollector();
  h.feed.text = ics(busyEvent('keep', '20260716T080000', '20260716T090000'));
  await h.collector.refresh();
  const before = h.collector.getStatus().lastFetchAt;
  h.feed.error = 'HTTP 417';
  await assert.rejects(() => h.collector.refresh(), /HTTP 417/);
  const status = h.collector.getStatus();
  assert.equal(status.lastError, 'HTTP 417');
  assert.equal(status.lastFetchAt, before);
  assert.equal(status.instanceCount, 1);
});

void test('unconfigured: no url → configured=false, refresh rejects, no fetch', async () => {
  const h = makeCollector({ url: null });
  assert.equal(h.collector.getStatus().configured, false);
  await assert.rejects(() => h.collector.refresh(), /not configured/);
  h.collector.maybeScheduledRefresh();
  await new Promise(r => setImmediate(r));
  assert.equal(h.fetches.count, 0);
});

// ─── Cadence ─────────────────────────────────────────────────────────────

async function settle(): Promise<void> {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
}

void test('cadence: hourly inside 10–14 local, 3-hourly outside', async () => {
  const h = makeCollector();
  h.nowRef.value = Date.UTC(2026, 6, 16, 9, 0, 0);
  await h.collector.refresh();                       // manual anchor at 09:00
  assert.equal(h.fetches.count, 1);

  h.nowRef.value = Date.UTC(2026, 6, 16, 10, 30, 0); // 1.5h later, morning window → due
  h.collector.maybeScheduledRefresh();
  await settle();
  assert.equal(h.fetches.count, 2);

  h.nowRef.value = Date.UTC(2026, 6, 16, 11, 15, 0); // 45m later → not due
  h.collector.maybeScheduledRefresh();
  await settle();
  assert.equal(h.fetches.count, 2);

  h.nowRef.value = Date.UTC(2026, 6, 16, 11, 35, 0); // 1h05 later, morning → due
  h.collector.maybeScheduledRefresh();
  await settle();
  assert.equal(h.fetches.count, 3);

  h.nowRef.value = Date.UTC(2026, 6, 16, 13, 30, 0); // 1h55 later, still morning → due
  h.collector.maybeScheduledRefresh();
  await settle();
  assert.equal(h.fetches.count, 4);

  h.nowRef.value = Date.UTC(2026, 6, 16, 15, 30, 0); // 2h later but 15:30 → 3h base, not due
  h.collector.maybeScheduledRefresh();
  await settle();
  assert.equal(h.fetches.count, 4);

  h.nowRef.value = Date.UTC(2026, 6, 16, 16, 35, 0); // 3h05 later → due
  h.collector.maybeScheduledRefresh();
  await settle();
  assert.equal(h.fetches.count, 5);
});

// ─── Summary ─────────────────────────────────────────────────────────────

void queue.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
