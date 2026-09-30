/**
 * Unit tests for the closed-month watch (approval-watch.ts): the lock follows
 * the cached status (a missing entry keeps the last one), a cut is due once
 * per closing moment — only for this or the previous month and only when the
 * month closed within its own days; after a push the month is asked every
 * 30 s for 10 minutes until it closes; in the submit window (or while
 * closed) it is asked by the cache TTL, and only while work goes on.
 *
 * Run: npx tsx tests/unit/approval-watch.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { APPROVAL_CACHE_FILE, ISSUE_CACHE_FILE } from '../../src/core/constants.js';
import { ApprovalWatch, monthsBetween } from '../../src/push/approval-watch.js';
import { SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig } from '../../src/core/types.js';

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

const config: AppConfig = {
  repos: [], boundaryHour: 4, timezone: 'UTC', tracking: { projectKeys: ['ATL'], branchOwners: [] }, genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 }, workDays: [1, 2, 3, 4, 5], holidays: [], apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal },
};
const secrets = { Jira_Email: 'a@b.c', Jira_BaseUrl: 'https://example.atlassian.net', Jira_Token: 't', Tempo_Token: 't' };

mkdirSync(getDataDir(), { recursive: true });
writeFileSync(join(getDataDir(), ISSUE_CACHE_FILE), JSON.stringify({ __accountId__: 'acc-1' }));

interface Cached { readonly statusKey: string; readonly statusUpdatedAt?: string; readonly ageMs?: number }

function cache(entries: Record<string, Cached>): void {
  writeFileSync(join(getDataDir(), APPROVAL_CACHE_FILE), JSON.stringify(Object.fromEntries(
    Object.entries(entries).map(([month, e]) => [month, {
      fetchedAt: new Date(Date.now() - (e.ageMs ?? 0)).toISOString(), period: null, statusKey: e.statusKey,
      statusUpdatedAt: e.statusUpdatedAt ?? null, requiredSeconds: 0, timeSpentSeconds: 0, canSubmit: false,
    }]),
  )));
}

// Tempo answers per month; every ask is recorded.
let tempoStatus: Record<string, { key: string; updatedAt?: string }> = {};
const asks: string[] = [];
globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const month = (new URL(String(input)).searchParams.get('from') ?? '').slice(0, 7);
  asks.push(month);
  const status = tempoStatus[month] ?? { key: 'OPEN' };
  return new Response(JSON.stringify({ period: null, status }), { status: 200 });
}) as typeof fetch;

let clock = Date.parse('2026-09-30T12:00:00.000Z');
const watch = (): ApprovalWatch => new ApprovalWatch({ getSecrets: () => secrets, getConfig: () => config, now: () => clock });

console.log('Lock and cuts');

await test('months of a range', () => {
  assert.deepEqual(monthsBetween('2026-11-20', '2027-01-02'), ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual(monthsBetween('2026-09-01', '2026-09-30'), ['2026-09']);
});

await test('submitted within the month: locked, the cut is due once', () => {
  cache({ '2026-09': { statusKey: 'IN_REVIEW', statusUpdatedAt: '2026-09-30T11:55:07Z' } });
  const w = watch();
  const due = w.sync('2026-09-30');
  assert.equal(w.isClosed('2026-09'), true);
  assert.deepEqual(due, [{ month: '2026-09', cutAt: '2026-09-30T11:55:07Z' }]);
  w.markCut(due[0]);
  assert.deepEqual(w.sync('2026-09-30'), []);
});

await test('submitted on the 1st of the next month: locked, nothing to cut', () => {
  cache({ '2026-09': { statusKey: 'IN_REVIEW', statusUpdatedAt: '2026-10-01T09:00:00Z' } });
  const w = watch();
  assert.deepEqual(w.sync('2026-10-01'), []);
  assert.equal(w.isClosed('2026-09'), true);
});

await test('an old month is never cut', () => {
  cache({ '2026-07': { statusKey: 'APPROVED', statusUpdatedAt: '2026-07-31T15:00:00Z' } });
  assert.deepEqual(watch().sync('2026-09-30'), []);
});

await test('no closing moment (old cache entry): locked, nothing to cut', () => {
  cache({ '2026-09': { statusKey: 'IN_REVIEW' } });
  const w = watch();
  assert.deepEqual(w.sync('2026-09-30'), []);
  assert.equal(w.isClosed('2026-09'), true);
});

await test('the cache dropped after a push keeps the last state; REJECTED unlocks', () => {
  cache({ '2026-09': { statusKey: 'IN_REVIEW', statusUpdatedAt: '2026-09-30T11:55:07Z' } });
  const w = watch();
  w.markCut(w.sync('2026-09-30')[0]);
  rmSync(join(getDataDir(), APPROVAL_CACHE_FILE));
  w.sync('2026-09-30');
  assert.equal(w.isClosed('2026-09'), true);
  cache({ '2026-09': { statusKey: 'REJECTED' } });
  w.sync('2026-09-30');
  assert.equal(w.isClosed('2026-09'), false);
});

await test('submitted again after a rejection: a new cut is due', () => {
  cache({ '2026-09': { statusKey: 'IN_REVIEW', statusUpdatedAt: '2026-09-30T11:55:07Z' } });
  const w = watch();
  w.markCut(w.sync('2026-09-30')[0]);
  cache({ '2026-09': { statusKey: 'REJECTED' } });
  w.sync('2026-09-30');
  cache({ '2026-09': { statusKey: 'IN_REVIEW', statusUpdatedAt: '2026-09-30T17:00:00Z' } });
  assert.deepEqual(w.sync('2026-09-30'), [{ month: '2026-09', cutAt: '2026-09-30T17:00:00Z' }]);
});

console.log('\nOwn reads');

await test('after a push: asked every 30 s, stops once the month closes', async () => {
  cache({});
  tempoStatus = {};
  asks.length = 0;
  const w = watch();
  w.armAfterPush(['2026-09']);
  await w.ask('2026-09-15', false);
  assert.deepEqual(asks, ['2026-09']);
  clock += 10_000;
  await w.ask('2026-09-15', false);
  assert.equal(asks.length, 1);
  clock += 30_000;
  tempoStatus = { '2026-09': { key: 'IN_REVIEW', updatedAt: '2026-09-30T12:00:30Z' } };
  await w.ask('2026-09-15', false);
  assert.equal(asks.length, 2);
  w.sync('2026-09-15');
  clock += 30_000;
  await w.ask('2026-09-15', false);
  assert.equal(asks.length, 2);
});

await test('after a push: the watch ends after 10 minutes', async () => {
  cache({});
  tempoStatus = {};
  asks.length = 0;
  const w = watch();
  w.armAfterPush(['2026-09']);
  clock += 11 * 60_000;
  await w.ask('2026-09-15', false);
  assert.equal(asks.length, 0);
});

await test('mid-month with work going on: never asked', async () => {
  cache({ '2026-09': { statusKey: 'OPEN', ageMs: 60 * 60_000 } });
  asks.length = 0;
  await watch().ask('2026-09-15', true);
  assert.equal(asks.length, 0);
});

await test('submit window: asked by the cache TTL, only while work goes on', async () => {
  cache({ '2026-09': { statusKey: 'OPEN', ageMs: 16 * 60_000 } });
  asks.length = 0;
  const w = watch();
  await w.ask('2026-09-29', false);
  assert.equal(asks.length, 0);
  await w.ask('2026-09-29', true);
  assert.equal(asks.length, 1);
  await w.ask('2026-09-29', true);
  assert.equal(asks.length, 1); // the fresh answer is cached now
});

await test('closed month with work going on: asked by the TTL, so a REJECTED unlocks', async () => {
  cache({ '2026-10': { statusKey: 'IN_REVIEW', statusUpdatedAt: '2026-10-05T10:00:00Z', ageMs: 16 * 60_000 } });
  tempoStatus = { '2026-10': { key: 'REJECTED' } };
  asks.length = 0;
  const w = watch();
  w.sync('2026-10-12');
  await w.ask('2026-10-12', true);
  assert.equal(asks.length, 1);
  w.sync('2026-10-12');
  assert.equal(w.isClosed('2026-10'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
