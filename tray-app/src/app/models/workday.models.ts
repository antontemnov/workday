// Mirrors the daemon HTTP API response types

export const EXPECTED_API_VERSION = 8;

export enum SensitivityLevel {
  Low = 'low',
  Normal = 'normal',
  Patient = 'patient',
  AlwaysOn = 'always_on',
}

export type SensitivityPill = SensitivityLevel | 'pause';

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  apiVersion?: number;
}

export interface Evidence {
  commits: number;
  reflogEvents: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

export interface SessionDetail {
  id: string;
  repo: string;
  task: string | null;
  branch: string;
  state: string;            // 'pending' | 'active'
  startedAt: string;
  activatedAt: string | null;
  lastSeenAt: string;
  paused: boolean;
  pauseSource: string | null;
  effectiveDurationMs: number;
  manualMinutes: number;
  score: number;
  normalizedScore: number;
  isLeader: boolean;
  sensitivity: SensitivityLevel;
  closedBy: string | null;
  evidence: Evidence;
  pauseCount: number;
  totalPauseDurationMs: number;
}

export interface ActiveInterval {
  readonly from: string;
  readonly to: string;
  readonly sessionId: string;
  readonly repo: string;
}

// Standalone time logged on a task with no tracked git session (meeting, code
// review, planning). Mirrors the daemon's ManualEntry — its own Tempo worklog.
export interface ManualEntry {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;        // Tempo _Activity_ value, e.g. 'CodeReview'
  readonly createdAt: string;
}

export interface TodayResponse {
  date: string;
  dayType: string;
  status: string;
  sessions: SessionDetail[];
  manualEntries: readonly ManualEntry[];
  totalEffectiveMs: number;
  signalCount: number;
  claimedMs: number;
  // Derived-only: earliest activatedAt across sessions (daemon-resolved).
  dayStart: string | null;
  activeIntervals: ActiveInterval[];
  downtimeMs?: number;
}

export interface StatusResponse {
  running: boolean;
  pid: number;
  date: string;
  uptime: number;
}

export interface SensitivityResponse {
  repo: string | null;
  level: SensitivityLevel;
}

export interface AdjustResponse {
  sessionId: string;
  repo: string;
  task: string | null;
  addedMinutes: number;
  totalManualMinutes: number;
}

export interface SessionDeleteResponse {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly effectiveDurationMs: number;
  readonly dayFileDeleted: boolean;
  readonly dayWasPushed: boolean;
}

export interface DaysResponse {
  readonly dates: readonly string[];
}

// ─── Manual entries ────────────────────────────────────────────────────────

// Tempo _Activity_ option — value is sent to Tempo, name is the display label.
export interface ActivityType {
  readonly value: string;   // e.g. 'CodeReview'
  readonly name: string;    // e.g. 'Code Review'
}

export interface ActivityTypesResponse {
  readonly key: string;                          // '_Activity_'
  readonly activities: readonly ActivityType[];
  readonly fromCache: boolean;                   // false when served from fallback
}

// Returned by POST /api/manual-entry and /api/manual-entry/update.
export interface ManualEntryResponse {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;
  readonly totalManualMinutes: number;
}

// Input for adding / editing a manual entry from the UI.
export interface ManualEntryInput {
  readonly task: string;
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;
}

export type ManualEntryPatch = Partial<Pick<ManualEntryInput, 'minutes' | 'description' | 'activity'>>;

// ─── Timesheets ──────────────────────────────────────────────────────────

// Mirrors src/core/types.ts DayStatus on the daemon side.
export enum DayStatus {
  Draft = 'draft',
  Confirmed = 'confirmed',
  Pushed = 'pushed',
}

export interface MonthDayTask {
  readonly key: string;        // e.g. 'ATL-6781' or 'standup'
  readonly ms: number;
}

export interface MonthDay {
  readonly date: string;       // YYYY-MM-DD
  readonly dayType: string;    // workday | weekend | holiday | overtime
  readonly status: DayStatus;
  readonly claimedMs: number;
  readonly tasks: readonly MonthDayTask[];
}

export interface MonthResponse {
  readonly year: number;
  readonly month: number;      // 1-12
  readonly days: readonly MonthDay[];
}

// ─── Settings ────────────────────────────────────────────────────────────

// Subset of AppConfig the UI exposes — keeps the surface small for MVP.
export interface SettingsConfigSubset {
  readonly repos: readonly string[];
  readonly boundaryHour: number;
  readonly timezone: string;
  readonly taskPattern: string;
  readonly sensitivity: {
    readonly default: SensitivityLevel;
    readonly perRepo?: Readonly<Record<string, SensitivityLevel>>;
  };
}

// GET /api/settings returns config + metadata about which secrets are set
// (never the raw token values). Editing a token = POST a new value.
export interface SettingsResponse {
  readonly config: SettingsConfigSubset;
  readonly secretsMeta: {
    readonly jiraConfigured: boolean;
    readonly tempoConfigured: boolean;
  };
  readonly daemonVersion?: string;
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

export interface SettingsPatch {
  readonly config?: Partial<SettingsConfigSubset>;
  readonly secrets?: {
    readonly jiraToken?: string;
    readonly tempoToken?: string;
  };
}

// POST /api/repo and /api/repo/remove both return the new repos list.
export interface AddRepoResponse {
  readonly repos: readonly string[];
}
