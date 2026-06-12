import { createHash } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChurnFile } from '../core/types.js';
import { CHURN_MAX_FILES, CHURN_MAX_FILE_BYTES } from '../core/constants.js';

/**
 * Builds the per-file churn map for one tick.
 *
 * Inputs:
 * - diffFiles — per-file numstat of the evidence diff (committed + staged +
 *   worktree vs the fresh merge-base / baseSha). These files get a content
 *   hash only when their diff numbers are flat vs the previous tick — that's
 *   the only case where a hash is needed to detect rewrite-in-place.
 * - untrackedPaths — brand-new files invisible to any git diff. Read from
 *   disk: line count becomes their "added", content hash detects edits.
 *
 * Unreadable / oversized / binary files get hash = null (and untracked ones
 * are skipped entirely) — they simply don't contribute churn.
 */
export async function buildChurnFiles(
  repoPath: string,
  diffFiles: ReadonlyMap<string, { readonly added: number; readonly removed: number }>,
  untrackedPaths: readonly string[],
  previous: ReadonlyMap<string, ChurnFile> | null,
): Promise<Map<string, ChurnFile>> {
  const result = new Map<string, ChurnFile>();
  let budget = CHURN_MAX_FILES;

  for (const [path, nums] of diffFiles) {
    const prev = previous?.get(path);
    const flat = prev !== undefined && prev.added === nums.added && prev.removed === nums.removed;
    let hash: string | null = null;
    if (flat && budget > 0) {
      budget--;
      hash = await hashFile(join(repoPath, path));
    }
    result.set(path, { added: nums.added, removed: nums.removed, hash });
  }

  for (const path of untrackedPaths) {
    if (budget <= 0) break;
    budget--;
    const entry = await readUntracked(join(repoPath, path));
    if (entry) {
      result.set(path, entry);
    }
  }

  return result;
}

async function hashFile(absPath: string): Promise<string | null> {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size > CHURN_MAX_FILE_BYTES) return null;
    const content = await readFile(absPath);
    return createHash('sha1').update(content).digest('hex');
  } catch {
    return null; // deleted / permission / race — no churn evidence
  }
}

async function readUntracked(absPath: string): Promise<ChurnFile | null> {
  try {
    const st = await stat(absPath);
    if (!st.isFile() || st.size > CHURN_MAX_FILE_BYTES) return null;
    const content = await readFile(absPath);
    if (content.subarray(0, 8000).includes(0)) return null; // binary
    let lines = 0;
    for (const byte of content) {
      if (byte === 10) lines++;
    }
    if (content.length > 0 && content[content.length - 1] !== 10) lines++;
    return {
      added: lines,
      removed: 0,
      hash: createHash('sha1').update(content).digest('hex'),
    };
  } catch {
    return null;
  }
}
