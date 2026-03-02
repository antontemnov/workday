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

// ─── Git internals ──────────────────────────────────────────────────────
export const GIT_BATCH_SEPARATOR = '---WORKDAY-SEP---';
export const GIT_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// ─── Activity Evaluator algorithm constants ─────────────────────────────
export const MIN_TIMEOUT_MINUTES = 15;
export const MAX_TIMEOUT_MINUTES = 45;
export const EMA_WINDOW_MINUTES = 10;
export const ACTIVITY_RATIO = 0.5;
export const MAGNITUDE_SCALE = 7;
export const MAGNITUDE_BONUS_MAX = 0.5;
export const COMMIT_BONUS_SECONDS = 150;
export const BASE_DECAY = 1;
