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
   * One process spawn: rev-parse + diff --numstat + status --porcelain + reflog.
   * ~80ms per repo.
   */
  public async fetchRepoState(repoPath: string): Promise<RawGitOutput> {
    if (!existsSync(repoPath)) {
      throw new Error(`Repo path not found: ${repoPath}`);
    }

    const cmd = [
      `git -C "${repoPath}" rev-parse --abbrev-ref HEAD`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" diff --numstat`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" status --porcelain`,
      `echo ${GIT_BATCH_SEPARATOR}`,
      `git -C "${repoPath}" reflog -${this.reflogCount} --date=iso --format="%gd %gs"`,
    ].join(' && ');

    try {
      const { stdout } = await execAsync(cmd, { maxBuffer: GIT_MAX_BUFFER_BYTES, windowsHide: true });
      return GitClient.parseSections(stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // index.lock = git is busy, caller should skip this tick
      if (message.includes('index.lock')) {
        throw new Error(`Git is locked in ${repoPath} (index.lock exists)`);
      }

      throw new Error(`Git command failed for ${repoPath}: ${message}`);
    }
  }

  private static parseSections(raw: string): RawGitOutput {
    const normalized = raw.replace(/\r\n/g, '\n');
    // Windows echo may add trailing space: "---WORKDAY-SEP--- \n"
    const sections = normalized.split(new RegExp(GIT_BATCH_SEPARATOR + '\\s*\\n'));

    return {
      branch: (sections[0] ?? '').trim(),
      diffNumstat: (sections[1] ?? '').trim(),
      statusPorcelain: (sections[2] ?? '').trim(),
      reflog: (sections[3] ?? '').trim(),
    };
  }
}
