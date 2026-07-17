// ─── File names ─────────────────────────────────────────────────────────
export const CONFIG_FILE_NAME = 'config.json';
export const SECRETS_FILE_NAME = 'secrets.json';
export const PID_FILE_NAME = 'workday.pid';
// Manual-stop marker (in WORKDAY_HOME) — the tray watchdog does not respawn
// a manually stopped daemon; cleared on daemon start / autostart login.
export const STOP_MARKER_FILE_NAME = 'daemon.stopped';
export const FAVORITES_FILE_NAME = 'favorites.json';
export const DATA_DIR_NAME = 'data';
export const TMP_EXTENSION = '.tmp';
export const BACKUP_EXTENSION = '.bak';

// ─── Daemon script resolution ───────────────────────────────────────────
export const DAEMON_SCRIPT_TS = 'daemon.ts';
export const DAEMON_SCRIPT_JS = 'daemon.js';

// ─── HTTP API ──────────────────────────────────────────────────────────
export const DEFAULT_API_PORT = 9213;
// Bump ONLY on breaking API changes (additive endpoints/fields don't count).
// Release ritual for a bump: ship the tray release first, let live trays
// pick it up (they re-check every 6h), THEN npm-publish the daemon —
// a tray with the old exact-match check meeting a newer apiVersion would
// reinstall-loop the daemon.
export const API_VERSION = 13;

// ─── Auto-update ────────────────────────────────────────────────────────
export const NPM_PACKAGE_NAME = 'workday-daemon';
export const NPM_REGISTRY_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;
/** Registry check timeout — fail fast, the next scheduled check will retry */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;
/** npm install -g can be slow on cold cache / slow network — be generous */
export const NPM_INSTALL_TIMEOUT_MS = 180_000;
/** Daemon checks the registry this often (~2-4 times per working day) */
export const UPDATE_CHECK_INTERVAL_HOURS = 6;
/** Random startup delay before the first scheduled check (thundering-herd hygiene) */
export const UPDATE_CHECK_JITTER_MINUTES = 10;

// ─── File locking ──────────────────────────────────────────────────────
export const LOCK_EXTENSION = '.lock';
export const LOCK_STALE_MS = 10_000;

// ─── Git internals ──────────────────────────────────────────────────────
export const GIT_BATCH_SEPARATOR = '---WORKDAY-SEP---';
export const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// ─── Manual entry cap (per-item typo guard) ─────────────────────────────
export const MAX_ENTRY_MINUTES = 480;

// ─── Manual entry / Activity types ──────────────────────────────────────
export const ACTIVITY_ATTRIBUTE_KEY = '_Activity_';
export const DEFAULT_ACTIVITY = 'Development';        // sessions (value == name)
export const DEFAULT_MANUAL_ACTIVITY = 'Other';       // manual entry, when unspecified
export const WORK_ATTRIBUTES_CACHE_FILE = 'work-attributes-cache.json';
// Fallback _Activity_ values (value/name) used only when no Tempo token /
// fetch fails. Mirrors the live instance — refreshed into cache on first
// successful GET /4/work-attributes.
export const FALLBACK_ACTIVITIES: ReadonlyArray<{ readonly value: string; readonly name: string }> = [
  { value: 'AutomationPerformanceTesting', name: 'Automation/Performance Testing' },
  { value: 'Bugfixing', name: 'Bugfixing' },
  { value: 'CodeReview', name: 'Code Review' },
  { value: 'CodeReviewFixes', name: 'Code Review Fixes' },
  { value: 'DesignAnalysis', name: 'Design/Analysis' },
  { value: 'Development', name: 'Development' },
  { value: 'EnvironmentSetup', name: 'Environment Setup' },
  { value: 'Estimation', name: 'Estimation' },
  { value: 'IntegrationTesting', name: 'Integration Testing' },
  { value: 'Merge', name: 'Merge' },
  { value: 'Other', name: 'Other' },
  { value: "QAlead'sactivities", name: "QA lead's activities" },
  { value: 'PM', name: 'PM' },
  { value: 'TechnicalControl', name: 'Technical Control' },
  { value: 'Testing', name: 'Testing' },
  { value: 'TestReview', name: 'Test Review' },
];

// ─── Jira search (log-cloud live fallback) ──────────────────────────────
// Queries shorter than this return empty without hitting Jira (mirrors the
// tray's len>=2 debounce rule).
export const JIRA_SEARCH_MIN_QUERY_LENGTH = 2;
// In-memory cache of recent search queries — results are perishable, never
// persisted to disk.
export const JIRA_SEARCH_CACHE_TTL_MS = 5 * 60_000;
export const JIRA_SEARCH_CACHE_MAX_ENTRIES = 50;
// JQL page size for a live search, and the max ranked hits handed back.
export const JQL_SEARCH_MAX_RESULTS = 20;
export const SEARCH_MAX_HITS = 10;
// Below this many JQL hits, also pull the picker (recency + key-number prefix
// the enhanced search can't do) and merge. Words shorter than the min never
// go into a `summary ~` clause (a 1-char prefix matches half the backlog).
export const SEARCH_PICKER_FILL_THRESHOLD = 8;
export const SEARCH_MIN_WORD_LENGTH = 2;

// Generic Jira issue-key shape (PROJECT-NUMBER). Logging accepts any real Jira
// key — existence is confirmed against Jira — so this is only a garbage guard,
// NOT project-scoped. config.tracking stays reserved for git-activity
// tracking (whose branches/commits to follow), never for what you may log.
export const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]+-\d+$/;

// ─── Push / Tempo ───────────────────────────────────────────────────────
export const ISSUE_CACHE_FILE = 'issue-cache.json';
export const PUSH_LOG_FILE = 'push-log.json';
export const PUSH_TOMBSTONES_FILE = 'push-tombstones.json';
export const TEMPO_REPORT_DIR = 'tempo';
export const TEMPO_CACHE_DIR = 'tempo-cache';
export const TEMPO_BASE_URL = 'https://api.tempo.io';
export const TEMPO_RATE_LIMIT_MS = 210;
export const TEMPO_TOLERANCE_SECONDS = 60;

// ─── Tempo month meta (schedule / approvals proxies) ────────────────────
// Schedule changes ~never (holiday scheme edits) — a day of staleness is fine.
export const SCHEDULE_CACHE_FILE = 'schedule-cache.json';
export const SCHEDULE_CACHE_TTL_MS = 24 * 3_600_000;
// Approval status can flip any time (reviewer action) — keep it short.
// The cache is also dropped entirely after every successful push.
export const APPROVAL_CACHE_FILE = 'approval-cache.json';
export const APPROVAL_CACHE_TTL_MS = 15 * 60_000;

// ─── Calendar feed (meeting suggestions) ────────────────────────────────
export const CALENDAR_CACHE_FILE = 'calendar-cache.json';
/** Expansion window: past for Timesheets backfill, +1 day for "идёт" rows */
export const CALENDAR_WINDOW_PAST_DAYS = 90;
export const CALENDAR_WINDOW_FUTURE_DAYS = 1;
/** Base re-fetch cadence (Exchange-side publish cache lags anyway) */
export const CALENDAR_FETCH_INTERVAL_MS = 3 * 3_600_000;
/**
 * Morning window: calendar re-shuffles are most likely at the start of the
 * working day, so 10:00–14:00 local time fetches hourly instead of 3-hourly.
 */
export const CALENDAR_MORNING_FETCH_INTERVAL_MS = 3_600_000;
export const CALENDAR_MORNING_FROM_HOUR = 10; // inclusive, local time
export const CALENDAR_MORNING_TO_HOUR = 14;   // exclusive
/** Outlook answers 417 to non-browser user agents on the legacy /owa/ path */
export const ICS_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
export const ICS_FETCH_TIMEOUT_MS = 30_000;
/** Runaway guard for recurrence expansion of a single series */
export const RRULE_MAX_ITERATIONS = 20_000;

// ─── Meeting suggestions ────────────────────────────────────────────────
/** data/suggestions-state.json — dismissed keys only; accept is derived */
export const SUGGESTIONS_STATE_FILE = 'suggestions-state.json';
export const SUGGESTION_SOURCE_MEETING = 'meeting';
/** data/meeting-associations.json — learned series→ticket memory */
export const MEETING_ASSOCIATIONS_FILE = 'meeting-associations.json';
/** Associations idle this long are pruned on load (~6 months — must survive
 *  quarterly meetings plus a vacation; the calendar cache window is separate) */
export const MEETING_ASSOCIATION_RETENTION_DAYS = 183;
/** Consecutive dismissed instances that mute a series (reset by accept) */
export const MEETING_MUTE_THRESHOLD = 10;

// ─── Notifications (desktop toasts) ──────────────────────────────────────
export const NOTIFICATIONS_STATE_FILE = 'notifications-state.json';
/** Delivery window opens at this hour on the last working day of the month */
export const DEFAULT_NOTIFY_HOUR = 14;
// Rule evaluation is lazy (on GET) — the memo keeps the month aggregate from
// being rebuilt more than once a minute under tray polling.
export const NOTIFICATION_MEMO_TTL_MS = 60_000;
export const TEST_NOTIFICATION_DEFAULT_MINUTES = 5;
export const TEST_NOTIFICATION_MAX_MINUTES = 60;

// ─── Idle auto-close ─────────────────────────────────────────────────────
// Default for config session.idleCloseHours (0 = disabled).
export const DEFAULT_IDLE_CLOSE_HOURS = 3;

// ─── Gap detection (sleep / hibernate / suspended process) ──────────────
export const GAP_THRESHOLD_POLL_MULTIPLIER = 3;
// Floor so a single slow git poll or GC hiccup never reads as a sleep gap.
export const GAP_THRESHOLD_FLOOR_SECONDS = 120;

// ─── HTTP body size limit ───────────────────────────────────────────────
export const MAX_BODY_BYTES = 4096;

// ─── CLI daemon startup polling ─────────────────────────────────────────
export const DAEMON_START_MAX_ATTEMPTS = 25;
export const DAEMON_START_POLL_MS = 200;

// ─── Time conversions ──────────────────────────────────────────────────
export const MS_PER_MINUTE = 60_000;

// ─── Activity Evaluator algorithm constants ─────────────────────────────
/** Smoothing window for activity frequency */
export const EMA_WINDOW_MINUTES = 10;
/**
 * Smoothing window for the attention EMA that drives cross-repo leadership.
 * Short on purpose: leadership must follow the developer within ~2 minutes
 * of switching repos, independent of how full the stamina bars are.
 */
export const ATTENTION_WINDOW_MINUTES = 2;
/**
 * Touch floor: any active tick lifts score to at least this fraction of the
 * sensitivity max timeout (Low: 3.75 min, Normal: 11.25 min, Patient: 22.5 min).
 * Guards against pause noise from single keystrokes without jumping the bar.
 *
 * Tuned to 1/4 (was 1/6): a false pause — real work whose time goes UNLOGGED —
 * is strictly worse than a late pause, so the guaranteed leash a single touch
 * buys is deliberately generous enough to ride out a normal "stop and think"
 * gap without any buildup. See the asymmetric-loss tuning note on DECAY_BOOST.
 */
export const STAMINA_FLOOR_RATIO = 1 / 4;
/** Score per active tick at full activity frequency (EMA = 1) */
export const FREQUENCY_GAIN_MAX = 2;
/**
 * Lines changed per minute worth +1 score per tick (4 lines per 30s tick).
 * Converted to a per-tick divisor at evaluator construction so the
 * lines-per-minute intensity needed to fill the bar doesn't depend on
 * diffPollSeconds.
 */
export const STAMINA_LINES_PER_MINUTE = 8;
/** Cap on the volume contribution per tick (reached at 32 changed lines at 30s ticks) */
export const VOLUME_GAIN_MAX = 8;
/**
 * Line-equivalent granted per file whose content changed while its diff
 * numbers stayed flat (rewrite-in-place: lines already differed from the
 * base, so numstat can't see the churn). Detected via content hashing.
 */
export const IN_PLACE_CHURN_LINES = 8;
/** Churn scanner caps: don't read/hash absurd working sets */
export const CHURN_MAX_FILES = 100;
export const CHURN_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * "Free" score on commit (in seconds, converted to ticks). Tuned up to 240
 * (was 150): committing every few minutes while polishing a branch for review
 * is real, focused work, so a commit should buy enough leash (Normal: ~4 min
 * on top of the touch floor) to bridge the gap to the next commit without a
 * false pause.
 */
export const COMMIT_BONUS_SECONDS = 240;
/** Constant per-tick score drain */
export const BASE_DECAY = 1;
/**
 * Extra drain per idle tick, scaled by the frequency EMA: decay = BASE_DECAY +
 * DECAY_BOOST × EMA. A dense coder who stops cools down faster than a sporadic
 * one (who keeps the plain 1/tick fade), but only mildly: the v1 "sudden stop
 * after intense work is a pause" instinct is wrong in the LLM era, where the
 * stop after a big paste is usually *reading/thinking*, not a break.
 *
 * Tuned down to 2 (was 4): a boost of 4 collapsed every earned buffer back to
 * the floor within ~15 min regardless of how hard you worked, so the leash
 * never reflected real effort and pulsed work risked false pauses. At 2 the
 * earned buffer survives normal think gaps while a true walk-away is still
 * caught within ~half the ceiling. Parameter set chosen by the asymmetric-loss
 * grid search in scripts/stamina-sim.mjs (false pause ≫ late pause).
 */
export const DECAY_BOOST = 2;

// ─── Sensitivity → max timeout (stamina ceiling) in minutes ──────────────
// The single knob per level: the score ceiling. The touch floor is derived
// from it via STAMINA_FLOOR_RATIO — no separate min constant.
// AlwaysOn uses the Normal number but isIdleTimeout is ignored at apply stage.
export const SENSITIVITY_TIMEOUTS = {
  low:       15,
  normal:    45,
  patient:   90,
  always_on: 45,
} as const;

export const DEFAULT_SENSITIVITY = 'normal';
