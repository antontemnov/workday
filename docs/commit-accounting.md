# Commit & Line Accounting — the Commit Ledger

Goal: each session's counters answer two questions *exactly*:

- **commits** — how many commits did this session ultimately produce?
  Squashing two session commits into one drops the counter 2 → 1. Squashing
  a session commit *into* a pre-session commit does **not** decrement — the
  session's work survived, inside a rewritten commit. Dropped / hard-reset
  commits stop counting; commits merged into the default branch keep
  counting.
- **lines** — how many lines does the session's work amount to right now:
  the lines of the session's live commits (exact per-commit numstat; a
  squash inherits the session's share of the absorbed chain, an amend or
  rebase pick takes its own numstat) plus the uncommitted diff vs HEAD
  beyond what was already dirty when the session opened.

Counters are **strictly session-scoped**. A session opens at zero, its
counters freeze the moment it closes, and nothing done outside a session —
daemon stopped, session closed, working on another branch — is ever
counted. A daemon restart therefore starts a fresh session at zero.

## Why polling counters can never be exact

The daemon polls every 30 seconds. Any number of git operations can land
between two polls — `commit` + `reset --soft` + `commit` (a squash) shows up
as a net counter jump of 0 or +1, and no amount of cleverness can
reconstruct what actually happened from two samples of
`rev-list --count`.

## The fix: replay the branch reflog

Git already keeps a complete, persistent journal of every branch-tip move:
the **branch reflog**. Every commit, amend, rebase finish, reset and merge
writes exactly one `old-sha → new-sha` entry, and entries are never
coalesced no matter how fast operations happen. The daemon stores a pointer
(sha + timestamp of the last processed entry) per session and, on every
tick, replays the entries above the pointer as individual transitions. So
while a session is open, no operation between polls is ever lost — no
matter how many of them land inside one 30-second window.

For each transition the collector computes (relative to the default branch,
so upstream commits never enter the picture):

- `removed` — commits reachable from the old tip but not the new one and
  not from the default branch. Note the last clause: **own commits that were
  merged upstream never count as removed** — merged work survives.
- `added` — commits reachable from the new tip but not the old one and not
  from the default branch, with full metadata (tree, author email/date,
  committer date).

## The ledger

Each session carries a ledger: the set of commit identities seen on the
branch, each flagged `live` (still exists) and `sessionCreated` (produced
by this session, directly or through rewrites). `evidence.commits` = live ∧
sessionCreated.

An added commit is classified by a matching cascade against gone,
not-yet-absorbed ledger entries:

1. **Known SHA** → resurrect (a reset back onto an old tip).
2. **Tree match** → squash: the new commit's tree equals the tree of a
   removed commit, so it absorbs the whole chain removed in that same
   transition and inherits `sessionCreated` as OR over the chain. This is
   the rule that keeps the counter when a session commit is squashed into a
   pre-session commit (`rebase -i` keeps the old commit's author date, so
   only the tree sees the truth).
3. **Author identity match** (email + author timestamp) → rebase pick /
   amend / reword: git preserves the author timestamp through these, so the
   rewrite inherits the original's membership. Rebasing pre-session commits
   does *not* recount them.
4. **No match** → genuinely new; counts when both its committer **and
   author** timestamps fall after the session opened (minus a two-tick
   slack, so the commit that itself triggered the session counts) AND its
   SHA is not already recorded in an earlier session's ledger today (a
   commit made moments before a close/reopen falls inside the next
   session's slack — the SHA-set check keeps it from being recounted). A
   rebase pick, amend, reword or cherry-pick refreshes the committer
   timestamp but keeps the author timestamp — git moving an old commit
   around is never new work, even with no lineage to match. Merge commits
   never count.

### Seeding

When a session opens, the ledger seeds from every commit between the
merge-base and HEAD — all marked pre-session, so the counter starts at
zero; the only exception is rule 4's author-and-committer test, which lets
the commit that itself triggered the session count. Commits a rebase
re-timestamped seconds before the session opened keep their old author
date and stay pre-session (the 2026-09-22 case: a session born by the
rebase itself started at 7 commits). The line baseline is captured from the
branch totals on the first tick: lines the branch already had (including
uncommitted work made before the session) are excluded.

### Lines: anchor-free by construction

In ledger mode the line counters never look at a merge-base: a rebase moves
HEAD but not the uncommitted diff against it, upstream commits pulled in by
a rebase onto a newer base are never session-created, a dropped session
commit takes its lines with it, and own commits merged upstream stay live.
The uncommitted baseline (dirty lines the branch carried at open) seeds
from the previous tick so a birth burst counts, and ratchets down as those
lines get committed or reverted.

Without a ledger (fallback mode) the lines are branch totals vs the
merge-base minus a baseline. There, when the merge-base moves, the branch
changes or git moves the tip (`PollResult.reanchored`), the counters so far
fold into a per-session carry (`evidenceCarry`) and the baseline restarts
at the new totals — only edits move the counters.

### Degradation ladder

- Pointer fell out of the reflog window (very long downtime) → **resync**:
  live flags are rebuilt from the current branch state; commits missing from
  the branch but reachable from the default branch stay counted (merged).
- Branch reflog unavailable (`core.logAllRefUpdates` off) or no default
  branch/merge-base resolvable → the old **positive-jump** counter takes
  over (squash-insensitive, but never loses counted work).

## Known limitations

- Session counters are not additive across history rewrites that span
  sessions: squashing two commits of a *closed* session during a later one
  doesn't retro-decrement the closed session's frozen counter (each number
  is honest for its own window, but the sum can differ from what finally
  survives on the branch).
- Pre-session dirty lines that get committed inside the session become part
  of a session commit's numstat and count from then on — the uncommitted
  baseline excluded them only while they stayed uncommitted.
- Fallback mode only: counters carried across a re-anchoring are frozen
  numbers — a later revert of those lines can no longer decrement them.
- A squash performed with extra edits staged (tree no longer equals any
  removed commit's tree) falls through to rule 4: the result counts as one
  new session commit when the chain's first commit was authored inside the
  session (a squash keeps the first author date), and not at all otherwise.
- `git reflog expire` or disabling reflogs removes the journal — the ledger
  then degrades as described above.

Integration coverage: `tests/integration/commit-ledger.test.ts` (commit +
squash inside one poll, amend, reword, drop, restart-at-zero, squash into
pre-session history via `rebase -i`, merge to master) and
`tests/integration/evidence-rebase.test.ts`.
