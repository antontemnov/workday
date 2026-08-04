/**
 * Unit tests for the logged-panel delete masks: a committed delete whose
 * DELETE never landed (daemon down mid-request) must un-hide after
 * HIDDEN_TTL_MS instead of swallowing the row — and, for a whole-card
 * delete, every future entry of the ticket — forever. A successful delete
 * and the anti-flicker window inside the TTL keep their behavior.
 *
 * The component runs headless: fake clock + fake timer queue drive the
 * undo/collapse pipeline, the host element is a null-returning stub.
 *
 * Run: npx tsx tests/unit/logged-panel-delete-ttl.test.ts
 */
import assert from 'node:assert/strict';

// ─── Fake clock + timers (installed before the component module loads) ────
let nowMs = 1_700_000_000_000;
const realDateNow = Date.now;
Date.now = () => nowMs;

interface FakeTimer { id: number; fn: () => void; at: number }
let timerSeq = 1;
let timerQueue: FakeTimer[] = [];
(globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0): number => {
  timerQueue.push({ id: timerSeq, fn, at: nowMs + ms });
  return timerSeq++;
};
(globalThis as { clearTimeout: unknown }).clearTimeout = (id: number): void => {
  timerQueue = timerQueue.filter(t => t.id !== id);
};

/** Advance the clock, firing due timers in order (they may schedule more). */
function advance(ms: number): void {
  const target = nowMs + ms;
  for (let guard = 0; guard < 10_000; guard++) {
    const due = timerQueue.filter(t => t.at <= target).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timerQueue = timerQueue.filter(t => t.id !== due.id);
    nowMs = Math.max(nowMs, due.at);
    due.fn();
  }
  nowMs = target;
}

// cardEl() calls CSS.escape — absent in Node.
(globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s };

// A SimpleChange stand-in — ngOnChanges only reads truthiness + firstChange
// (@angular/core lives in tray-app/node_modules, unreachable from tests/).
const change = (currentValue: unknown): { previousValue: null; currentValue: unknown; firstChange: false } =>
  ({ previousValue: null, currentValue, firstChange: false });
// Partially-compiled Angular libs (CommonModule) fall back to JIT at module
// load — the compiler must be present first. It lives in tray-app's tree.
await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { LoggedPanelComponent } = await import(
  '../../tray-app/src/app/views/day-view/logged-panel/logged-panel.component');
const { DEVELOPMENT_ACTIVITY } = await import('../../tray-app/src/app/models/workday.models');
import type { ManualEntry, SessionDetail } from '../../tray-app/src/app/models/workday.models';

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

function entry(id: string, task: string, minutes: number,
  activity = 'CodeReview', description = 'named row'): ManualEntry {
  return { id, task, minutes, description, activity, createdAt: new Date(nowMs).toISOString() };
}

function session(id: string, task: string, effectiveDurationMs: number): SessionDetail {
  return {
    id, repo: 'repoA', task, branch: `${task}-branch`, state: 'closed',
    startedAt: new Date(nowMs - effectiveDurationMs).toISOString(),
    activatedAt: new Date(nowMs - effectiveDurationMs).toISOString(),
    lastSeenAt: new Date(nowMs).toISOString(),
    paused: false, pauseSource: null, effectiveDurationMs,
    score: 0, normalizedScore: 0, isLeader: false, sensitivity: 'normal',
    closedBy: 'idle', evidence: { commits: 0, reflogEvents: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    pauseCount: 0, totalPauseDurationMs: 0,
  } as SessionDetail;
}

interface Harness {
  comp: InstanceType<typeof LoggedPanelComponent>;
  refresh: (entries: readonly ManualEntry[], sessions?: readonly SessionDetail[]) => void;
  deleted: string[];
  sesDeleted: string[];
  taskDeleted: string[];
  lastDiff: () => number;
}

function makePanel(): Harness {
  const host = { nativeElement: { querySelector: () => null } };
  const cdr = { markForCheck(): void {}, detectChanges(): void {} };
  const comp = new LoggedPanelComponent(host as never, cdr as never, {} as never);
  comp.issueSummaries = {};
  const deleted: string[] = [];
  const sesDeleted: string[] = [];
  const taskDeleted: string[] = [];
  let diff = 0;
  comp.deleteCommitted.subscribe((id: string) => deleted.push(id));
  comp.sessionDeleteCommitted.subscribe((id: string) => sesDeleted.push(id));
  comp.taskDeleteCommitted.subscribe((t: string) => taskDeleted.push(t));
  comp.liveDiffChanged.subscribe((d: number) => { diff = d; });
  const refresh = (entries: readonly ManualEntry[], sessions?: readonly SessionDetail[]): void => {
    comp.entries = entries;
    if (sessions) comp.closedSessions = sessions;
    comp.ngOnChanges({
      entries: change(entries),
      closedSessions: change(comp.closedSessions),
    } as never);
  };
  return { comp, refresh, deleted, sesDeleted, taskDeleted, lastDiff: () => diff };
}

const blockOf = (h: Harness, task: string) => h.comp.feedBlocks.find(b => b.task === task);
// Undo window (3s) + collapse animation (240ms) → the commit fires.
const commitDelete = (): void => advance(4_000);

// ─── Row-level delete ─────────────────────────────────────────────────────

test('lost DELETE: row stays hidden inside the TTL (anti-flicker intact)', () => {
  const h = makePanel();
  const e1 = entry('e1', 'ATL-1', 30);
  const e2 = entry('e2', 'ATL-1', 45, 'Testing', 'qa pass');
  h.refresh([e1, e2]);
  assert.equal(blockOf(h, 'ATL-1')?.named.length, 2);

  (h.comp as never as { deleteEntry(e: ManualEntry): void }).deleteEntry(e1);
  commitDelete();
  assert.deepEqual(h.deleted, ['e1'], 'DELETE goes out after undo window');

  h.refresh([e1, e2]); // server still carries e1 — the DELETE was lost
  assert.equal(blockOf(h, 'ATL-1')?.named.length, 1, 'stale read must not flicker the row back');
  advance(20_000);
  h.refresh([e1, e2]); // ~24s after commit — still inside the TTL
  assert.equal(blockOf(h, 'ATL-1')?.named.length, 1);
  assert.equal(h.lastDiff(), -30, 'day total honestly excludes the pending delete');
});

test('lost DELETE: row returns after the TTL, day total recovers', () => {
  const h = makePanel();
  const e1 = entry('e1', 'ATL-1', 30);
  const e2 = entry('e2', 'ATL-1', 45, 'Testing', 'qa pass');
  h.refresh([e1, e2]);
  (h.comp as never as { deleteEntry(e: ManualEntry): void }).deleteEntry(e1);
  commitDelete();

  advance(46_000); // past HIDDEN_TTL_MS
  h.refresh([e1, e2]); // data still carries e1 → the DELETE evidently failed
  assert.equal(blockOf(h, 'ATL-1')?.named.length, 2, 'row resurrects');
  assert.equal(h.lastDiff(), 0, 'day total settles back');
});

test('successful DELETE stays deleted forever', () => {
  const h = makePanel();
  const e1 = entry('e1', 'ATL-1', 30);
  const e2 = entry('e2', 'ATL-1', 45, 'Testing', 'qa pass');
  h.refresh([e1, e2]);
  (h.comp as never as { deleteEntry(e: ManualEntry): void }).deleteEntry(e2);
  commitDelete();

  h.refresh([e1]); // server confirmed the delete
  assert.equal(blockOf(h, 'ATL-1')?.named.length, 1);
  advance(60_000);
  h.refresh([e1]); // long past the TTL — nothing resurrects
  assert.equal(blockOf(h, 'ATL-1')?.named.length, 1);
  assert.deepEqual(blockOf(h, 'ATL-1')?.named.map(e => e.id), ['e1']);
});

// ─── Whole-card delete (the 2026-08-05 incident) ──────────────────────────

test('incident: lost card DELETE hides new adds only until the TTL', () => {
  const h = makePanel();
  const f1 = entry('f1', 'ATL-2', 90, DEVELOPMENT_ACTIVITY, '');
  h.refresh([f1]);
  // Deleting the block's only row is the whole-card delete → task mask.
  (h.comp as never as { deleteEntry(e: ManualEntry): void }).deleteEntry(f1);
  commitDelete();
  assert.deepEqual(h.deleted, ['f1']);
  assert.deepEqual(h.taskDeleted, [], 'no tracked material — no task-level DELETE');

  advance(30_000); // DELETE was lost; user retries the add three times
  const adds = [f1,
    entry('f2', 'ATL-2', 60, DEVELOPMENT_ACTIVITY, ''),
    entry('f3', 'ATL-2', 60, DEVELOPMENT_ACTIVITY, ''),
    entry('f4', 'ATL-2', 60, DEVELOPMENT_ACTIVITY, '')];
  h.refresh(adds);
  assert.equal(blockOf(h, 'ATL-2'), undefined, 'inside the TTL the task mask still swallows the adds');
  assert.equal(h.lastDiff(), -270, 'day total excludes all four entries');

  advance(20_000); // ~50s after commit — past the TTL
  h.refresh(adds);
  const block = blockOf(h, 'ATL-2');
  assert.ok(block, 'block resurrects with the ticket mask');
  assert.equal(block?.folded.length, 4, 'all four foldable entries visible');
  assert.equal(block?.foldedMinutes, 270);
  assert.equal(h.lastDiff(), 0, 'day total honest again');
  assert.deepEqual(h.deleted, ['f1'], 'resurrection re-emits nothing');
});

// ─── Tracked session delete ───────────────────────────────────────────────

test('lost session DELETE: the tracked row returns after the TTL', () => {
  const h = makePanel();
  const s1 = session('s1', 'ATL-3', 30 * 60_000);
  const e5 = entry('e5', 'ATL-3', 15);
  h.refresh([e5], [s1]);
  assert.equal(blockOf(h, 'ATL-3')?.sessions.length, 1);

  h.comp.deleteSessionRow(s1, { stopPropagation(): void {} } as never);
  commitDelete();
  assert.deepEqual(h.sesDeleted, ['s1']);

  h.refresh([e5], [s1]); // session still in data — DELETE lost
  assert.equal(blockOf(h, 'ATL-3')?.sessions.length, 0, 'hidden inside the TTL');
  advance(46_000);
  h.refresh([e5], [s1]);
  assert.equal(blockOf(h, 'ATL-3')?.sessions.length, 1, 'session row resurrects');
  assert.equal(blockOf(h, 'ATL-3')?.trkMs, 30 * 60_000);
  assert.equal(h.lastDiff(), 0);
});

Date.now = realDateNow;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
