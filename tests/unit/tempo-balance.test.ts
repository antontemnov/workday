/**
 * Unit tests for the year balance (tempo-balance.ts): the months before
 * today's are summed as Tempo has them — a closed month by its numbers at
 * submit, an open one live; months before the first logged one are left
 * out; a closed month is trusted a day, an open one the approval TTL; a push
 * drops the months it touched; a month Tempo can't give and the cache never
 * had makes the answer unavailable. fetch is stubbed; no network.
 *
 * Run: npx tsx tests/unit/tempo-balance.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { BALANCE_CACHE_FILE, ISSUE_CACHE_FILE } from '../../src/core/constants.js';
import { invalidateBalanceMonths, resolveYearBalance, settledMonths } from '../../src/push/tempo-balance.js';

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

const H = 3600;
const secrets = { Jira_Email: 'a@b.c', Jira_BaseUrl: 'https://example.atlassian.net', Jira_Token: 't', Tempo_Token: 't' };
const TODAY = '2026-04-15';

mkdirSync(getDataDir(), { recursive: true });
writeFileSync(join(getDataDir(), ISSUE_CACHE_FILE), JSON.stringify({ __accountId__: 'acc-1' }));

interface Period {
  readonly key: string;
  readonly required: number;          // hours, live
  readonly spent: number;
  readonly atSubmit?: readonly [number, number]; // [required, spent] when submitted
}

// Tempo answers per month ("YYYY-MM" of ?from=); null = Tempo is down, 403 = no scope.
let tempo: Record<string, Period> | null | 403 = {};
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input));
  const month = (url.searchParams.get('from') ?? '').slice(0, 7);
  calls.push(month);
  if (tempo === null) throw new Error('fetch failed');
  if (tempo === 403) return new Response('forbidden', { status: 403 });
  const p = tempo[month] ?? { key: 'OPEN', required: 160, spent: 0 };
  const status: Record<string, unknown> = { key: p.key, updatedAt: '2026-01-31T10:00:00Z' };
  if (p.atSubmit) {
    status.requiredSecondsAtSubmit = p.atSubmit[0] * H;
    status.timeSpentSecondsAtSubmit = p.atSubmit[1] * H;
  }
  return new Response(JSON.stringify({ period: null, requiredSeconds: p.required * H, timeSpentSeconds: p.spent * H, status }), { status: 200 });
}) as typeof fetch;

function resetCache(): void {
  rmSync(join(getDataDir(), BALANCE_CACHE_FILE), { force: true });
}

function cacheAge(month: string, ageMs: number): void {
  const path = join(getDataDir(), BALANCE_CACHE_FILE);
  const cache = JSON.parse(readFileSync(path, 'utf-8'));
  cache[month].fetchedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(path, JSON.stringify(cache));
}

const year = {
  '2026-01': { key: 'APPROVED', required: 128, spent: 136, atSubmit: [120, 136] as const },
  '2026-02': { key: 'APPROVED', required: 160, spent: 160, atSubmit: [160, 160] as const },
  '2026-03': { key: 'OPEN', required: 168, spent: 170 },
};

console.log('Settled months');

await test('the months before today\'s: none in January, all twelve for a past year, none ahead', () => {
  assert.deepEqual(settledMonths(2026, TODAY), ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(settledMonths(2026, '2026-01-20'), []);
  assert.equal(settledMonths(2025, TODAY).length, 12);
  assert.deepEqual(settledMonths(2027, TODAY), []);
});

console.log('\nSum');

await test('a closed month counts as submitted, an open one live', async () => {
  resetCache();
  tempo = year;
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(b.available, true);
  assert.deepEqual(b.months.map(m => [m.month, m.requiredSeconds / H, m.timeSpentSeconds / H]), [
    ['2026-01', 120, 136], ['2026-02', 160, 160], ['2026-03', 168, 170],
  ]);
  assert.equal(b.balanceSeconds, 18 * H);
  assert.equal(b.fromCache, false);
});

await test('a month sent back (REJECTED) counts live, its old submit is gone', async () => {
  resetCache();
  tempo = { ...year, '2026-02': { key: 'REJECTED', required: 160, spent: 150, atSubmit: [152, 160] } };
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(b.months[1].requiredSeconds, 160 * H);
  assert.equal(b.months[1].timeSpentSeconds, 150 * H);
});

await test('months before the first logged one are left out; an empty month later stays', async () => {
  resetCache();
  tempo = { '2026-01': { key: 'OPEN', required: 120, spent: 0 }, '2026-02': { key: 'OPEN', required: 160, spent: 170 }, '2026-03': { key: 'OPEN', required: 168, spent: 0 } };
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.deepEqual(b.months.map(m => m.month), ['2026-02', '2026-03']);
  assert.equal(b.balanceSeconds, -158 * H);
});

await test('nothing logged all year → no months, zero', async () => {
  resetCache();
  tempo = {};
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(b.available, true);
  assert.deepEqual(b.months, []);
  assert.equal(b.balanceSeconds, 0);
});

console.log('\nCache');

await test('a second read asks Tempo nothing', async () => {
  resetCache();
  tempo = year;
  await resolveYearBalance(2026, TODAY, secrets);
  calls.length = 0;
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(calls.length, 0);
  assert.equal(b.fromCache, true);
  assert.equal(b.balanceSeconds, 18 * H);
});

await test('a closed month is trusted a day, an open one a quarter of an hour', async () => {
  cacheAge('2026-01', 2 * H * 1000);
  cacheAge('2026-03', 20 * 60_000);
  calls.length = 0;
  await resolveYearBalance(2026, TODAY, secrets);
  assert.deepEqual(calls, ['2026-03']);
  cacheAge('2026-01', 25 * H * 1000);
  calls.length = 0;
  await resolveYearBalance(2026, TODAY, secrets);
  assert.deepEqual(calls, ['2026-01']);
});

await test('a push drops the months it touched, the rest stay', async () => {
  invalidateBalanceMonths('2026-03-02', '2026-03-31');
  calls.length = 0;
  await resolveYearBalance(2026, TODAY, secrets);
  assert.deepEqual(calls, ['2026-03']);
});

console.log('\nTempo unreachable');

await test('Tempo down: a stale cache answers', async () => {
  cacheAge('2026-03', H * 1000);
  tempo = null;
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(b.available, true);
  assert.equal(b.balanceSeconds, 18 * H);
});

await test('Tempo down and a month never seen → unavailable, nothing half-summed', async () => {
  resetCache();
  tempo = null;
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(b.available, false);
  assert.equal(b.reason, 'error');
  assert.deepEqual(b.months, []);
});

await test('no approvals scope → unavailable (scope)', async () => {
  resetCache();
  tempo = 403;
  const b = await resolveYearBalance(2026, TODAY, secrets);
  assert.equal(b.reason, 'scope');
});

await test('no Tempo token → unavailable without asking', async () => {
  calls.length = 0;
  const b = await resolveYearBalance(2026, TODAY, { ...secrets, Tempo_Token: '' });
  assert.equal(b.reason, 'no-token');
  assert.equal(calls.length, 0);
});

await test('callers asking at once share one walk', async () => {
  resetCache();
  tempo = year;
  calls.length = 0;
  const [a, b] = await Promise.all([resolveYearBalance(2026, TODAY, secrets), resolveYearBalance(2026, TODAY, secrets)]);
  assert.equal(calls.length, 3);
  assert.equal(a.balanceSeconds, b.balanceSeconds);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
