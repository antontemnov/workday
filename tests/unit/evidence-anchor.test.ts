/**
 * Live GitTracker test for the evidence anchor-guard: when the default
 * branch moves so that the merge-base of the task branch jumps (a fetch
 * after the base branch was merged upstream), the churn map re-anchors
 * wholesale with nothing edited — that tick must not report dynamics.
 * The 2026-09-22 phantom: 117-file map → 2 files, 0m session born.
 *
 * Also covers the two sibling rules: git moving the tip (reset, rebase,
 * merge, cherry-pick, pull — any non-commit reflog entry) is a baseline
 * tick, and an untracked path counts only once it survives two ticks.
 *
 * Run: npx tsx tests/unit/evidence-anchor.test.ts
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitTracker } from '../../src/collectors/git-tracker.js';
import type { AppConfig, PollResult } from '../../src/core/types.js';

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
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

const root = mkdtempSync(join(tmpdir(), 'workday-evidence-anchor-'));
const ORIGIN = join(root, 'origin.git');
const REPO = join(root, 'clone');
const GITCONFIG = join(root, 'gitconfig');
writeFileSync(GITCONFIG, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n');
process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
process.env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'nul' : '/dev/null';

function git(args: string, cwd: string = REPO): string {
  return execSync(`git -C "${cwd}" ${args}`, { encoding: 'utf-8', windowsHide: true });
}

const config = {
  repos: [REPO],
  tracking: { projectKeys: ['ATL'], branchOwners: ['atemnov'] },
  genericBranches: ['master'],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20 },
  sensitivity: { default: 'normal', perRepo: {} },
} as unknown as AppConfig;

// origin (bare) with master at one commit; clone tracks it as origin/master.
mkdirSync(ORIGIN, { recursive: true });
git('init -q --bare', ORIGIN);
mkdirSync(REPO, { recursive: true });
git('init -q');
writeFileSync(join(REPO, 'base.txt'), 'base\n');
git('add .');
git('commit -q -m base');
git(`remote add origin "${ORIGIN}"`);
git('push -q -u origin master');

// Task branch cut from master with its own commit — the evidence diff vs
// merge-base (= master tip) holds exactly this file.
git('checkout -q -b ATL-1-atemnov-anchor-guard');
writeFileSync(join(REPO, 'work.txt'), 'line 1\nline 2\nline 3\n');
git('add .');
git('commit -q -m "[ATL-1] work"');

const tracker = new GitTracker(config);

async function tick(): Promise<PollResult> {
  const results = await tracker.pollAll();
  assert.equal(results.length, 1, 'expected one poll result');
  return results[0];
}

console.log('GitTracker evidence anchor-guard (live repo)');

await (async () => {
  const first = await tick();
  check('first tick is the baseline (no previous snapshot)', () => {
    assert.equal(first.delta.hasDynamics, false);
    assert.equal(first.snapshot.churnFiles.size, 1, 'work.txt is the whole evidence diff');
  });

  const quiet = await tick();
  check('a quiet tick under the same anchor reports no dynamics', () => {
    assert.equal(quiet.delta.hasDynamics, false);
    assert.equal(quiet.delta.magnitude, 0);
  });

  // The default branch absorbs the task branch's commit (merged upstream,
  // then fetched — here the push updates origin/master directly). The
  // merge-base jumps to the branch tip: the evidence diff becomes empty.
  git('push -q origin HEAD:master');
  const shifted = await tick();
  check('merge-base jump after a fetch is a baseline tick — not activity', () => {
    assert.notEqual(shifted.mergeBaseSha, quiet.mergeBaseSha, 'precondition: merge-base moved');
    assert.equal(shifted.snapshot.churnFiles.size, 0, 'precondition: churn map re-anchored to nothing');
    assert.equal(shifted.delta.hasDynamics, false, 'a fetch must never birth a session');
    assert.equal(shifted.delta.magnitude, 0);
    assert.equal(shifted.prevEvidenceSnapshot, null, 'prev evidence snapshot is anchored elsewhere — no seeding');
  });

  // Real work under the new anchor still registers on the next tick.
  appendFileSync(join(REPO, 'work.txt'), 'line 4\n');
  const edited = await tick();
  check('an edit after the re-anchoring is reported normally', () => {
    assert.equal(edited.delta.hasDynamics, true);
    assert.ok(edited.delta.magnitude > 0, `magnitude = ${edited.delta.magnitude}`);
  });

  // ── git moving the tip is not work ────────────────────────────────────
  git('commit -q -am "[ATL-1] more work"');
  const committed = await tick();
  check('a commit tick is activity, not a re-anchoring', () => {
    assert.equal(committed.newReflogEntries.some(e => e.type === 'commit'), true, 'precondition: commit seen');
    assert.equal(committed.reanchored, false);
  });

  git('reset -q --hard HEAD~1');
  const reset = await tick();
  check('reset --hard is a baseline tick — the shrunken map is not activity', () => {
    assert.equal(reset.reanchored, true, 'a non-commit reflog entry re-anchors');
    assert.equal(reset.delta.hasDynamics, false);
    assert.equal(reset.delta.magnitude, 0);
    assert.equal(reset.prevEvidenceSnapshot, null);
  });

  appendFileSync(join(REPO, 'work.txt'), 'line 5\n');
  const afterReset = await tick();
  check('an edit after the reset is reported normally', () => {
    assert.equal(afterReset.delta.hasDynamics, true);
  });

  // ── untracked debounce ────────────────────────────────────────────────
  writeFileSync(join(REPO, 'scratch.txt'), 'a\nb\nc\n');
  const pending = await tick();
  check('a new untracked file is pending on its first tick', () => {
    assert.equal(pending.delta.hasDynamics, false);
    assert.equal(pending.snapshot.churnFiles.has('scratch.txt'), false);
  });
  const confirmed = await tick();
  check('…and counts whole once it survives a second tick', () => {
    assert.equal(confirmed.delta.hasDynamics, true);
    assert.equal(confirmed.delta.magnitude, 3);
    assert.equal(confirmed.delta.untrackedDelta, 1);
  });
  writeFileSync(join(REPO, 'transient.tmp'), 'x\n');
  const transientSeen = await tick();
  rmSync(join(REPO, 'transient.tmp'));
  const transientGone = await tick();
  check('a build artifact that appears and vanishes within a tick never registers', () => {
    assert.equal(transientSeen.delta.hasDynamics, false);
    assert.equal(transientGone.delta.hasDynamics, false);
  });
})().catch(err => {
  failed++;
  console.error('  FAIL GitTracker evidence anchor-guard');
  console.error(`       ${(err as Error).stack ?? (err as Error).message}`);
});

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
