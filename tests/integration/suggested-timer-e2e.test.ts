/**
 * E2E: suggested timers, end to end. The repo's daemon runs in-process on a
 * throwaway home and a spare port, watching a real git repo; the calendar is
 * a cache file with meetings that are on right now, Jira is faked inside the
 * process (nothing leaves the machine). The tray is plain HTTP calls, the CLI
 * is the real `workday` run against the same daemon.
 *
 *   1. Switched off (the default): ongoing rows offer no timer, the action
 *      is refused, nothing else changes.
 *   2. Meetings switched on from the CLI: ongoing meetings offer a
 *      timer, a finished one does not.
 *   3. A meeting with a ticket: a record with no minutes and a timer running
 *      on it; the row leaves the suggestions.
 *   4. A meeting without a ticket: a running timer without one, named after
 *      the meeting; the timer before it goes on pause.
 *   5. Remove on both timers: the suggestions do not come back.
 *   6. A review: ongoing while its branch is checked out, its own switch,
 *      taken by a timer from the CLI.
 *   7. A ticket given with the request (picked for a row that has none): the
 *      record is made on it and the series learns it; --task of the CLI; a
 *      private meeting is a meeting like any other.
 *   8. A timer that grew from a meeting without a ticket remembers the
 *      meeting: its ticket, bound later, brings the meeting's record — Other,
 *      the meeting's sourceRef — and teaches the series. A New timer binds
 *      as before. No history and no --activity is Other on every path.
 *
 * Run: npx tsx tests/integration/suggested-timer-e2e.test.ts  (~50 s: CLI spawns)
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

const meeting = (uid: string, title: string, startMin: number, endMin: number, isPrivate = false): Record<string, unknown> => ({
  uid, date: DAY, start: at(startMin), end: at(endMin), title,
  busyStatus: 'BUSY', allDay: false, cancelled: false, recurring: false, ...(isPrivate ? { isPrivate } : {}),
});
writeFileSync(join(TEST_HOME, 'data', CALENDAR_CACHE_FILE), JSON.stringify({
  fetchedAt: at(-5),
  instances: [
    meeting('ev-past', 'Daily standup', -120, -105),
    meeting('ev-known', 'Sprint planning', -10, 50),
    meeting('ev-unknown', 'Sync with the platform team', -5, 25),
    meeting('ev-picked', 'Architecture sync', -4, 40),
    meeting('ev-private', 'Private appointment', -3, 40, true),
    meeting('ev-cli', 'Release review', -2, 40),
    meeting('ev-bind', 'Roadmap sync', -1.5, 40, true),
    meeting('ev-bind-cli', 'Vendor call', -1, 40),
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
interface TimerRow { id: string; state: string; entryId: string | null; task: string | null; description: string; handMinutes: number; sourceRef?: string }
interface Entry { id: string; task: string; minutes: number; activity: string; description: string; added?: boolean }
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
const take = async (uid: string, ticket: { task?: string; activity?: string } = {}): Promise<ApiResult<Taken>> =>
  api<Taken>('/api/suggestions/timer', { uid, date: DAY, ...ticket });
// What the series have learned, as the daemon keeps it.
const learned = (): Record<string, { task: string; activity: string; description?: string }> =>
  (JSON.parse(readFileSync(join(TEST_HOME, 'data', MEETING_ASSOCIATIONS_FILE), 'utf-8')) as {
    series: Record<string, { task: string; activity: string; description?: string }>;
  }).series;
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
    assert.deepEqual(rows.map(s => s.uid), ['ev-past', 'ev-known', 'ev-unknown', 'ev-picked', 'ev-private', 'ev-cli', 'ev-bind', 'ev-bind-cli']);
    assert.deepEqual(rows.map(s => s.ongoing), [false, true, true, true, true, true, true, true]);
    assert.equal(rows.some(s => 'suggestedTimer' in s), false);
    assert.equal(rows[1].resolved?.task, 'ATL-1');
  });
  await check('the action is refused and nothing changes', async () => {
    const refused = await take('ev-known');
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? '', /switched off/);
    assert.equal((await timers()).timers.length, 0);
    assert.equal((await suggestions()).length, 8);
  });

  // ─── 2. Calendar events switched on ─────────────────────────────────────
  console.log('\n2. Meetings switched on');

  await check('workday timer suggested shows and sets the switches', async () => {
    assert.match(await cli('timer suggested'), /meetings off · reviews off/);
    assert.match(await cli('timer suggested meeting on'), /meetings on · reviews off/);
  });
  await check('an ongoing meeting offers a timer, a finished one does not', async () => {
    const rows = await suggestions();
    assert.deepEqual(rows.map(s => s.suggestedTimer === true), [false, true, true, true, true, true, true, true]);
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
    assert.deepEqual(known.data!.day.suggestions.map(s => s.uid), ['ev-past', 'ev-unknown', 'ev-picked', 'ev-private', 'ev-cli', 'ev-bind', 'ev-bind-cli']);
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
    assert.deepEqual(unknown.data!.day.suggestions.map(s => s.uid), ['ev-past', 'ev-picked', 'ev-private', 'ev-cli', 'ev-bind', 'ev-bind-cli']);
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
    assert.deepEqual((await suggestions()).map(s => s.uid), ['ev-past', 'ev-picked', 'ev-private', 'ev-cli', 'ev-bind', 'ev-bind-cli']);
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

  // ─── 7. A ticket given with the request ─────────────────────────────────
  console.log('\n7. A ticket picked for a suggestion without one');

  await check('the row has no ticket of its own, and no series knows it', async () => {
    const picked = await row('ev-picked');
    assert.equal(picked?.suggestedTimer, true);
    assert.equal(picked?.resolved, undefined);
    assert.equal(learned()['ev-picked'], undefined);
  });

  const picked = await take('ev-picked', { task: 'ATL-3' });
  await check('the record is made on the given ticket, as the form would fill it', () => {
    assert.equal(picked.ok, true, picked.error);
    const entry = picked.data!.entry!;
    assert.equal(entry.task, 'ATL-3');
    assert.equal(entry.minutes, 0);
    assert.equal(entry.activity, 'Other');
    assert.equal(entry.description, 'Architecture sync');
    const timer = picked.data!.timers.find(t => t.id === picked.data!.timerId)!;
    assert.equal(timer.state, 'running');
    assert.equal(timer.entryId, entry.id);
    assert.equal(timer.task, 'ATL-3');
  });
  await check('one timer runs: the review before it is on pause; the row left for good', async () => {
    assert.deepEqual(picked.data!.timers.map(t => t.state), ['paused', 'running']);
    assert.equal(await row('ev-picked'), undefined);
    assert.equal(storedDay().manualEntries.find(e => e.id === picked.data!.entry!.id)?.sourceRef, `meeting:ev-picked:${DAY}`);
  });
  await check('taken by a timer, the series learns the ticket — as a Log teaches it', () => {
    const series = learned()['ev-picked'];
    assert.equal(series?.task, 'ATL-3');
    assert.equal(series?.activity, 'Other');
  });

  await check('workday suggestions timer --task --activity is the same request', async () => {
    const out = await cli('suggestions timer ev-cli --task ATL-4 --activity Meeting');
    assert.match(out, /Timer started on ATL-4: Meeting — "Release review"/);
    assert.equal(await row('ev-cli'), undefined);
    const entry = (await today()).manualEntries.find(e => e.task === 'ATL-4')!;
    assert.equal(entry.activity, 'Meeting');
    assert.equal(entry.description, 'Release review');
    assert.equal(learned()['ev-cli']?.activity, 'Meeting');
    const live = (await timers()).timers.find(t => t.entryId === entry.id)!;
    assert.equal(live.state, 'running');
  });

  await check('a private meeting is a meeting: the record takes the ticket and the text the row shows', async () => {
    const taken = await take('ev-private', { task: 'ATL-5' });
    assert.equal(taken.ok, true, taken.error);
    const entry = taken.data!.entry!;
    assert.equal(entry.task, 'ATL-5');
    assert.equal(entry.activity, 'Other');
    assert.equal(entry.description, 'Private appointment');
    assert.equal(taken.data!.timers.find(t => t.id === taken.data!.timerId)!.entryId, entry.id);
    assert.deepEqual(taken.data!.day.suggestions.map(s => s.uid), ['ev-past', 'ev-bind', 'ev-bind-cli']);
  });

  // ─── 8. A ticket for a timer that grew from a meeting ───────────────────
  console.log('\n8. A ticket for a timer that grew from a meeting');

  const loose = await take('ev-bind');
  const looseId = loose.data?.timerId ?? '';
  await check('the timer has no ticket and remembers its meeting — a private one is named as its row is', () => {
    assert.equal(loose.ok, true, loose.error);
    const timer = loose.data!.timers.find(t => t.id === looseId)!;
    assert.equal(timer.task, null);
    assert.equal(timer.description, 'Roadmap sync');
    assert.equal(timer.sourceRef, `meeting:ev-bind:${DAY}`);
    assert.equal(learned()['ev-bind'], undefined, 'nothing is learned until it has a ticket');
  });

  // The tray sends the timer's own text; no activity is said — the daemon's default.
  const bound = await api<Timers>('/api/timer/bind', { id: looseId, task: 'ATL-6', description: 'Roadmap sync' });
  await check('its ticket brings the meeting\'s record: Other, the meeting\'s name, the meeting\'s sourceRef', () => {
    assert.equal(bound.ok, true, bound.error);
    const entry = bound.data!.entry!;
    assert.equal(entry.task, 'ATL-6');
    assert.equal(entry.activity, 'Other', 'not Development');
    assert.equal(entry.description, 'Roadmap sync');
    assert.equal(entry.added, undefined, 'a record of its own');
    assert.equal(storedDay().manualEntries.find(e => e.id === entry.id)?.sourceRef, `meeting:ev-bind:${DAY}`);
    const timer = bound.data!.timers.find(t => t.id === looseId)!;
    assert.equal(timer.entryId, entry.id);
    assert.equal(timer.state, 'running');
    assert.equal('sourceRef' in timer, false, 'the record carries it now');
  });
  await check('the series learns the ticket and the activity — next time the meeting comes with them', () => {
    const series = learned()['ev-bind'];
    assert.equal(series?.task, 'ATL-6');
    assert.equal(series?.activity, 'Other');
  });

  await check('workday timer bind without --activity: the same record', async () => {
    const cliTimer = await take('ev-bind-cli');
    assert.equal(cliTimer.ok, true, cliTimer.error);
    const out = await cli(`timer bind ${cliTimer.data!.timerId} ATL-7 Vendor call`);
    assert.match(out, /Timer bound to ATL-7: \d+m Other — "Vendor call"/);
    const entry = (await today()).manualEntries.find(e => e.task === 'ATL-7')!;
    assert.equal(storedDay().manualEntries.find(e => e.id === entry.id)?.sourceRef, `meeting:ev-bind-cli:${DAY}`);
    assert.equal(learned()['ev-bind-cli']?.task, 'ATL-7');
    assert.equal(learned()['ev-bind-cli']?.activity, 'Other');
  });

  await check('a New timer binds as before: Development stays Development, no sourceRef, nothing learned', async () => {
    const before = Object.keys(learned()).length;
    const fresh = await api<Timers>('/api/timer/new', { description: 'deploy' });
    assert.equal('sourceRef' in fresh.data!.timers.find(t => t.id === fresh.data!.timerId)!, false);
    const plainBind = await api<Timers>('/api/timer/bind', { id: fresh.data!.timerId, task: 'ATL-9', activity: 'Development', description: 'deploy' });
    assert.equal(plainBind.ok, true, plainBind.error);
    assert.equal(plainBind.data!.entry!.activity, 'Development');
    assert.equal(storedDay().manualEntries.find(e => e.id === plainBind.data!.entry!.id)?.sourceRef, undefined);
    assert.equal(Object.keys(learned()).length, before);
  });

  await check('workday suggestions accept --task without --activity: no history is Other there too', async () => {
    const out = await cli('suggestions accept ev-past --task ATL-8');
    assert.match(out, /Logged ATL-8 on .*: 15m Other — "Daily standup"/);
    assert.equal(learned()['ev-past']?.activity, 'Other');
  });

  await daemon.stop();
} catch (err) {
  failed++;
  console.error(`  FAIL ${(err as Error).message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
try { rmSync(REPO, { recursive: true, force: true }); } catch { /* git may still hold it on Windows */ }
process.exit(failed > 0 ? 1 : 0);
