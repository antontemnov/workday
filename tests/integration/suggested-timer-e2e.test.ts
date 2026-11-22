/**
 * E2E: suggested timers, end to end. The repo's daemon runs in-process on a
 * throwaway home and a spare port, watching a real git repo; the calendar is
 * a cache file with meetings that are on right now, Jira is faked inside the
 * process (nothing leaves the machine). The tray is plain HTTP calls, the CLI
 * is the real `workday` run against the same daemon.
 *
 *   1. Switched off (the default): ongoing rows offer no timer, the action
 *      is refused, nothing else changes.
 *   2. Calendar events switched on from the CLI: ongoing meetings offer a
 *      timer, a finished one does not.
 *   3. A meeting with a ticket: a record with no minutes and a timer running
 *      on it; the row leaves the suggestions.
 *   4. A meeting without a ticket: a running timer without one, named after
 *      the meeting; the timer before it goes on pause.
 *   5. Remove on both timers: the suggestions do not come back.
 *   6. A review: ongoing while its branch is checked out, its own switch,
 *      taken by a timer from the CLI.
 *
 * Run: npx tsx tests/integration/suggested-timer-e2e.test.ts  (~30 s: CLI spawns)
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import { TEST_HOME } from '../helpers/test-home.js';
import assert from 'node:assert/strict';
import { exec, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { computeWorkingDate } from '../../src/core/config.js';
import { CALENDAR_CACHE_FILE, MEETING_ASSOCIATIONS_FILE } from '../../src/core/constants.js';

const PORT = 9379;
const BOUNDARY_HOUR = 4;
const REPO = join(TEST_HOME, 'repo');
const OWN_BRANCH = 'atemnov/ATL-1-e2e';
const REVIEW_BRANCH = 'ATL-2-colleague-fix';
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MINUTE = 60_000;

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

// ─── Home: config, calendar, what the meetings resolve to ─────────────────

const DAY = computeWorkingDate(Date.now(), BOUNDARY_HOUR, 'UTC');
const at = (minutesFromNow: number): string => new Date(Date.now() + minutesFromNow * MINUTE).toISOString();

mkdirSync(join(TEST_HOME, 'data'), { recursive: true });
writeFileSync(join(TEST_HOME, 'config.json'), JSON.stringify({
  repos: [REPO],
  boundaryHour: BOUNDARY_HOUR,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: ['atemnov'] },
  genericBranches: ['master'],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  apiPort: PORT,
  sensitivity: { default: 'normal' },
  calendar: { enabled: true, hidePrivate: false },
}, null, 2));
writeFileSync(join(TEST_HOME, 'secrets.json'), JSON.stringify({
  Jira_Email: 'e2e@example.test', Jira_BaseUrl: 'https://e2e.atlassian.net', Jira_Token: 't', Tempo_Token: 't',
  Calendar_IcsUrl: 'https://calendar.e2e.test/feed.ics',
}));
writeFileSync(join(TEST_HOME, 'data', 'issue-cache.json'), JSON.stringify({ __accountId__: 'acc-e2e' }));

const meeting = (uid: string, title: string, startMin: number, endMin: number): Record<string, unknown> => ({
  uid, date: DAY, start: at(startMin), end: at(endMin), title,
  busyStatus: 'BUSY', allDay: false, cancelled: false, recurring: false,
});
writeFileSync(join(TEST_HOME, 'data', CALENDAR_CACHE_FILE), JSON.stringify({
  fetchedAt: at(-5),
  instances: [
    meeting('ev-past', 'Daily standup', -120, -105),
    meeting('ev-known', 'Sprint planning', -10, 50),
    meeting('ev-unknown', 'Sync with the platform team', -5, 25),
  ],
}));
// "Sprint planning" was logged before: the series knows its ticket.
writeFileSync(join(TEST_HOME, 'data', MEETING_ASSOCIATIONS_FILE), JSON.stringify({
  series: { 'ev-known': { task: 'ATL-1', activity: 'Other', titleKey: 'planning sprint', uses: 1, lastUsedAt: at(-24 * 60) } },
  muted: {},
}));

// ─── Repo: an own branch and a colleague's ────────────────────────────────

const git = (args: string): string => execSync(`git -C "${REPO}" ${args}`, { encoding: 'utf-8', windowsHide: true }).trim();
mkdirSync(REPO, { recursive: true });
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '[user]\n\tname = E2E\n\temail = e2e@example.test\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n');
git('init');
writeFileSync(join(REPO, 'base.txt'), 'line\n'.repeat(10));
git('add .');
git('commit -m init');
git(`branch ${REVIEW_BRANCH}`);
git(`checkout -b ${OWN_BRANCH}`);

// ─── Offline: Jira answers from here, Tempo says the month is open ────────

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '127.0.0.1') return realFetch(input, init);
  if (url.host === 'e2e.atlassian.net') {
    if (url.pathname === '/rest/api/3/myself') return json({ accountId: 'acc-e2e' });
    const issue = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(url.pathname);
    if (issue) return json({ id: '4242', key: issue[1], fields: { summary: 'E2E ticket' } });
    return json({ errorMessages: [`e2e: unexpected ${url.pathname}`] }, 404);
  }
  if (url.host === 'api.tempo.io' && url.pathname.startsWith('/4/timesheet-approvals/user/')) {
    const month = url.searchParams.get('from')!.slice(0, 7);
    return json({ period: { from: `${month}-01`, to: `${month}-28` }, requiredSeconds: 0, timeSpentSeconds: 0, status: { key: 'OPEN' } });
  }
  // The feed is down: the daemon keeps the cache it has.
  if (url.host === 'calendar.e2e.test') return new Response('', { status: 503 });
  throw new TypeError(`fetch failed (e2e is offline: ${url.host})`);
}) as typeof fetch;

// ─── The tray's calls, the CLI, the day's file ────────────────────────────

interface ApiResult<T> { ok: boolean; data?: T; error?: string }
interface Row { uid: string; source: string; ongoing: boolean; suggestedTimer?: boolean; resolved?: { task: string } }
interface Day { date: string; suggestions: Row[] }
interface TimerRow { id: string; state: string; entryId: string | null; task: string | null; description: string; handMinutes: number }
interface Entry { id: string; task: string; minutes: number; activity: string; description: string }
interface Timers { date: string; counting: string; timers: TimerRow[]; timerId?: string | null; entry?: Entry }
interface Taken extends Timers { day: Day }
interface Today { manualEntries: Entry[] }
interface Settings { config: { timer: { desktopWidget: boolean; suggested: { meeting: boolean; review: boolean } } } }
interface StoredDay { manualEntries: { id: string; minutes: number; sourceRef?: string }[] }

async function api<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const res = await realFetch(`http://127.0.0.1:${PORT}${path}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return await res.json() as ApiResult<T>;
}

const suggestions = async (): Promise<Row[]> => (await api<Day>('/api/suggestions')).data!.suggestions;
const row = async (uid: string): Promise<Row | undefined> => (await suggestions()).find(s => s.uid === uid);
const take = async (uid: string): Promise<ApiResult<Taken>> => api<Taken>('/api/suggestions/timer', { uid, date: DAY });
const timers = async (): Promise<Timers> => (await api<Timers>('/api/timers')).data!;
const today = async (): Promise<Today> => (await api<Today>('/api/today')).data!;

const run = promisify(exec);
async function cli(args: string): Promise<string> {
  const { stdout } = await run(`npx tsx src/cli.ts ${args}`, {
    cwd: PROJECT_ROOT, env: { ...process.env, WORKDAY_HOME: TEST_HOME }, windowsHide: true,
  });
  return stdout;
}

function storedDay(): StoredDay {
  const [year, month, day] = DAY.split('-');
  return JSON.parse(readFileSync(join(TEST_HOME, 'data', `${year}-${month}`, `${month}-${day}.json`), 'utf-8')) as StoredDay;
}

const { Daemon } = await import('../../src/daemon.js');
const daemon = new Daemon();
await daemon.start();

// The repo moved to another branch: the daemon sees it on its next poll.
async function checkout(branch: string): Promise<void> {
  git(`checkout ${branch}`);
  await daemon.pollTick();
}

try {
  // ─── 1. Switched off ────────────────────────────────────────────────────
  console.log('1. Switched off (the default)');

  await check('both switches are off', async () => {
    const settings = (await api<Settings>('/api/settings')).data!;
    assert.deepEqual(settings.config.timer.suggested, { meeting: false, review: false });
  });
  await check('ongoing meetings are rows as before — no timer on them', async () => {
    const rows = await suggestions();
    assert.deepEqual(rows.map(s => s.uid), ['ev-past', 'ev-known', 'ev-unknown']);
    assert.deepEqual(rows.map(s => s.ongoing), [false, true, true]);
    assert.equal(rows.some(s => 'suggestedTimer' in s), false);
    assert.equal(rows[1].resolved?.task, 'ATL-1');
  });
  await check('the action is refused and nothing changes', async () => {
    const refused = await take('ev-known');
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /switched off/);
    assert.equal((await timers()).timers.length, 0);
    assert.equal((await suggestions()).length, 3);
  });

  // ─── 2. Calendar events switched on ─────────────────────────────────────
  console.log('\n2. Calendar events switched on');

  await check('workday timer suggested shows and sets the switches', async () => {
    assert.match(await cli('timer suggested'), /calendar events off · code reviews off/);
    assert.match(await cli('timer suggested meeting on'), /calendar events on · code reviews off/);
  });
  await check('an ongoing meeting offers a timer, a finished one does not', async () => {
    const rows = await suggestions();
    assert.deepEqual(rows.map(s => s.suggestedTimer === true), [false, true, true]);
  });
  await check('workday suggestions marks the rows a timer can take', async () => {
    const listing = await cli('suggestions');
    assert.match(listing, /Sprint planning\s+\[ongoing · timer\]\s+→ ATL-1/);
    assert.match(listing, /Daily standup\n/);
    assert.match(listing, /workday suggestions timer <#N>/);
  });

  // ─── 3. A meeting with a ticket ─────────────────────────────────────────
  console.log('\n3. A meeting with a ticket');

  const known = await take('ev-known');
  await check('a record with no minutes, and a timer running on it', () => {
    assert.equal(known.ok, true, known.error);
    const entry = known.data!.entry!;
    assert.equal(entry.task, 'ATL-1');
    assert.equal(entry.minutes, 0);
    assert.equal(entry.activity, 'Other');
    assert.equal(entry.description, 'Sprint planning');
    assert.equal(known.data!.timers.length, 1);
    const timer = known.data!.timers[0];
    assert.equal(timer.id, known.data!.timerId);
    assert.equal(timer.state, 'running');
    assert.equal(timer.entryId, entry.id);
    assert.equal(timer.handMinutes, 0);
    assert.equal(known.data!.counting, 'timer');
  });
  await check('the row left the suggestions; the record names where it came from', async () => {
    assert.deepEqual(known.data!.day.suggestions.map(s => s.uid), ['ev-past', 'ev-unknown']);
    assert.equal(await row('ev-known'), undefined);
    assert.equal(storedDay().manualEntries[0].sourceRef, `meeting:ev-known:${DAY}`);
  });
  await check('a second click finds no suggestion', async () => {
    const again = await take('ev-known');
    assert.equal(again.ok, false);
    assert.equal((await timers()).timers.length, 1);
  });

  // ─── 4. A meeting without a ticket ──────────────────────────────────────
  console.log('\n4. A meeting without a ticket');

  const unknown = await take('ev-unknown');
  await check('a running timer without a ticket, named after the meeting', () => {
    assert.equal(unknown.ok, true, unknown.error);
    assert.equal(unknown.data!.entry, undefined);
    assert.equal(unknown.data!.timers.length, 2);
    const timer = unknown.data!.timers[1];
    assert.equal(timer.id, unknown.data!.timerId);
    assert.equal(timer.state, 'running');
    assert.equal(timer.task, null);
    assert.equal(timer.entryId, null);
    assert.equal(timer.description, 'Sync with the platform team');
  });
  await check('one timer runs: the meeting before it is on pause', () => {
    assert.equal(unknown.data!.timers[0].state, 'paused');
    assert.deepEqual(unknown.data!.day.suggestions.map(s => s.uid), ['ev-past']);
  });

  // ─── 5. Remove ──────────────────────────────────────────────────────────
  console.log('\n5. Remove on both timers');

  await check('the timers go, the record that grew from one goes with it', async () => {
    for (const timer of (await timers()).timers) {
      const removed = await api<Timers>('/api/timer/delete', { id: timer.id });
      assert.equal(removed.ok, true, removed.error);
    }
    assert.equal((await timers()).timers.length, 0);
    assert.equal((await today()).manualEntries.length, 0);
  });
  await check('the suggestions do not come back', async () => {
    assert.deepEqual((await suggestions()).map(s => s.uid), ['ev-past']);
  });

  // ─── 6. A review ────────────────────────────────────────────────────────
  console.log('\n6. A review while its branch is checked out');

  await checkout(REVIEW_BRANCH);
  await check('the review is ongoing; its switch is off — no timer', async () => {
    const review = await row('ATL-2');
    assert.equal(review?.source, 'review');
    assert.equal(review?.ongoing, true);
    assert.equal('suggestedTimer' in review!, false);
  });
  await check('code reviews switched on: the row offers a timer, the other settings stay', async () => {
    const saved = await api<Settings>('/api/settings', { config: { timer: { suggested: { review: true } } } });
    assert.equal(saved.ok, true, saved.error);
    assert.deepEqual(saved.data!.config.timer, { desktopWidget: true, suggested: { meeting: true, review: true } });
    assert.equal((await row('ATL-2'))?.suggestedTimer, true);
  });

  await checkout(OWN_BRANCH);
  await check('the repo left the branch: the row stays, the timer is gone', async () => {
    const review = await row('ATL-2');
    assert.equal(review?.ongoing, false);
    assert.equal('suggestedTimer' in review!, false);
    const refused = await take('ATL-2');
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /not ongoing/);
  });

  await checkout(REVIEW_BRANCH);
  await check('back on the branch: workday suggestions timer takes the review', async () => {
    assert.equal((await row('ATL-2'))?.suggestedTimer, true);
    const out = await cli('suggestions timer ATL-2');
    assert.match(out, /Timer started on ATL-2: CodeReview — "code review"/);
    assert.match(out, /▶ running/);
    assert.equal(await row('ATL-2'), undefined);
    const entry = (await today()).manualEntries[0];
    assert.equal(entry.task, 'ATL-2');
    assert.equal(entry.activity, 'CodeReview');
    assert.equal(entry.description, 'code review');
    assert.equal(storedDay().manualEntries[0].sourceRef, `review:${DAY}:ATL-2`);
    const live = (await timers()).timers[0];
    assert.equal(live.state, 'running');
    assert.equal(live.entryId, entry.id);
  });

  await daemon.stop();
} catch (err) {
  failed++;
  console.error(`  FAIL ${(err as Error).message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
try { rmSync(REPO, { recursive: true, force: true }); } catch { /* git may still hold it on Windows */ }
process.exit(failed > 0 ? 1 : 0);
