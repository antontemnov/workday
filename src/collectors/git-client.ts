import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { RawGitOutput, CommitMeta } from '../core/types.js';
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

  /**
   * Branch reflog entries, newest first: [{sha (new value of the ref),
   * ts (when the move happened), message}]. Every branch-tip move —
   * commit, amend, rebase finish, reset, merge — writes exactly one entry,
   * so consecutive entries form the complete old→new transition journal.
   * Empty array when the branch has no reflog (core.logAllRefUpdates off).
   */
  public async getBranchReflog(
    repoPath: string,
    branch: string,
    count: number,
  ): Promise<Array<{ sha: string; ts: number; message: string }>> {
    try {
      const { stdout } = await execAsync(
        `git -C "${repoPath}" reflog show "${branch}" -${count} --format="%H|%gd|%gs" --date=unix`,
        { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      );
      const entries: Array<{ sha: string; ts: number; message: string }> = [];
      for (const line of stdout.split('\n')) {
        const match = line.match(/^([0-9a-f]{40})\|.*@\{(\d+)\}\|(.*)$/);
        if (!match) continue;
        entries.push({ sha: match[1], ts: parseInt(match[2], 10), message: match[3] });
      }
      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Batched commit metadata. Works for unreachable SHAs too (squashed-away
   * commits stay in the object db until gc — reflog entries protect them),
   * which is exactly what transition replay needs. SHAs whose objects are
   * gone are silently omitted.
   */
  public async getCommitsMeta(repoPath: string, shas: readonly string[]): Promise<CommitMeta[]> {
    if (shas.length === 0) return [];
    const metas: CommitMeta[] = [];
    // Chunk to keep the command line comfortably short.
    for (let i = 0; i < shas.length; i += 50) {
      const chunk = shas.slice(i, i + 50);
      let stdout: string;
      try {
        ({ stdout } = await execAsync(
          `git -C "${repoPath}" show -s --format="%H|%T|%P|%ae|%at|%ct" ${chunk.join(' ')}`,
          { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
        ));
      } catch {
        // One bad SHA fails the whole batch — retry individually, skip the dead.
        stdout = '';
        for (const sha of chunk) {
          try {
            const single = await execAsync(
              `git -C "${repoPath}" show -s --format="%H|%T|%P|%ae|%at|%ct" ${sha}`,
              { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
            );
            stdout += single.stdout + '\n';
          } catch { /* object gone — skip */ }
        }
      }
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split('|');
        if (parts.length !== 6 || !/^[0-9a-f]{40}$/.test(parts[0])) continue;
        metas.push({
          sha: parts[0],
          tree: parts[1],
          parentCount: parts[2] === '' ? 0 : parts[2].split(' ').length,
          authorEmail: parts[3],
          authorTs: parseInt(parts[4], 10),
          committerTs: parseInt(parts[5], 10),
        });
      }
    }
    return metas;
  }

  /**
   * `git rev-list include ^exclude ...` — SHAs reachable from `include` but
   * none of `excludes`, parent-first (oldest first). Empty on any git error.
   */
  public async revListShas(
    repoPath: string,
    include: string,
    excludes: readonly string[],
  ): Promise<string[]> {
    const excludeArgs = excludes.map(e => `"^${e}"`).join(' ');
    try {
      const { stdout } = await execAsync(
        `git -C "${repoPath}" rev-list --reverse ${include} ${excludeArgs}`,
        { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      );
      return stdout.split('\n').map(s => s.trim()).filter(s => /^[0-9a-f]{40}$/.test(s));
    } catch {
      return [];
    }
  }

  /** `git merge-base --is-ancestor sha ref` — true when sha is reachable from ref. */
  public async isAncestor(repoPath: string, sha: string, ref: string): Promise<boolean> {
    try {
      await execAsync(`git -C "${repoPath}" merge-base --is-ancestor ${sha} ${ref}`, {
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Raw `git diff from to --numstat` output. Empty string on error. */
  public async diffNumstat(repoPath: string, from: string, to: string): Promise<string> {
    try {
      const { stdout } = await execAsync(
        `git -C "${repoPath}" diff ${from} ${to} --numstat`,
        { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true },
      );
      return stdout.trim();
    } catch {
      return '';
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
