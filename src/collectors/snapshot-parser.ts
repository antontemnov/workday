import type { RawGitOutput, GitSnapshot, GitDelta } from '../core/types.js';

/**
 * Parses git diff --numstat and status --porcelain output into GitSnapshot.
 * Computes delta between consecutive snapshots.
 *
 * New logic (not in legacy) — diff dynamics is the primary activity signal.
 */
export class SnapshotParser {
  /**
   * Parse raw git output into a typed snapshot.
   *
   * diff --numstat format: "added\tremoved\tfilename" per line
   * status --porcelain: "?? filename" for untracked files
   */
  public parseSnapshot(raw: RawGitOutput, timestamp: number): GitSnapshot {
    const { added, removed, fileCount } = SnapshotParser.parseDiffNumstat(raw.diffNumstat);
    const untrackedCount = SnapshotParser.parseUntrackedCount(raw.statusPorcelain);

    return {
      branch: raw.branch,
      trackedLines: { added, removed },
      trackedFileCount: fileCount,
      untrackedCount,
      timestamp,
    };
  }

  /**
   * Compute delta between previous and current snapshot.
   * Delta = change in tracked lines + change in untracked file count.
   *
   * Returns null delta (hasDynamics=false) if previous is null (first tick after start).
   */
  public computeDelta(previous: GitSnapshot | null, current: GitSnapshot): GitDelta {
    if (previous === null) {
      // First tick = baseline, no dynamics
      return { addedDelta: 0, removedDelta: 0, untrackedDelta: 0, hasDynamics: false };
    }

    const addedDelta = current.trackedLines.added - previous.trackedLines.added;
    const removedDelta = current.trackedLines.removed - previous.trackedLines.removed;
    const untrackedDelta = current.untrackedCount - previous.untrackedCount;

    const hasDynamics = addedDelta !== 0 || removedDelta !== 0 || untrackedDelta !== 0;

    return { addedDelta, removedDelta, untrackedDelta, hasDynamics };
  }

  /**
   * Parse "git diff --numstat" output.
   * Each line: "added\tremoved\tfilename"
   * Binary files show "-\t-\tfilename" → skip.
   */
  private static parseDiffNumstat(text: string): { readonly added: number; readonly removed: number; readonly fileCount: number } {
    if (!text) return { added: 0, removed: 0, fileCount: 0 };

    let added = 0;
    let removed = 0;
    let fileCount = 0;

    for (const line of text.split('\n')) {
      const match = line.match(/^(\d+)\t(\d+)\t/);
      if (!match) continue; // skip binary files or empty lines
      added += parseInt(match[1], 10);
      removed += parseInt(match[2], 10);
      fileCount++;
    }

    return { added, removed, fileCount };
  }

  /**
   * Count untracked files from "git status --porcelain" output.
   * Untracked files start with "?? ".
   */
  private static parseUntrackedCount(text: string): number {
    if (!text) return 0;

    let count = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('?? ')) {
        count++;
      }
    }
    return count;
  }
}
