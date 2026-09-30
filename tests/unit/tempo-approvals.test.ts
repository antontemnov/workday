/**
 * Unit tests for the closed-month rule (tempo-approvals.ts): OPEN and
 * REJECTED are editable, every other status closes the month; a day edit is
 * refused in a closed month — a past month is asked fresh, the submit window
 * and a closed month trust a minute-old status, the rest of the current
 * month rides the cache; the moment the month closed comes along; callers
 * asking at once share one request. fetch is stubbed; no network.
 *
 * Run: npx tsx tests/unit/tempo-approvals.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { APPROVAL_CACHE_FILE, ISSUE_CACHE_FILE } from '../../src/core/constants.js';
import { approvalUnavailable, cachedApprovals, dayEditRefusal, isClosedStatus, resolveMonthApproval } from '../../src/push/tempo-approvals.js';
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

const secrets = { Jira_Email: 'a@b.c', Jira_BaseUrl: 'https://example.atlassian.net', Jira_Token: 't', Tempo_Token: 't' };
const TODAY = '2026-09-20';
const config: AppConfig = {
  repos: [], boundaryHour: 0, timezone: 'UTC', tracking: { projectKeys: ['ATL'], branchOwners: [] }, genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 }, workDays: [1, 2, 3, 4, 5], holidays: [], apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal },
};

mkdirSync(getDataDir(), { recursive: true });
writeFileSync(join(getDataDir(), ISSUE_CACHE_FILE), JSON.stringify({ __accountId__: 'acc-1' }));

function cache(entries: Record<string, string>, ageMs = 0): void {
  const fetchedAt = new Date(Date.now() - ageMs).toISOString();
  writeFileSync(join(getDataDir(), APPROVAL_CACHE_FILE), JSON.stringify(Object.fromEntries(
    Object.entries(entries).map(([month, statusKey]) => [month, { fetchedAt, period: null, statusKey, requiredSeconds: 0, timeSpentSeconds: 0, canSubmit: false }]),
  )));
}

// Tempo answers per month ("YYYY-MM" of ?from=); null = Tempo is down.
let tempoStatus: Record<string, string> | null = {};
const calls: string[] = [];
globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input));
  calls.push(url.pathname);
  if (!tempoStatus) throw new Error('fetch failed');
  const month = (url.searchParams.get('from') ?? '').slice(0, 7);
  await new Promise(r => setTimeout(r, 5));
  return new Response(JSON.stringify({ period: null, status: { key: tempoStatus[month] ?? 'OPEN', updatedAt: '2026-09-30T11:55:07Z' } }), { status: 200 });
}) as typeof fetch;

console.log('Closed statuses');

await test('OPEN and REJECTED are editable', () => {
  assert.equal(isClosedStatus('OPEN'), false);
  assert.equal(isClosedStatus('REJECTED'), false);
});

await test('IN_REVIEW, APPROVED and anything unknown close the month', () => {
  assert.equal(isClosedStatus('IN_REVIEW'), true);
  assert.equal(isClosedStatus('APPROVED'), true);
  assert.equal(isClosedStatus('SOMETHING_NEW'), true);
});

await test('no status known → editable', () => {
  assert.equal(isClosedStatus(null), false);
  assert.equal(approvalUnavailable('scope').closed, false);
});

await test('the approval response says closed', async () => {
  cache({ '2026-06': 'APPROVED', '2026-07': 'REJECTED' });
  assert.equal((await resolveMonthApproval(2026, 6, secrets)).closed, true);
  assert.equal((await resolveMonthApproval(2026, 7, secrets)).closed, false);
});

console.log('\nDay edits');

await test('without secrets nothing is checked', async () => {
  calls.length = 0;
  assert.equal(await dayEditRefusal('2026-06-10', TODAY, null, config), null);
  assert.equal(calls.length, 0);
});

await test('current month IN_REVIEW in the cache → refused without asking Tempo', async () => {
  cache({ '2026-09': 'IN_REVIEW' });
  calls.length = 0;
  assert.equal(await dayEditRefusal('2026-09-20', TODAY, secrets, config), 'Timesheet 2026-09 is IN_REVIEW in Tempo — a closed month stays as it is');
  assert.equal(calls.length, 0);
});

await test('current month OPEN in the cache → editable', async () => {
  cache({ '2026-09': 'OPEN' });
  assert.equal(await dayEditRefusal('2026-09-02', TODAY, secrets, config), null);
});

await test('past month: approved a minute ago → refused although the cache says OPEN', async () => {
  cache({ '2026-08': 'OPEN' });
  tempoStatus = { '2026-08': 'APPROVED' };
  calls.length = 0;
  assert.match(await dayEditRefusal('2026-08-04', TODAY, secrets, config) ?? '', /2026-08 is APPROVED/);
  assert.equal(calls.length, 1);
});

await test('past month sent back (REJECTED) → editable', async () => {
  tempoStatus = { '2026-08': 'REJECTED' };
  assert.equal(await dayEditRefusal('2026-08-04', TODAY, secrets, config), null);
});

await test('past month, Tempo down → the last known status decides', async () => {
  cache({ '2026-07': 'APPROVED', '2026-05': 'OPEN' });
  tempoStatus = null;
  assert.match(await dayEditRefusal('2026-07-15', TODAY, secrets, config) ?? '', /2026-07 is APPROVED/);
  assert.equal(await dayEditRefusal('2026-05-15', TODAY, secrets, config), null);
  assert.equal(await dayEditRefusal('2026-04-15', TODAY, secrets, config), null); // never seen → open
});

await test('mid-month: a 5-minute-old OPEN is trusted', async () => {
  cache({ '2026-09': 'OPEN' }, 5 * 60_000);
  tempoStatus = { '2026-09': 'IN_REVIEW' };
  calls.length = 0;
  assert.equal(await dayEditRefusal('2026-09-15', TODAY, secrets, config), null);
  assert.equal(calls.length, 0);
});

await test('submit window: an OPEN older than a minute is asked — submitted on the site → refused', async () => {
  cache({ '2026-09': 'OPEN' }, 2 * 60_000);
  tempoStatus = { '2026-09': 'IN_REVIEW' };
  calls.length = 0;
  assert.match(await dayEditRefusal('2026-09-29', '2026-09-29', secrets, config) ?? '', /2026-09 is IN_REVIEW/);
  assert.equal(calls.length, 1);
});

await test('submit window: an OPEN younger than a minute is trusted', async () => {
  cache({ '2026-09': 'OPEN' }, 20_000);
  calls.length = 0;
  assert.equal(await dayEditRefusal('2026-09-29', '2026-09-29', secrets, config), null);
  assert.equal(calls.length, 0);
});

await test('closed in the cache for over a minute: asked — sent back (REJECTED) → editable', async () => {
  cache({ '2026-09': 'IN_REVIEW' }, 2 * 60_000);
  tempoStatus = { '2026-09': 'REJECTED' };
  calls.length = 0;
  assert.equal(await dayEditRefusal('2026-09-10', TODAY, secrets, config), null);
  assert.equal(calls.length, 1);
});

console.log('\nStatus reads');

await test('maxAge 0 always asks; the moment the month closed comes along', async () => {
  cache({ '2026-09': 'OPEN' });
  tempoStatus = { '2026-09': 'IN_REVIEW' };
  calls.length = 0;
  const approval = await resolveMonthApproval(2026, 9, secrets, 0);
  assert.equal(calls.length, 1);
  assert.equal(approval.closed, true);
  assert.equal(approval.closedAt, '2026-09-30T11:55:07Z');
  assert.equal(cachedApprovals().get('2026-09')?.closedAt, '2026-09-30T11:55:07Z');
});

await test('an open month has no closing moment', async () => {
  tempoStatus = { '2026-09': 'REJECTED' };
  assert.equal((await resolveMonthApproval(2026, 9, secrets, 0)).closedAt, null);
});

await test('callers asking the same month at once share one request', async () => {
  tempoStatus = { '2026-09': 'OPEN' };
  calls.length = 0;
  const [a, b] = await Promise.all([resolveMonthApproval(2026, 9, secrets, 0), resolveMonthApproval(2026, 9, secrets, 0)]);
  assert.equal(calls.length, 1);
  assert.equal(a.statusKey, b.statusKey);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
