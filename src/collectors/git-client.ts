import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { RawGitOutput } from '../core/types.js';
import { GIT_BATCH_SEPARATOR, GIT_MAX_BUFFER_BYTES } from '../core/constants.js';

const execAsync = promisify(exec);

/**
 * Low-level git command executor.
 * Runs batched git calls and returns raw output split by sections.
 */
export class GitClient {
  private readonly reflogCount: number;

  public constructor(reflogCount: number = 20) {
    this.reflogCount = reflogCount;
  }

  /**
   * Execute batched git command for a single repo.
   * Always: branch name, current HEAD SHA, working-tree diff, untracked status, reflog.
   * When baseSha is provided: also a diff and commit count vs that base — used
   * for PR-equivalent evidence stats on the open session. The caller passes the
   * fresh merge-base with the default branch here when available (rebase-stable),
   * falling back to the session's sticky baseSha.
   * ~80–120ms per repo.
   */
  public async fetchRepoState(
    repoPath: string,
    baseSha?: string,
  ): Promise<RawGitOutput> {
    if (!existsSync(repoPath)) {
      throw new Error(`Repo path not found: ${repoPath}`);
    }

    const parts = [
      `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" rev-parse HEAD`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" diff --numstat`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" status --porcelain`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" reflog -${this.reflogCount} --date=iso --format="%gd %gs"`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" ls-files --others --exclude-standard`,
    ];

    if (baseSha) {
      parts.push(
        `echo ${GIT_BATCH_SEPARATOR}`,
        // diff against baseSha — working tree + staged + committed since base.
        // Untracked files are intentionally not counted (per project decision).
        `git -C "${repoPath}" diff ${baseSha} --numstat`,
        `echo ${GIT_BATCH_SEPARATOR}`,
        // Counts real commits in graph between base and HEAD. `git commit --amend`
        // rewrites the tip, so this still returns 1 — not 2 like the reflog scan.
        `git -C "${repoPath}" rev-list ${baseSha}..HEAD --count`,
      );
    }

    const cmd = parts.join(' && ');

    try {
      const { stdout } = await execAsync(cmd, { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true });
      return GitClient.parseSections(stdout, baseSha !== undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // index.lock = git is busy, caller should skip this tick
      if (message.includes('index.lock')) {
        throw new Error(`Git is locked in ${repoPath} (index.lock exists)`);
      }

      // baseSha can become invalid after a hard reset / force-push — fall back
      // to a baseless fetch; the next tick recaptures a base.
      if (baseSha && (message.includes('unknown revision') || message.includes('bad revision'))) {
        return this.fetchRepoState(repoPath, undefined);
      }

      throw new Error(`Git command failed for ${repoPath}: ${message}`);
    }
  }

  /**
   * `git merge-base HEAD <ref>` — the point where the current branch diverges
   * from the default branch. Null when histories are unrelated, the ref is
   * gone, or git is busy. Resolved fresh every tick so evidence diffs never
   * run against a stale merge-base (the staleness was exactly what inflated
   * line counts after rebases).
   */
  public async getMergeBase(repoPath: string, ref: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`git -C "${repoPath}" merge-base HEAD ${ref}`, {
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      const sha = stdout.trim();
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** Verify that a ref exists locally (`git rev-parse --verify`). */
  public async refExists(repoPath: string, ref: string): Promise<boolean> {
    try {
      await execAsync(`git -C "${repoPath}" rev-parse --verify --quiet ${ref}`, {
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read `git symbolic-ref refs/remotes/origin/HEAD` and return its short name
   * (e.g. "master" or "main"). Null when the symbolic ref is not configured —
   * typical for shallow clones or repos that never had origin/HEAD set.
   */
  public async detectDefaultBranchName(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync(
        `git -C "${repoPath}" symbolic-ref refs/remotes/origin/HEAD`,
        { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      );
      const trimmed = stdout.trim();           // refs/remotes/origin/master
      const parts = trimmed.split('/');
      const name = parts[parts.length - 1];
      return name && name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  private static parseSections(raw: string, withBase: boolean): RawGitOutput {
    const normalized = raw.replace(/\r\n/g, '\n');
    // Windows echo may add trailing space: "---WORKDAY-SEP--- \n"
    const sections = normalized.split(new RegExp(GIT_BATCH_SEPARATOR + '\\s*\\n'));

    let idx = 6; // fixed: branch, head, diff, status, reflog, untracked
    const diffSinceBase = withBase ? (sections[idx++] ?? '').trim() : undefined;
    const commitsSinceBase = withBase ? (sections[idx++] ?? '').trim() : undefined;

    return {
      branch: (sections[0] ?? '').trim(),
      currentHead: (sections[1] ?? '').trim(),
      diffNumstat: (sections[2] ?? '').trim(),
      statusPorcelain: (sections[3] ?? '').trim(),
      reflog: (sections[4] ?? '').trim(),
      untrackedFiles: (sections[5] ?? '').trim(),
      diffSinceBase,
      commitsSinceBase,
    };
  }
}
