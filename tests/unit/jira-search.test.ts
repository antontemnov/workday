/**
 * Unit tests for jira-client search & existence probe (stubbed fetch).
 *
 * Run: npx tsx tests/unit/jira-search.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * test-home MUST be the first import — the issue cache lives under WORKDAY_HOME.
 */
import '../helpers/test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import {
  isJiraConfigured,
  searchIssues,
  checkIssueExists,
  JiraApiError,
} from '../../src/push/jira-client.js';
import { getDataDir } from '../../src/core/config.js';
import type { Secrets } from '../../src/core/types.js';

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

function makeSecrets(overrides: Partial<Secrets> = {}): Secrets {
  return {
    Developer: 'atemnov',
    Jira_Email: 'dev@example.com',
    Jira_BaseUrl: 'https://example.atlassian.net',
    Jira_Token: 'token',
    Tempo_Token: '',
    ...overrides,
  };
}

// ─── fetch stub ────────────────────────────────────────────────────────────

interface StubResponse {
  readonly status: number;
  readonly body: unknown;
}

let fetchCalls: string[] = [];
let nextResponses: StubResponse[] = [];

function stubFetch(...responses: StubResponse[]): void {
  fetchCalls = [];
  nextResponses = [...responses];
  globalThis.fetch = (async (url: string | URL) => {
    fetchCalls.push(String(url));
    const stub = nextResponses.shift();
    if (!stub) throw new Error('fetch stub: no response queued');
    return {
      ok: stub.status >= 200 && stub.status < 300,
      status: stub.status,
      json: async () => stub.body,
      text: async () => JSON.stringify(stub.body),
    };
  }) as unknown as typeof fetch;
}

const secrets = makeSecrets();
mkdirSync(getDataDir(), { recursive: true });

async function main(): Promise<void> {
  console.log('Jira client — search & existence probe');

  await test('isJiraConfigured requires all three Jira fields', () => {
    assert.equal(isJiraConfigured(secrets), true);
    assert.equal(isJiraConfigured(makeSecrets({ Jira_Token: '' })), false);
    assert.equal(isJiraConfigured(makeSecrets({ Jira_Token: '   ' })), false);
    assert.equal(isJiraConfigured(makeSecrets({ Jira_BaseUrl: '' })), false);
    assert.equal(isJiraConfigured(makeSecrets({ Jira_Email: '' })), false);
  });

  await test('searchIssues parses picker sections and dedupes across them', async () => {
    stubFetch({
      status: 200,
      body: {
        sections: [
          { issues: [
            { key: 'ATL-1', summaryText: 'First issue', summary: '<b>First</b> issue' },
            { key: 'ATL-2', summary: '<b>Second</b> issue' },
          ] },
          { issues: [
            { key: 'ATL-1', summaryText: 'First issue (dup section)' },
            { key: 'ATL-3', summaryText: 'Third issue' },
          ] },
        ],
      },
    });
    const hits = await searchIssues('first', secrets);
    assert.deepEqual(hits, [
      { key: 'ATL-1', summary: 'First issue' },
      { key: 'ATL-2', summary: 'Second issue' },   // HTML stripped from fallback
      { key: 'ATL-3', summary: 'Third issue' },
    ]);
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].includes('/rest/api/3/issue/picker?query=first'));
    // Without currentJQL the picker returns History Search only (empty for a
    // user with no view history); without showSubTasks sub-tasks are invisible.
    assert.ok(fetchCalls[0].includes('currentJQL='));
    assert.ok(fetchCalls[0].includes('showSubTasks=true'));
    assert.ok(fetchCalls[0].includes('showSubTaskParent=true'));
  });

  await test('searchIssues caches a repeated query (case-insensitive)', async () => {
    stubFetch({
      status: 200,
      body: { sections: [{ issues: [{ key: 'ATL-9', summaryText: 'Cached' }] }] },
    });
    const first = await searchIssues('cache-me', secrets);
    const second = await searchIssues('  CACHE-ME ', secrets);
    assert.deepEqual(second, first);
    assert.equal(fetchCalls.length, 1);
  });

  await test('searchIssues tolerates an empty picker response', async () => {
    stubFetch({ status: 200, body: {} });
    assert.deepEqual(await searchIssues('nothing-here', secrets), []);
  });

  await test('checkIssueExists returns the issue and caches it on disk', async () => {
    stubFetch({ status: 200, body: { id: '41100', fields: { summary: 'Real issue' } } });
    const issue = await checkIssueExists('ATL-100', secrets);
    assert.deepEqual(issue, { issueId: 41100, summary: 'Real issue' });

    // Second probe is served from issue-cache.json — no network.
    const again = await checkIssueExists('ATL-100', secrets);
    assert.deepEqual(again, issue);
    assert.equal(fetchCalls.length, 1);
  });

  await test('checkIssueExists returns null on 404 and never caches it', async () => {
    stubFetch(
      { status: 404, body: { errorMessages: ['Issue does not exist'] } },
      { status: 404, body: { errorMessages: ['Issue does not exist'] } },
    );
    assert.equal(await checkIssueExists('ATL-404', secrets), null);
    // The issue may be created a minute later — a retry must hit the API.
    assert.equal(await checkIssueExists('ATL-404', secrets), null);
    assert.equal(fetchCalls.length, 2);
  });

  await test('checkIssueExists rethrows non-404 failures with the status', async () => {
    stubFetch({ status: 503, body: { message: 'boom' } });
    await assert.rejects(
      () => checkIssueExists('ATL-503', secrets),
      (err: unknown) => err instanceof JiraApiError && err.status === 503,
    );
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
