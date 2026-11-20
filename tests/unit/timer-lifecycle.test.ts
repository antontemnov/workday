/**
 * Unit tests for the live side of manual timers: TimerTracker on top of a
 * SessionTracker and the real ActivityEvaluator. One counts at a time — a
 * session or a timer; a start or a pause by hand settles the lead at once,
 * without a tick; the tick moves the timer between running and waiting.
 * Plus the daemon's life: downtime, day boundary, closed month, the janitor.
 *
 * Run: npx tsx tests/unit/timer-lifecycle.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import '../helpers/test-home.js'; // MUST be first — pins WORKDAY_HOME before config.ts loads
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ActivityEvaluator } from '../../src/core/activity-evaluator.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { TimerTracker } from '../../src/core/timer-tracker.js';
import { runStartupJanitor } from '../../src/core/janitor.js';
import { addManualEntry, createEmptyEvidence, createEmptyLog, getDailyLogPath, getOpenPause, readDailyLog, writeDailyLog } from '../../src/core/daily-log.js';
import { getTimers, newTimer, startEntryTimer } from '../../src/core/timers.js';
import { buildPatchedConfig } from '../../src/core/config.js';
import { PauseSource, SensitivityLevel, SessionState, TimerState, type AppConfig, type DailyLog, type EvaluatorResult, type Session } from '../../src/core/types.js';

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

const config: AppConfig = {
  repos: [],
  boundaryHour: 4,
  timezone: 'UTC',
  tracking: { projectKeys: ['ATL'], branchOwners: [] },
  genericBranches: [],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20, idleCloseHours: 3 },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5],
  holidays: [],
  apiPort: 9213,
  sensitivity: { default: SensitivityLevel.Normal },
  search: { projectKeys: [], knownProjects: [] },
  activities: { values: [] },
  notifications: { timesheetReminder: { enabled: true, notifyHour: 17 } },
  calendar: { enabled: false, hidePrivate: false },
  timer: { desktopWidget: true },
} as unknown as AppConfig;

const MINUTE = 60_000;
const TODAY = new Date().toISOString().slice(0, 10);
const ago = (minutes: number): string => new Date(Date.now() - minutes * MINUTE - 15_000).toISOString();

function activeSession(id: string): Session {
  const startedAt = ago(60);
  return {
    id, repo: `repo-${id}`, task: 'ATL-1', branch: 'ATL-1-fix', state: SessionState.Active,
    startedAt, activatedAt: startedAt, lastSeenAt: new Date().toISOString(), closedBy: null,
    evidence: createEmptyEvidence(), pauses: [], baseSha: null, mergeBaseSha: null,
    evidenceBaseline: null, evidenceCarry: null, uncommittedBaseline: null,
    lastBranchCommits: null, ledger: null, sensitivity: null,
  };
}

interface Rig {
  readonly log: DailyLog;
  readonly sessions: SessionTracker;
  readonly evaluator: ActivityEvaluator;
  readonly timers: TimerTracker;
  tick(edits?: readonly string[]): EvaluatorResult;
}

// The daemon's tick without git: scores from edits, then both trackers apply.
function rig(sessionIds: readonly string[] = [], date = TODAY): Rig {
  const log = createEmptyLog(date, config);
  log.sessions.push(...sessionIds.map(activeSession));
  const sessions = new SessionTracker(config, log);
  const evaluator = new ActivityEvaluator(30);
  sessions.onSessionClosed = (id): void => evaluator.removeSession(id);
  const timers = new TimerTracker(sessions, evaluator, config);
  return {
    log, sessions, evaluator, timers,
    tick: (edits = []) => {
      const inputs = sessions.getDailyLog().sessions.filter(s => !s.closedBy).map(s => ({
        sessionId: s.id,
        signals: { hasDynamics: edits.includes(s.id), hasCommit: false, deltaMagnitude: edits.includes(s.id) ? 4 : 0 },
        maxTicks: 90,
      }));
      const result = evaluator.processAllTicks(inputs, timers.evaluatorOptions());
      sessions.applyEvaluatorResult(result);
      timers.applyEvaluatorResult(result);
      return result;
    },
  };
}

// A rig whose session 'a' has been coding and counts.
function codingRig(): Rig {
  const r = rig(['a']);
  for (let i = 0; i < 4; i++) r.tick(['a']);
  assert.equal(r.sessions.hasCountingSession(), true);
  return r;
}

const pauseOf = (r: Rig, index = 0): PauseSource | null => getOpenPause(r.log.sessions[index])?.source ?? null;

console.log('A session or a timer');

test('a started timer takes the count from the session at once, without a tick', () => {
  const r = codingRig();
  const timer = r.timers.create('deploy');
  assert.equal(timer.state, TimerState.Running);
  assert.equal(pauseOf(r), PauseSource.Superseded);
  const view = r.timers.getTimers();
  assert.equal(view.counting, 'timer');
  assert.equal(view.timers.length, 1);
  assert.equal(view.timers[0].description, 'deploy');
  assert.equal(view.desktopWidget, true);
});

test('pausing the timer hands the count back to a session that still has stamina', () => {
  const r = codingRig();
  r.timers.create('deploy');
  r.timers.pause();
  assert.equal(pauseOf(r), null);
  assert.equal(r.timers.getTimers().counting, 'session');
});

test('pausing after the stamina ran out leaves nobody counting', () => {
  const r = codingRig();
  r.timers.create('deploy');
  for (let i = 0; i < 60; i++) r.tick();
  assert.equal(pauseOf(r), PauseSource.IdleTimeout);
  assert.equal(getTimers(r.log)[0].state, TimerState.Running, 'the timer ran through the fade');
  r.timers.pause();
  assert.equal(pauseOf(r), PauseSource.IdleTimeout);
  assert.equal(r.timers.getTimers().counting, 'none');
});

test('one stray edit leaves the count with the timer', () => {
  const r = codingRig();
  const timer = r.timers.create('deploy');
  for (let i = 0; i < 8; i++) r.tick();
  r.tick(['a']);
  assert.equal(timer.state, TimerState.Running);
  assert.equal(pauseOf(r), PauseSource.Superseded);
});

test('dense edits take the count — the timer waits; the session fades — the timer counts again', () => {
  const r = codingRig();
  const timer = r.timers.create('deploy');
  r.tick(['a']);
  r.tick(['a']);
  assert.equal(timer.state, TimerState.Running);
  r.tick(['a']);
  assert.equal(timer.state, TimerState.Waiting);
  assert.equal(pauseOf(r), null);
  assert.equal(r.timers.getTimers().counting, 'session');
  assert.equal(timer.spans.length, 1);
  assert.notEqual(timer.spans[0].to, null);

  let quiet = 0;
  while (timer.state === TimerState.Waiting && quiet < 200) { r.tick(); quiet++; }
  assert.equal(timer.state, TimerState.Running, `after ${quiet} quiet ticks`);
  assert.equal(timer.spans.length, 2);
  assert.equal(pauseOf(r), PauseSource.IdleTimeout);
  assert.equal(r.timers.getTimers().counting, 'timer');
});

test('pausing a waiting timer changes nothing for the session', () => {
  const r = codingRig();
  const timer = r.timers.create('deploy');
  for (let i = 0; i < 3; i++) r.tick(['a']);
  assert.equal(timer.state, TimerState.Waiting);
  r.timers.pause();
  assert.equal(timer.state, TimerState.Paused);
  assert.equal(pauseOf(r), null);
  r.tick();
  assert.equal(timer.state, TimerState.Paused, 'a paused timer never comes back by itself');
});

test('a waiting timer gets the count when the leading session is closed', () => {
  const r = codingRig();
  const timer = r.timers.create('deploy');
  for (let i = 0; i < 3; i++) r.tick(['a']);
  assert.equal(timer.state, TimerState.Waiting);
  assert.equal(r.sessions.stopSession('a').ok, true);
  r.tick();
  assert.equal(timer.state, TimerState.Running);
});

test('Esc on a fresh timer gives the count back to whoever had it', () => {
  const r = codingRig();
  const first = r.timers.create('deploy');
  const fresh = r.timers.create('');
  assert.equal(first.state, TimerState.Paused);
  r.timers.cancel(fresh.id);
  assert.deepEqual(getTimers(r.log).map(t => t.id), [first.id]);
  assert.equal(first.state, TimerState.Running);
  assert.equal(pauseOf(r), PauseSource.Superseded);

  r.timers.pause();
  const stray = r.timers.create('');
  r.timers.cancel(stray.id);
  assert.equal(first.state, TimerState.Paused);
  assert.equal(pauseOf(r), null, 'with no timer running the session counts again');
});

test('an entry deleted with its running timer hands the count back at once', () => {
  const r = codingRig();
  const entry = addManualEntry(r.log, { task: 'ATL-2', minutes: 30, description: 'call', activity: 'Meeting' }, config);
  r.timers.startOnEntry(entry.id);
  assert.equal(pauseOf(r), PauseSource.Superseded);
  assert.equal(r.sessions.deleteManualEntry(entry.id).ok, true);
  r.timers.settle();
  assert.equal(getTimers(r.log).length, 0);
  assert.equal(pauseOf(r), null);
});

console.log('Timer actions through the tracker');

test('the view shows an entry\'s whole time and what of it is the timer\'s', () => {
  const r = rig();
  const entry = addManualEntry(r.log, { task: 'ATL-2', minutes: 120, description: 'call', activity: 'Meeting' }, config);
  startEntryTimer(r.log, entry.id, ago(47));
  const stray = newTimer(r.log, 'ops', ago(5));
  const view = r.timers.getTimers();
  const [fed, loose] = view.timers;

  assert.equal(fed.task, 'ATL-2');
  assert.equal(fed.activity, 'Meeting');
  assert.equal(fed.description, 'call');
  assert.equal(fed.added, false);
  assert.equal(fed.handMinutes, 120);
  assert.equal(fed.state, TimerState.Paused, 'the newer timer put it on pause');
  assert.equal(Math.floor(fed.shareMs / MINUTE), 42);
  assert.equal(fed.totalMs, 120 * MINUTE + fed.shareMs);
  assert.equal(entry.minutes, 162, 'the read credits the entry');

  assert.equal(loose.id, stray.timer.id);
  assert.equal(loose.task, null);
  assert.equal(loose.description, 'ops');
  assert.equal(loose.handMinutes, 0);
  assert.equal(loose.totalMs, loose.shareMs);
  assert.equal(view.counting, 'timer');
  assert.equal(view.date, TODAY);
});

test('timers are named by id or by their place in the day', () => {
  const r = rig();
  const first = r.timers.create('one');
  const second = r.timers.create('two');
  assert.equal(r.timers.start('#1').id, first.id);
  assert.equal(r.timers.pause(first.id).id, first.id);
  assert.equal(r.timers.describe('#2', 'two, renamed').timer.id, second.id);
  assert.throws(() => r.timers.start('#9'), /Timer not found/);
  assert.throws(() => r.timers.pause(), /No timer is running/);
  assert.throws(() => r.timers.startOnEntry('#1'), /Manual entry not found/);
});

test('bind and remove go through the day\'s log and are written to disk', () => {
  const r = rig();
  const timer = r.timers.create('incident call');
  timer.spans[0] = { from: ago(30), to: null };
  const { entry } = r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'incident call' });
  assert.equal(entry.minutes, 30);
  const onDisk = readDailyLog(TODAY)!;
  assert.equal(onDisk.manualEntries[0].minutes, 30);
  assert.equal(onDisk.timers?.[0].entryId, entry.id);

  assert.throws(() => r.timers.remove(entry.id), /Nothing typed by hand/);
  r.sessions.editManualEntry(entry.id, { minutes: 45 });
  const removed = r.timers.remove('#1');
  assert.equal(removed.removedMinutes, 30);
  assert.equal(removed.entry.minutes, 15);
  assert.equal(readDailyLog(TODAY)!.timers, undefined);
});

test('Remove on a timer with a ticket: the timer and its time go, what was typed stays', () => {
  const r = rig();
  const timer = r.timers.create('incident call');
  timer.spans[0] = { from: ago(30), to: null };
  const { entry } = r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'incident call' });
  r.sessions.editManualEntry(entry.id, { minutes: 50 });
  assert.equal(r.timers.isRunning(), true);

  const removal = r.timers.delete(timer.id);
  assert.equal(removal.removedMinutes, 30);
  assert.equal(removal.entry?.id, entry.id);
  assert.equal(removal.entry?.minutes, 20);
  assert.equal(removal.deletedEntry, null);
  assert.equal(r.timers.isRunning(), false, 'a running timer stops first');
  const onDisk = readDailyLog(TODAY)!;
  assert.equal(onDisk.timers, undefined);
  assert.equal(onDisk.manualEntries[0].minutes, 20);
});

test('Remove on a timer whose entry grew from it alone: the entry goes with it', () => {
  const r = rig([], '2026-06-21');
  const timer = r.timers.create('incident call');
  timer.spans[0] = { from: ago(30), to: null };
  const { entry } = r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'incident call' });
  assert.equal(entry.minutes, 30);

  const removal = r.timers.delete(timer.id);
  assert.equal(removal.entry, null);
  assert.equal(removal.deletedEntry?.id, entry.id);
  assert.equal(r.timers.getTimers().timers.length, 0);
  assert.equal(existsSync(getDailyLogPath('2026-06-21')), false, 'the day\'s last fact is gone');
});

test('the text of a timer with a ticket is its entry\'s description', () => {
  const r = rig();
  const timer = r.timers.create('incident call');
  const { entry } = r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'incident call' });
  assert.equal(r.timers.entryIdOf(timer.id), entry.id);

  const described = r.timers.describe(timer.id, '  incident call, part 2 ');
  assert.equal(described.entry?.id, entry.id);
  assert.equal(entry.description, 'incident call, part 2');
  assert.equal(r.timers.getTimers().timers[0].description, 'incident call, part 2');
  assert.equal(timer.entryId, entry.id, 'the timer stays on its entry');
  assert.equal(r.sessions.getDailyLog().manualEntries.length, 1, 'no new record');
  assert.equal(readDailyLog(TODAY)!.manualEntries[0].description, 'incident call, part 2');

  assert.throws(() => r.timers.describe(timer.id, '   '), /Description is required/, 'only Development may go without one');
  assert.equal(entry.description, 'incident call, part 2');
});

test('the ticket first, the description after: a timer on manual added names its record', () => {
  const r = rig();
  const timer = r.timers.create('');
  timer.spans[0] = { from: ago(5), to: null };
  const { entry } = r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Development', description: '' });
  assert.equal(entry.added, true);
  assert.equal(r.timers.getTimers().timers[0].added, true);

  const described = r.timers.describe(timer.id, 'spike');
  assert.equal(described.absorbed, null);
  assert.equal(described.entry?.id, entry.id, 'the same record');
  assert.equal(described.timer.id, timer.id);
  assert.equal(entry.added, undefined);
  assert.equal(entry.description, 'spike');
  assert.equal(entry.minutes, 5, 'the time it counted stays on the record');
  assert.equal(timer.entryId, entry.id, 'the timer goes on feeding it');
  const view = r.timers.getTimers().timers[0];
  assert.equal(view.added, false);
  assert.equal(view.description, 'spike');
  assert.equal(view.state, TimerState.Running);
  assert.equal(r.sessions.getDailyLog().manualEntries.length, 1, 'no new record');
  assert.equal(readDailyLog(TODAY)!.manualEntries[0].description, 'spike');
});

test('a Development text taken away from the timer\'s side: the record is bare again, the timer goes on', () => {
  const r = rig();
  const timer = r.timers.create('spike');
  timer.spans[0] = { from: ago(7), to: null };
  const { entry } = r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Development', description: 'spike' });
  assert.equal(entry.added, undefined);

  const emptied = r.timers.describe(timer.id, '  ');
  assert.equal(emptied.absorbed?.id, entry.id, 'the caller tombstones its worklog by this id');
  assert.equal(emptied.entry?.added, true);
  assert.equal(emptied.entry?.minutes, 7);
  assert.equal(emptied.timer.entryId, emptied.entry?.id);
  const view = r.timers.getTimers().timers[0];
  assert.equal(view.added, true);
  assert.equal(view.description, '');
  assert.equal(view.state, TimerState.Running);
  assert.equal(r.sessions.getDailyLog().manualEntries.length, 1);
});

test('the last timer deleted takes the day\'s file with it', () => {
  const r = rig([], '2026-06-20');
  const timer = r.timers.create('deploy');
  assert.equal(existsSync(getDailyLogPath('2026-06-20')), true, 'a timer is a fact: the day is written');
  r.timers.delete(timer.id);
  assert.equal(existsSync(getDailyLogPath('2026-06-20')), false);
});

console.log('The daemon\'s life');

test('downtime is cut where the timer was last seen; it goes on by itself', () => {
  const r = rig();
  const timer = r.timers.create('deploy');
  const lastSeen = ago(90);
  timer.spans[0] = { from: ago(120), to: null };
  timer.lastSeenAt = lastSeen;
  assert.equal(r.timers.skipDowntime(), 1);
  assert.equal(timer.state, TimerState.Running);
  assert.equal(timer.spans.length, 2);
  assert.equal(timer.spans[0].to, lastSeen);
  const view = r.timers.getTimers().timers[0];
  assert.equal(Math.floor(view.totalMs / MINUTE), 30, 'the 90 minutes of downtime are nobody\'s');
});

test('a stop by hand pauses the timers; a tick later they are still paused', () => {
  const r = codingRig();
  const timer = r.timers.create('deploy');
  assert.equal(r.timers.pauseAll(), 1);
  assert.equal(timer.state, TimerState.Paused);
  r.tick();
  assert.equal(timer.state, TimerState.Paused);
  assert.equal(r.timers.skipDowntime(), 0, 'nothing live to pick up on the next start');
});

test('the day rolls over: timers stay in the old day, the new day has none', () => {
  const r = rig();
  const entry = addManualEntry(r.log, { task: 'ATL-2', minutes: 10, description: 'call', activity: 'Meeting' }, config);
  const fed = startEntryTimer(r.log, entry.id, ago(40)).timer;
  const loose = r.timers.create('helped the ops team');
  loose.spans[0] = { from: ago(20), to: null };

  r.timers.handleDayBoundary();
  const { oldLog, materialized } = r.sessions.handleDayBoundary();
  assert.equal(materialized, true);
  assert.deepEqual(getTimers(oldLog).map(t => t.id), [fed.id, loose.id]);
  assert.equal(getTimers(oldLog).every(t => t.state === TimerState.Paused && t.spans.every(s => s.to !== null)), true);
  assert.equal(oldLog.manualEntries[0].minutes, 10 + 40, 'fed until the newer timer paused it');
  assert.equal(loose.entryId, null, 'unlinked time of the old day');
  assert.equal(r.timers.getTimers().timers.length, 0, 'the island is empty');
  assert.equal(r.sessions.getDailyLog().timers, undefined);
});

test('a closed month: no timer starts, a paused one stays as it is', () => {
  const r = rig();
  const timer = r.timers.create('deploy');
  r.timers.pauseAll();
  r.sessions.setMonthLock(true);
  assert.throws(() => r.timers.create('late'), /month is closed/);
  assert.throws(() => r.timers.start(timer.id), /month is closed/);
  assert.throws(() => r.timers.bind(timer.id, { task: 'ATL-7', activity: 'Meeting', description: 'x' }), /month is closed/);
  assert.equal(r.timers.pause(timer.id).state, TimerState.Paused, 'a pause is never refused');
});

test('the janitor stops timers a crash left live in a past day', () => {
  const past = createEmptyLog('2026-06-01', config);
  const entry = addManualEntry(past, { task: 'ATL-2', minutes: 10, description: 'call', activity: 'Meeting' }, config);
  const fed = startEntryTimer(past, entry.id, '2026-06-01T10:00:00.000Z').timer;
  fed.lastSeenAt = '2026-06-01T10:45:00.000Z';
  writeDailyLog(past);

  const result = runStartupJanitor(TODAY);
  assert.equal(result.settledTimers, 1);
  const after = readDailyLog('2026-06-01')!;
  assert.equal(after.timers?.[0].state, TimerState.Paused);
  assert.equal(after.timers?.[0].spans[0].to, '2026-06-01T10:45:00.000Z');
  assert.equal(after.manualEntries[0].minutes, 55);
  assert.equal(runStartupJanitor(TODAY).settledTimers, 0, 'idempotent');
});

console.log('Config');

test('the desktop widget switch defaults to on and survives other patches', () => {
  const off = buildPatchedConfig(config, { timer: { desktopWidget: false } });
  assert.equal(off.timer.desktopWidget, false);
  const other = buildPatchedConfig(off, { boundaryHour: 5 });
  assert.equal(other.timer.desktopWidget, false);
  const legacy = { ...config } as unknown as { timer?: unknown };
  delete legacy.timer;
  assert.equal(buildPatchedConfig(legacy as unknown as AppConfig, { boundaryHour: 5 }).timer.desktopWidget, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
