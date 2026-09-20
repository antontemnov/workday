/**
 * Unit tests for the bulk-add folder scan: which folders count as a repo,
 * what the scan skips, where it stops.
 *
 * Run: npx tsx tests/unit/repo-scanner.test.ts
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitRepo, repoPathKey, scanForRepos } from '../../src/collectors/repo-scanner.js';
import { REPO_SCAN_MAX_RESULTS } from '../../src/core/constants.js';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'workday-repo-scan-'));

function makeRepo(...segments: string[]): string {
  const repoPath = join(ROOT, ...segments);
  mkdirSync(join(repoPath, '.git'), { recursive: true });
  writeFileSync(join(repoPath, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  return repoPath;
}

function names(root: string, repos: readonly string[]): string[] {
  return repos.map(r => r.slice(root.length + 1).replace(/\\/g, '/')).sort();
}

console.log('repo-scanner');

await test('isGitRepo: .git dir with HEAD, gitdir file; not an empty .git or a plain folder', async () => {
  const repo = makeRepo('kinds', 'normal');
  const worktree = join(ROOT, 'kinds', 'worktree');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), 'gitdir: ../normal/.git/worktrees/worktree\n');
  const emptyGit = join(ROOT, 'kinds', 'empty-git');
  mkdirSync(join(emptyGit, '.git'), { recursive: true });
  const plain = join(ROOT, 'kinds', 'plain');
  mkdirSync(plain, { recursive: true });

  assert.equal(await isGitRepo(repo), true);
  assert.equal(await isGitRepo(worktree), true);
  assert.equal(await isGitRepo(emptyGit), false);
  assert.equal(await isGitRepo(plain), false);
  assert.equal(await isGitRepo(join(ROOT, 'missing')), false);
});

await test('scan: finds repos on several levels, skips nested / hidden / node_modules', async () => {
  const root = join(ROOT, 'projects');
  makeRepo('projects', 'alpha');
  makeRepo('projects', 'group', 'beta');
  makeRepo('projects', 'group', 'deep', 'gamma');
  makeRepo('projects', 'alpha', 'vendor', 'submodule');
  makeRepo('projects', '.cache', 'hidden');
  makeRepo('projects', 'node_modules', 'pkg');
  makeRepo('projects', 'a', 'b', 'c', 'too-deep');
  mkdirSync(join(root, 'not-a-repo', 'src'), { recursive: true });

  const result = await scanForRepos(root);
  assert.deepEqual(names(root, result.repos), ['alpha', 'group/beta', 'group/deep/gamma']);
  assert.equal(result.truncated, false);
});

await test('scan: missing or empty root gives an empty list', async () => {
  assert.deepEqual((await scanForRepos(join(ROOT, 'nowhere'))).repos, []);
  mkdirSync(join(ROOT, 'empty'));
  assert.deepEqual((await scanForRepos(join(ROOT, 'empty'))).repos, []);
});

await test('scan: result cap marks the list as truncated', async () => {
  for (let i = 0; i < REPO_SCAN_MAX_RESULTS + 3; i++) makeRepo('many', `repo-${String(i).padStart(3, '0')}`);
  const result = await scanForRepos(join(ROOT, 'many'));
  assert.equal(result.repos.length, REPO_SCAN_MAX_RESULTS);
  assert.equal(result.truncated, true);
});

await test('repoPathKey: trailing separator and (on Windows) case do not matter', async () => {
  const base = join(ROOT, 'Projects', 'Alpha');
  assert.equal(repoPathKey(base), repoPathKey(base + '/'));
  if (process.platform === 'win32') assert.equal(repoPathKey(base), repoPathKey(base.toUpperCase()));
});

rmSync(ROOT, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
