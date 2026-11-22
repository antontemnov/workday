/**
 * Unit tests for what the tray icon says. The eyes burn with the colour of
 * whoever counts: green — a session, orange — a manual timer, empty sockets
 * — nobody. A timer that waits or stands does not change the icon; a waiting
 * one adds its line under the session's. The session states read exactly as
 * they did before timers existed.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/tray-status.test.ts
 */
import assert from 'node:assert/strict';

const { TimerState } = await import('../../tray-app/src/app/models/workday.models');
const { trayStatus } = await import('../../tray-app/src/app/tray-status.util');
import type { SessionDetail, TimerView, TimersResponse } from '../../tray-app/src/app/models/workday.models';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const AS_OF = new Date(NOW).toISOString();

function session(over: Partial<SessionDetail>): SessionDetail {
  return {
    id: 's1', repo: 'D:/work/web-app', task: 'ATL-8110', branch: 'ATL-8110-work', state: 'active',
    paused: false, pauseSource: null, closedBy: null, ...over,
  } as SessionDetail;
}

function timer(state: TimerView['state'], over: Partial<TimerView> = {}): TimerView {
  return {
    id: 't1', state, entryId: 'e1', task: 'ATL-6712', activity: 'Other', added: false, description: 'PR review',
    totalMs: 82 * MINUTE, shareMs: 47 * MINUTE, handMinutes: 35, hidden: false, touchedAt: AS_OF, ...over,
  };
}

const timers = (...list: TimerView[]): TimersResponse =>
  ({ date: '2026-11-16', asOf: AS_OF, counting: 'none', desktopWidget: true, timers: list });

const LIVE = session({});
const SUPERSEDED = session({ paused: true, pauseSource: 'superseded' });

// ─── Sessions alone: as before ────────────────────────────────────────────

test('nobody counts: empty sockets, the bare name', () => {
  assert.deepEqual(trayStatus([], null, NOW), { kind: 'none', tooltip: 'Workday' });
  assert.deepEqual(trayStatus([], timers(), NOW), { kind: 'none', tooltip: 'Workday' });
});

test('a session counts: green eyes, the repo and the ticket', () => {
  assert.deepEqual(trayStatus([LIVE], null, NOW), { kind: 'live', tooltip: 'Workday — web-app · ATL-8110' });
  assert.equal(trayStatus([session({ task: null })], null, NOW).tooltip, 'Workday — web-app');
});

test('the other session states read as they did', () => {
  assert.deepEqual(trayStatus([session({ state: 'pending' })], null, NOW),
    { kind: 'pending', tooltip: 'Workday — web-app (pending)' });
  assert.deepEqual(trayStatus([session({ paused: true, pauseSource: 'idle_timeout' })], null, NOW),
    { kind: 'idle', tooltip: 'Workday — idle (web-app)' });
  assert.deepEqual(trayStatus([session({ paused: true, pauseSource: 'manual' })], null, NOW),
    { kind: 'paused', tooltip: 'Workday — paused (web-app)' });
  assert.equal(trayStatus([session({ paused: true, pauseSource: 'manual' }), LIVE], null, NOW).kind, 'live',
    'a counting session wins over a paused one');
});

// ─── A timer counts ───────────────────────────────────────────────────────

test('a timer counts: orange eyes, its own time and its ticket', () => {
  assert.deepEqual(trayStatus([SUPERSEDED], timers(timer(TimerState.Running)), NOW),
    { kind: 'timer', tooltip: 'Workday — timer 47m · ATL-6712' });
  assert.equal(trayStatus([], timers(timer(TimerState.Running)), NOW).kind, 'timer', 'with no session at all too');
});

test('the time reads to the minute and goes on', () => {
  const running = timers(timer(TimerState.Running, { shareMs: 47 * MINUTE + 30_000 }));
  assert.equal(trayStatus([], running, NOW + 29_000).tooltip, 'Workday — timer 47m · ATL-6712');
  assert.equal(trayStatus([], running, NOW + 30_000).tooltip, 'Workday — timer 48m · ATL-6712');
  assert.equal(trayStatus([], timers(timer(TimerState.Running, { shareMs: 62 * MINUTE })), NOW).tooltip,
    'Workday — timer 1h 02m · ATL-6712');
});

test('a timer without a ticket is named by the start of its description', () => {
  const loose = (description: string): TimersResponse =>
    timers(timer(TimerState.Running, { entryId: null, task: null, activity: null, description, totalMs: 3 * MINUTE, shareMs: 3 * MINUTE }));
  assert.equal(trayStatus([], loose('incident call'), NOW).tooltip, 'Workday — timer 3m · incident call');
  assert.equal(trayStatus([], loose('helped the ops team with the staging deploy'), NOW).tooltip,
    'Workday — timer 3m · helped the ops team wit…');
  assert.equal(trayStatus([], loose(''), NOW).tooltip, 'Workday — timer 3m', 'no description — the time alone');
});

// ─── A timer waits or stands ──────────────────────────────────────────────

test('a session counts, a timer waits: the session\'s line and the timer\'s under it', () => {
  assert.deepEqual(trayStatus([LIVE], timers(timer(TimerState.Waiting)), NOW),
    { kind: 'live', tooltip: 'Workday — web-app · ATL-8110\ntimer waiting 47m · ATL-6712' });
});

test('a waiting timer does not count on in the tooltip', () => {
  const status = trayStatus([LIVE], timers(timer(TimerState.Waiting)), NOW + 10 * MINUTE);
  assert.equal(status.tooltip, 'Workday — web-app · ATL-8110\ntimer waiting 47m · ATL-6712');
});

test('a timer at rest changes nothing', () => {
  const resting = timers(timer(TimerState.Paused));
  assert.deepEqual(trayStatus([LIVE], resting, NOW), trayStatus([LIVE], null, NOW));
  assert.deepEqual(trayStatus([], resting, NOW), { kind: 'none', tooltip: 'Workday' });
  assert.deepEqual(trayStatus([SUPERSEDED], resting, NOW), { kind: 'paused', tooltip: 'Workday — paused (web-app)' });
});

test('a waiting timer adds its line only to a session that counts', () => {
  // The timers were polled ahead of the day: the session is not live in this data yet.
  assert.deepEqual(trayStatus([SUPERSEDED], timers(timer(TimerState.Waiting)), NOW),
    { kind: 'paused', tooltip: 'Workday — paused (web-app)' });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
