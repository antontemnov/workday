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
export const API_VERSION = 3;

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
/** Min inactivity timeout (when developer is frequently active) */
export const MIN_TIMEOUT_MINUTES = 15;
/** Max inactivity timeout (when developer is rarely active) */
export const MAX_TIMEOUT_MINUTES = 45;
/** Smoothing window for activity frequency */
export const EMA_WINDOW_MINUTES = 10;
/** Fraction of max score awarded per active tick */
export const ACTIVITY_RATIO = 0.5;
/** log2 divisor; ~128 changed lines = full bonus */
export const MAGNITUDE_SCALE = 7;
/** Max extra multiplier on dynamics contribution */
export const MAGNITUDE_BONUS_MAX = 0.5;
/** "Free" score on commit (in seconds, converted to ticks) */
export const COMMIT_BONUS_SECONDS = 150;
/** Constant per-tick score drain */
export const BASE_DECAY = 1;
