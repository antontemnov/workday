import type { RawGitOutput, GitSnapshot, GitDelta, ChurnFile } from '../core/types.js';
import { IN_PLACE_CHURN_LINES } from '../core/constants.js';

/**
 * Parses git diff --numstat and status --porcelain output into GitSnapshot.
 * Computes delta between consecutive snapshots.
 *
 * Activity volume (delta.magnitude) is measured per file over the churn map,
 * never over summed totals — totals net out cross-file movement and are blind
 * to rewrites of already-modified lines and to untracked files.
 */
export class SnapshotParser {
  /**
   * Parse raw git output into a typed snapshot.
   *
   * diff --numstat format: "added\tremoved\tfilename" per line
   * status --porcelain: "?? filename" for untracked files
   * churnFiles: built by churn-scanner from the evidence diff + untracked files
   */
  public static parseSnapshot(
    raw: RawGitOutput,
    timestamp: number,
    churnFiles: ReadonlyMap<string, ChurnFile> = new Map(),
  ): GitSnapshot {
    const { added, removed, fileCount } = SnapshotParser.parseDiffNumstat(raw.diffNumstat).totals;
    const untrackedCount = SnapshotParser.parseUntrackedCount(raw.statusPorcelain);

    return {
      branch: raw.branch,
      trackedLines: { added, removed },
      trackedFileCount: fileCount,
      untrackedCount,
      timestamp,
      churnFiles,
    };
  }

  /**
   * Compute delta between previous and current snapshot.
   *
   * addedDelta/removedDelta/untrackedDelta keep the worktree-totals semantics
   * (used for signal logging). magnitude is the real churn estimate:
   * - per-file |Δadded| + |Δremoved| across the churn map;
   * - a file entering the map counts whole (new untracked file, first edit);
   * - a file leaving counts its last known size (revert / re-anchor);
   * - a flat file whose content hash changed counts IN_PLACE_CHURN_LINES.
   *
   * Returns null delta (hasDynamics=false) if previous is null (first tick after start)
   * or the branch changed — churn maps are anchored per branch (evidence diff vs
   * merge-base), so a cross-branch comparison would count the union of both diffs
   * as activity and a bare checkout would birth a session.
   */
  public static computeDelta(previous: GitSnapshot | null, current: GitSnapshot): GitDelta {
    if (previous === null || previous.branch !== current.branch) {
      // Baseline tick, no dynamics
      return { addedDelta: 0, removedDelta: 0, untrackedDelta: 0, hasDynamics: false, magnitude: 0 };
    }

    const addedDelta = current.trackedLines.added - previous.trackedLines.added;
    const removedDelta = current.trackedLines.removed - previous.trackedLines.removed;
    const untrackedDelta = current.untrackedCount - previous.untrackedCount;

    const magnitude = SnapshotParser.computeChurnMagnitude(previous.churnFiles, current.churnFiles);

    const hasDynamics = magnitude > 0 || addedDelta !== 0 || removedDelta !== 0 || untrackedDelta !== 0;

    return { addedDelta, removedDelta, untrackedDelta, hasDynamics, magnitude };
  }

  private static computeChurnMagnitude(
    prev: ReadonlyMap<string, ChurnFile>,
    cur: ReadonlyMap<string, ChurnFile>,
  ): number {
    let magnitude = 0;

    for (const [path, c] of cur) {
      const p = prev.get(path);
      if (p === undefined) {
        magnitude += c.added + c.removed;
        continue;
      }
      const d = Math.abs(c.added - p.added) + Math.abs(c.removed - p.removed);
      if (d > 0) {
        magnitude += d;
      } else if (c.hash !== null && p.hash !== null && c.hash !== p.hash) {
        magnitude += IN_PLACE_CHURN_LINES;
      }
    }

    for (const [path, p] of prev) {
      if (!cur.has(path)) {
        magnitude += p.added + p.removed;
      }
    }

    return magnitude;
  }

  /**
   * Public alias — used by GitTracker to parse a `diff <base> --numstat`
   * output for the PR-equivalent evidence snapshot and the churn file map.
   */
  public static parseDiffNumstatFiles(text: string): {
    readonly totals: { readonly added: number; readonly removed: number; readonly fileCount: number };
    readonly files: ReadonlyMap<string, { readonly added: number; readonly removed: number }>;
  } {
    return SnapshotParser.parseDiffNumstat(text);
  }

  /**
   * Parse "git diff --numstat" output.
   * Each line: "added\tremoved\tfilename"
   * Binary files show "-\t-\tfilename" → skip.
   * Unusual paths come quoted from git — quotes are stripped (escapes kept:
   * keys only need to be stable between ticks; fs reads on them just miss).
   */
  private static parseDiffNumstat(text: string): {
    readonly totals: { readonly added: number; readonly removed: number; readonly fileCount: number };
    readonly files: ReadonlyMap<string, { readonly added: number; readonly removed: number }>;
  } {
    const files = new Map<string, { added: number; removed: number }>();
    let added = 0;
    let removed = 0;
    let fileCount = 0;

    if (text) {
      for (const line of text.split('\n')) {
        const match = line.match(/^(\d+)\t(\d+)\t(.+)$/);
        if (!match) continue; // skip binary files or empty lines
        const a = parseInt(match[1], 10);
        const r = parseInt(match[2], 10);
        let path = match[3];
        if (path.startsWith('"') && path.endsWith('"')) {
          path = path.slice(1, -1);
        }
        added += a;
        removed += r;
        fileCount++;
        files.set(path, { added: a, removed: r });
      }
    }

    return { totals: { added, removed, fileCount }, files };
  }

  /** Parse `git ls-files --others --exclude-standard` output into paths. */
  public static parseUntrackedList(text: string): string[] {
    if (!text) return [];
    const paths: string[] = [];
    for (const line of text.split('\n')) {
      let path = line.trim();
      if (!path) continue;
      if (path.startsWith('"') && path.endsWith('"')) {
        path = path.slice(1, -1);
      }
      paths.push(path);
    }
    return paths;
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
