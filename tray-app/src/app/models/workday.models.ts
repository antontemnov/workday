// Mirrors the daemon HTTP API response types

export const EXPECTED_API_VERSION = 6;

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

export interface TodayResponse {
  date: string;
  dayType: string;
  status: string;
  sessions: SessionDetail[];
  totalEffectiveMs: number;
  signalCount: number;
  budgetMs: number;
  claimedMs: number;
  remainingBudgetMs: number;
  dayStartedAt: string | null;
  manualStart: string | null;
  schedule: { start: number; end: number };
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
  remainingBudgetMs: number;
}

export interface SetStartResponse {
  dayStart: string;
  budgetMs: number;
  remainingBudgetMs: number;
}

export interface DaysResponse {
  readonly dates: readonly string[];
}

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
  readonly schedule: { readonly start: number; readonly end: number };
  readonly timezone: string;
  readonly taskPattern: string;
  readonly sensitivity: { readonly default: SensitivityLevel };
}

// GET /api/settings returns config + metadata about which secrets are set
// (never the raw token values). Editing a token = POST a new value.
export interface SettingsResponse {
  readonly config: SettingsConfigSubset;
  readonly secretsMeta: {
    readonly jiraConfigured: boolean;
    readonly tempoConfigured: boolean;
  };
}

export interface SettingsPatch {
  readonly config?: Partial<SettingsConfigSubset>;
  readonly secrets?: {
    readonly jiraToken?: string;
    readonly tempoToken?: string;
  };
}
