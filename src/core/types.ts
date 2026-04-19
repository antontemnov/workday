// ─── Config ──────────────────────────────────────────────────────────────

export interface ScheduleConfig {
  readonly start: number; // 0-23, hour when work schedule begins
  readonly end: number;   // 0-23, hour when work schedule ends (next day if < start)
}

export interface AppConfig {
  readonly repos: readonly string[];
  readonly schedule: ScheduleConfig;
  readonly timezone: string;        // IANA timezone, e.g. "Europe/Moscow"
  readonly taskPattern: string;
  readonly genericBranches: readonly string[];
  readonly session: SessionConfig;
  readonly report: ReportConfig;
  readonly workDays: readonly number[];
  readonly holidays: readonly string[];
  readonly apiPort: number;
}

export interface SessionConfig {
  readonly diffPollSeconds: number;
  readonly signalDeduplicationSeconds: number;
  readonly dayBoundaryCheckSeconds: number;
  readonly reflogCount: number;
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
  BudgetExhausted = 'budget_exhausted',
}

// ─── Manual Adjustment ──────────────────────────────────────────────────

export interface ManualAdjustment {
  readonly minutes: number;     // > 0, max 480
  readonly reason: string;
  readonly addedAt: string;     // ISO timestamp
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
  manualAdjustments: ManualAdjustment[];
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
  manualStart: string | null;
  dayStartedAt: string | null;
  sessions: Session[];
  signals: Signal[];
  pushedAt: string | null;
}

// ─── Git Snapshot (runtime, not persisted) ───────────────────────────────

export interface GitSnapshot {
  readonly branch: string;
  readonly trackedLines: { readonly added: number; readonly removed: number };
  readonly trackedFileCount: number;
  readonly untrackedCount: number;
  readonly timestamp: number;
}

export interface GitDelta {
  readonly addedDelta: number;
  readonly removedDelta: number;
  readonly untrackedDelta: number;
  readonly hasDynamics: boolean;
}

// ─── Reflog ──────────────────────────────────────────────────────────────

export type ReflogEntryType = 'commit' | 'checkout' | 'reset' | 'other';

export interface ReflogEntry {
  readonly ts: number;
  readonly type: ReflogEntryType;
  readonly message: string;
}

// ─── Git collector I/O ───────────────────────────────────────────────────

export interface RawGitOutput {
  readonly branch: string;
  readonly diffNumstat: string;
  readonly statusPorcelain: string;
  readonly reflog: string;
}

export interface PollResult {
  readonly repoPath: string;
  readonly branch: string;
  readonly task: string | null;
  readonly snapshot: GitSnapshot;
  readonly delta: GitDelta;
  readonly newReflogEntries: ReflogEntry[];
}

// ─── Daemon runtime state (per repo, not persisted) ─────────────────────

export enum RepoState {
  Idle = 'idle',
  Pending = 'pending',
  Active = 'active',
}

export interface RepoTracker {
  state: RepoState;
  currentBranch: string | null;
  currentTask: string | null;
  activeSessionId: string | null;
  previousSnapshot: GitSnapshot | null;
  lastReflogTs: number;
}

// ─── HTTP API ───────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: string;
  readonly apiVersion?: number;
}

export interface StatusResponse {
  readonly running: boolean;
  readonly pid: number;
  readonly date: string;
  readonly uptime: number;
  readonly openSessions: readonly SessionSummary[];
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
  readonly manualMinutes: number;
  readonly score: number;
  readonly normalizedScore: number;
  readonly isLeader: boolean;
  readonly autoPauseDisabled: boolean;
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
  readonly totalEffectiveMs: number;
  readonly signalCount: number;
  readonly budgetMs: number;
  readonly claimedMs: number;
  readonly remainingBudgetMs: number;
  readonly dayStartedAt: string | null;
  readonly schedule: ScheduleConfig;
  readonly activeIntervals: readonly ActiveInterval[];
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

export interface AutoPauseResponse {
  readonly repo: string | null;
  readonly autoPauseDisabled: boolean;
}

export interface AdjustResponse {
  readonly sessionId: string;
  readonly repo: string;
  readonly task: string | null;
  readonly addedMinutes: number;
  readonly totalManualMinutes: number;
  readonly remainingBudgetMs: number;
}

export interface SetStartResponse {
  readonly dayStart: string;
  readonly budgetMs: number;
  readonly remainingBudgetMs: number;
}

// ─── Report & Push ──────────────────────────────────────────────────────

export interface TaskDayReport {
  readonly date: string;        // YYYY-MM-DD
  readonly task: string;        // e.g. ATL-6173
  readonly totalSeconds: number;
  readonly sessionCount: number;
}

export interface TempoWorklog {
  readonly tempoWorklogId: number;
  readonly issueId: number;
  readonly startDate: string;
  readonly timeSpentSeconds: number;
}

export interface JiraIssue {
  readonly issueId: number;
  readonly summary: string;
}

export type PushActionType = 'create' | 'update' | 'skip' | 'error';

export interface PushPlanEntry {
  readonly date: string;
  readonly task: string;
  readonly targetSeconds: number;
  readonly action: PushActionType;
  readonly detail: string;
  readonly issueId?: number;
  readonly existingWorklogId?: number;
  readonly extraWorklogIds?: readonly number[];
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
}

export interface PushResponse {
  readonly dryRun: boolean;
  readonly plan: readonly PushPlanEntry[];
  readonly result?: PushResult;
}

// ─── Activity Evaluator ─────────────────────────────────────────────────

export interface ActivitySignals {
  readonly hasDynamics: boolean;
  readonly hasCommit: boolean;
  readonly deltaMagnitude: number; // |addedDelta| + |removedDelta|
}

export interface TickInput {
  readonly sessionId: string;
  readonly signals: ActivitySignals;
  readonly autoPauseDisabled: boolean;
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
  readonly isIdleTimeout: boolean; // score == 0
}
