// ─── Config ──────────────────────────────────────────────────────────────

export interface AppConfig {
  readonly repos: readonly string[];
  // 0-23, hour when the working day rolls over (04 = night work before
  // 04:00 belongs to the previous day). Date attribution + budget window.
  readonly boundaryHour: number;
  readonly timezone: string;        // IANA timezone, e.g. "Europe/Moscow"
  readonly taskPattern: string;
  readonly genericBranches: readonly string[];
  readonly session: SessionConfig;
  readonly report: ReportConfig;
  readonly workDays: readonly number[];
  readonly holidays: readonly string[];
  readonly apiPort: number;
  sensitivity: SensitivityConfig;
  // Default branch to compute merge-base against — what the PR is opened from.
  // Resolved at session level by SessionTracker through GitTracker's cache:
  //   defaultBranches[basename] || defaultBranches[fullPath] || defaultBranch
  //   ?? `git symbolic-ref refs/remotes/origin/HEAD`
  //   ?? fallback ('main' / 'master' / 'develop' — first that exists)
  // When nothing resolves, merge-base advancement is disabled and the older
  // per-session baseSha logic takes over.
  readonly defaultBranch?: string;
  readonly defaultBranches?: Readonly<Record<string, string>>;
}

// ─── Sensitivity ────────────────────────────────────────────────────────

export enum SensitivityLevel {
  Low = 'low',
  Normal = 'normal',
  Patient = 'patient',
  AlwaysOn = 'always_on',
}

export interface SensitivityConfig {
  default: SensitivityLevel;
  perRepo: Record<string, SensitivityLevel>;
}

export interface SessionConfig {
  readonly diffPollSeconds: number;
  readonly signalDeduplicationSeconds: number;
  readonly dayBoundaryCheckSeconds: number;
  readonly reflogCount: number;
  // Auto-close a session after this many hours of continuous idle pause
  // (honest trimmed end). 0 disables — sessions then hang until rollover.
  readonly idleCloseHours: number;
}

export interface ReportConfig {
  readonly roundingMinutes: number; // 15 = quarter-hour, 30 = half-hour
}

export interface Secrets {
  readonly Developer: string;
  readonly Jira_Email: string;
  readonly Jira_BaseUrl: string;
  readonly Jira_Token: string;
  readonly Tempo_Token: string;
}

// ─── Pause ──────────────────────────────────────────────────────────────

export enum PauseSource {
  Manual = 'manual',
  IdleTimeout = 'idle_timeout',
  Superseded = 'superseded',
}

export interface Pause {
  readonly from: string;
  to: string | null;           // null = currently paused
  readonly source: PauseSource;
}

// ─── Session state machine ───────────────────────────────────────────────

export enum SessionState {
  Pending = 'pending',
  Active = 'active',
}

export enum ClosedBy {
  CheckoutOtherTask = 'checkout_other_task',
  DayBoundary = 'day_boundary',
  DaemonStop = 'daemon_stop',
  DaemonCrash = 'daemon_crash',
  ManualStop = 'manual_stop',
  IdleTimeout = 'idle_timeout',
  // Legacy — never produced since budget v2; kept so old day files still read.
  BudgetExhausted = 'budget_exhausted',
}

// ─── Manual Entry ─────────────────────────────────────────────────────────

// Declared time on a task. Two kinds:
// - standalone (via "Log" / `workday log`): meeting, review, planning —
//   becomes its own Tempo worklog;
// - session-born (via "+ Add time" on a session card): carries
//   sourceSessionId, has no description, activity is always Development,
//   and its minutes fold into the session aggregate worklog at push time.
//   Not editable — delete-and-redo is the correction path.
export interface ManualEntry {
  readonly id: string;
  readonly task: string;          // matches config.taskPattern, e.g. ATL-10
  minutes: number;                // > 0, max MAX_ENTRY_MINUTES
  description: string;            // → worklog.description ('' for session-born)
  activity: string;              // Tempo _Activity_ value, e.g. 'CodeReview'
  readonly createdAt: string;     // ISO timestamp
  // Origin marker only — push merges by task, never by this id, so a
  // dangling id (session later deleted) is harmless.
  readonly sourceSessionId?: string;
}

// Reusable manual-entry template ("favorite"). Day-independent — lives in
// WORKDAY_HOME/favorites.json, never inside daily logs. Logging from a
// favorite creates a plain standalone ManualEntry (name → description).
export interface Favorite {
  readonly id: string;
  readonly name: string;          // chip label; becomes the entry description
  readonly task: string;          // matches config.taskPattern, e.g. ATL-10
  readonly minutes: number;       // default duration, > 0, max MAX_ENTRY_MINUTES
  readonly activity: string;      // Tempo _Activity_ value, e.g. 'CodeReview'
  readonly createdAt: string;     // ISO timestamp
}

// ─── Evidence & Sessions ─────────────────────────────────────────────────

// Mutable accumulator — fields incremented during session lifecycle
export interface Evidence {
  commits: number;
  reflogEvents: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

export interface Session {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly branch: string;
  state: SessionState;
  startedAt: string;
  activatedAt: string | null;
  lastSeenAt: string;
  closedBy: ClosedBy | null;
  evidence: Evidence;
  pauses: Pause[];
  // Commit SHA captured at session open (or copied from a prior session
  // on the same repo+task today). Only used as the evidence base on repos
  // where no default branch resolves (fallback mode): evidence is then
  // `git diff baseSha` / `git rev-list baseSha..HEAD`. Null until the
  // first poll fills it in.
  baseSha: string | null;
  // Merge-base against the resolved default branch as of the last tick.
  // Informational — evidence is computed against the *fresh* merge-base
  // each tick, so rebases / upstream pulls can't inflate it.
  mergeBaseSha: string | null;
  // Branch totals (diff vs merge-base) captured at session open, or
  // inherited from a prior session on the same repo+task today. Evidence
  // lines/files = current branch totals − this baseline; stable across
  // rebases because both sides move together. Ratcheted down when totals
  // drop below it (own work merged upstream / dropped). Null until the
  // first merge-base tick.
  evidenceBaseline: EvidenceBaseline | null;
  // Branch commit count (`rev-list merge-base..HEAD`) seen on the previous
  // tick. Fallback only (repos where the branch reflog is unavailable):
  // evidence.commits then accumulates only positive jumps of this counter.
  lastBranchCommits: number | null;
  // Commit ledger — exact per-commit accounting replayed from the branch
  // reflog. When present, evidence.commits is derived from it and the
  // positive-jump fallback is skipped. Null on old logs / fallback repos.
  ledger: CommitLedgerState | null;
}

// Mutable — ratcheted down in place when branch totals drop below it.
export interface EvidenceBaseline {
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

// ─── Signals ─────────────────────────────────────────────────────────────

export enum SignalType {
  DiffDynamics = 'diff_dynamics',
  Commit = 'commit',
  Checkout = 'checkout',
}

export interface DiffDynamicsSignal {
  readonly ts: number;
  readonly type: SignalType.DiffDynamics;
  readonly repo: string;
  readonly delta: { readonly added: number; readonly removed: number; readonly untracked?: number };
}

export interface CommitSignal {
  readonly ts: number;
  readonly type: SignalType.Commit;
  readonly repo: string;
  readonly task: string | null;
}

export interface CheckoutSignal {
  readonly ts: number;
  readonly type: SignalType.Checkout;
  readonly repo: string;
  readonly task: string | null;
}

export type Signal = DiffDynamicsSignal | CommitSignal | CheckoutSignal;

// ─── Daily Log ───────────────────────────────────────────────────────────

export enum DayStatus {
  Draft = 'draft',
  Confirmed = 'confirmed',
  Pushed = 'pushed',
}

export enum DayType {
  Workday = 'workday',
  Weekend = 'weekend',
  Holiday = 'holiday',
  Overtime = 'overtime',
}

export interface DailyLog {
  readonly date: string;
  status: DayStatus;
  dayType: DayType;
  sessions: Session[];
  signals: Signal[];
  manualEntries: ManualEntry[];
  pushedAt: string | null;
}

// ─── Git Snapshot (runtime, not persisted) ───────────────────────────────

export interface GitSnapshot {
  readonly branch: string;
  readonly trackedLines: { readonly added: number; readonly removed: number };
  readonly trackedFileCount: number;
  readonly untrackedCount: number;
  readonly timestamp: number;
  // Per-file churn state used to measure real activity volume between ticks.
  // Sourced from the evidence diff (committed + staged + worktree vs the
  // fresh merge-base) plus untracked files read from disk — the plain
  // worktree numstat is blind to committed chunks and brand-new files.
  readonly churnFiles: ReadonlyMap<string, ChurnFile>;
}

// Per-file diff numbers + content fingerprint. hash is null when the file
// wasn't hashed this tick (numbers moved — no need) or couldn't be read.
export interface ChurnFile {
  readonly added: number;
  readonly removed: number;
  readonly hash: string | null;
}

export interface GitDelta {
  readonly addedDelta: number;
  readonly removedDelta: number;
  readonly untrackedDelta: number;
  readonly hasDynamics: boolean;
  // Line-equivalent of real churn this tick: per-file |Δadded|+|Δremoved|
  // (cross-file netting impossible), files entering the diff count whole,
  // flat files with a changed content hash count IN_PLACE_CHURN_LINES.
  readonly magnitude: number;
}

// ─── Commit ledger ───────────────────────────────────────────────────────
//
// Exact per-commit accounting that survives history rewrites. Instead of
// sampling `rev-list --count` every 30s (which coalesces commit+squash into
// a net number), the branch reflog — a complete journal of every branch-tip
// move — is replayed transition-by-transition through a ledger of commit
// identities. See docs/commit-accounting.md.

/** Immutable metadata of a single commit, readable even for unreachable SHAs. */
export interface CommitMeta {
  readonly sha: string;
  readonly tree: string;
  readonly parentCount: number;
  readonly authorEmail: string;
  readonly authorTs: number;    // unix seconds
  readonly committerTs: number; // unix seconds
}

/** One branch-tip move taken from the branch reflog (old → new). */
export interface BranchTransition {
  readonly ts: number; // reflog entry timestamp, unix seconds
  // Commits that left the branch and are NOT reachable from the default
  // branch (commits merged upstream are deliberately absent — they survive).
  readonly removedShas: readonly string[];
  // Commits that entered the branch and are NOT reachable from the default
  // branch, parent-first order.
  readonly added: readonly CommitMeta[];
}

/** Resume position in the branch reflog: newest processed entry. */
export interface ReflogPointer {
  readonly sha: string;
  readonly ts: number; // unix seconds
}

/** One commit tracked by the ledger. Mutable — flags flip as history moves. */
export interface LedgerCommit {
  readonly sha: string;
  readonly tree: string;
  readonly authorEmail: string;
  readonly authorTs: number;
  readonly committerTs: number;
  // Created within this session (directly or inherited through rewrites).
  // Seeded pre-session commits and commits made while the daemon was down
  // are false — the counter is strictly bounded by the session's lifetime.
  readonly sessionCreated: boolean;
  // Still exists: reachable from the branch tip or merged into the default
  // branch. Squashed/dropped/reset-away commits flip to false.
  live: boolean;
  // Monotonic id of the ledger transition that removed this commit — squash
  // detection matches a new commit's tree against a chain removed together.
  removedAtSeq: number | null;
  // SHA of the rewrite that absorbed this commit (amend/squash/rebase pick).
  // Absorbed commits are out of the matching pool; cleared on resurrect.
  absorbedBy: string | null;
}

/** Persisted per-session ledger state. */
export interface CommitLedgerState {
  commits: LedgerCommit[];
  pointer: ReflogPointer | null;
  // Monotonic transition counter — source of LedgerCommit.removedAtSeq.
  seq: number;
}

/**
 * Per-repo ledger context passed into the poll — mirrors baseShas. Tells the
 * collector whether to seed a fresh ledger (no open session yet) or collect
 * reflog transitions since the stored pointer.
 */
export interface LedgerQuery {
  readonly branch: string;
  readonly pointer: ReflogPointer | null;
  // SHAs already known to the ledger — used by resync to restore live flags.
  readonly knownShas: readonly string[];
}

export type LedgerUpdate =
  // Fresh ledger: every commit currently on the branch (vs merge-base).
  // Seeded commits are pre-session — the counter starts at zero.
  | { readonly kind: 'seed'; readonly commits: readonly CommitMeta[]; readonly pointer: ReflogPointer | null }
  // Normal tick: branch-reflog transitions since the stored pointer.
  | { readonly kind: 'transitions'; readonly transitions: readonly BranchTransition[]; readonly pointer: ReflogPointer | null }
  // Pointer fell out of the reflog window (long daemon downtime) — rebuild
  // live flags from the current branch state instead of replaying.
  | { readonly kind: 'resync'; readonly liveShas: readonly string[]; readonly mergedShas: readonly string[]; readonly unknownCommits: readonly CommitMeta[]; readonly pointer: ReflogPointer | null };

// ─── Reflog ──────────────────────────────────────────────────────────────

export type ReflogEntryType = 'commit' | 'checkout' | 'reset' | 'rebase' | 'other';

export interface ReflogEntry {
  readonly ts: number;
  readonly type: ReflogEntryType;
  readonly message: string;
}

// ─── Git collector I/O ───────────────────────────────────────────────────

export interface RawGitOutput {
  readonly branch: string;
  readonly currentHead: string;
  readonly diffNumstat: string;
  readonly statusPorcelain: string;
  readonly reflog: string;
  // `git ls-files --others --exclude-standard` — untracked files, one per line.
  readonly untrackedFiles: string;
  // Populated only when baseSha is passed to GitClient.fetchRepoState().
  readonly diffSinceBase?: string;
  readonly commitsSinceBase?: string;
}

/**
 * Branch totals vs an evidence base — what a PR/MR diff would show.
 * Computed each tick from `git diff <base> --numstat` and
 * `git rev-list <base>..HEAD --count`. The base is the fresh merge-base
 * with the default branch (preferred, rebase-stable) or the session's
 * sticky baseSha (fallback) — see PollResult.evidenceBasis.
 */
export interface EvidenceSnapshot {
  readonly commits: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly filesChanged: number;
}

// How the evidence snapshot was computed: vs the fresh merge-base with the
// default branch (rebase-stable branch totals), or vs the sticky session
// baseSha (fallback when no default branch resolves).
export type EvidenceBasis = 'merge_base' | 'base_sha';

export interface PollResult {
  readonly repoPath: string;
  readonly branch: string;
  readonly task: string | null;
  readonly snapshot: GitSnapshot;
  readonly delta: GitDelta;
  readonly newReflogEntries: ReflogEntry[];
  readonly currentHead: string;
  // null when no evidence base was available at poll time (no merge-base
  // resolved AND no session baseSha known yet).
  readonly evidenceSnapshot: EvidenceSnapshot | null;
  // null when evidenceSnapshot is null.
  readonly evidenceBasis: EvidenceBasis | null;
  // Fresh `merge-base(HEAD, default branch)` for this tick. Null when no
  // default branch resolves.
  readonly mergeBaseSha: string | null;
  // Previous tick's evidence snapshot (merge-base basis, same branch only —
  // null when the branch changed this tick or no prior merge-base tick
  // exists). Seeds a newborn candidate's baseline so the birth burst counts.
  readonly prevEvidenceSnapshot: EvidenceSnapshot | null;
  // Commit-ledger input for this tick: seed / reflog transitions / resync.
  // Null when the branch reflog (or a merge-base) is unavailable — the
  // session then falls back to the positive-jump commit counter.
  readonly ledgerUpdate: LedgerUpdate | null;
}

// ─── Daemon runtime state (per repo, not persisted) ─────────────────────

export interface RepoTracker {
  currentBranch: string | null;
  currentTask: string | null;
  previousSnapshot: GitSnapshot | null;
  lastReflogTs: number;
  // Evidence snapshot of the previous tick (merge-base basis only). Used to
  // seed a newborn candidate's baseline so the birth burst is counted.
  // Nulled on branch change — a baseline from another branch would count the
  // whole branch diff as today's work (the forbidden v0.4.3 bug class).
  prevEvidenceSnapshot: EvidenceSnapshot | null;
}

// Live view of a configured repo sitting on a task branch with no session —
// source for synthetic "watching" cards in the HTTP API.
export interface WatchingRepo {
  readonly repoName: string;
  readonly branch: string;
  readonly task: string;
}

// ─── HTTP API ───────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
  // Machine-readable discriminator for errors the tray reacts to
  // differently — never string-match the error text.
  readonly errorCode?: ApiErrorCode;
  readonly apiVersion?: number;
}

export enum ApiErrorCode {
  JiraNotFound = 'jira-not-found',
  JiraNotConfigured = 'jira-not-configured',
}

export interface StatusResponse {
  readonly running: boolean;
  readonly pid: number;
  readonly version: string;
  readonly date: string;
  readonly uptime: number;
  readonly openSessions: readonly SessionSummary[];
}

export interface UpdateCheckResponse {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
}

export interface UpdateApplyResponse {
  readonly updating: boolean;
  readonly target: string;
  readonly message: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly branch: string;
  readonly state: string;
  readonly startedAt: string;
  readonly activatedAt: string | null;
  readonly lastSeenAt: string;
  readonly paused: boolean;
  readonly pauseSource: string | null;
  readonly effectiveDurationMs: number;
  readonly score: number;
  readonly normalizedScore: number;
  readonly isLeader: boolean;
  readonly sensitivity: SensitivityLevel;
}

export interface ActiveInterval {
  readonly from: string; // ISO timestamp
  readonly to: string;   // ISO timestamp
  readonly sessionId: string;
  readonly repo: string;
}

export interface TodayResponse {
  readonly date: string;
  readonly dayType: string;
  readonly status: string;
  readonly sessions: readonly SessionDetail[];
  readonly manualEntries: readonly ManualEntry[];
  readonly totalEffectiveMs: number;
  readonly signalCount: number;
  readonly claimedMs: number;
  // Derived-only: earliest activatedAt across sessions (null until first
  // confirmed work). Presentation label, consumed by no algorithm.
  readonly dayStart: string | null;
  readonly activeIntervals: readonly ActiveInterval[];
  // Time when no session was active (union of work intervals subtracted from full span).
  readonly downtimeMs: number;
  // Ticket summaries (task key → Jira summary) for the day's tasks, cached
  // lookups only. Display-only; a key is absent when its summary isn't cached
  // yet (a background fill pulls it in for the next poll).
  readonly issueSummaries?: Readonly<Record<string, string>>;
}

export interface SessionDetail extends SessionSummary {
  readonly closedBy: string | null;
  readonly evidence: Evidence;
  readonly pauseCount: number;
  readonly totalPauseDurationMs: number;
}

export interface PauseResponse {
  readonly paused: readonly string[];
}

export interface ResumeResponse {
  readonly resumed: readonly string[];
}

export interface StopResponse {
  readonly message: string;
}

export interface SensitivityResponse {
  readonly repo: string | null;
  readonly level: SensitivityLevel;
}

export interface SessionDeleteResponse {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly effectiveDurationMs: number;
  // Day lost its last confirmed fact — the file was removed (storage invariant).
  readonly dayFileDeleted: boolean;
  // Day was already pushed to Tempo — the next push re-syncs the remote.
  readonly dayWasPushed: boolean;
}

export interface ManualEntryResponse {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;
  readonly date: string;                 // day the entry lives on (YYYY-MM-DD)
  readonly totalManualMinutes: number;   // sum of all manual entries that day
}

export interface ManualEntryDeleteResponse {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
  readonly date: string;                 // day the entry lived on (YYYY-MM-DD)
  readonly totalManualMinutes: number;   // sum after the delete
  // Past-day delete removed the day's last fact — file deleted (storage invariant).
  readonly dayFileDeleted?: boolean;
}

export interface FavoritesResponse {
  readonly favorites: readonly Favorite[];
}

// Mutations echo the touched favorite plus the full list — the tray refreshes
// its chip cloud in one hop, no follow-up GET.
export interface FavoriteAddResponse {
  readonly added: Favorite;
  readonly favorites: readonly Favorite[];
}

export interface FavoriteRemoveResponse {
  readonly removed: Favorite;
  readonly favorites: readonly Favorite[];
}

// One hit of the live Jira search (log-cloud fallback when favorites don't
// match). Plain text only — picker HTML highlighting is stripped.
export interface JiraSearchHit {
  readonly key: string;      // e.g. 'ATL-6712'
  readonly summary: string;
}

export interface JiraSearchResponse {
  readonly hits: readonly JiraSearchHit[];
}

export interface ActivityType {
  readonly value: string;   // Tempo _Activity_ value, e.g. 'CodeReview'
  readonly name: string;    // display label, e.g. 'Code Review'
}

export interface ActivityTypesResponse {
  readonly key: string;                          // '_Activity_'
  readonly activities: readonly ActivityType[];
  readonly fromCache: boolean;                   // false when served from fallback
}

export interface DaysResponse {
  // YYYY-MM-DD, descending (newest first). Includes only days with sessions.
  readonly dates: readonly string[];
}

// ─── Month (timesheets tab) ─────────────────────────────────────────────

// Sync state of a day vs Tempo, derived offline from the daily log alone:
// pending — has data, never pushed; outdated — pushed, then edited (Tempo
// holds a stale version, next push sends updates); pushed — in sync.
export enum MonthDayStatus {
  None = 'none',
  Pending = 'pending',
  Pushed = 'pushed',
  Outdated = 'outdated',
}

// One would-be Tempo worklog line: session aggregate (rounded, session-born
// entries folded in) or a standalone manual entry.
// Month-view line kinds: the push kinds plus 'foreign' — a Tempo-only
// worklog we do not own (created directly in Tempo). Read-only mirror rows.
export type MonthTaskKind = ReportEntryKind | 'foreign';

export interface MonthDayTask {
  readonly task: string;
  readonly seconds: number;
  readonly kind: MonthTaskKind;
  readonly sessionCount: number;   // 0 for manual/foreign kind
  readonly description?: string;   // manual/foreign kind only
  readonly activity?: string;      // manual/foreign kind only
  readonly tempoWorklogId?: number; // foreign kind only — the import handle
}

export interface MonthDaySummary {
  readonly date: string;
  readonly dayType: string | null;    // null when the day has no data
  readonly status: MonthDayStatus;
  readonly claimedMs: number;         // raw local total (sessions + manual)
  readonly reportedSeconds: number;   // Σ tasks[].seconds — what push would send
  readonly taskCount: number;         // unique task keys
  readonly tasks: readonly MonthDayTask[];
  readonly pushedAt: string | null;
  // Present only when the month has a Tempo snapshot: what exactly diverges
  // from Tempo, one human line per drift (empty array = verified parity).
  readonly drift?: readonly string[];
}

export interface MonthTotals {
  readonly claimedMs: number;
  readonly reportedSeconds: number;
  readonly daysWithData: number;
  readonly pendingDays: number;
  readonly outdatedDays: number;
  readonly pushedDays: number;
}

export interface MonthResponse {
  readonly year: number;
  readonly month: number;             // 1-12
  readonly from: string;              // YYYY-MM-DD, first day
  readonly to: string;                // YYYY-MM-DD, last day
  // Full calendar month, oldest first — days without data carry status 'none'.
  readonly days: readonly MonthDaySummary[];
  readonly totals: MonthTotals;
  readonly lastPushAt: string | null; // max pushedAt across the month
  // fetchedAt of the Tempo snapshot the statuses were derived from,
  // null = no snapshot → statuses fall back to local pushed-flags.
  readonly syncedAt?: string | null;
}

// ─── Tempo month meta (schedule / approvals proxies) ────────────────────

// Why the Tempo-side data is missing. UI degrades silently on any of these:
// no-token — Tempo/Jira not configured; scope — token lacks the required
// scope (schemes:view / approvals:view); error — network/API failure.
export type TempoMetaUnavailableReason = 'no-token' | 'scope' | 'error';

export interface ScheduleDay {
  readonly date: string;
  readonly requiredSeconds: number;
  // WORKING_DAY | NON_WORKING_DAY | HOLIDAY | HOLIDAY_AND_NON_WORKING_DAY
  readonly type: string;
  readonly holidayName: string | null;
}

export interface TempoScheduleResponse {
  readonly available: boolean;
  readonly reason?: TempoMetaUnavailableReason;
  readonly days: readonly ScheduleDay[];
  readonly requiredSecondsTotal: number;
  readonly fromCache: boolean;
}

export interface TempoApprovalResponse {
  readonly available: boolean;
  readonly reason?: TempoMetaUnavailableReason;
  readonly period: { readonly from: string; readonly to: string } | null;
  readonly statusKey: string | null;        // OPEN | IN_REVIEW | APPROVED
  readonly requiredSeconds: number | null;
  readonly timeSpentSeconds: number | null; // Tempo-side logged total
  readonly canSubmit: boolean;              // actions.submit present (v2 groundwork)
  readonly fromCache: boolean;
}

// ─── Settings ───────────────────────────────────────────────────────────

/** Subset of AppConfig exposed via GET /api/settings (UI-editable surface). */
export interface SettingsConfigSubset {
  readonly repos: readonly string[];
  readonly boundaryHour: number;
  readonly timezone: string;
  readonly taskPattern: string;
  readonly sensitivity: {
    readonly default: SensitivityLevel;
    readonly perRepo: Readonly<Record<string, SensitivityLevel>>;
  };
}

export interface SettingsResponse {
  readonly config: SettingsConfigSubset;
  readonly secretsMeta: {
    readonly jiraConfigured: boolean;
    readonly tempoConfigured: boolean;
  };
  readonly daemonVersion: string;
}

export interface AddRepoResponse {
  readonly repos: readonly string[];
}

// ─── Report & Push ──────────────────────────────────────────────────────

export type ReportEntryKind = 'session' | 'manual';

export interface TaskDayReport {
  readonly date: string;        // YYYY-MM-DD
  readonly task: string;        // e.g. ATL-6173
  readonly totalSeconds: number;
  readonly sessionCount: number;
  readonly kind: ReportEntryKind;  // 'session' = aggregated git work, 'manual' = standalone entry
  readonly entryId?: string;       // ManualEntry.id — manual kind only
  readonly description?: string;   // manual kind only → worklog description
  readonly activity?: string;      // manual kind only → Tempo _Activity_ value
}

export interface TempoWorklog {
  readonly tempoWorklogId: number;
  readonly issueId: number;
  readonly startDate: string;
  readonly timeSpentSeconds: number;
  readonly description?: string;   // plain worklog text as Tempo has it now
  readonly activity?: string;      // _Activity_ attribute value
  readonly updatedAt?: string;     // Tempo-side last modification (ISO)
}

// POST /api/tempo-sync — refresh the month's Tempo snapshot on demand.
export interface TempoSyncResponse {
  readonly month: string;          // YYYY-MM
  readonly syncedAt: string;       // snapshot fetchedAt
  readonly worklogCount: number;
}

// POST /api/tempo-import — adopt foreign worklogs into local manual entries
// with push-log ownership (mirror pull). One item per targeted worklog.
export interface TempoImportItem {
  readonly tempoWorklogId: number;
  readonly date: string;           // worklog startDate
  readonly task: string;           // resolved key, or 'issue #<id>' when unresolved
  readonly seconds: number;
  readonly entryId?: string;       // created ManualEntry id (success only)
  readonly error?: string;         // failure reason; absent = imported
}

export interface TempoImportResponse {
  readonly month: string;          // YYYY-MM
  readonly syncedAt: string;       // import re-fetches the snapshot first
  readonly imported: number;
  readonly failed: number;
  readonly items: readonly TempoImportItem[];
}

// One month of the user's Tempo worklogs as last fetched — the remote side
// of mirror-sync. Cached in data/tempo-cache/YYYY-MM.json.
export interface TempoMonthSnapshot {
  readonly month: string;          // YYYY-MM
  readonly accountId: string;
  readonly fetchedAt: string;
  readonly worklogs: readonly TempoWorklog[];
  // issueId → ticket key ('ATL-7446') — resolved at fetch time so foreign
  // rows render offline. Best-effort: an unresolved id is simply absent.
  readonly issueKeys?: Readonly<Record<string, string>>;
}

export interface JiraIssue {
  readonly issueId: number;
  readonly summary: string;
}

export type PushActionType = 'create' | 'update' | 'delete' | 'skip' | 'error';

export interface PushPlanEntry {
  readonly date: string;
  readonly task: string;
  readonly targetSeconds: number;
  readonly action: PushActionType;
  readonly detail: string;
  readonly issueId?: number;
  readonly existingWorklogId?: number;
  readonly extraWorklogIds?: readonly number[];
  readonly kind: ReportEntryKind;  // mirrors the source report entry
  readonly entryId?: string;       // manual kind: ManualEntry.id (pushLog key + snapshot)
  readonly description?: string;   // manual kind: text to send
  readonly activity?: string;      // manual kind: _Activity_ value to send
  readonly conflict?: boolean;     // the worklog was edited/removed on the Tempo side since our push
}

export interface PushResult {
  readonly posted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface ReportResponse {
  readonly from: string;
  readonly to: string;
  readonly entries: readonly TaskDayReport[];
  readonly taskTotals: Readonly<Record<string, number>>;
  readonly totalSeconds: number;
}

export interface PushLogEntry {
  readonly tempoWorklogId: number;
  readonly timeSpentSeconds: number;
  readonly pushedAt: string;
  readonly description?: string;   // snapshot of last pushed text — manual entries (drift detection)
  readonly activity?: string;      // snapshot of last pushed _Activity_ value
}

// A pushed manual entry deleted locally: its Tempo worklog must eventually be
// deleted too. Recorded on local delete, consumed by the push delete pass.
export interface PushTombstone {
  readonly date: string;
  readonly task: string;
  readonly entryId: string;
  readonly tempoWorklogId: number;
  readonly deletedAt: string;
}

export interface PushResponse {
  readonly dryRun: boolean;
  readonly plan: readonly PushPlanEntry[];
  readonly result?: PushResult;
  // Commit push refused: the plan contains conflict entries (edited in Tempo
  // since our push) and force was not set. Nothing was executed.
  readonly blockedByConflicts?: boolean;
}

// ─── Activity Evaluator ─────────────────────────────────────────────────

export interface ActivitySignals {
  readonly hasDynamics: boolean;
  readonly hasCommit: boolean;
  readonly deltaMagnitude: number; // per-file churn line-equivalent (GitDelta.magnitude)
}

export interface TickInput {
  readonly sessionId: string;
  readonly signals: ActivitySignals;
  readonly maxTicks: number;
  readonly ignoreIdleTimeout: boolean;
}

export interface EvaluatorResult {
  readonly scores: Map<string, SessionScore>;
  readonly leaderId: string | null;
}

export interface SessionScore {
  readonly score: number;
  readonly maxScore: number;
  readonly normalizedScore: number; // score / maxScore (0..1)
  readonly ema: number;
  readonly etaTicks: number; // ticks until auto-pause with no further activity
  readonly isIdleTimeout: boolean; // score == 0
}
