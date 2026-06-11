// ─── File names ─────────────────────────────────────────────────────────
export const CONFIG_FILE_NAME = 'config.json';
export const SECRETS_FILE_NAME = 'secrets.json';
export const PID_FILE_NAME = 'workday.pid';
export const DATA_DIR_NAME = 'data';
export const TMP_EXTENSION = '.tmp';
export const BACKUP_EXTENSION = '.bak';

// ─── Daemon script resolution ───────────────────────────────────────────
export const DAEMON_SCRIPT_TS = 'daemon.ts';
export const DAEMON_SCRIPT_JS = 'daemon.js';

// ─── HTTP API ──────────────────────────────────────────────────────────
export const DEFAULT_API_PORT = 9213;
export const API_VERSION = 6;

// ─── File locking ──────────────────────────────────────────────────────
export const LOCK_EXTENSION = '.lock';
export const LOCK_STALE_MS = 10_000;

// ─── Git internals ──────────────────────────────────────────────────────
export const GIT_BATCH_SEPARATOR = '---WORKDAY-SEP---';
export const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// ─── Budget / Manual adjustment ─────────────────────────────────────────
export const MAX_ADJUSTMENT_MINUTES = 480;

// ─── Push / Tempo ───────────────────────────────────────────────────────
export const ISSUE_CACHE_FILE = 'issue-cache.json';
export const PUSH_LOG_FILE = 'push-log.json';
export const TEMPO_REPORT_DIR = 'tempo';
export const TEMPO_BASE_URL = 'https://api.tempo.io';
export const TEMPO_RATE_LIMIT_MS = 210;
export const TEMPO_TOLERANCE_SECONDS = 60;

// ─── Daemon crash recovery ──────────────────────────────────────────────
export const CRASH_RECOVERY_LOOKBACK_DAYS = 7;

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
 * sensitivity max timeout (Low: 2.5 min, Normal: 7.5 min, Patient: 15 min).
 * Guards against pause noise from single keystrokes without jumping the bar.
 */
export const STAMINA_FLOOR_RATIO = 1 / 6;
/** Score per active tick at full activity frequency (EMA = 1) */
export const FREQUENCY_GAIN_MAX = 2;
/**
 * Lines changed per minute worth +1 score per tick (5 lines per 30s tick).
 * Converted to a per-tick divisor at evaluator construction so the
 * lines-per-minute intensity needed to fill the bar doesn't depend on
 * diffPollSeconds.
 */
export const STAMINA_LINES_PER_MINUTE = 10;
/** Cap on the volume contribution per tick (reached at 20 changed lines at 30s ticks) */
export const VOLUME_GAIN_MAX = 4;
/** "Free" score on commit (in seconds, converted to ticks) */
export const COMMIT_BONUS_SECONDS = 150;
/** Constant per-tick score drain */
export const BASE_DECAY = 1;

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
