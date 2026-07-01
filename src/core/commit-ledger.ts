import type {
  BranchTransition,
  CommitLedgerState,
  CommitMeta,
  LedgerCommit,
  LedgerUpdate,
} from './types.js';

/**
 * Commit ledger — exact accounting of "how many commits did this session
 * actually produce", robust to any git operation happening between polls.
 *
 * The 30-second poll can never reconstruct events from counter samples:
 * commit + squash inside one tick shows a net jump of 0 or +1. So instead
 * of counting, the ledger tracks commit *identities* and replays the branch
 * reflog — a complete, persistent journal of every branch-tip move — one
 * transition at a time. Each transition is small and unambiguous.
 *
 * The counter is strictly session-scoped: a fresh session starts at zero,
 * seeded with everything already on the branch as pre-session, and nothing
 * done outside a session (daemon down, session closed) is ever counted.
 *
 * Rewrite matching cascade for a commit that appears in a transition:
 *   0. Known SHA            → resurrect (reset back to an old tip).
 *   1. Tree match           → squash: the new commit's tree equals the tree
 *      of a commit removed earlier; it absorbs the whole chain removed in
 *      that same transition and inherits sessionCreated as OR over the
 *      chain. This is why squashing a session commit INTO a pre-session
 *      commit keeps the counter (the session's work survived, inside a
 *      rewritten commit), while squashing two session commits drops 2 → 1.
 *   2. (authorEmail, authorTs) match → rebase pick / amend / reword: git
 *      preserves the author timestamp through these, so the rewritten
 *      commit inherits the original's membership. Rebasing pre-session
 *      commits does NOT count them (committer ts is fresh but the author
 *      identity says "old").
 *   3. No match             → genuinely new commit; counts when its
 *      committer timestamp falls after the session started (`isSessionTs`).
 *
 * Commits merged into the default branch never appear as "removed" (the
 * collector excludes ^defaultRef), so merged work stays counted — it is
 * the most real work of all.
 */

/** Number of live commits created within this session. */
export function countSessionCommits(state: CommitLedgerState): number {
  let count = 0;
  for (const commit of state.commits) {
    if (commit.live && commit.sessionCreated) count++;
  }
  return count;
}

/**
 * Apply one poll's ledger update. `countsAsSession(meta)` decides whether an
 * unmatched commit was created by this session — typically: committer
 * timestamp after the session opened (minus a small slack, so the commit
 * that itself triggered the session counts) and not already accounted for
 * by an earlier session's ledger.
 */
export function applyLedgerUpdate(
  state: CommitLedgerState,
  update: LedgerUpdate,
  countsAsSession: (meta: CommitMeta) => boolean,
): void {
  switch (update.kind) {
    case 'seed':
      seedLedger(state, update.commits, countsAsSession);
      break;
    case 'transitions':
      for (const transition of update.transitions) {
        applyTransition(state, transition, countsAsSession);
      }
      break;
    case 'resync':
      applyResync(state, update.liveShas, update.mergedShas, update.unknownCommits, countsAsSession);
      break;
  }
  state.pointer = update.pointer;
}

/**
 * Seed a fresh ledger from the commits currently on the branch. Everything
 * already there is pre-session (counter starts at zero) — except commits
 * landing within the slack window right before the session opened, i.e. the
 * commit that itself triggered the session.
 */
function seedLedger(
  state: CommitLedgerState,
  commits: readonly CommitMeta[],
  countsAsSession: (meta: CommitMeta) => boolean,
): void {
  for (const meta of commits) {
    if (findCommit(state, meta.sha)) continue;
    state.commits.push(newLedgerCommit(meta, meta.parentCount < 2 && countsAsSession(meta)));
  }
}

function applyTransition(
  state: CommitLedgerState,
  transition: BranchTransition,
  countsAsSession: (meta: CommitMeta) => boolean,
): void {
  const seq = ++state.seq;

  // 1. Commits that left the branch (and are not on the default branch).
  for (const sha of transition.removedShas) {
    const entry = findCommit(state, sha);
    if (entry && entry.live) {
      entry.live = false;
      entry.removedAtSeq = seq;
    }
  }

  // 2. Commits that entered the branch, parent-first.
  for (const meta of transition.added) {
    const known = findCommit(state, meta.sha);
    if (known) {
      // Resurrect: reset back onto a previously-seen tip.
      known.live = true;
      known.removedAtSeq = null;
      known.absorbedBy = null;
      continue;
    }

    if (meta.parentCount >= 2) {
      // Merge commits are recorded but never counted as created work.
      state.commits.push(newLedgerCommit(meta, false));
      continue;
    }

    const pool = matchPool(state);

    // Cascade 1: tree match → squash of the chain removed in one transition.
    const treeMatch = pool.find(c => c.tree === meta.tree);
    if (treeMatch) {
      const chain = pool.filter(c => c.removedAtSeq === treeMatch.removedAtSeq);
      const inherited = chain.some(c => c.sessionCreated);
      for (const absorbed of chain) absorbed.absorbedBy = meta.sha;
      state.commits.push(newLedgerCommit(meta, inherited));
      continue;
    }

    // Cascade 2: author identity match → rebase pick / amend / reword.
    const authorMatch = pool.find(
      c => c.authorEmail === meta.authorEmail && c.authorTs === meta.authorTs,
    );
    if (authorMatch) {
      authorMatch.absorbedBy = meta.sha;
      state.commits.push(newLedgerCommit(meta, authorMatch.sessionCreated));
      continue;
    }

    // Cascade 3: genuinely new commit. The countsAsSession test keeps
    // commits resurrected from outside the session (e.g. reset --hard onto
    // a tip built while the daemon was down) out of the counter.
    state.commits.push(newLedgerCommit(meta, countsAsSession(meta)));
  }
}

/**
 * Pointer fell out of the reflog window — rebuild flags from current state
 * instead of replaying. Known commits: live when still on the branch OR
 * merged into the default branch. Unknown commits on the branch are adopted
 * with the committer-timestamp session test (no lineage available).
 */
function applyResync(
  state: CommitLedgerState,
  liveShas: readonly string[],
  mergedShas: readonly string[],
  unknownCommits: readonly CommitMeta[],
  countsAsSession: (meta: CommitMeta) => boolean,
): void {
  const live = new Set(liveShas);
  const merged = new Set(mergedShas);
  for (const commit of state.commits) {
    if (live.has(commit.sha)) {
      commit.live = true;
      commit.removedAtSeq = null;
      commit.absorbedBy = null;
    } else if (!merged.has(commit.sha)) {
      commit.live = false;
    }
  }
  seedLedger(state, unknownCommits, countsAsSession);
}

/** Gone-but-unabsorbed commits — the pool rewrite matching runs against. */
function matchPool(state: CommitLedgerState): LedgerCommit[] {
  return state.commits.filter(c => !c.live && c.absorbedBy === null);
}

function findCommit(state: CommitLedgerState, sha: string): LedgerCommit | undefined {
  return state.commits.find(c => c.sha === sha);
}

function newLedgerCommit(meta: CommitMeta, sessionCreated: boolean): LedgerCommit {
  return {
    sha: meta.sha,
    tree: meta.tree,
    authorEmail: meta.authorEmail,
    authorTs: meta.authorTs,
    committerTs: meta.committerTs,
    sessionCreated,
    live: true,
    removedAtSeq: null,
    absorbedBy: null,
  };
}

export function createEmptyLedger(): CommitLedgerState {
  return { commits: [], pointer: null, seq: 0 };
}
