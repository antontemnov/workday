/**
 * E2E: the closed-month lock, end to end. The repo's daemon runs in-process
 * on a throwaway home, watching a real git repo on a task branch; Tempo and
 * Jira are faked inside the process (nothing leaves the machine). Work is
 * real file edits, the tray is plain HTTP calls to the daemon.
 *
 *   1. Tracking works; the day is pushed.
 *   2. The timesheet is submitted on the site right after the push: the
 *      post-push watch sees it with no user action, the running session ends
 *      at the submit moment, the Day data says monthClosed, edits and pushes
 *      are refused, further work tracks nothing and asks Tempo nothing.
 *   3. The lead sends it back (REJECTED): the status tag (fresh read)
 *      unlocks, tracking and edits come back.
 *   4. Submitted again: the cached status still says REJECTED, a Fetch reads
 *      it fresh and locks at once; the session born after the submit is gone,
 *      the one stopped before it stays.
 *   5. Sent back, a quiet stretch, then submitted once more: an add does not
 *      wait on the stale OPEN (Tempo answers slowly here) — the read behind
 *      it locks the month and cuts the add. In the submit window the add
 *      waits and is refused instead.
 *
 * Run: npx tsx tests/integration/closed-month-e2e.test.ts  (~1 min: real poll ticks)
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import { TEST_HOME } from '../helpers/test-home.js';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inSubmissionWindow } from '../../src/core/month-lock.js';
import type { AppConfig } from '../../src/core/types.js';

const PORT = 9377;
const POLL_SECONDS = 6;
const REPO = join(TEST_HOME, 'repo');
const BRANCH = 'atemnov/ATL-1-e2e';

process.env.GIT_CONFIG_GLOBAL = join(TEST_HOME, 'gitconfig');
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

let passed = 0;
let failed = 0;

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${label}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${(err as Error).message}`);
  }
}

// ─── Home, repo ───────────────────────────────────────────────────────────

mkdirSync(join(TEST_HOME, 'data'), { recursive: true });
writeFileSync(join(TEST_HOME, 'config.json'), JSON.stringify({
  repos: [REPO],
  boundaryHour: 4,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: ['atemnov'] },
  genericBranches: ['master'],
  session: { diffPollSeconds: POLL_SECONDS, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  apiPort: PORT,
  sensitivity: { default: 'normal' },
}, null, 2));
writeFileSync(join(TEST_HOME, 'secrets.json'), JSON.stringify({
  Jira_Email: 'e2e@example.test', Jira_BaseUrl: 'https://e2e.atlassian.net', Jira_Token: 't', Tempo_Token: 't',
}));
writeFileSync(join(TEST_HOME, 'data', 'issue-cache.json'), JSON.stringify({ __accountId__: 'acc-e2e' }));

const git = (args: string): string => execSync(`git -C "${REPO}" ${args}`, { encoding: 'utf-8', windowsHide: true }).trim();
mkdirSync(REPO, { recursive: true });
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = E2E\n\temail = e2e@example.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n');
git('init');
writeFileSync(join(REPO, 'base.txt'), 'line\n'.repeat(10));
git('add .');
git('commit -m init');
git(`checkout -b ${BRANCH}`);
writeFileSync(join(REPO, 'work.txt'), 'start\n');
git('add .');
git('commit -m start');

let edits = 0;
function work(): void {
  appendFileSync(join(REPO, 'work.txt'), `change ${++edits}\n`.repeat(8));
}

// ─── Fake Tempo + Jira ────────────────────────────────────────────────────

interface RawWorklog {
  tempoWorklogId: number;
  issue: { id: number };
  startDate: string;
  timeSpentSeconds: number;
  description?: string;
  updatedAt: string;
  attributes: { values: { key: string; value: string }[] };
}

const worklogs = new Map<number, RawWorklog>();
let nextWorklogId = 1000;
const approval: Record<string, { key: string; updatedAt?: string }> = {};
let approvalReads = 0;
let approvalDelayMs = 0;
const ISSUE_ID = 4242;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

async function fakeTempo(url: URL, method: string, init?: RequestInit): Promise<Response> {
  const p = url.pathname;
  if (method === 'GET' && p.startsWith('/4/worklogs/user/')) {
    const from = url.searchParams.get('from')!;
    const to = url.searchParams.get('to')!;
    const all = [...worklogs.values()].filter(w => w.startDate >= from && w.startDate <= to);
    return json({ results: all, metadata: { count: all.length } });
  }
  if (method === 'GET' && p.startsWith('/4/timesheet-approvals/user/')) {
    approvalReads++;
    if (approvalDelayMs > 0) await sleep(approvalDelayMs);
    const month = url.searchParams.get('from')!.slice(0, 7);
    return json({
      period: { from: `${month}-01`, to: monthEnd(month) }, requiredSeconds: 0, timeSpentSeconds: 0,
      status: approval[month] ?? { key: 'OPEN' },
    });
  }
  if (method === 'GET' && p === '/4/work-attributes') {
    return json({ results: [{ key: '_Activity_', name: 'Activity', type: 'STATIC_LIST', values: ['Development', 'Other'], names: { Development: 'Development', Other: 'Other' } }] });
  }
  if (method === 'GET' && p === '/4/user-schedule') return json({ results: [] });
  const body = init?.body ? JSON.parse(String(init.body)) as { issueId: number; startDate: string; timeSpentSeconds: number; description?: string; attributes?: { key: string; value: string }[] } : null;
  const activity = body?.attributes?.find(a => a.key === '_Activity_')?.value ?? 'Development';
  const make = (id: number): RawWorklog => ({
    tempoWorklogId: id, issue: { id: body!.issueId }, startDate: body!.startDate, timeSpentSeconds: body!.timeSpentSeconds,
    ...(body!.description !== undefined ? { description: body!.description } : {}),
    updatedAt: new Date().toISOString(), attributes: { values: [{ key: '_Activity_', value: activity }] },
  });
  if (method === 'POST' && p === '/4/worklogs' && body) {
    const w = make(nextWorklogId++);
    worklogs.set(w.tempoWorklogId, w);
    return json(w);
  }
  const id = Number(p.match(/^\/4\/worklogs\/(\d+)$/)?.[1]);
  if (id && method === 'PUT' && body) {
    worklogs.set(id, make(id));
    return json(worklogs.get(id));
  }
  if (id && method === 'DELETE') {
    worklogs.delete(id);
    return new Response(null, { status: 204 });
  }
  return json({ errors: [{ message: `e2e: unexpected ${method} ${p}` }] }, 404);
}

function fakeJira(url: URL): Response {
  const p = url.pathname;
  if (p === '/rest/api/3/myself') return json({ accountId: 'acc-e2e' });
  if (/^\/rest\/api\/3\/issue\/[^/]+$/.test(p)) return json({ id: String(ISSUE_ID), key: 'ATL-1', fields: { summary: 'E2E ticket' } });
  return json({ errorMessages: [`e2e: unexpected ${p}`] }, 404);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.host === 'api.tempo.io') return fakeTempo(url, method, init);
  if (url.host === 'e2e.atlassian.net') return fakeJira(url);
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  throw new TypeError(`fetch failed (e2e is offline: ${url.host})`);
}) as typeof fetch;

// ─── Daemon + the tray's calls ────────────────────────────────────────────

interface ApiResult<T> { ok: boolean; data?: T; error?: string }
interface Session { id: string; closedBy: string | null; activatedAt: string | null; lastSeenAt: string }
interface Today { date: string; monthClosed?: boolean; sessions: Session[]; manualEntries: { id: string; minutes: number }[]; signalCount: number }
interface Approval { statusKey: string | null; closed: boolean; closedAt?: string | null }

async function api<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await realFetch(`http://127.0.0.1:${PORT}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return await res.json() as ApiResult<T>;
}

const today = async (): Promise<Today> => (await api<Today>('/api/today')).data!;
const realSessions = (t: Today): Session[] => t.sessions.filter(s => !s.id.startsWith('watch:') && s.activatedAt !== null);
const openSessions = (t: Today): Session[] => realSessions(t).filter(s => s.closedBy === null);

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 300));
  }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const TICK_MS = POLL_SECONDS * 1000;

// A quiet stretch: the month's cached status grows older than its TTL.
function ageApprovalCache(month: string, ageMs: number): void {
  const path = join(TEST_HOME, 'data', 'approval-cache.json');
  const cache = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { fetchedAt: string }>;
  cache[month] = { ...cache[month], fetchedAt: new Date(Date.now() - ageMs).toISOString() };
  writeFileSync(path, JSON.stringify(cache, null, 2));
}

// Tempo reports the submit to the second: the "submit" lands on the next
// whole second, after everything done so far.
async function submitMoment(): Promise<string> {
  const next = Math.ceil((Date.now() + 1) / 1000) * 1000;
  await sleep(next - Date.now() + 50);
  return new Date(next).toISOString().replace('.000Z', 'Z');
}

const { Daemon } = await import('../../src/daemon.js');
await new Daemon().start();

try {
  const day = (await today()).date;
  const month = day.slice(0, 7);
  const [year, monthNo] = month.split('-').map(Number);

  // ─── 1. Tracking, push ──────────────────────────────────────────────────
  console.log('1. Open month: tracking, push');

  work();
  const first = await waitFor('a session from real edits', async () => openSessions(await today())[0], 3 * TICK_MS);
  const entry = await api<{ id: string }>('/api/manual-entry', { task: 'ATL-1', minutes: 30, description: 'planning', activity: 'Other' });
  await check('an entry can be logged while the month is open', () => assert.equal(entry.ok, true, entry.error));
  const push = await api<unknown>('/api/push', { from: day, to: day });
  await check('the day goes to Tempo', () => {
    assert.equal(push.ok, true, push.error);
    assert.ok(worklogs.size >= 2, `worklogs in Tempo: ${worklogs.size}`);
  });

  // ─── 2. Submitted on the site right after the push ──────────────────────
  console.log('\n2. Submitted on the site: the post-push watch locks the month');

  const submitAt = await submitMoment();
  approval[month] = { key: 'IN_REVIEW', updatedAt: submitAt };
  work();
  const locked = await waitFor('the lock after the submit', async () => { const t = await today(); return t.monthClosed ? t : null; }, 3 * TICK_MS);

  await check('Day data says monthClosed; nothing runs', () => {
    assert.equal(locked.monthClosed, true);
    assert.deepEqual(openSessions(locked), []);
  });
  await check('the running session ended at the submit moment', () => {
    const s = realSessions(locked).find(x => x.id === first.id);
    assert.ok(s, 'the session is kept (it began before the submit)');
    assert.equal(s.closedBy, 'month_closed');
    assert.ok(Date.parse(s.lastSeenAt) <= Date.parse(submitAt), `${s.lastSeenAt} > ${submitAt}`);
  });
  await check('edits and adds are refused', async () => {
    const edit = await api('/api/manual-entry/update', { target: entry.data!.id, minutes: 45 });
    const add = await api('/api/manual-entry', { task: 'ATL-1', minutes: 15, description: 'late', activity: 'Other' });
    assert.equal(edit.ok, false);
    assert.match(edit.error ?? '', /IN_REVIEW/);
    assert.equal(add.ok, false);
  });
  await check('a push is refused', async () => {
    const again = await api('/api/push', { from: day, to: day });
    assert.equal(again.ok, false);
    assert.match(again.error ?? '', /IN_REVIEW/);
  });

  const signalsBefore = locked.signalCount;
  const readsBefore = approvalReads;
  work();
  await sleep(2 * TICK_MS + 500);
  const quiet = await today();
  await check('further work tracks nothing and asks Tempo nothing', () => {
    assert.deepEqual(openSessions(quiet), []);
    assert.equal(quiet.signalCount, signalsBefore);
    assert.equal(approvalReads, readsBefore);
  });

  // ─── 3. Sent back ───────────────────────────────────────────────────────
  console.log('\n3. REJECTED: the status tag unlocks');

  approval[month] = { key: 'REJECTED' };
  const tag = await api<Approval>(`/api/tempo/approval?year=${year}&month=${monthNo}&fresh=1`);
  await check('the status tag reads REJECTED at once', () => assert.equal(tag.data?.statusKey, 'REJECTED'));
  await waitFor('the unlock', async () => (await today()).monthClosed === false, 2 * TICK_MS);
  await sleep(2000); // the unlocking tick is still polling git — edit after it
  work();
  const reborn = await waitFor('a session again', async () => openSessions(await today())[0], 3 * TICK_MS);
  const edit = await api('/api/manual-entry/update', { target: entry.data!.id, minutes: 45 });
  await check('tracking and edits are back', () => {
    assert.ok(reborn.id !== first.id);
    assert.equal(edit.ok, true, edit.error);
  });

  // ─── 4. Submitted again, seen by a Fetch ────────────────────────────────
  console.log('\n4. Submitted again: a Fetch locks at once and cuts the tail');

  const stop = await api('/api/session/stop', { target: reborn.id });
  assert.equal(stop.ok, true, stop.error);
  const resubmitAt = await submitMoment();
  approval[month] = { key: 'IN_REVIEW', updatedAt: resubmitAt };
  work();
  const tail = await waitFor('a session after the submit', async () => openSessions(await today())[0], 3 * TICK_MS);

  const cached = await api<Approval>(`/api/tempo/approval?year=${year}&month=${monthNo}`);
  await check('the cached status still says REJECTED', () => assert.equal(cached.data?.statusKey, 'REJECTED'));

  const fetchedAt = Date.now();
  const sync = await api<{ skipped?: string }>('/api/tempo-sync', { year, month: monthNo });
  const relocked = await waitFor('the lock after the Fetch', async () => { const t = await today(); return t.monthClosed ? t : null; }, 2 * TICK_MS);
  const lockMs = Date.now() - fetchedAt;
  await check(`the Fetch reads it fresh and locks at once (${lockMs} ms, poll ${TICK_MS} ms)`, () => {
    assert.equal(sync.data?.skipped, 'closed');
    assert.ok(lockMs < 2500, `${lockMs} ms`);
  });
  await check('the session born after the submit is gone, the one stopped before it stays', () => {
    const ids = realSessions(relocked).map(s => s.id);
    assert.equal(ids.includes(tail.id), false);
    assert.equal(ids.includes(reborn.id), true);
  });
  const status = await api<Approval>(`/api/tempo/approval?year=${year}&month=${monthNo}`);
  await check('the status now says IN_REVIEW with its moment', () => {
    assert.equal(status.data?.statusKey, 'IN_REVIEW');
    assert.equal(status.data?.closedAt, resubmitAt);
  });

  // ─── 5. Submitted mid-month, an add on its way ──────────────────────────
  const midMonth = !inSubmissionWindow(day, { workDays: [1, 2, 3, 4, 5, 6, 7], holidays: [] } as unknown as AppConfig);
  console.log(`\n5. An add after a quiet stretch (${midMonth ? 'mid-month' : 'submit window'})`);

  approval[month] = { key: 'REJECTED' };
  await api<Approval>(`/api/tempo/approval?year=${year}&month=${monthNo}&fresh=1`);
  await waitFor('the unlock', async () => (await today()).monthClosed === false, 2 * TICK_MS);
  ageApprovalCache(month, 20 * 60_000);
  const lateSubmitAt = await submitMoment();
  approval[month] = { key: 'IN_REVIEW', updatedAt: lateSubmitAt };
  approvalDelayMs = 1500;
  const readsBefore5 = approvalReads;
  const addStart = Date.now();
  const late = await api<{ id: string }>('/api/manual-entry', { task: 'ATL-1', minutes: 15, description: 'after the submit', activity: 'Other' });
  const addMs = Date.now() - addStart;

  if (midMonth) {
    await check(`the add answers at once by the cached OPEN (${addMs} ms, Tempo takes ${approvalDelayMs} ms)`, () => {
      assert.equal(late.ok, true, late.error);
      assert.ok(addMs < approvalDelayMs, `${addMs} ms`);
    });
    const cut = await waitFor('the lock from the read behind the add', async () => { const t = await today(); return t.monthClosed ? t : null; }, 2 * TICK_MS);
    await check('the read behind it locks the month and cuts the add; the earlier entry stays', () => {
      assert.equal(approvalReads, readsBefore5 + 1);
      const ids = cut.manualEntries.map(e => e.id);
      assert.equal(ids.includes(late.data!.id), false);
      assert.equal(ids.includes(entry.data!.id), true);
    });
  } else {
    await check('the add waits for Tempo and is refused', () => {
      assert.equal(late.ok, false);
      assert.match(late.error ?? '', /IN_REVIEW/);
    });
  }
  approvalDelayMs = 0;
} catch (err) {
  failed++;
  console.error(`  FAIL ${(err as Error).message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
try { rmSync(REPO, { recursive: true, force: true }); } catch { /* git may still hold it on Windows */ }
process.exit(failed > 0 ? 1 : 0);
