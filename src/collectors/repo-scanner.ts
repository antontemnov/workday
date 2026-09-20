import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REPO_SCAN_MAX_DEPTH, REPO_SCAN_MAX_DIRS, REPO_SCAN_MAX_RESULTS, REPO_SCAN_SKIP_DIRS } from '../core/constants.js';

export interface RepoScanResult {
  readonly repos: readonly string[];
  // A cap was hit — the list may be incomplete.
  readonly truncated: boolean;
}

/** Comparison key for a repo path: same folder → same key on any spelling. */
export function repoPathKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * True for a real working tree: `.git` directory with HEAD inside, or a
 * `.git` file pointing to a gitdir (linked worktree / submodule).
 */
export async function isGitRepo(path: string): Promise<boolean> {
  const gitPath = join(path, '.git');
  try {
    const info = await stat(gitPath);
    if (info.isDirectory()) {
      await stat(join(gitPath, 'HEAD'));
      return true;
    }
    const content = await readFile(gitPath, 'utf-8');
    return content.startsWith('gitdir:');
  } catch {
    return false;
  }
}

/**
 * Finds git repos under a root folder, breadth-first. A found repo is not
 * descended into, so submodules and nested clones stay out. Symlinks and
 * junctions are never followed.
 */
export async function scanForRepos(root: string): Promise<RepoScanResult> {
  const repos: string[] = [];
  let visited = 0;
  let level: string[] = [root];

  for (let depth = 1; depth <= REPO_SCAN_MAX_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const child of await listSubdirs(dir)) {
        if (++visited > REPO_SCAN_MAX_DIRS) return { repos, truncated: true };
        if (await isGitRepo(child)) {
          repos.push(child);
          if (repos.length >= REPO_SCAN_MAX_RESULTS) return { repos, truncated: true };
        } else {
          next.push(child);
        }
      }
    }
    level = next;
  }

  return { repos, truncated: false };
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !REPO_SCAN_SKIP_DIRS.includes(e.name))
      .map(e => join(dir, e.name))
      .sort();
  } catch {
    return [];
  }
}
