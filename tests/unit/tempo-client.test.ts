/**
 * Unit tests for TempoClient.getUserWorklogs pagination — metadata.count is
 * the page size, NOT the total; the only "more pages" signal is metadata.next.
 * fetch is stubbed; no network.
 *
 * Run: npx tsx tests/unit/tempo-client.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import assert from 'node:assert/strict';
import { TempoClient } from '../../src/push/tempo-client.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>): Promise<void> {
  return fn().then(
    () => { passed++; console.log(`  PASS ${name}`); },
    (err) => { failed++; console.error(`  FAIL ${name}`); console.error(`       ${(err as Error).message}`); },
  );
}

function worklogPage(startId: number, count: number, next: boolean): unknown {
  return {
    results: Array.from({ length: count }, (_, i) => ({
      tempoWorklogId: startId + i,
      issue: { id: 1 },
      startDate: '2026-07-01',
      timeSpentSeconds: 900,
    })),
    metadata: {
      count, // page size — deliberately equals results.length, like the real API
      offset: 0,
      limit: count,
      ...(next ? { next: 'https://api.tempo.io/next' } : {}),
    },
  };
}

function stubFetch(pages: unknown[]): { urls: string[] } {
  const calls: { urls: string[] } = { urls: [] };
  globalThis.fetch = (async (url: string | URL) => {
    calls.urls.push(String(url));
    const body = pages[calls.urls.length - 1] ?? { results: [], metadata: { count: 0 } };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as typeof fetch;
  return calls;
}

console.log('TempoClient.getUserWorklogs — pagination');

await test('full page WITHOUT next → single request (no phantom pages)', async () => {
  const calls = stubFetch([worklogPage(1, 50, false)]);
  const client = new TempoClient('t');
  const result = await client.getUserWorklogs('acc', '2026-07-01', '2026-07-31');
  assert.equal(result.length, 50);
  assert.equal(calls.urls.length, 1);
});

await test('full page WITH next → follows to the tail page', async () => {
  const calls = stubFetch([worklogPage(1, 50, true), worklogPage(51, 9, false)]);
  const client = new TempoClient('t');
  const result = await client.getUserWorklogs('acc', '2026-06-01', '2026-07-31');
  assert.equal(result.length, 59); // the pre-fix loop stopped at 50
  assert.equal(calls.urls.length, 2);
  assert.match(calls.urls[1], /offset=50/);
  assert.equal(result[58].tempoWorklogId, 59);
});

await test('three pages chain through', async () => {
  const calls = stubFetch([worklogPage(1, 50, true), worklogPage(51, 50, true), worklogPage(101, 3, false)]);
  const client = new TempoClient('t');
  const result = await client.getUserWorklogs('acc', '2026-05-01', '2026-07-31');
  assert.equal(result.length, 103);
  assert.equal(calls.urls.length, 3);
  assert.match(calls.urls[2], /offset=100/);
});

await test('empty page with stray next → terminates (no infinite loop)', async () => {
  const calls = stubFetch([{ results: [], metadata: { count: 0, next: 'https://api.tempo.io/next' } }]);
  const client = new TempoClient('t');
  const result = await client.getUserWorklogs('acc', '2026-07-01', '2026-07-31');
  assert.equal(result.length, 0);
  assert.equal(calls.urls.length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
