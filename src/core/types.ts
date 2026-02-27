// ─── Config ──────────────────────────────────────────────────────────────

export interface AppConfig {
  readonly repos: readonly string[];
  readonly dayStart: string;
  readonly dayBoundaryHour: number;
  readonly taskPattern: string;
  readonly genericBranches: readonly string[];
  readonly session: SessionConfig;
  readonly report: ReportConfig;
  readonly workDays: readonly number[];
  readonly holidays: readonly string[];
}

export interface SessionConfig {
  readonly diffPollSeconds: number;
  readonly minSessionMinutes: number;
  readonly minConfidence: number;
}

export interface ReportConfig {
  readonly roundToHalfHour: boolean;
}

export interface Secrets {
  readonly Developer: string;
  readonly Jira_Email: string;
  readonly Jira_BaseUrl: string;
  readonly Jira_Token: string;
  readonly Tempo_Token: string;
}

// ─── Session state machine ───────────────────────────────────────────────

export const SESSION_STATE = {
  PENDING: 'pending',
  ACTIVE: 'active',
} as const;

export type SessionState = typeof SESSION_STATE[keyof typeof SESSION_STATE];

export const CLOSED_BY = {
  CHECKOUT_OTHER_TASK: 'checkout_other_task',
  DAY_BOUNDARY: 'day_boundary',
  DAEMON_STOP: 'daemon_stop',
  MANUAL_STOP: 'manual_stop',
} as const;

export type ClosedBy = typeof CLOSED_BY[keyof typeof CLOSED_BY];

// ─── Evidence & Sessions ─────────────────────────────────────────────────

export interface Evidence {
  commits: number;
  dynamicsHeartbeats: number;
  totalSnapshots: number;
  reflogEvents: number;
}

export interface Session {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly branch: string;
  state: SessionState;
  startedAt: string;
  endedAt: string;
  closedBy: ClosedBy | null;
  evidence: Evidence;
}

// ─── Signals ─────────────────────────────────────────────────────────────

export const SIGNAL_TYPE = {
  DIFF_DYNAMICS: 'diff_dynamics',
  COMMIT: 'commit',
  CHECKOUT: 'checkout',
} as const;

export type SignalType = typeof SIGNAL_TYPE[keyof typeof SIGNAL_TYPE];

export interface DiffDynamicsSignal {
  readonly ts: number;
  readonly type: typeof SIGNAL_TYPE.DIFF_DYNAMICS;
  readonly repo: string;
  readonly delta: { readonly added: number; readonly removed: number };
}

export interface CommitSignal {
  readonly ts: number;
  readonly type: typeof SIGNAL_TYPE.COMMIT;
  readonly repo: string;
  readonly task: string | null;
}

export interface CheckoutSignal {
  readonly ts: number;
  readonly type: typeof SIGNAL_TYPE.CHECKOUT;
  readonly repo: string;
  readonly task: string | null;
}

export type Signal = DiffDynamicsSignal | CommitSignal | CheckoutSignal;

// ─── Daily Log ───────────────────────────────────────────────────────────

export const DAY_STATUS = {
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  PUSHED: 'pushed',
} as const;

export type DayStatus = typeof DAY_STATUS[keyof typeof DAY_STATUS];

export const DAY_TYPE = {
  WORKDAY: 'workday',
  WEEKEND: 'weekend',
  HOLIDAY: 'holiday',
  OVERTIME: 'overtime',
} as const;

export type DayType = typeof DAY_TYPE[keyof typeof DAY_TYPE];

export interface DailyLog {
  readonly date: string;
  status: DayStatus;
  dayType: DayType;
  manualStart: string | null;
  sessions: Session[];
  signals: Signal[];
  confirmedAt: string | null;
  pushedAt: string | null;
  note: string;
}

// ─── Git Snapshot (runtime, not persisted) ───────────────────────────────

export interface GitSnapshot {
  readonly branch: string;
  readonly trackedLines: { readonly added: number; readonly removed: number };
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

export interface ReflogEntry {
  readonly ts: number;
  readonly type: 'commit' | 'checkout' | 'other';
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

export const REPO_STATE = {
  IDLE: 'idle',
  PENDING: 'pending',
  ACTIVE: 'active',
} as const;

export type RepoState = typeof REPO_STATE[keyof typeof REPO_STATE];

export interface RepoTracker {
  state: RepoState;
  currentBranch: string | null;
  currentTask: string | null;
  activeSessionId: string | null;
  previousSnapshot: GitSnapshot | null;
  lastReflogTs: number;
}
