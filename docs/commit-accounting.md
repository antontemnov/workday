# Commit & Line Accounting — the Commit Ledger

Goal: at the end of the day the counters answer two questions *exactly*:

- **commits** — how many commits did today ultimately produce? Squashing two
  of today's commits into one drops the counter 2 → 1. Squashing a today
  commit *into* an older commit does **not** decrement — the day's work
  survived, inside a rewritten commit. Dropped / hard-reset commits stop
  counting; commits merged into the default branch keep counting.
- **lines** — how many lines does today's work amount to right now (branch
  totals vs the merge-base, minus everything the branch already had before
  today).

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
tick, replays the entries above the pointer as individual transitions.
Because the reflog is on disk, replay also survives daemon restarts: work
done while the daemon was down is accounted for after the next start.

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
today, directly or through rewrites). `evidence.commits` = live ∧
sessionCreated.

An added commit is classified by a matching cascade against gone,
not-yet-absorbed ledger entries:

1. **Known SHA** → resurrect (a reset back onto an old tip).
2. **Tree match** → squash: the new commit's tree equals the tree of a
   removed commit, so it absorbs the whole chain removed in that same
   transition and inherits `sessionCreated` as OR over the chain. This is
   the rule that keeps the counter when a today-commit is squashed into a
   pre-day commit (`rebase -i` keeps the old commit's author date, so only
   the tree sees the truth).
3. **Author identity match** (email + author timestamp) → rebase pick /
   amend / reword: git preserves the author timestamp through these, so the
   rewrite inherits the original's membership. Rebasing yesterday's commits
   today does *not* recount them.
4. **No match** → genuinely new; counts when its committer timestamp falls
   inside the current working day. Merge commits never count.

### Seeding

When a session first sees a branch, the ledger seeds from every commit
between the merge-base and HEAD: commits with a today committer date count
(the stats reflect the day, not the daemon's uptime), older ones don't. The
seed also anchors the **line baseline** at the last pre-day commit, so lines
committed earlier today count and older branch lines don't.

### Degradation ladder

- Pointer fell out of the reflog window (very long downtime) → **resync**:
  live flags are rebuilt from the current branch state; commits missing from
  the branch but reachable from the default branch stay counted (merged).
- Branch reflog unavailable (`core.logAllRefUpdates` off) or no default
  branch/merge-base resolvable → the old **positive-jump** counter takes
  over (squash-insensitive, but never loses counted work).

## Known limitations

- Line totals are branch-state based; when the branch is merged into the
  default branch mid-session, branch totals collapse and the line counters
  ratchet from a new base (the commit counter is unaffected — merged commits
  stay counted).
- A squash performed with extra edits staged (tree no longer equals any
  removed commit's tree) falls through to rule 4: the result counts as one
  new today-commit — the net count is still correct when the squashed chain
  was today's work.
- `git reflog expire` or disabling reflogs removes the journal — the ledger
  then degrades as described above.

Integration coverage: `tests/integration/commit-ledger.test.ts` (commit +
squash inside one poll, amend, reword, drop, restart replay, mixed-day
squash via `rebase -i`, merge to master) and
`tests/integration/evidence-rebase.test.ts`.
