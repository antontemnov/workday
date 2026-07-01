/**
 * Integration test: commit-ledger accounting against a real git repo.
 *
 * The scenarios that break counter-sampling approaches: several git
 * operations landing between two polls (commit + squash inside one tick),
 * amend/reword, dropped commits, squash that includes a pre-day commit,
 * work done while the daemon was down, and a mid-day merge to master.
 *
 * Run: npx tsx tests/integration/commit-ledger.test.ts
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { GitTracker } from '../../src/collectors/git-tracker.js';
import { SessionTracker } from '../../src/core/session-tracker.js';
import { ClosedBy } from '../../src/core/types.js';
import type { AppConfig, PollResult, Secrets } from '../../src/core/types.js';

const TEST_DIR = join(tmpdir(), `workday-ledger-test-${randomBytes(4).toString('hex')}`);
const REPO = join(TEST_DIR, 'repo');

// Hermetic git: no user config, no commit signing.
const GITCONFIG = join(TEST_DIR, 'gitconfig');
process.env.GIT_CONFIG_GLOBAL = GITCONFIG;
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

function git(args: string, dates?: string): string {
  const env = dates
    ? { ...process.env, GIT_AUTHOR_DATE: dates, GIT_COMMITTER_DATE: dates }
    : process.env;
  return execSync(`git -C "${REPO}" ${args}`, { encoding: 'utf-8', windowsHide: true, env }).trim();
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

  // Firmly outside any working-day window regardless of when the test runs.
  const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  git('init');
  writeFileSync(join(REPO, 'base.txt'), 'line\n'.repeat(10));
  git('add .');
  git('commit -m "init"', twoDaysAgo);
  git('checkout -b atemnov/ATL-2-ledger');

  // Branch history that predates the daemon: a commit from two days ago
  // (+100 lines) and a commit made earlier today (+30 lines).
  writeFileSync(join(REPO, 'old-work.ts'), 'old\n'.repeat(100));
  git('add .');
  git('commit -m "ATL-2 yesterday work"', twoDaysAgo);
  writeFileSync(join(REPO, 'today.ts'), 'early\n'.repeat(30));
  git('add .');
  git('commit -m "ATL-2 before daemon"');

  const gitTracker = new GitTracker(config, secrets);
  let sessions = new SessionTracker(config);

  const tick = async (): Promise<PollResult | undefined> => {
    const baseShas = sessions.getBaseShasPerRepoPath(config.repos);
    const ledgerQueries = sessions.getLedgerQueries(config.repos);
    const results = await gitTracker.pollAll(baseShas, ledgerQueries);
    for (const r of results) sessions.processPollResult(r);
    return results[0];
  };

  const evidence = () => {
    const open = sessions.getOpenSessions();
    assert.equal(open.length, 1, 'expected one open session');
    return open[0].evidence;
  };

  // ── Seed: daemon starts on a branch with history ───────────────────────
  await tick();

  check('seed counts today\'s pre-daemon commit, not older branch work', () => {
    const ev = evidence();
    assert.equal(ev.commits, 1, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 30, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Commit + squash between two polls (the original bug) ──────────────
  writeFileSync(join(REPO, 'f1.ts'), 'one\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-2 c1"');
  writeFileSync(join(REPO, 'f2.ts'), 'two\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-2 c2"');
  git('reset --soft HEAD~2');
  git('commit -m "ATL-2 squashed"');
  await tick(); // ONE tick sees all four operations

  check('commit + commit + squash inside one tick nets exactly +1', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 50, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Amend with content, then reword ────────────────────────────────────
  appendFileSync(join(REPO, 'f1.ts'), 'amend\n'.repeat(5));
  git('add .');
  git('commit --amend --no-edit');
  await tick();

  check('content amend does not change the commit count', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 55, `linesAdded = ${ev.linesAdded}`);
  });

  git('commit --amend -m "ATL-2 squashed (reworded)"');
  await tick();

  check('reword does not change the commit count', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
  });

  // ── Dropped commit: reset --hard between polls ─────────────────────────
  writeFileSync(join(REPO, 'discard.ts'), 'drop\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-2 to be dropped"');
  await tick();

  check('new commit counts before being dropped', () => {
    const ev = evidence();
    assert.equal(ev.commits, 3, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 65, `linesAdded = ${ev.linesAdded}`);
  });

  git('reset --hard HEAD~1');
  await tick();

  check('hard reset of a session commit decrements the count', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 55, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Daemon restart: operations happen while no polls run ───────────────
  sessions.closeAllSessions(ClosedBy.DaemonCrash);
  const persistedLog = sessions.getDailyLog();

  writeFileSync(join(REPO, 'f4.ts'), 'four\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-2 c4"');
  writeFileSync(join(REPO, 'f5.ts'), 'five\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-2 c5"');
  git('reset --soft HEAD~2');
  git('commit -m "ATL-2 downtime squashed"');

  sessions = new SessionTracker(config, persistedLog);
  await tick();

  check('downtime operations replay from the branch reflog after restart', () => {
    const ev = evidence();
    assert.equal(ev.commits, 3, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 75, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Squash everything, including pre-day commits ───────────────────────
  git('reset --soft master');
  git('commit -m "ATL-2 all squashed"');
  await tick();

  check('squash into pre-day history keeps exactly one session commit', () => {
    const ev = evidence();
    assert.equal(ev.commits, 1, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 75, `linesAdded = ${ev.linesAdded}`);
  });

  // ── Merge to master mid-session: merged work survives ─────────────────
  git('checkout master');
  await tick(); // closes the session (generic branch)
  git('merge --ff-only atemnov/ATL-2-ledger');
  git('checkout atemnov/ATL-2-ledger');
  await tick(); // reopens the session, ledger inherited

  check('commit merged into master stays counted', () => {
    const ev = evidence();
    assert.equal(ev.commits, 1, `commits = ${ev.commits}`);
  });

  writeFileSync(join(REPO, 'after-merge.ts'), 'post\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-2 after merge"');
  await tick();

  check('work continues counting after the merge', () => {
    const ev = evidence();
    assert.equal(ev.commits, 2, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 10, `linesAdded = ${ev.linesAdded}`);
  });

  // ── rebase -i squash of a today-commit INTO a pre-day commit ───────────
  // The squashed result keeps the OLD commit's author date, so only the
  // tree match (which sees the whole removed chain) keeps today's work
  // counted — the user rule: such a squash must NOT decrement.
  git('checkout -b atemnov/ATL-3-mixed master');
  writeFileSync(join(REPO, 'mixed.ts'), 'pre\n'.repeat(20));
  git('add .');
  git('commit -m "ATL-3 old base"', twoDaysAgo);
  appendFileSync(join(REPO, 'mixed.ts'), 'new\n'.repeat(10));
  git('add .');
  git('commit -m "ATL-3 today fix"');
  await tick(); // new session on ATL-3

  check('new task session seeds with one today-commit', () => {
    const ev = evidence();
    assert.equal(ev.commits, 1, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 10, `linesAdded = ${ev.linesAdded}`);
  });

  execSync(`git -C "${REPO}" rebase -i master`, {
    encoding: 'utf-8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_SEQUENCE_EDITOR: `sed -i -e '2s/^pick/squash/'`,
      GIT_EDITOR: 'true',
    },
  });
  await tick();

  check('rebase-squash into a pre-day commit keeps the count', () => {
    const ev = evidence();
    assert.equal(ev.commits, 1, `commits = ${ev.commits}`);
    assert.equal(ev.linesAdded, 10, `linesAdded = ${ev.linesAdded}`);
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
