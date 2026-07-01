import type {
  BranchTransition,
  LedgerQuery,
  LedgerUpdate,
  ReflogPointer,
} from '../core/types.js';
import { GitClient } from './git-client.js';

/**
 * Reflog entries fetched per tick. Far above any realistic number of branch
 * operations between two polls (or across a same-day daemon restart) — when
 * the stored pointer still falls outside this window, the collector degrades
 * to a resync instead of replaying.
 */
const REFLOG_WINDOW = 200;

/**
 * Builds the per-tick LedgerUpdate for a repo: seeds a fresh ledger when no
 * session context exists yet, otherwise turns branch-reflog entries since
 * the stored pointer into old→new transitions with full commit metadata.
 *
 * Everything is computed relative to the default branch: commits reachable
 * from it are never "added" (upstream work entering via merge/rebase) and
 * never "removed" (own work merged upstream survives squashes of the local
 * branch).
 */
export async function collectLedgerUpdate(
  gitClient: GitClient,
  repoPath: string,
  branch: string,
  mergeBaseSha: string,
  defaultBranchRef: string,
  query: LedgerQuery | null,
): Promise<LedgerUpdate | null> {
  const reflog = await gitClient.getBranchReflog(repoPath, branch, REFLOG_WINDOW);
  if (reflog.length === 0) {
    // No branch reflog (core.logAllRefUpdates off) — ledger can't work here.
    return null;
  }
  const currentPointer: ReflogPointer = { sha: reflog[0].sha, ts: reflog[0].ts };

  if (query === null || query.branch !== branch || query.pointer === null) {
    return buildSeed(gitClient, repoPath, mergeBaseSha, currentPointer);
  }

  // Newest occurrence of the stored pointer. Entries above it are unprocessed.
  const pointerIndex = reflog.findIndex(
    e => e.sha === query.pointer!.sha && e.ts === query.pointer!.ts,
  );
  if (pointerIndex === -1) {
    // Pointer fell out of the window (long downtime / reflog expired) —
    // rebuild flags from the current branch state instead of replaying.
    return buildResync(gitClient, repoPath, mergeBaseSha, defaultBranchRef, query, currentPointer);
  }

  const transitions: BranchTransition[] = [];
  let oldSha = query.pointer.sha;
  for (let i = pointerIndex - 1; i >= 0; i--) {
    const entry = reflog[i];
    if (entry.sha !== oldSha) {
      const removedShas = await gitClient.revListShas(repoPath, oldSha, [entry.sha, defaultBranchRef]);
      const addedShas = await gitClient.revListShas(repoPath, entry.sha, [oldSha, defaultBranchRef]);
      const added = await gitClient.getCommitsMeta(repoPath, addedShas);
      transitions.push({ ts: entry.ts, removedShas, added });
    }
    oldSha = entry.sha;
  }

  return { kind: 'transitions', transitions, pointer: currentPointer };
}

/**
 * Fresh ledger: all commits currently on the branch (vs merge-base). The
 * SessionTracker marks them pre-session at apply time — a new session always
 * starts counting from zero.
 */
async function buildSeed(
  gitClient: GitClient,
  repoPath: string,
  mergeBaseSha: string,
  pointer: ReflogPointer,
): Promise<LedgerUpdate> {
  const shas = await gitClient.revListShas(repoPath, 'HEAD', [mergeBaseSha]);
  const commits = await gitClient.getCommitsMeta(repoPath, shas);
  return { kind: 'seed', commits, pointer };
}

async function buildResync(
  gitClient: GitClient,
  repoPath: string,
  mergeBaseSha: string,
  defaultBranchRef: string,
  query: LedgerQuery,
  pointer: ReflogPointer,
): Promise<LedgerUpdate> {
  const liveShas = await gitClient.revListShas(repoPath, 'HEAD', [mergeBaseSha]);
  const liveSet = new Set(liveShas);

  const mergedShas: string[] = [];
  for (const sha of query.knownShas) {
    if (!liveSet.has(sha) && await gitClient.isAncestor(repoPath, sha, defaultBranchRef)) {
      mergedShas.push(sha);
    }
  }

  const known = new Set(query.knownShas);
  const unknownShas = liveShas.filter(sha => !known.has(sha));
  const unknownCommits = await gitClient.getCommitsMeta(repoPath, unknownShas);

  return { kind: 'resync', liveShas, mergedShas, unknownCommits, pointer };
}
