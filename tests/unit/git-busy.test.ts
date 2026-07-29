/**
 * Unit tests for GitClient.isRepoBusy — the index.lock probe that keeps
 * poll ticks away from a repo mid-checkout/rebase (worktree already
 * rewritten, HEAD not yet flipped — invisible to branch guards).
 *
 * Run: npx tsx tests/unit/git-busy.test.ts
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitClient } from '../../src/collectors/git-client.js';
import { GitTracker } from '../../src/collectors/git-tracker.js';
import type { AppConfig } from '../../src/core/types.js';

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

const root = mkdtempSync(join(tmpdir(), 'workday-git-busy-'));

function makeRepo(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
}

console.log('GitClient.isRepoBusy');

test('plain repo without lock is not busy', () => {
  const repo = makeRepo('plain');
  assert.equal(GitClient.isRepoBusy(repo), false);
});

test('index.lock present means busy', () => {
  const repo = makeRepo('locked');
  writeFileSync(join(repo, '.git', 'index.lock'), '');
  assert.equal(GitClient.isRepoBusy(repo), true);
});

test('linked worktree resolves gitdir file to the real gitdir', () => {
  const gitDir = join(root, 'main-repo', '.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  const wt = join(root, 'wt');
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, '.git'), `gitdir: ${gitDir}\n`);

  assert.equal(GitClient.isRepoBusy(wt), false);
  writeFileSync(join(gitDir, 'index.lock'), '');
  assert.equal(GitClient.isRepoBusy(wt), true);
});

test('linked worktree with relative gitdir path', () => {
  const wt = join(root, 'wt-rel');
  mkdirSync(wt, { recursive: true });
  mkdirSync(join(wt, 'sub-git'), { recursive: true });
  writeFileSync(join(wt, '.git'), 'gitdir: sub-git\n');

  assert.equal(GitClient.isRepoBusy(wt), false);
  writeFileSync(join(wt, 'sub-git', 'index.lock'), '');
  assert.equal(GitClient.isRepoBusy(wt), true);
});

test('not a repo (no .git) is not busy', () => {
  const dir = join(root, 'no-git');
  mkdirSync(dir, { recursive: true });
  assert.equal(GitClient.isRepoBusy(dir), false);
});

test('.git file without gitdir line is not busy', () => {
  const dir = join(root, 'garbage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.git'), 'not a gitdir pointer\n');
  assert.equal(GitClient.isRepoBusy(dir), false);
});

// ─── pollRepo wiring: a locked repo yields no tick ───────────────────────

console.log('\nGitTracker busy-guard');

const REPO = join(root, 'live-repo');
mkdirSync(REPO, { recursive: true });
const GITCONFIG = join(root, 'gitconfig');
writeFileSync(GITCONFIG, '[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = master\n');
process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
process.env.GIT_CONFIG_SYSTEM = process.platform === 'win32' ? 'nul' : '/dev/null';

function git(args: string): void {
  execSync(`git -C "${REPO}" ${args}`, { encoding: 'utf-8', windowsHide: true });
}

const config = {
  repos: [REPO],
  tracking: { projectKeys: ['ATL'], branchOwners: ['atemnov'] },
  genericBranches: ['master'],
  session: { diffPollSeconds: 30, signalDeduplicationSeconds: 300, dayBoundaryCheckSeconds: 60, reflogCount: 20 },
  sensitivity: { default: 'normal', perRepo: {} },
} as unknown as AppConfig;

git('init -q');
writeFileSync(join(REPO, 'a.txt'), 'hello\n');
git('add .');
git('commit -q -m init');

const tracker = new GitTracker(config);

await (async () => {
  const before = await tracker.pollAll();
  assert.equal(before.length, 1, 'unlocked repo must produce a poll result');
  passed++;
  console.log('  PASS unlocked repo produces a tick');

  writeFileSync(join(REPO, '.git', 'index.lock'), '');
  const locked = await tracker.pollAll();
  assert.equal(locked.length, 0, 'locked repo must be skipped');
  passed++;
  console.log('  PASS locked repo tick is dropped');

  rmSync(join(REPO, '.git', 'index.lock'));
  const after = await tracker.pollAll();
  assert.equal(after.length, 1, 'unlock must restore polling');
  passed++;
  console.log('  PASS unlock restores polling');
})().catch(err => {
  failed++;
  console.error('  FAIL GitTracker busy-guard');
  console.error(`       ${(err as Error).message}`);
});

rmSync(root, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
