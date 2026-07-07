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
  fetchProjects,
  parseProjectSearchPage,
} from '../../src/push/jira-client.js';
import { getDataDir, deriveProjectKeysFromTaskPattern } from '../../src/core/config.js';
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

  await test('searchIssues resolves keys and words separately, then merges the picker', async () => {
    stubFetch(
      // 1) key JQL — exact-key lookup, never crowded out by word hits.
      { status: 200, body: { issues: [{ key: 'ATL-16', fields: { summary: 'Retrospective' } }] } },
      // 2) word JQL — summary prefix search.
      { status: 200, body: { issues: [{ key: 'ATL-16', fields: { summary: 'Retrospective' } }] } },
      // 3) picker fill (merged set < a page) — a sibling from the key-number family.
      { status: 200, body: { sections: [{ id: 'cs', issues: [
        { key: 'ATL-16', summaryText: 'Retrospective' },
        { key: 'ATL-1650', summaryText: 'Retro board cleanup' },
      ] }] } },
    );
    const hits = await searchIssues('ATL-16 Retrospective', secrets, ['ATL']);
    assert.equal(hits[0].key, 'ATL-16');                 // exact key ranked first
    assert.ok(hits.some(h => h.key === 'ATL-1650'));     // picker family kept below
    assert.equal(fetchCalls.length, 3);
    assert.ok(decodeURIComponent(fetchCalls[0]).includes('key in ("ATL-16")'));
    assert.ok(!decodeURIComponent(fetchCalls[0]).includes('summary ~')); // keys are isolated
    assert.ok(decodeURIComponent(fetchCalls[1]).includes('summary ~ "retrospective*"'));
    assert.ok(fetchCalls[2].includes('/rest/api/3/issue/picker'));
  });

  await test('searchIssues widens words AND → OR when the precise query is empty', async () => {
    stubFetch(
      { status: 200, body: { issues: [] } },                                          // AND — no hits
      { status: 200, body: { issues: [{ key: 'ATL-5', fields: { summary: 'Alpha only' } }] } }, // OR — a hit
      { status: 200, body: { sections: [] } },                                        // picker fill
    );
    const hits = await searchIssues('alpha beta', secrets, ['ATL']);
    assert.deepEqual(hits.map(h => h.key), ['ATL-5']);
    assert.ok(decodeURIComponent(fetchCalls[0]).includes('"alpha*" AND summary ~ "beta*"'));
    assert.ok(decodeURIComponent(fetchCalls[1]).includes('"alpha*" OR summary ~ "beta*"'));
  });

  await test('searchIssues drops picker leaks outside the allow-list', async () => {
    stubFetch(
      { status: 200, body: { issues: [{ key: 'ATL-16', fields: { summary: 'Retrospective' } }] } },
      { status: 200, body: { sections: [{ id: 'hs', issues: [
        { key: 'APP-23719', summaryText: 'Retrospective' },   // history section, foreign project
      ] }] } },
    );
    const hits = await searchIssues('retrospective', secrets, ['ATL']);
    assert.ok(hits.every(h => h.key.startsWith('ATL-')));
    assert.ok(!hits.some(h => h.key.startsWith('APP-')));
  });

  await test('searchIssues skips the picker when JQL already fills a page', async () => {
    const issues = Array.from({ length: 8 }, (_, i) => ({ key: `ATL-${i + 1}`, fields: { summary: `Issue ${i + 1}` } }));
    stubFetch({ status: 200, body: { issues } });
    const hits = await searchIssues('issue', secrets, ['ATL']);
    assert.equal(fetchCalls.length, 1); // no picker call
    assert.equal(hits.length, 8);
  });

  await test('searchIssues caches by query + scope', async () => {
    stubFetch(
      { status: 200, body: { issues: [{ key: 'ATL-9', fields: { summary: 'Cached' } }] } },
      { status: 200, body: { sections: [] } },
    );
    const first = await searchIssues('cache-me', secrets, ['ATL']);
    const second = await searchIssues('  CACHE-ME ', secrets, ['ATL']);
    assert.deepEqual(second, first);
    assert.equal(fetchCalls.length, 2); // both fetches on the first call; second is cached
  });

  await test('searchIssues returns [] when nothing matches', async () => {
    stubFetch(
      { status: 200, body: { issues: [] } },   // AND
      { status: 200, body: { issues: [] } },   // OR (two words)
      { status: 200, body: { sections: [] } }, // picker
    );
    assert.deepEqual(await searchIssues('nothing here', secrets, ['ATL']), []);
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

  // ─── Phase 1: project catalog + taskPattern seeding ──────────────────────

  await test('deriveProjectKeysFromTaskPattern extracts uppercase keys', () => {
    assert.deepEqual(deriveProjectKeysFromTaskPattern('ATL-\\d+'), ['ATL']);
    assert.deepEqual(deriveProjectKeysFromTaskPattern('PROJ-\\d+'), ['PROJ']);
    assert.deepEqual(deriveProjectKeysFromTaskPattern('(?:ATL|CNF)-\\d+'), ['ATL', 'CNF']);
    assert.deepEqual(deriveProjectKeysFromTaskPattern(''), []);
    // Single-letter runs and lowercase are ignored (no false project keys).
    assert.deepEqual(deriveProjectKeysFromTaskPattern('x-\\d+'), []);
  });

  await test('parseProjectSearchPage keeps well-formed entries, drops the rest', () => {
    const refs = parseProjectSearchPage({
      values: [
        { id: '10000', key: 'ATL', name: 'Core Platform' },
        { id: 10001, key: 'WEB', name: 'Web Portal' } as unknown as { id: string; key: string; name: string },
        { key: 'BAD', name: 'No id' },              // dropped: no id
        { id: '10002', name: 'No key' },            // dropped: no key
      ],
    });
    assert.deepEqual(refs, [
      { key: 'ATL', name: 'Core Platform', id: '10000' },
      { key: 'WEB', name: 'Web Portal', id: '10001' }, // numeric id coerced to string
    ]);
  });

  await test('fetchProjects paginates until isLast and sorts by key', async () => {
    stubFetch(
      { status: 200, body: { isLast: false, values: [
        { id: '3', key: 'OPS', name: 'Infra & Ops' },
        { id: '1', key: 'ATL', name: 'Core Platform' },
      ] } },
      { status: 200, body: { isLast: true, values: [
        { id: '2', key: 'APP', name: 'Mobile App' },
      ] } },
    );
    const projects = await fetchProjects(secrets);
    assert.deepEqual(projects.map(p => p.key), ['APP', 'ATL', 'OPS']);
    assert.equal(fetchCalls.length, 2);
    assert.ok(fetchCalls[0].includes('/rest/api/3/project/search'));
    assert.ok(fetchCalls[0].includes('startAt=0'));
    assert.ok(fetchCalls[1].includes('startAt=50'));
  });

  await test('fetchProjects stops on an empty page (no isLast flag)', async () => {
    stubFetch(
      { status: 200, body: { values: [{ id: '1', key: 'ATL', name: 'Core Platform' }] } },
      { status: 200, body: { values: [] } },
    );
    const projects = await fetchProjects(secrets);
    assert.deepEqual(projects.map(p => p.key), ['ATL']);
    assert.equal(fetchCalls.length, 2);
  });

  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
