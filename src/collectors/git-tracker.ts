import { basename } from 'node:path';
import type {
  AppConfig,
  TrackingConfig,
  PollResult,
  ReflogEntry,
  RepoTracker,
  WatchingRepo,
  EvidenceSnapshot,
  EvidenceBasis,
  ForeignCheckout,
  LedgerQuery,
  LedgerUpdate,
} from '../core/types.js';
import { buildTaskPattern, extractForeignTask, extractTask, getConfiguredDefaultBranchName } from '../core/config.js';
import { GitClient } from './git-client.js';
import { ReflogParser } from './reflog-parser.js';
import { SnapshotParser } from './snapshot-parser.js';  // static methods only
import { buildChurnFiles } from './churn-scanner.js';
import { collectLedgerUpdate } from './ledger-collector.js';

/**
 * Final fallback list when no config and no `origin/HEAD` are available.
 * Tried in order; the first ref that actually exists wins.
 */
const DEFAULT_BRANCH_FALLBACK_NAMES: readonly string[] = ['main', 'master', 'develop'];

/**
 * Main git activity tracker.
 * Orchestrates GitClient, ReflogParser, SnapshotParser.
 * Stores per-repo state (previous snapshot, last reflog timestamp).
 *
 * Usage:
 *   const tracker = new GitTracker(config);
 *   const results = await tracker.pollAll(); // one poll tick for all repos
 */
export class GitTracker {
  private readonly config: AppConfig;
  private readonly gitClient: GitClient;
  private reflogParser: ReflogParser;
  private readonly repoStates: Map<string, RepoTracker> = new Map();
  // Resolved default-branch ref (e.g. "origin/master" or "master"). null = no
  // ref resolved → merge-base advancement disabled for this repo, evidence
  // falls back to per-session baseSha. `undefined` = not yet resolved.
  private readonly defaultBranchRefCache: Map<string, string | null> = new Map();

  public constructor(config: AppConfig) {
    this.config = config;
    this.gitClient = new GitClient(config.session.reflogCount);
    this.reflogParser = new ReflogParser(buildTaskPattern(config.tracking.projectKeys));
  }

  /**
   * Poll all configured repos. Returns results only for accessible repos.
   * baseShas (per repoPath) drives the PR-equivalent evidence snapshot —
   * if a baseSha is provided for a repo, the batch includes diff/log vs
   * that base; otherwise the snapshot is null and SessionTracker is
   * expected to capture currentHead as the new baseSha.
   */
  public async pollAll(
    baseShas?: ReadonlyMap<string, string | null>,
    ledgerQueries?: ReadonlyMap<string, LedgerQuery | null>,
  ): Promise<PollResult[]> {
    const results: PollResult[] = [];

    for (const repoPath of this.config.repos) {
      try {
        const baseSha = baseShas?.get(repoPath) ?? null;
        const ledgerQuery = ledgerQueries?.get(repoPath) ?? null;
        const result = await this.pollRepo(repoPath, baseSha, ledgerQuery);
        if (result !== null) {
          results.push(result);
        }
      } catch (error) {
        const repoName = basename(repoPath);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[GitTracker] ${repoName}: ${message}`);
      }
    }

    return results;
  }

  /** Get current state for a repo */
  public getRepoState(repoPath: string): RepoTracker | undefined {
    return this.repoStates.get(repoPath);
  }

  /**
   * Register a repo for tracking. No-op in the body — pollAll iterates over
   * current `config.repos` (mutated by Daemon.applyConfigUpdate) and lazy-inits
   * per-repo state on first poll via getOrCreateRepoState.
   */
  public addRepo(_repoPath: string): void {
    // intentional no-op — symmetry + future hook point
  }

  /** Drop per-repo state so the repo is fully forgotten. */
  public removeRepo(repoPath: string): void {
    this.repoStates.delete(repoPath);
    this.defaultBranchRefCache.delete(repoPath);
  }

  /** Rebuild reflog parser when the tracking scope changes. */
  public setTracking(tracking: TrackingConfig): void {
    this.reflogParser = new ReflogParser(buildTaskPattern(tracking.projectKeys));
  }

  /**
   * Poll a single repo.
   * Returns null if branch is not developer's (skip this repo for now).
   */
  private async pollRepo(
    repoPath: string,
    baseSha: string | null,
    ledgerQuery: LedgerQuery | null,
  ): Promise<PollResult | null> {
    const now = Date.now();

    // Busy-guard (pre): git holds index.lock for the whole worktree rewrite
    // while HEAD flips only at the end, so a mid-operation tick pairs the old
    // branch name with the new branch's diff and slips past both branch
    // guards. Never measure a repo in motion — skip the tick.
    if (GitClient.isRepoBusy(repoPath)) {
      return null;
    }

    const defaultBranchRef = await this.resolveDefaultBranchRef(repoPath);

    // Evidence base: fresh merge-base with the default branch (rebase-stable
    // branch totals — resolved every tick on purpose), falling back to the
    // session's sticky baseSha when no default branch is available.
    const mergeBaseSha = defaultBranchRef
      ? await this.gitClient.getMergeBase(repoPath, defaultBranchRef)
      : null;
    const evidenceBase = mergeBaseSha ?? baseSha ?? undefined;

    const raw = await this.gitClient.fetchRepoState(repoPath, evidenceBase);

    // Busy-guard (post): an operation that started during the batch means the
    // diff may already describe a half-rewritten worktree. Together with the
    // branchAfter check below this closes the window: still rewriting → lock
    // present here; finished rewriting → branchAfter reads the new branch.
    if (GitClient.isRepoBusy(repoPath)) {
      return null;
    }

    // Detached HEAD shows as commit SHA (7-40 hex chars); skip to avoid disrupting sessions
    if (raw.branch === 'HEAD' || /^[0-9a-f]{7,40}$/.test(raw.branch)) {
      return null;
    }

    // A checkout mid-batch pairs the old branch name with the new branch's
    // diff — the evidence would land on the task the developer just left,
    // inflated by everything that separates the two branches. Drop the tick;
    // the next one measures a settled worktree.
    if (raw.branchAfter !== raw.branch) {
      return null;
    }

    // Branch filter: only track developer's branches
    const task = extractTask(
      raw.branch,
      this.config.tracking,
      this.config.genericBranches,
    );

    const state = this.getOrCreateRepoState(repoPath);

    // Churn sources: per-file evidence diff (sees committed + staged +
    // worktree; falls back to the plain worktree diff when no base yet)
    // and untracked files (invisible to any git diff — read from disk).
    const evidenceDiff = raw.diffSinceBase !== undefined
      ? SnapshotParser.parseDiffNumstatFiles(raw.diffSinceBase)
      : null;
    const churnSource = evidenceDiff ?? SnapshotParser.parseDiffNumstatFiles(raw.diffNumstat);
    const untrackedPaths = SnapshotParser.parseUntrackedList(raw.untrackedFiles);
    const churnFiles = await buildChurnFiles(
      repoPath,
      churnSource.files,
      untrackedPaths,
      state.previousSnapshot?.churnFiles ?? null,
    );

    // Parse snapshot and compute delta
    const snapshot = SnapshotParser.parseSnapshot(raw, now, churnFiles);
    const delta = SnapshotParser.computeDelta(state.previousSnapshot, snapshot);

    // Parse reflog, filter to new entries only
    const allEntries = this.reflogParser.parseEntries(raw.reflog);
    const newEntries = this.filterNewReflogEntries(allEntries, state);

    // Review-suggestion signal: checkouts onto colleague ticket branches.
    // Scanned over ALL entries every tick (not only new) — the daily-log
    // dedup makes it idempotent and same-day facts survive daemon restarts.
    const foreignCheckouts: ForeignCheckout[] = [];
    for (const entry of allEntries) {
      if (entry.type !== 'checkout') continue;
      const target = this.reflogParser.extractCheckoutTarget(entry.message);
      if (!target) continue;
      const foreignTask = extractForeignTask(target, this.config.tracking, this.config.genericBranches);
      if (foreignTask !== null) {
        foreignCheckouts.push({ ts: entry.ts, task: foreignTask, branch: target });
      }
    }

    // Branch-guard for prev-snapshot seeding (A-3): a snapshot taken on
    // another branch must never seed a newborn candidate's baseline.
    const branchChanged = state.currentBranch !== null && state.currentBranch !== raw.branch;
    const prevEvidenceSnapshot = branchChanged ? null : state.prevEvidenceSnapshot;

    // Update stored state
    state.previousSnapshot = snapshot;
    state.currentBranch = raw.branch;
    state.currentTask = task;
    // First poll: set baseline from all entries so next poll can filter correctly
    if (state.lastReflogTs === 0 && allEntries.length > 0) {
      state.lastReflogTs = allEntries[allEntries.length - 1].ts;
    } else if (newEntries.length > 0) {
      state.lastReflogTs = newEntries[newEntries.length - 1].ts;
    }

    // PR-equivalent evidence snapshot (only when an evidence base was supplied
    // AND git accepted it — fetchRepoState transparently drops it on bad-ref).
    let evidenceSnapshot: EvidenceSnapshot | null = null;
    let evidenceBasis: EvidenceBasis | null = null;
    if (evidenceDiff !== null && raw.commitsSinceBase !== undefined) {
      const commits = parseInt(raw.commitsSinceBase, 10);
      evidenceSnapshot = {
        commits: Number.isFinite(commits) ? commits : 0,
        linesAdded: evidenceDiff.totals.added,
        linesRemoved: evidenceDiff.totals.removed,
        filesChanged: evidenceDiff.totals.fileCount,
      };
      evidenceBasis = mergeBaseSha !== null ? 'merge_base' : 'base_sha';
    }

    // Remember this tick's snapshot for the next tick's seeding — merge-base
    // basis only (a base_sha snapshot is anchored differently and would
    // corrupt a merge-base baseline).
    state.prevEvidenceSnapshot = evidenceBasis === 'merge_base' ? evidenceSnapshot : null;

    // Commit ledger: replay branch-reflog transitions (exact per-operation
    // accounting) or seed a fresh ledger. Only on developer branches with a
    // resolved default branch + merge-base — everything else falls back to
    // the positive-jump commit counter.
    let ledgerUpdate: LedgerUpdate | null = null;
    if (task !== null && defaultBranchRef !== null && mergeBaseSha !== null) {
      ledgerUpdate = await collectLedgerUpdate(
        this.gitClient, repoPath, raw.branch, mergeBaseSha, defaultBranchRef, ledgerQuery,
      );
    }

    return {
      repoPath,
      branch: raw.branch,
      task,
      snapshot,
      delta,
      newReflogEntries: newEntries,
      currentHead: raw.currentHead,
      evidenceSnapshot,
      evidenceBasis,
      mergeBaseSha,
      prevEvidenceSnapshot,
      ledgerUpdate,
      foreignCheckouts,
    };
  }


  /**
   * Resolve the default-branch ref for a repo through the configured cascade.
   * Result is cached (including the null "no ref" outcome) — git probes only
   * happen on first poll per repo.
   *
   * Chain:
   *   1. config.defaultBranches[basename(repo)] or [fullPath]
   *   2. config.defaultBranch (global)
   *   3. `git symbolic-ref refs/remotes/origin/HEAD` auto-detect
   *   4. fallback list — first of [main, master, develop] that exists
   * For each candidate name we prefer "origin/<name>" over local "<name>".
   */
  private async resolveDefaultBranchRef(repoPath: string): Promise<string | null> {
    const cached = this.defaultBranchRefCache.get(repoPath);
    if (cached !== undefined) return cached;

    const configuredName = getConfiguredDefaultBranchName(this.config, repoPath);
    const detectedName = configuredName ? null : await this.gitClient.detectDefaultBranchName(repoPath);

    // Build candidate list — dedup while preserving order.
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const name of [configuredName, detectedName, ...DEFAULT_BRANCH_FALLBACK_NAMES]) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      candidates.push(name);
    }

    for (const name of candidates) {
      if (await this.gitClient.refExists(repoPath, `origin/${name}`)) {
        return this.cacheBranchRef(repoPath, `origin/${name}`);
      }
      if (await this.gitClient.refExists(repoPath, name)) {
        return this.cacheBranchRef(repoPath, name);
      }
    }

    return this.cacheBranchRef(repoPath, null);
  }

  private cacheBranchRef(repoPath: string, ref: string | null): string | null {
    this.defaultBranchRefCache.set(repoPath, ref);
    return ref;
  }

  /** Get or initialize per-repo tracking state */
  private getOrCreateRepoState(repoPath: string): RepoTracker {
    let state = this.repoStates.get(repoPath);
    if (!state) {
      state = {
        currentBranch: null,
        currentTask: null,
        previousSnapshot: null,
        lastReflogTs: 0,
        prevEvidenceSnapshot: null,
      };
      this.repoStates.set(repoPath, state);
    }
    return state;
  }

  /**
   * Live view for watching-card synthesis: configured repos currently on a
   * task branch (as of their last poll), in config.repos order.
   */
  public getWatchingRepos(): readonly WatchingRepo[] {
    const result: WatchingRepo[] = [];
    for (const repoPath of this.config.repos) {
      const state = this.repoStates.get(repoPath);
      if (!state || state.currentTask === null || state.currentBranch === null) continue;
      result.push({
        repoName: basename(repoPath),
        branch: state.currentBranch,
        task: state.currentTask,
      });
    }
    return result;
  }

  /** Filter reflog entries to only those newer than last seen timestamp */
  private filterNewReflogEntries(entries: ReflogEntry[], state: RepoTracker): ReflogEntry[] {
    if (state.lastReflogTs === 0) {
      // First poll: set baseline, don't report any entries as "new"
      return [];
    }
    return entries.filter(e => e.ts > state.lastReflogTs);
  }

  /** Enrich reflog entries with extracted task keys */
  public enrichReflogEntries(entries: ReflogEntry[]): Array<{
    readonly entry: ReflogEntry;
    readonly task: string | null;
    readonly targetBranch: string | null;
  }> {
    return entries.map(entry => {
      if (entry.type === 'checkout') {
        const targetBranch = this.reflogParser.extractCheckoutTarget(entry.message);
        const task = targetBranch
          ? extractTask(targetBranch, this.config.tracking, this.config.genericBranches)
          : null;
        return { entry, task, targetBranch };
      }

      if (entry.type === 'commit') {
        const task = this.reflogParser.extractTaskFromMessage(entry.message);
        return { entry, task, targetBranch: null };
      }

      return { entry, task: null, targetBranch: null };
    });
  }
}
