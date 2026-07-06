// Mirrors the daemon HTTP API response types

export const EXPECTED_API_VERSION = 9;

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
  // Machine-readable discriminator (mirrors the daemon's ApiErrorCode) —
  // never string-match the error text.
  errorCode?: ApiErrorCode;
  apiVersion?: number;
}

export enum ApiErrorCode {
  JiraNotFound = 'jira-not-found',
  JiraNotConfigured = 'jira-not-configured',
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

// Declared time on a task. Mirrors the daemon's ManualEntry. Standalone
// entries (via "Log") become their own Tempo worklogs; session-born entries
// (via "+ Add time", sourceSessionId set) fold into the session aggregate at
// push time and are not editable.
export interface ManualEntry {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
  readonly description: string;     // '' for session-born
  readonly activity: string;        // Tempo _Activity_ value, e.g. 'CodeReview'
  readonly createdAt: string;
  readonly sourceSessionId?: string;
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

// Mirrors the daemon's DEFAULT_ACTIVITY — the only activity that may carry
// an empty description (session-born entries and quiet dev logs).
export const DEVELOPMENT_ACTIVITY = 'Development';

// Returned by POST /api/manual-entry and /api/manual-entry/update.
export interface ManualEntryResponse {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
  readonly description: string;
  readonly activity: string;
  readonly totalManualMinutes: number;
}

// Returned by POST /api/manual-entry/delete.
export interface ManualEntryDeleteResponse {
  readonly id: string;
  readonly task: string;
  readonly minutes: number;
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

// ─── Favorites (manual-entry templates) ────────────────────────────────────

// Mirrors the daemon's Favorite — a reusable log template shown as a chip in
// the log cloud. Day-independent; logging from one creates a plain ManualEntry
// (name → description).
export interface Favorite {
  readonly id: string;
  readonly name: string;        // chip label; becomes the entry description
  readonly task: string;
  readonly minutes: number;
  readonly activity: string;
  readonly createdAt: string;
}

/**
 * Favorite-name comparison key: case-insensitive, inner whitespace collapsed.
 * Template identity = task + this key + minutes; keep in sync with the
 * daemon's normalizeFavoriteName (src/core/favorites.ts).
 */
export function normalizeFavName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface FavoritesResponse {
  readonly favorites: readonly Favorite[];
}

// Mutations echo the touched favorite plus the full list — one hop to refresh.
export interface FavoriteAddResponse {
  readonly added: Favorite;
  readonly favorites: readonly Favorite[];
}

export interface FavoriteRemoveResponse {
  readonly removed: Favorite;
  readonly favorites: readonly Favorite[];
}

// Input for adding a favorite (right-click on a logged row in the redesign).
export interface FavoriteInput {
  readonly name: string;
  readonly task: string;
  readonly minutes: number;
  readonly activity: string;
}

// ─── Jira search (log-cloud live fallback) ─────────────────────────────────

export interface JiraSearchHit {
  readonly key: string;      // e.g. 'ATL-6712'
  readonly summary: string;  // plain text
}

export interface JiraSearchResponse {
  readonly hits: readonly JiraSearchHit[];
}

// ─── Timesheets (month view) ─────────────────────────────────────────────
// Mirrors the daemon's month/push/Tempo-meta contract (src/core/types.ts).

// Sync state of a day vs Tempo, derived offline from the daily log alone:
// pending — has data, never pushed; outdated — pushed, then edited (Tempo
// holds a stale version, next push sends updates); pushed — in sync.
export enum MonthDayStatus {
  None = 'none',
  Pending = 'pending',
  Pushed = 'pushed',
  Outdated = 'outdated',
}

export type ReportEntryKind = 'session' | 'manual';

// One would-be Tempo worklog line: session aggregate (rounded, session-born
// entries folded in) or a standalone manual entry.
export interface MonthDayTask {
  readonly task: string;
  readonly seconds: number;
  readonly kind: ReportEntryKind;
  readonly sessionCount: number;   // 0 for manual kind
  readonly description?: string;   // manual kind only
  readonly activity?: string;      // manual kind only
}

export interface MonthDaySummary {
  readonly date: string;              // YYYY-MM-DD
  readonly dayType: string | null;    // null when the day has no data
  readonly status: MonthDayStatus;
  readonly claimedMs: number;         // raw local total (sessions + manual)
  readonly reportedSeconds: number;   // Σ tasks[].seconds — what push would send
  readonly taskCount: number;
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
  readonly lastPushAt: string | null;
  // fetchedAt of the Tempo snapshot the statuses were derived from,
  // null/absent = no snapshot → statuses fall back to local pushed-flags.
  readonly syncedAt?: string | null;
}

// ─── Tempo month meta (schedule / approvals proxies) ─────────────────────

// Why the Tempo-side data is missing — the UI degrades silently on any of
// these (no gauge, no holidays, no period pill).
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
  readonly canSubmit: boolean;
  readonly fromCache: boolean;
}

// ─── Push to Tempo ───────────────────────────────────────────────────────

export type PushActionType = 'create' | 'update' | 'delete' | 'skip' | 'error';

export interface PushPlanEntry {
  readonly date: string;
  readonly task: string;
  readonly targetSeconds: number;
  readonly action: PushActionType;
  readonly detail: string;
  readonly kind: ReportEntryKind;
  readonly conflict?: boolean;     // worklog edited/removed on the Tempo side since our push
}

export interface PushResult {
  readonly posted: number;
  readonly updated: number;
  readonly deleted: number;
  readonly skipped: number;
  readonly failed: number;
}

export interface PushResponse {
  readonly dryRun: boolean;
  readonly plan: readonly PushPlanEntry[];
  readonly result?: PushResult;
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
