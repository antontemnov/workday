/**
 * Unit tests for buildPushPlan — manual-entry reconcile + session isolation.
 *
 * Run: npx tsx tests/unit/push-plan.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Pure in-memory — no disk, no Tempo, no daemon.
 */
import assert from 'node:assert/strict';
import { buildPushPlan } from '../../src/push/tempo-pusher.js';
import type { TaskDayReport, JiraIssue, PushLogEntry, TempoWorklog, PushPlanEntry } from '../../src/core/types.js';

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

function worklog(id: number, seconds: number): TempoWorklog {
  return { tempoWorklogId: id, issueId: ISSUE, startDate: DATE, timeSpentSeconds: seconds };
}

function manualLog(worklogId: number, seconds: number, description: string, activity: string): PushLogEntry {
  return { tempoWorklogId: worklogId, timeSpentSeconds: seconds, pushedAt: 'x', description, activity };
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

test('same manual entry already pushed → skip', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual()], jiraMap, pushLog, [worklog(100, 1800)]);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, 'skip');
});

test('manual entry time changed → update', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual({ totalSeconds: 1200 })], jiraMap, pushLog, [worklog(100, 1800)]);
  assert.equal(plan[0].action, 'update');
  assert.equal(plan[0].existingWorklogId, 100);
});

test('manual entry text changed (same time) → update', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'OLD text', 'Other') };
  const plan = buildPushPlan([manual({ description: 'NEW text' })], jiraMap, pushLog, [worklog(100, 1800)]);
  assert.equal(plan[0].action, 'update');
  assert.match(plan[0].detail, /text\/activity/);
});

test('manual entry activity changed (same time) → update', () => {
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual({ activity: 'CodeReview' })], jiraMap, pushLog, [worklog(100, 1800)]);
  assert.equal(plan[0].action, 'update');
});

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
  const plan = buildPushPlan(report, jiraMap, pushLog, [worklog(100, 1800), worklog(101, 1800)]);
  const manualPlans = plan.filter(p => p.kind === 'manual');
  assert.equal(manualPlans.length, 2);
  assert.ok(manualPlans.every(p => p.action === 'skip'));
});

test('foreign Tempo worklog (not ours) is never mutated', () => {
  // We push our entry e1; Tempo also has a worklog 999 we never created.
  const plan = buildPushPlan([manual({ entryId: 'e1' })], jiraMap, {}, [worklog(999, 1800)]);
  const ours = plan.find(p => p.kind === 'manual' && p.entryId === 'e1');
  assert.equal(ours?.action, 'create');             // our entry creates a fresh worklog
  const foreign = plan.find(p => p.existingWorklogId === 999);
  assert.equal(foreign?.action, 'skip');            // foreign one shown but skipped
  assert.match(foreign!.detail, /Tempo only/);
});

test('session + manual both pushed on same task → both skip, no false create', () => {
  const pushLog = {
    [`${DATE}|ATL-10`]: { tempoWorklogId: 100, timeSpentSeconds: 3600, pushedAt: 'x' } as PushLogEntry,
    [`${DATE}|ATL-10|m:e1`]: manualLog(101, 1800, 'Daily standup', 'Other'),
  };
  const report = [session({ totalSeconds: 3600 }), manual({ entryId: 'e1', totalSeconds: 1800 })];
  const plan = buildPushPlan(report, jiraMap, pushLog, [worklog(100, 3600), worklog(101, 1800)]);
  assert.equal(plan.find(p => p.kind === 'session')?.action, 'skip');
  assert.equal(plan.find(p => p.kind === 'manual')?.action, 'skip');
  // Session must NOT "add" just because Tempo total (1.5h) exceeds its own 1h.
  assert.ok(!plan.some(p => p.kind === 'session' && p.action === 'create'));
});

test('unpushed session ignores already-pushed manual worklog of same task', () => {
  // Manual e1 already in Tempo (0.5h); session not yet pushed (1h).
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(101, 1800, 'Daily standup', 'Other') };
  const report = [session({ totalSeconds: 3600 }), manual({ entryId: 'e1', totalSeconds: 1800 })];
  const plan = buildPushPlan(report, jiraMap, pushLog, [worklog(101, 1800)]);
  const sess = plan.find(p => p.kind === 'session');
  assert.equal(sess?.action, 'create');
  assert.match(sess!.detail, /New/);                // NOT "Tempo has 0.5h, adding" — manual excluded
  assert.equal(plan.find(p => p.kind === 'manual')?.action, 'skip');
});

test('manual entry whose worklog vanished from Tempo → create again', () => {
  // pushLog remembers worklog 100, but Tempo no longer has it (deleted in UI).
  const pushLog = { [`${DATE}|ATL-10|m:e1`]: manualLog(100, 1800, 'Daily standup', 'Other') };
  const plan = buildPushPlan([manual()], jiraMap, pushLog, []);
  assert.equal(plan.find(p => p.kind === 'manual')?.action, 'create');
});

test('unresolved Jira → error', () => {
  const plan = buildPushPlan([manual({ task: 'ATL-99' })], new Map(), {}, []);
  assert.equal(plan[0].action, 'error');
  assert.equal(plan[0].kind, 'manual');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
