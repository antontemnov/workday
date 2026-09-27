/**
 * End-to-end tests of a commit push (runPush) against an in-memory Tempo
 * behind a fake fetch: the read-first sync stops the push on adopted
 * worklogs and on conflicts, Stop tracking runs only once the gates pass, a
 * refused worklog comes back with Tempo's reason and keeps only its own day
 * open, a closed month is refused. Jira stays offline — the issue cache on
 * disk answers every lookup.
 *
 * Run: npx tsx tests/unit/tempo-push.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../../src/core/config.js';
import { ISSUE_CACHE_FILE } from '../../src/core/constants.js';
import { createEmptyLog, readDailyLog, writeDailyLog } from '../../src/core/daily-log.js';
import { runPush } from '../../src/push/tempo-pusher.js';
import { loadPushLog, pushLogKey, savePushLog, saveTombstones } from '../../src/push/push-log.js';
import { DayStatus, SensitivityLevel } from '../../src/core/types.js';
import type { AppConfig, ManualEntry } from '../../src/core/types.js';

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
};
const secrets = { Jira_Email: 'a@b.c', Jira_BaseUrl: 'https://example.atlassian.net', Jira_Token: 't', Tempo_Token: 't' };
const TODAY = '2026-03-20';
const FROM = '2026-03-01';
const TO = '2026-03-31';

// Jira offline: the issue cache answers accountId and every key ↔ id.
mkdirSync(getDataDir(), { recursive: true });
writeFileSync(join(getDataDir(), ISSUE_CACHE_FILE), JSON.stringify({
  __accountId__: 'acc-1',
  'ATL-1': { issueId: 1, summary: 'One', fetchedAt: new Date().toISOString() },
  'ATL-2': { issueId: 2, summary: 'Two', fetchedAt: new Date().toISOString() },
}));

// ─── In-memory Tempo ─────────────────────────────────────────────────────

interface RawWorklog {
  tempoWorklogId: number;
  issue: { id: number };
  startDate: string;
  timeSpentSeconds: number;
  description?: string;
  attributes: { values: { key: string; value: string }[] };
}
const tempo = new Map<number, RawWorklog>();
let nextId = 500;
let approval = 'OPEN';
const calls: string[] = [];

function raw(id: number, issueId: number, date: string, seconds: number, description: string, activity: string): RawWorklog {
  return { tempoWorklogId: id, issue: { id: issueId }, startDate: date, timeSpentSeconds: seconds, description, attributes: { values: [{ key: '_Activity_', value: activity }] } };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.host !== 'api.tempo.io') throw new Error(`unexpected call ${method} ${url}`);
  calls.push(`${method} ${url.pathname}`);

  if (method === 'GET' && url.pathname.startsWith('/4/timesheet-approvals/user/')) {
    return json({ period: { from: FROM, to: TO }, requiredSeconds: 0, timeSpentSeconds: 0, status: { key: approval } });
  }
  if (method === 'GET' && url.pathname.startsWith('/4/worklogs/user/')) {
    const from = url.searchParams.get('from')!;
    const to = url.searchParams.get('to')!;
    const results = [...tempo.values()].filter(w => w.startDate >= from && w.startDate <= to);
    return json({ results, metadata: { count: results.length } });
  }
  const body = init?.body ? JSON.parse(String(init.body)) as { issueId: number; startDate: string; timeSpentSeconds: number; description?: string; attributes: { key: string; value: string }[] } : null;
  if (method === 'POST' && url.pathname === '/4/worklogs' && body) {
    if (body.description === 'refuse me') return json({ errors: [{ message: 'The issue is closed for time logging' }] }, 400);
    const w = raw(nextId++, body.issueId, body.startDate, body.timeSpentSeconds, body.description ?? '', body.attributes[0].value);
    tempo.set(w.tempoWorklogId, w);
    return json(w);
  }
  const match = url.pathname.match(/^\/4\/worklogs\/(\d+)$/);
  if (match && method === 'PUT' && body) {
    const w = raw(Number(match[1]), body.issueId, body.startDate, body.timeSpentSeconds, body.description ?? '', body.attributes[0].value);
    tempo.set(w.tempoWorklogId, w);
    return json(w);
  }
  if (match && method === 'DELETE') {
    tempo.delete(Number(match[1]));
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected call ${method} ${url}`);
}) as typeof fetch;

// ─── Fixture: three never-pushed entries, a colleague's worklog in Tempo ──

function entry(id: string, task: string, minutes: number, description: string, activity: string): ManualEntry {
  return { id, task, minutes, description, activity, createdAt: '2026-03-01T09:00:00.000Z' };
}
function day(date: string, entries: ManualEntry[]): void {
  const log = createEmptyLog(date, config);
  log.manualEntries.push(...entries);
  writeDailyLog(log);
}
day('2026-03-02', [entry('a', 'ATL-1', 60, 'Refund review', 'Other')]);
day('2026-03-03', [entry('b', 'ATL-1', 30, 'refuse me', 'Other')]);
day('2026-03-04', [entry('c', 'ATL-2', 30, 'Daily', 'Meeting')]);
savePushLog({});
saveTombstones([]);
tempo.set(400, raw(400, 2, '2026-03-05', 2700, 'Arch review', 'Meeting'));

let stops = 0;
const push = (over: { from?: string; to?: string; stopTracking?: boolean } = {}) => runPush({
  from: over.from ?? FROM, to: over.to ?? TO, commit: true, config, secrets,
  today: TODAY, live: null,
  ...(over.stopTracking ? { stopTracking: async () => { stops++; } } : {}),
});

console.log('Push — read first');

const first = await push({ stopTracking: true });

await test('a worklog created in Tempo without us is adopted and nothing is sent', () => {
  assert.equal(first.blockedByAdoption, true);
  assert.deepEqual(first.adopted?.map(a => a.date), ['2026-03-05']);
  assert.ok(!calls.some(c => c.startsWith('POST') || c.startsWith('PUT') || c.startsWith('DELETE')));
  assert.equal(readDailyLog('2026-03-05')!.manualEntries[0].description, 'Arch review');
});

await test('Stop tracking does not run when the read stops the push', () => {
  assert.equal(stops, 0);
});

console.log('\nPush — partial refusal');

const second = await push({ stopTracking: true });

await test('the next push goes out; Tempo\'s refusal comes back in its own words', () => {
  assert.equal(second.blockedByAdoption, undefined);
  assert.equal(second.result?.posted, 2);
  assert.equal(second.result?.failed, 1);
  assert.equal(second.failures?.length, 1);
  assert.equal(second.failures![0].date, '2026-03-03');
  assert.equal(second.failures![0].entryId, 'b');
  assert.equal(second.failures![0].reason, 'The issue is closed for time logging');
});

await test('Stop tracking ran once, after the gates', () => {
  assert.equal(stops, 1);
});

await test('each day seals on its own: the refused day stays open', () => {
  assert.equal(readDailyLog('2026-03-02')!.status, DayStatus.Pushed);
  assert.equal(readDailyLog('2026-03-04')!.status, DayStatus.Pushed);
  assert.equal(readDailyLog('2026-03-03')!.status, DayStatus.Draft);
});

console.log('\nPush — conflicts stop it');

await test('edited on both sides → nothing is sent', async () => {
  const key = pushLogKey('2026-03-02', 'ATL-1', 'a');
  const own = loadPushLog()[key];
  const w = tempo.get(own.tempoWorklogId)!;
  tempo.set(w.tempoWorklogId, { ...w, timeSpentSeconds: 5400 });           // Tempo: 60 → 90
  const log = readDailyLog('2026-03-02')!;
  log.manualEntries[0].minutes = 45;                                        // here: 60 → 45
  writeDailyLog(log);
  calls.length = 0;
  const r = await push({ stopTracking: true });
  assert.equal(r.blockedByConflicts, true);
  assert.ok(!calls.some(c => c.startsWith('POST') || c.startsWith('PUT') || c.startsWith('DELETE')));
  assert.equal(stops, 1);
});

await test('a one-day push elsewhere still goes (the gate looks at its own range)', async () => {
  const b = readDailyLog('2026-03-03')!;
  b.manualEntries[0].description = 'Refund rules';
  writeDailyLog(b);
  const r = await push({ from: '2026-03-03', to: '2026-03-03' });
  assert.equal(r.blockedByConflicts, undefined);
  assert.equal(r.result?.posted, 1);
  assert.equal(readDailyLog('2026-03-03')!.status, DayStatus.Pushed);
});

console.log('\nPush — closed months');

await test('a month that is not OPEN is refused before anything is read', async () => {
  approval = 'APPROVED';
  calls.length = 0;
  await assert.rejects(push(), /not open/);
  assert.ok(!calls.some(c => c.includes('/4/worklogs')));
  approval = 'OPEN';
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
