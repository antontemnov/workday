import { basename } from 'node:path';
import type {
  AppConfig,
  Secrets,
  GitSnapshot,
  PollResult,
  ReflogEntry,
  RepoTracker,
  EvidenceSnapshot,
} from '../core/types.js';
import { RepoState } from '../core/types.js';
import { extractTask, getConfiguredDefaultBranchName } from '../core/config.js';
import { GitClient } from './git-client.js';
import { ReflogParser } from './reflog-parser.js';
import { SnapshotParser } from './snapshot-parser.js';  // static methods only

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
 *   const tracker = new GitTracker(config, secrets);
 *   const results = await tracker.pollAll(); // one poll tick for all repos
 */
export class GitTracker {
  private readonly config: AppConfig;
  private readonly developer: string;
  private readonly gitClient: GitClient;
  private readonly reflogParser: ReflogParser;
  private readonly repoStates: Map<string, RepoTracker> = new Map();
  // Resolved default-branch ref (e.g. "origin/master" or "master"). null = no
  // ref resolved → merge-base advancement disabled for this repo, evidence
  // falls back to per-session baseSha. `undefined` = not yet resolved.
  private readonly defaultBranchRefCache: Map<string, string | null> = new Map();

  public constructor(config: AppConfig, secrets: Secrets) {
    this.config = config;
    this.developer = secrets.Developer;
    this.gitClient = new GitClient(config.session.reflogCount);
    this.reflogParser = new ReflogParser(config.taskPattern);
  }

  /**
   * Poll all configured repos. Returns results only for accessible repos.
   * baseShas (per repoPath) drives the PR-equivalent evidence snapshot —
   * if a baseSha is provided for a repo, the batch includes diff/log vs
   * that base; otherwise the snapshot is null and SessionTracker is
   * expected to capture currentHead as the new baseSha.
   */
  public async pollAll(baseShas?: ReadonlyMap<string, string | null>): Promise<PollResult[]> {
    const results: PollResult[] = [];

    for (const repoPath of this.config.repos) {
      try {
        const baseSha = baseShas?.get(repoPath) ?? null;
        const result = await this.pollRepo(repoPath, baseSha);
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
   * Poll a single repo.
   * Returns null if branch is not developer's (skip this repo for now).
   */
  private async pollRepo(repoPath: string, baseSha: string | null): Promise<PollResult | null> {
    const now = Date.now();
    const defaultBranchRef = await this.resolveDefaultBranchRef(repoPath);
    const raw = await this.gitClient.fetchRepoState(
      repoPath,
      baseSha ?? undefined,
      defaultBranchRef ?? undefined,
    );

    // Detached HEAD shows as commit SHA (7-40 hex chars); skip to avoid disrupting sessions
    if (raw.branch === 'HEAD' || /^[0-9a-f]{7,40}$/.test(raw.branch)) {
      return null;
    }

    // Branch filter: only track developer's branches
    const task = extractTask(
      raw.branch,
      this.config.taskPattern,
      this.developer,
      this.config.genericBranches,
    );

    const state = this.getOrCreateRepoState(repoPath);

    // Parse snapshot and compute delta
    const snapshot = SnapshotParser.parseSnapshot(raw, now);
    const delta = SnapshotParser.computeDelta(state.previousSnapshot, snapshot);

    // Parse reflog, filter to new entries only
    const allEntries = this.reflogParser.parseEntries(raw.reflog);
    const newEntries = this.filterNewReflogEntries(allEntries, state);

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

    // Determine repo state based on signals
    this.updateRepoState(state, task, delta, newEntries);

    // PR-equivalent evidence snapshot (only when baseSha was supplied AND
    // git accepted it — fetchRepoState transparently drops it on bad-ref).
    let evidenceSnapshot: EvidenceSnapshot | null = null;
    if (raw.diffSinceBase !== undefined && raw.commitsSinceBase !== undefined) {
      const { added, removed, fileCount } = SnapshotParser.parseDiffNumstatTotals(raw.diffSinceBase);
      const commits = parseInt(raw.commitsSinceBase, 10);
      evidenceSnapshot = {
        commits: Number.isFinite(commits) ? commits : 0,
        linesAdded: added,
        linesRemoved: removed,
        filesChanged: fileCount,
      };
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
      mergeBaseSha: raw.mergeBase ?? null,
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
        state: RepoState.Idle,
        currentBranch: null,
        currentTask: null,
        activeSessionId: null,
        previousSnapshot: null,
        lastReflogTs: 0,
      };
      this.repoStates.set(repoPath, state);
    }
    return state;
  }

  /** Filter reflog entries to only those newer than last seen timestamp */
  private filterNewReflogEntries(entries: ReflogEntry[], state: RepoTracker): ReflogEntry[] {
    if (state.lastReflogTs === 0) {
      // First poll: set baseline, don't report any entries as "new"
      return [];
    }
    return entries.filter(e => e.ts > state.lastReflogTs);
  }

  /**
   * Update repo state based on collected signals.
   * IDLE → PENDING on checkout to own branch.
   * PENDING → ACTIVE on dynamics or commit.
   */
  private updateRepoState(
    state: RepoTracker,
    task: string | null,
    delta: { readonly hasDynamics: boolean },
    newEntries: ReflogEntry[],
  ): void {
    const hasCommit = newEntries.some(e => e.type === 'commit');
    const hasCheckout = newEntries.some(e => e.type === 'checkout');

    // Check if branch changed to a non-developer branch
    if (task === null) {
      if (state.state !== RepoState.Idle) {
        state.state = RepoState.Idle;
        state.activeSessionId = null;
      }
      return;
    }

    switch (state.state) {
      case RepoState.Idle:
        // Any signal on own branch → open PENDING
        if (hasCheckout || hasCommit || delta.hasDynamics) {
          state.state = RepoState.Pending;
        }
        break;

      case RepoState.Pending:
        // Dynamics or commit → promote to ACTIVE
        if (delta.hasDynamics || hasCommit) {
          state.state = RepoState.Active;
        }
        break;

      case RepoState.Active:
        // Stay active — session manager will handle lastSeenAt updates
        break;
    }
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
          ? extractTask(targetBranch, this.config.taskPattern, this.developer, this.config.genericBranches)
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
