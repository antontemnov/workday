/**
 * E2E: manual timers, end to end. The repo's daemon runs in-process on a
 * throwaway home and a spare port, watching a real git repo; Jira is faked
 * inside the process (nothing leaves the machine). The tray is plain HTTP
 * calls, the CLI is the real `workday timer` run against the same daemon.
 *
 *   1. New timer: it counts, the Day data carries the island.
 *   2. One real edit in the repo does not take the count from it.
 *   3. task? → Log: the timer gets its ticket and goes on running.
 *   4. Pause / start; the text of a timer with a ticket is its entry's
 *      description; Remove timer is refused while nothing is typed by hand
 *      and passes after a number was typed; Remove in the island takes a
 *      ticketed timer out of its entry, or the entry grown from it alone.
 *   5. The CLI drives the same timers.
 *   6. An observation gap (sleep): the timer is cut and goes on by itself.
 *   7. The day rolls over: the timer without a ticket stays in the old
 *      day's file as unlinked time, the island is empty.
 *   8. The daemon stopped by hand: live timers are on pause in the file.
 *
 * Run: npx tsx tests/integration/timer-e2e.test.ts  (~40 s: real poll ticks, CLI spawns)
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import { TEST_HOME } from '../helpers/test-home.js';
import assert from 'node:assert/strict';
import { exec, execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const PORT = 9378;
const POLL_SECONDS = 6;
const REPO = join(TEST_HOME, 'repo');
const BRANCH = 'atemnov/ATL-1-e2e';
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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
  calendar: { enabled: false, hidePrivate: false },
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

// ─── Offline: Jira answers from here, Tempo says the month is open ────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.host === 'e2e.atlassian.net') {
    if (url.pathname === '/rest/api/3/myself') return json({ accountId: 'acc-e2e' });
    if (/^\/rest\/api\/3\/issue\/[^/]+$/.test(url.pathname)) return json({ id: '4242', key: 'ATL-1', fields: { summary: 'E2E ticket' } });
    return json({ errorMessages: [`e2e: unexpected ${url.pathname}`] }, 404);
  }
  if (url.host === 'api.tempo.io' && url.pathname.startsWith('/4/timesheet-approvals/user/')) {
    const month = url.searchParams.get('from')!.slice(0, 7);
    return json({ period: { from: `${month}-01`, to: `${month}-28` }, requiredSeconds: 0, timeSpentSeconds: 0, status: { key: 'OPEN' } });
  }
  throw new TypeError(`fetch failed (e2e is offline: ${url.host})`);
}) as typeof fetch;

// ─── The tray's calls, the CLI, the day's file ────────────────────────────

interface ApiResult<T> { ok: boolean; data?: T; error?: string }
interface TimerRow { id: string; state: string; entryId: string | null; task: string | null; description: string; totalMs: number; shareMs: number; handMinutes: number }
interface Timers { date: string; counting: string; desktopWidget: boolean; timers: TimerRow[]; timerId?: string | null; entry?: { id: string; minutes: number; task: string }; removedMinutes?: number }
interface Today { date: string; manualEntries: { id: string; minutes: number; task: string; description: string }[]; timers?: Timers }
interface StoredTimer { id: string; entryId: string | null; state: string; description: string; spans: { from: string; to: string | null }[] }
interface StoredDay { timers?: StoredTimer[]; manualEntries: { id: string; minutes: number }[] }

async function api<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await realFetch(`http://127.0.0.1:${PORT}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return await res.json() as ApiResult<T>;
}

const timer = async (action: string, body: unknown = {}): Promise<ApiResult<Timers>> => api<Timers>(`/api/timer/${action}`, body);
const timers = async (): Promise<Timers> => (await api<Timers>('/api/timers')).data!;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const TICK_MS = POLL_SECONDS * 1000;

const run = promisify(exec);
async function cli(args: string): Promise<string> {
  const { stdout } = await run(`npx tsx src/cli.ts ${args}`, {
    cwd: PROJECT_ROOT, env: { ...process.env, WORKDAY_HOME: TEST_HOME }, windowsHide: true,
  });
  return stdout;
}

function storedDay(date: string): StoredDay {
  const [year, month, day] = date.split('-');
  return JSON.parse(readFileSync(join(TEST_HOME, 'data', `${year}-${month}`, `${month}-${day}.json`), 'utf-8')) as StoredDay;
}

const { Daemon } = await import('../../src/daemon.js');
const daemon = new Daemon();
await daemon.start();

try {
  // ─── 1. New timer ───────────────────────────────────────────────────────
  console.log('1. New timer');

  const created = await timer('new', { description: 'deploy of the release' });
  const firstId = created.data?.timerId ?? '';
  await check('a new timer counts at once', () => {
    assert.equal(created.ok, true, created.error);
    assert.equal(created.data!.timers.length, 1);
    assert.equal(created.data!.timers[0].state, 'running');
    assert.equal(created.data!.timers[0].task, null);
    assert.equal(created.data!.counting, 'timer');
    assert.equal(created.data!.desktopWidget, true);
  });
  const day = created.data!.date;
  await check('the Day data carries the island; the day is on disk', async () => {
    const today = (await api<Today>('/api/today')).data!;
    assert.equal(today.timers?.timers[0].id, firstId);
    assert.equal(storedDay(day).timers?.[0].id, firstId);
  });

  // ─── 2. One edit does not take the count ────────────────────────────────
  console.log('\n2. One real edit in the repo');

  appendFileSync(join(REPO, 'work.txt'), 'change\n'.repeat(8));
  await sleep(2 * TICK_MS + 500);
  await check('the count stays with the timer', async () => {
    const now = await timers();
    assert.equal(now.counting, 'timer');
    assert.equal(now.timers[0].state, 'running');
    assert.ok(now.timers[0].totalMs >= 2 * TICK_MS, `${now.timers[0].totalMs} ms`);
  });

  // ─── 3. task? → Log ─────────────────────────────────────────────────────
  console.log('\n3. task? → Log');

  const bound = await timer('bind', { id: firstId, task: 'ATL-1', activity: 'Other', description: 'deploy of the release' });
  await check('the timer gets its ticket, keeps its id and goes on running', () => {
    assert.equal(bound.ok, true, bound.error);
    assert.equal(bound.data!.timerId, firstId);
    assert.equal(bound.data!.entry?.task, 'ATL-1');
    const row = bound.data!.timers[0];
    assert.equal(row.state, 'running');
    assert.equal(row.task, 'ATL-1');
    assert.equal(row.entryId, bound.data!.entry?.id);
    assert.equal(row.handMinutes, 0);
  });
  const entryId = bound.data!.entry!.id;
  await check('a malformed ticket key is refused before anything changes', async () => {
    const stray = await timer('new', { description: 'stray' });
    const refused = await timer('bind', { id: stray.data!.timerId, task: 'nope', activity: 'Other', description: 'x' });
    assert.equal(refused.ok, false);
    await timer('delete', { id: stray.data!.timerId });
    assert.equal((await timers()).timers.length, 1);
  });

  // ─── 4. Pause, start, Remove timer ──────────────────────────────────────
  console.log('\n4. Pause, start, Remove timer');

  await check('the deleted stray left the first timer on pause; start runs it again', async () => {
    assert.equal((await timers()).timers[0].state, 'paused');
    const started = await timer('start', { id: firstId });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.data!.timers[0].state, 'running');
    const paused = await timer('pause');
    assert.equal(paused.data!.timers[0].state, 'paused');
    assert.notEqual(paused.data!.counting, 'timer');
    assert.equal((await timer('start', { entry: entryId })).data!.timers[0].state, 'running');
  });
  await check('the text of a timer with a ticket is its entry\'s description', async () => {
    const described = await timer('describe', { id: firstId, description: 'deploy, second try' });
    assert.equal(described.ok, true, described.error);
    assert.equal(described.data!.timerId, firstId);
    assert.equal(described.data!.entry?.id, entryId);
    assert.equal(described.data!.timers[0].description, 'deploy, second try');
    const today = (await api<Today>('/api/today')).data!;
    assert.deepEqual(today.manualEntries.map(e => e.description), ['deploy, second try']);
    const emptied = await timer('describe', { id: firstId, description: '  ' });
    assert.equal(emptied.ok, false);
    assert.match(emptied.error ?? '', /cannot be empty/);
  });
  await check('Remove timer is refused while nothing is typed by hand', async () => {
    const refused = await timer('remove', { entry: entryId });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /Nothing typed by hand/);
  });
  await check('after the time is set by hand the timer leaves and the number stays', async () => {
    const edited = await api<{ minutes: number }>('/api/manual-entry/update', { target: entryId, minutes: 25 });
    assert.equal(edited.ok, true, edited.error);
    const removed = await timer('remove', { entry: entryId });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(removed.data!.removedMinutes, 0);
    assert.equal(removed.data!.entry?.minutes, 25);
    assert.equal(removed.data!.timers.length, 0);
    assert.equal(storedDay(day).timers, undefined);
  });
  await check('Remove in the island: a ticketed timer goes, the typed number stays', async () => {
    const started = await timer('start', { entry: entryId });
    assert.equal(started.ok, true, started.error);
    const removed = await timer('delete', { id: started.data!.timerId });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(removed.data!.entry?.minutes, 25);
    assert.equal(removed.data!.timers.length, 0);
    assert.notEqual(removed.data!.counting, 'timer');
  });
  await check('Remove in the island: an entry grown from the timer alone goes with it', async () => {
    const fresh = await timer('new', { description: 'retro' });
    const grown = await timer('bind', { id: fresh.data!.timerId, task: 'ATL-1', activity: 'Other', description: 'retro' });
    assert.equal(grown.ok, true, grown.error);
    assert.equal((await api<Today>('/api/today')).data!.manualEntries.length, 2);
    const removed = await timer('delete', { id: grown.data!.timerId });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(removed.data!.entry, undefined);
    assert.equal(removed.data!.timers.length, 0);
    const today = (await api<Today>('/api/today')).data!;
    assert.deepEqual(today.manualEntries.map(e => e.id), [entryId]);
    assert.equal(storedDay(day).timers, undefined);
  });

  // ─── 5. The CLI ─────────────────────────────────────────────────────────
  console.log('\n5. The CLI drives the same timers');

  await check('workday timer new / timer / timer pause', async () => {
    assert.match(await cli('timer'), /No timers/);
    assert.match(await cli('timer new "helped the ops team"'), /Timer started[\s\S]*#1 [0-9a-f]{8}\s+▶ running[\s\S]*"helped the ops team"/);
    assert.match(await cli('timer'), /a timer counts/);
    assert.match(await cli('timer pause'), /Timer paused[\s\S]*⏸ paused/);
    assert.match(await cli('timer start #1'), /Timer started/);
    assert.match(await cli('timer widget off'), /Desktop widget: off/);
    assert.equal((await timers()).desktopWidget, false);
  });
  const looseId = (await timers()).timers[0].id;

  // ─── 6. An observation gap ──────────────────────────────────────────────
  console.log('\n6. Sleep: an observation gap');

  await check('the timer is cut at the gap and goes on by itself', async () => {
    const before = storedDay(day).timers![0].spans.length;
    (daemon as unknown as { lastAliveAt: number }).lastAliveAt = Date.now() - 10 * 60_000;
    await daemon.pollTick();
    const now = await timers();
    assert.equal(now.timers[0].state, 'running');
    assert.equal(storedDay(day).timers![0].spans.length, before + 1);
  });

  // ─── 7. The day rolls over ──────────────────────────────────────────────
  console.log('\n7. The day rolls over');

  // A timezone far enough to put "now" on another working date.
  const dayClock = new Date(Date.now() - 4 * 3_600_000).getUTCHours();
  const farZone = dayClock >= 10 ? 'Pacific/Kiritimati' : 'Etc/GMT+12';
  const moved = await api<unknown>('/api/settings', { config: { timezone: farZone } });
  await check('the island is empty on the new day', async () => {
    assert.equal(moved.ok, true, moved.error);
    const now = await timers();
    assert.notEqual(now.date, day);
    assert.equal(now.timers.length, 0);
    assert.equal(now.counting, 'none');
  });
  await check('the timer without a ticket stays in its day as unlinked time', () => {
    const old = storedDay(day);
    assert.equal(old.timers?.length, 1);
    const unlinked = old.timers![0];
    assert.equal(unlinked.id, looseId);
    assert.equal(unlinked.entryId, null);
    assert.equal(unlinked.description, 'helped the ops team');
    assert.equal(unlinked.state, 'paused');
    assert.equal(unlinked.spans.every(span => span.to !== null), true);
    assert.equal(old.manualEntries.length, 1, 'the entry of the old day is untouched');
  });

  // ─── 8. The daemon stopped by hand ──────────────────────────────────────
  console.log('\n8. The daemon stopped by hand');

  const last = await timer('new', { description: 'running at the stop' });
  const newDay = last.data!.date;
  await daemon.stop();
  await check('a live timer is on pause in the file', () => {
    const stored = storedDay(newDay).timers!;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].state, 'paused');
    assert.equal(stored[0].spans.every(span => span.to !== null), true);
  });
} catch (err) {
  failed++;
  console.error(`  FAIL ${(err as Error).message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
try { rmSync(REPO, { recursive: true, force: true }); } catch { /* git may still hold it on Windows */ }
process.exit(failed > 0 ? 1 : 0);
