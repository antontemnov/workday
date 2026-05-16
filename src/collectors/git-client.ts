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
   * for PR-equivalent evidence stats on the open session.
   * ~80–100ms per repo.
   */
  public async fetchRepoState(repoPath: string, baseSha?: string): Promise<RawGitOutput> {
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
      // to a baseless fetch so the caller can re-capture a fresh baseSha.
      if (baseSha && (message.includes('unknown revision') || message.includes('bad revision'))) {
        return this.fetchRepoState(repoPath);
      }

      throw new Error(`Git command failed for ${repoPath}: ${message}`);
    }
  }

  private static parseSections(raw: string, withBase: boolean): RawGitOutput {
    const normalized = raw.replace(/\r\n/g, '\n');
    // Windows echo may add trailing space: "---WORKDAY-SEP--- \n"
    const sections = normalized.split(new RegExp(GIT_BATCH_SEPARATOR + '\\s*\\n'));

    return {
      branch: (sections[0] ?? '').trim(),
      currentHead: (sections[1] ?? '').trim(),
      diffNumstat: (sections[2] ?? '').trim(),
      statusPorcelain: (sections[3] ?? '').trim(),
      reflog: (sections[4] ?? '').trim(),
      diffSinceBase: withBase ? (sections[5] ?? '').trim() : undefined,
      commitsSinceBase: withBase ? (sections[6] ?? '').trim() : undefined,
    };
  }
}
