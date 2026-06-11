/**
 * Integration test: evidence tracking against real git repos.
 *
 * Exercises the full GitTracker → SessionTracker pipeline (real git commands,
 * fresh merge-base resolution, baseline-delta evidence) through the scenarios
 * that used to corrupt the counters: rebase onto an advanced default branch,
 * squash, and continued work after both.
 *
 * Run: npx tsx tests/integration/evidence-rebase.test.ts
 * Fast (< 10s): no daemon, no polling delays — ticks are driven manually.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { GitTracker } from '../../src/collectors/git-tracker.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import type { AppConfig, Secrets } from '../../src/core/types.js';

const TEST_DIR = join(tmpdir(), `workday-evidence-test-${randomBytes(4).toString('hex')}`);
const REPO = join(TEST_DIR, 'repo');

// Hermetic git: no user config, no commit signing (CI environments may
// enforce signing globally, which breaks throwaway repos).
const GITCONFIG = join(TEST_DIR, 'gitconfig');
process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

function git(args: string): string {
  return execSync(`git -C "${REPO}" ${args}`, { encoding: 'utf-8', windowsHide: true }).trim();
}

const config = {
  repos: [REPO],
  schedule: { start: 10, end: 4 },
  timezone: 'UTC',
  taskPattern: 'ATL-\\d+',
  genericBranches: ['master'],
  session: {
    diffPollSeconds: 30,
    signalDeduplicationSeconds: 300,
    dayBoundaryCheckSeconds: 60,
    reflogCount: 20,
  },
  report: { roundingMinutes: 15 },
  workDays: [1, 2, 3, 4, 5, 6, 7],
  holidays: [],
  sensitivity: { default: 'normal', perRepo: {} },
} as unknown as AppConfig;

const secrets = { Developer: 'atemnov' } as Secrets;

let passed = 0;
let failed = 0;

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS ${label}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${label}`);
    console.error(`       ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  mkdirSync(REPO, { recursive: true });
  writeFileSync(GITCONFIG, '[user]\n\tname = Test\n\temail = test@test.local\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n');

  // master with a base file, then the developer's feature branch
  git('init');
  writeFileSync(join(REPO, 'base.txt'), 'line\n'.repeat(10));
  git('add .');
  git('commit -m "init"');
  git('checkout -b atemnov/ATL-1-feature');

  const gitTracker = new GitTracker(config, secrets);
  const sessions = new SessionTracker(config);

  const tick = async (): Promise<void> => {
    const baseShas = sessions.getBaseShasPerRepoPath(config.repos);
    const results = await gitTracker.pollAll(baseShas);
    for (const r of results) sessions.processPollResult(r);
  };

  const evidence = () => {
    const open = sessions.getOpenSessions();
    assert.equal(open.length, 1, 'expected one open session');
    return open[0].evidence;
  };

  // ── Baseline + work ────────────────────────────────────────────────────
  await tick(); // opens the session, anchors the baseline

  writeFileSync(join(REPO, 'feature.ts'), 'code\n'.repeat(30));
  git('add .');
  git('commit -m "ATL-1 first"');
  appendFileSync(join(REPO, 'feature.ts'), 'more\n'.repeat(20));
  git('add .');
  git('commit -m "ATL-1 second"');
  await tick();

  check('two commits and 50 added lines are counted', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 50, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Upstream advances, branch rebases onto it ──────────────────────────
  git('checkout master');
  writeFileSync(join(REPO, 'upstream.txt'), 'upstream\n'.repeat(500));
  git('add .');
  git('commit -m "huge upstream change"');
  git('checkout atemnov/ATL-1-feature');
  git('rebase master');
  await tick();

  check('rebase onto advanced master keeps commits and lines intact', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits} (used to reset to 0)`);
    assert.equal(ev.linesAdded, 50, `linesAdded = ${ev.linesAdded} (used to explode by +500 or zero out)`);
  });

  // ── Squash both commits into one (Rider-style reset --soft) ───────────
  git('reset --soft master');
  git('commit -m "ATL-1 squashed"');
  await tick();

  check('squash keeps the day\'s commit count', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 50, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Work continues after rebase + squash ───────────────────────────────
  appendFileSync(join(REPO, 'feature.ts'), 'even more\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-1 third"');
  await tick();

  check('new commit after rebase+squash keeps counting', () => {
    const ev = evidence();
    assert.equal(ev.commits, 3, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 60, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Uncommitted worktree changes are part of the evidence ─────────────
  appendFileSync(join(REPO, 'feature.ts'), 'wip\n'.repeat(5));
  await tick();

  check('uncommitted worktree lines are included', () => {
    const ev = evidence();
    assert.equal(ev.linesAdded, 65, `linesAdded = ${ev.linesAdded}`);
    assert.equal(ev.commits, 3, `commits = ${ev.commits}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main()
  .catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  })
  .finally(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
