/**
 * Unit tests for buildPushPlan — the mirror-sync diff engine: field diff vs
 * the actual Tempo snapshot, orphan re-adoption, remote-edit conflicts.
 *
 * Run: npx tsx tests/unit/push-plan.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Pure in-memory — no disk, no Tempo, no daemon.
 */
import assert from 'node:assert/strict';
import { buildPushPlan } from '../../src/push/tempo-pusher.js';
import { computeDayDrift } from '../../src/push/reconcile.js';
import type { TaskDayReport, JiraIssue, PushLogEntry, TempoWorklog } from '../../src/core/types.js';

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

const DATE = '2026-06-13';
const ISSUE = 67890;
const jiraMap = new Map<string, JiraIssue>([['ATL-10', { issueId: ISSUE, summary: 'Task' }]]);

function manual(over: Partial<TaskDayReport> = {}): TaskDayReport {
  return {
    date: DATE, task: 'ATL-10', totalSeconds: 1800, sessionCount: 0,
    kind: 'manual', entryId: 'e1', description: 'Daily standup', activity: 'Other',
    ...over,
  };
}

function session(over: Partial<TaskDayReport> = {}): TaskDayReport {
  return { date: DATE, task: 'ATL-10', totalSeconds: 3600, sessionCount: 1, kind: 'session', ...over };
}

function worklog(id: number, seconds: number, over: Partial<TempoWorklog> = {}): TempoWorklog {
  return { tempoWorklogId: id, issueId: ISSUE, startDate: DATE, timeSpentSeconds: seconds, ...over };
}

/** Snapshot worklog matching what a manual() entry would have pushed. */
function manualWorklog(id: number, seconds = 1800, over: Partial<TempoWorklog> = {}): TempoWorklog {
  return worklog(id, seconds, { description: 'Daily standup', activity: 'Other', ...over });
}

function manualLog(worklogId: number, seconds: number, description: string, activity: string): PushLogEntry {
  return { tempoWorklogId: worklogId, timeSpentSeconds: seconds, pushedAt: 'x', description, activity };
}

function sessionLog(worklogId: number, seconds: number): PushLogEntry {
  return { tempoWorklogId: worklogId, timeSpentSeconds: seconds, pushedAt: 'x' };
}

console.log('buildPushPlan — manual reconcile');

test('new manual entry → create', () => {
  const plan = buildPushPlan([manual()], jiraMap, {}, []);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'create');
  assert.equal(plan[0].kind, 'manual');
  assert.equal(plan[0].entryId, 'e1');
  assert.equal(plan[0].description, 'Daily standup');
  assert.equal(plan[0].activity, 'Other');
});

test('manual entry in parity with Tempo → skip', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual()], jiraMap, pushLog, [manualWorklog(100)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'skip');
});

test('local time changed → update, no conflict', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual({ totalSeconds: 1200 })], jiraMap, pushLog, [manualWorklog(100)]);
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].existingWorklogId, 100);
  assert.equal(plan[0].conflict, undefined);
});

test('local text changed → update against snapshot, no conflict', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'OLD text', 'Other') };
  const plan = buildPushPlan(
    [manual({ description: 'NEW text' })], jiraMap, pushLog,
    [manualWorklog(100, 1800, { description: 'OLD text' })],
  );
  assert.equal(plan[0].action, 'update');
  assert.match(plan[0].detail, /text\/activity/);
  assert.equal(plan[0].conflict, undefined);
});

test('local activity changed → update', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual({ activity: 'CodeReview' })], jiraMap, pushLog, [manualWorklog(100)]);
  assert.equal(plan[0].action, 'update');
});

console.log('\nbuildPushPlan — remote edits (bug D)');

test('remote time edit, local unchanged → update restores + conflict flag', () => {
  // We pushed 1800; someone set 3600 in Tempo; local still wants 1800.
  // The old engine compared desired vs push-log and skipped — blind to Tempo.
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual()], jiraMap, pushLog, [manualWorklog(100, 3600)]);
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].conflict, true);
});

test('remote text edit → update restores + conflict flag', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan(
    [manual()], jiraMap, pushLog,
    [manualWorklog(100, 1800, { description: 'edited in Tempo' })],
  );
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].conflict, true);
});

test('remote edit that matches local → skip (no false update)', () => {
  // We pushed 1800, user changed Tempo to 3600, local also says 3600 now.
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual({ totalSeconds: 3600 })], jiraMap, pushLog, [manualWorklog(100, 3600)]);
  assert.equal(plan[0].action, 'skip');
});

test('worklog dragged to another day in Tempo → update restores date + conflict', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan(
    [manual()], jiraMap, pushLog,
    [manualWorklog(100, 1800, { startDate: '2026-06-14' })],
  );
  assert.equal(plan[0].action, 'update');
  assert.match(plan[0].detail, /moved to 2026-06-14/);
  assert.equal(plan[0].conflict, true);
  assert.equal(plan[0].date, DATE); // PUT will restore startDate
});

test('session remote time edit → update + conflict, remote text preserved', () => {
  const pushLog = { [`${DATE}|ATL-10`]: sessionLog(100, 3600) };
  const plan = buildPushPlan(
    [session()], jiraMap, pushLog,
    [worklog(100, 7200, { description: 'note added in Tempo', activity: 'CodeReview' })],
  );
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].conflict, true);
  // Session updates never wipe Tempo-side cosmetics.
  assert.equal(plan[0].description, 'note added in Tempo');
  assert.equal(plan[0].activity, 'CodeReview');
});

console.log('\nbuildPushPlan — orphan re-adoption (bug B)');

test('session with lost push-log adopts the single candidate → NO duplicate', () => {
  // Push-log is gone (torn file); Tempo already has our 1.0h worklog; local
  // now says 1.5h. The old engine did create ("Tempo has 1.0h, adding 1.5h").
  const plan = buildPushPlan([session({ totalSeconds: 5400 })], jiraMap, {}, [worklog(500, 3600)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].existingWorklogId, 500);
  assert.match(plan[0].detail, /Re-adopted/);
  assert.ok(!plan.some(p => p.action === 'create'));
});

test('manual entry re-adopts by exact content', () => {
  const plan = buildPushPlan([manual()], jiraMap, {}, [manualWorklog(600)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].existingWorklogId, 600);
  assert.match(plan[0].detail, /Re-adopted/);
});

test('two unowned candidates summing to desired → skip (split in Tempo)', () => {
  const plan = buildPushPlan([session({ totalSeconds: 5400 })], jiraMap, {},
    [worklog(500, 3600), worklog(501, 1800)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'skip');
  assert.match(plan[0].detail, /Exists in Tempo/);
  assert.deepEqual(plan[0].extraWorklogIds, [500, 501]);
});

test('two unowned candidates NOT summing → error, never a blind create', () => {
  const plan = buildPushPlan([session({ totalSeconds: 5400 })], jiraMap, {},
    [worklog(500, 3600), worklog(501, 3600)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'error');
  assert.match(plan[0].detail, /Ambiguous/);
});

test('owned worklog on another issue → error, never guessed', () => {
  const pushLog = { [`${DATE}|ATL-10`]: sessionLog(100, 3600) };
  const plan = buildPushPlan([session()], jiraMap, pushLog, [worklog(100, 3600, { issueId: 111 })]);
  const ours = plan.find(p => p.task === 'ATL-10');
  assert.equal(ours?.action, 'error');
  assert.match(ours!.detail, /another issue/);
});

console.log('\nbuildPushPlan — isolation & legacy invariants');

test('two manual entries on same task → two creates', () => {
  const report = [manual({ entryId: 'e1', description: 'standup' }), manual({ entryId: 'e2', description: 'grooming' })];
  const plan = buildPushPlan(report, jiraMap, {}, []);
  const creates = plan.filter(p => p.action === 'create' && p.kind === 'manual');
  assert.equal(creates.length, 2);
  assert.deepEqual(creates.map(c => c.entryId).sort(), ['e1', 'e2']);
});

test('double-push of two entries → both skip (no dup)', () => {
  const report = [manual({ entryId: 'e1', description: 'standup' }), manual({ entryId: 'e2', description: 'grooming' })];
  const pushLog = {
    [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'standup', 'Other'),
    [`${DATE}|ATL-10|m:e2`]: manualLog(101, 1800, 'grooming', 'Other'),
  };
  const plan = buildPushPlan(report, jiraMap, pushLog, [
    manualWorklog(100, 1800, { description: 'standup' }),
    manualWorklog(101, 1800, { description: 'grooming' }),
  ]);
  const manualPlans = plan.filter(p => p.kind === 'manual');
  assert.equal(manualPlans.length, 2);
  assert.ok(manualPlans.every(p => p.action === 'skip'));
});

test('foreign worklog with different content is never adopted or mutated', () => {
  // Tempo has a 999 worklog with other text — our entry must NOT steal it.
  const plan = buildPushPlan([manual({ entryId: 'e1' })], jiraMap, {},
    [worklog(999, 1800, { description: 'someone else' })]);
  const ours = plan.find(p => p.kind === 'manual' && p.entryId === 'e1');
  assert.equal(ours?.action, 'create');
  const foreign = plan.find(p => p.existingWorklogId === 999);
  assert.equal(foreign?.action, 'skip');
  assert.match(foreign!.detail, /Tempo only/);
});

test('session + manual both in parity → both skip, no false create', () => {
  const pushLog = {
    [`${DATE}|ATL-10`]: sessionLog(100, 3600),
    [`${DATE}|ATL-10|m:e1`]: manualLog(101, 1800, 'Daily standup', 'Other'),
  };
  const report = [session({ totalSeconds: 3600 }), manual({ entryId: 'e1', totalSeconds: 1800 })];
  const plan = buildPushPlan(report, jiraMap, pushLog, [worklog(100, 3600), manualWorklog(101)]);
  assert.equal(plan.find(p => p.kind === 'session')?.action, 'skip');
  assert.equal(plan.find(p => p.kind === 'manual')?.action, 'skip');
  assert.ok(!plan.some(p => p.kind === 'session' && p.action === 'create'));
});

test('unpushed session never adopts a manual-owned worklog of same task', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(101, 1800, 'Daily standup', 'Other') };
  const report = [session({ totalSeconds: 3600 }), manual({ entryId: 'e1', totalSeconds: 1800 })];
  const plan = buildPushPlan(report, jiraMap, pushLog, [manualWorklog(101)]);
  const sess = plan.find(p => p.kind === 'session');
  assert.equal(sess?.action, 'create');
  assert.match(sess!.detail, /New/);
  assert.equal(plan.find(p => p.kind === 'manual')?.action, 'skip');
});

test('manual entry whose worklog vanished from Tempo → create again + conflict', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual()], jiraMap, pushLog, []);
  const ours = plan.find(p => p.kind === 'manual');
  assert.equal(ours?.action, 'create');
  assert.equal(ours?.conflict, true); // remote deletion is a remote change
});

test('unresolved Jira → error', () => {
  const plan = buildPushPlan([manual({ task: 'ATL-99' })], new Map(), {}, []);
  assert.equal(plan[0].action, 'error');
  assert.equal(plan[0].kind, 'manual');
});

console.log('\ncomputeDayDrift — offline status diff');

function snapOf(...worklogs: TempoWorklog[]): Map<number, TempoWorklog> {
  return new Map(worklogs.map(w => [w.tempoWorklogId, w]));
}

test('parity → empty drift', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const drift = computeDayDrift(DATE, [manual()], pushLog, snapOf(manualWorklog(100)));
  assert.deepEqual(drift, []);
});

test('unpushed entry → drift line', () => {
  const drift = computeDayDrift(DATE, [manual()], {}, snapOf());
  assert.equal(drift.length, 1);
  assert.match(drift[0], /not pushed/);
});

test('time drift vs Tempo → drift line', () => {
  const pushLog = { [`${DATE}|ATL-10`]: sessionLog(100, 3600) };
  const drift = computeDayDrift(DATE, [session()], pushLog, snapOf(worklog(100, 7200)));
  assert.equal(drift.length, 1);
  assert.match(drift[0], /2\.0h in Tempo vs 1\.0h local/);
});

test('worklog moved to another day → drift line', () => {
  const pushLog = { [`${DATE}|ATL-10`]: sessionLog(100, 3600) };
  const drift = computeDayDrift(DATE, [session()], pushLog, snapOf(worklog(100, 3600, { startDate: '2026-06-14' })));
  assert.equal(drift.length, 1);
  assert.match(drift[0], /moved to 2026-06-14/);
});

test('manual text drift → drift line', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const drift = computeDayDrift(DATE, [manual()], pushLog, snapOf(manualWorklog(100, 1800, { description: 'edited' })));
  assert.equal(drift.length, 1);
  assert.match(drift[0], /description\/activity/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
