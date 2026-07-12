import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ActivityScopeConfig, AppConfig, NotificationsConfig, Secrets, SensitivityConfig, SearchConfig, ProjectRef, TimesheetReminderConfig } from './types.js';
import { SensitivityLevel } from './types.js';
import { CONFIG_FILE_NAME, SECRETS_FILE_NAME, DATA_DIR_NAME, DEFAULT_API_PORT, DEFAULT_IDLE_CLOSE_HOURS, DEFAULT_NOTIFY_HOUR, DEFAULT_SENSITIVITY, SENSITIVITY_TIMEOUTS, TMP_EXTENSION } from './constants.js';

/** Find the directory containing this package's package.json */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('Could not find package root (no package.json found)');
}

/**
 * Resolve workday home directory (where config, secrets, data live).
 * 1. WORKDAY_HOME env — explicit override
 * 2. Local mode — config.json next to package.json (dev / local install)
 * 3. ~/.workday/ — global npm install
 */
function resolveWorkdayHome(): string {
  if (process.env.WORKDAY_HOME) return process.env.WORKDAY_HOME;
  const pkgRoot = findPackageRoot();
  if (existsSync(join(pkgRoot, CONFIG_FILE_NAME))) return pkgRoot;
  return join(homedir(), '.workday');
}

const PACKAGE_ROOT = findPackageRoot();
const WORKDAY_HOME = resolveWorkdayHome();

function readJson<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateConfig(config: AppConfig): void {
  if (!config.repos || config.repos.length === 0) {
    throw new Error('config.json: repos must be a non-empty array');
  }

  for (const repo of config.repos) {
    if (!existsSync(repo)) {
      console.warn(`WARNING: repo path not found: ${repo}`);
    }
  }

  if (!config.taskPattern) {
    throw new Error('config.json: taskPattern is required');
  }

  if (!Number.isInteger(config.boundaryHour) || config.boundaryHour < 0 || config.boundaryHour > 23) {
    throw new Error('config.json: boundaryHour must be an integer 0-23');
  }

  if (!isValidTimezone(config.timezone)) {
    throw new Error(`config.json: invalid timezone "${config.timezone}"`);
  }

  if (!config.session?.diffPollSeconds || config.session.diffPollSeconds < 5) {
    throw new Error('config.json: session.diffPollSeconds must be >= 5');
  }

  const idleCloseHours = config.session.idleCloseHours;
  if (typeof idleCloseHours !== 'number' || !Number.isFinite(idleCloseHours) || idleCloseHours < 0) {
    throw new Error('config.json: session.idleCloseHours must be a number >= 0 (0 disables auto-close)');
  }

  if (!isValidSensitivity(config.sensitivity.default)) {
    throw new Error(`config.json: invalid sensitivity.default "${config.sensitivity.default}"`);
  }
  for (const [repo, level] of Object.entries(config.sensitivity.perRepo)) {
    if (!isValidSensitivity(level)) {
      throw new Error(`config.json: invalid sensitivity.perRepo[${repo}] "${level}"`);
    }
  }

  validateSearchConfig(config.search);
  validateActivityScopeConfig(config.activities);
  validateNotificationsConfig(config.notifications);

  if (config.defaultBranch !== undefined && typeof config.defaultBranch !== 'string') {
    throw new Error('config.json: defaultBranch must be a string');
  }
  if (config.defaultBranches !== undefined) {
    if (typeof config.defaultBranches !== 'object' || config.defaultBranches === null) {
      throw new Error('config.json: defaultBranches must be an object');
    }
    for (const [repo, name] of Object.entries(config.defaultBranches)) {
      if (typeof name !== 'string') {
        throw new Error(`config.json: defaultBranches[${repo}] must be a string`);
      }
    }
  }
}

function validateSearchConfig(search: SearchConfig): void {
  if (!search || typeof search !== 'object') {
    throw new Error('config.json: search must be an object');
  }
  if (!Array.isArray(search.projectKeys) || search.projectKeys.some(k => typeof k !== 'string')) {
    throw new Error('config.json: search.projectKeys must be an array of strings');
  }
  if (!Array.isArray(search.knownProjects)) {
    throw new Error('config.json: search.knownProjects must be an array');
  }
  for (const p of search.knownProjects) {
    if (typeof p?.key !== 'string' || typeof p?.name !== 'string' || typeof p?.id !== 'string') {
      throw new Error('config.json: search.knownProjects entries must be { key, name, id } strings');
    }
  }
}

function validateActivityScopeConfig(activities: ActivityScopeConfig): void {
  if (!activities || typeof activities !== 'object') {
    throw new Error('config.json: activities must be an object');
  }
  if (!Array.isArray(activities.values) || activities.values.some(v => typeof v !== 'string')) {
    throw new Error('config.json: activities.values must be an array of strings');
  }
}

function validateNotificationsConfig(notifications: NotificationsConfig): void {
  if (!notifications || typeof notifications !== 'object') {
    throw new Error('config.json: notifications must be an object');
  }
  const reminder = notifications.timesheetReminder;
  if (!reminder || typeof reminder !== 'object') {
    throw new Error('config.json: notifications.timesheetReminder must be an object');
  }
  if (typeof reminder.enabled !== 'boolean') {
    throw new Error('config.json: notifications.timesheetReminder.enabled must be a boolean');
  }
  if (!Number.isInteger(reminder.notifyHour) || reminder.notifyHour < 0 || reminder.notifyHour > 23) {
    throw new Error('config.json: notifications.timesheetReminder.notifyHour must be an integer 0-23');
  }
}

/**
 * Uppercase project keys embedded in the branch taskPattern regex — e.g.
 * "ATL-\\d+" → ["ATL"], "(?:ATL|CNF)-\\d+" → ["ATL", "CNF"]. Used only to seed
 * search.projectKeys on first run; the two decouple afterwards.
 */
export function deriveProjectKeysFromTaskPattern(pattern: string): string[] {
  const matches = pattern.match(/[A-Z][A-Z0-9]+/g) ?? [];
  return [...new Set(matches)];
}

function isValidSensitivity(level: string): level is SensitivityLevel {
  return level === SensitivityLevel.Low
    || level === SensitivityLevel.Normal
    || level === SensitivityLevel.Patient
    || level === SensitivityLevel.AlwaysOn;
}

function validateSecrets(secrets: Secrets): void {
  if (!secrets.Developer) {
    throw new Error('secrets.json: Developer is required');
  }
}

export function loadConfig(): AppConfig {
  const configPath = join(WORKDAY_HOME, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error('Run "workday init" to create it.');
    process.exit(1);
  }
  const raw = readJson<Record<string, unknown>>(configPath);
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Backward compat: schedule {start,end} → boundaryHour (start was never
  // read by any algorithm), and the even older dayBoundaryHour.
  if (raw.boundaryHour === undefined) {
    const schedule = raw.schedule as { end?: number } | undefined;
    if (typeof schedule?.end === 'number') {
      raw.boundaryHour = schedule.end;
    } else if (typeof raw.dayBoundaryHour === 'number') {
      raw.boundaryHour = raw.dayBoundaryHour;
    }
  }
  delete raw.schedule;
  delete raw.dayBoundaryHour;

  const rawSensitivity = (raw.sensitivity ?? {}) as Partial<SensitivityConfig>;
  const sensitivity: SensitivityConfig = {
    default: rawSensitivity.default ?? (DEFAULT_SENSITIVITY as SensitivityLevel),
    perRepo: rawSensitivity.perRepo ?? {},
  };

  const rawSession = (raw.session ?? {}) as Record<string, unknown>;

  // search config: default on first run, seeding projectKeys from taskPattern.
  const rawSearch = (raw.search ?? {}) as Partial<SearchConfig>;
  const taskPattern = (raw.taskPattern as string) ?? '';
  const search: SearchConfig = {
    projectKeys: rawSearch.projectKeys ?? deriveProjectKeysFromTaskPattern(taskPattern),
    knownProjects: rawSearch.knownProjects ?? [],
  };

  // activity scope: empty allow-list = all known activities (legacy behaviour).
  const rawActivities = (raw.activities ?? {}) as Partial<ActivityScopeConfig>;
  const activities: ActivityScopeConfig = { values: rawActivities.values ?? [] };

  const rawNotifications = (raw.notifications ?? {}) as Partial<NotificationsConfig>;
  const rawReminder = (rawNotifications.timesheetReminder ?? {}) as Partial<TimesheetReminderConfig>;
  const notifications: NotificationsConfig = {
    timesheetReminder: {
      enabled: rawReminder.enabled ?? true,
      notifyHour: rawReminder.notifyHour ?? DEFAULT_NOTIFY_HOUR,
    },
  };

  const config = {
    ...raw,
    boundaryHour: raw.boundaryHour ?? 4,
    apiPort: raw.apiPort ?? DEFAULT_API_PORT,
    timezone: raw.timezone ?? systemTimezone,
    sensitivity,
    search,
    activities,
    notifications,
    session: {
      ...rawSession,
      idleCloseHours: rawSession.idleCloseHours ?? DEFAULT_IDLE_CLOSE_HOURS,
    },
  } as AppConfig;
  validateConfig(config);
  return config;
}

/** Atomic write of config.json — tmp + rename, preserves formatting. */
export function writeConfig(config: AppConfig): void {
  const configPath = join(WORKDAY_HOME, CONFIG_FILE_NAME);
  const tmpPath = configPath + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, configPath);
}

/** Atomic write of secrets.json — tmp + rename. */
export function writeSecrets(secrets: Secrets): void {
  const secretsPath = join(WORKDAY_HOME, SECRETS_FILE_NAME);
  const tmpPath = secretsPath + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify(secrets, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, secretsPath);
}

/**
 * Merge a partial config patch onto current config, then validate.
 * Throws on validation failure — caller is expected to map to 400.
 */
export function buildPatchedConfig(current: AppConfig, patch: Partial<AppConfig>): AppConfig {
  const merged: AppConfig = {
    ...current,
    ...patch,
    sensitivity: {
      default: patch.sensitivity?.default ?? current.sensitivity.default,
      perRepo: patch.sensitivity?.perRepo ?? current.sensitivity.perRepo,
    },
    // Deep-merge: a patch that only sets projectKeys must not wipe the cached
    // catalog, and a catalog refresh must not wipe the selection.
    search: {
      projectKeys: patch.search?.projectKeys ?? current.search.projectKeys,
      knownProjects: patch.search?.knownProjects ?? current.search.knownProjects,
    },
    activities: {
      values: patch.activities?.values ?? current.activities.values,
    },
    notifications: {
      timesheetReminder: {
        enabled: patch.notifications?.timesheetReminder?.enabled ?? current.notifications.timesheetReminder.enabled,
        notifyHour: patch.notifications?.timesheetReminder?.notifyHour ?? current.notifications.timesheetReminder.notifyHour,
      },
    },
  };
  validateConfig(merged);
  return merged;
}

/** Resolve sensitivity for a repo (perRepo override → default). repo is either path or basename. */
export function getSensitivityForRepo(config: AppConfig, repo: string): SensitivityLevel {
  const name = basename(repo);
  return config.sensitivity.perRepo[name] ?? config.sensitivity.perRepo[repo] ?? config.sensitivity.default;
}

/**
 * Configured default-branch name for a repo — used by GitTracker as the
 * first link in the resolution chain (perRepo → global → auto-detect → fallback).
 * Returns undefined when nothing is configured; the caller takes over.
 */
export function getConfiguredDefaultBranchName(config: AppConfig, repoPath: string): string | undefined {
  const name = basename(repoPath);
  return config.defaultBranches?.[name]
    ?? config.defaultBranches?.[repoPath]
    ?? config.defaultBranch;
}

/** Resolve (maxTicks, ignoreIdleTimeout) for evaluator from sensitivity. */
export function resolveSensitivityTicks(
  level: SensitivityLevel,
  pollSeconds: number,
): { maxTicks: number; ignoreIdleTimeout: boolean } {
  return {
    maxTicks: SENSITIVITY_TIMEOUTS[level] * 60 / pollSeconds,
    ignoreIdleTimeout: level === SensitivityLevel.AlwaysOn,
  };
}

export function loadSecrets(): Secrets {
  const secretsPath = join(WORKDAY_HOME, SECRETS_FILE_NAME);
  if (!existsSync(secretsPath)) {
    console.error(`Secrets not found: ${secretsPath}`);
    console.error('Run "workday init" to create it.');
    process.exit(1);
  }
  const secrets = readJson<Secrets>(secretsPath);
  validateSecrets(secrets);
  return secrets;
}

/** Non-fatal variant for optional integrations: missing/invalid → null. */
export function tryLoadSecrets(): Secrets | null {
  const secretsPath = join(WORKDAY_HOME, SECRETS_FILE_NAME);
  if (!existsSync(secretsPath)) return null;
  try {
    const secrets = readJson<Secrets>(secretsPath);
    validateSecrets(secrets);
    return secrets;
  } catch {
    return null;
  }
}

export function getWorkdayHome(): string {
  return WORKDAY_HOME;
}

export function getPackageRoot(): string {
  return PACKAGE_ROOT;
}

export function getDataDir(): string {
  return join(WORKDAY_HOME, DATA_DIR_NAME);
}

/** Get hour (0-23) in specified IANA timezone */
export function getHourInTimezone(timestamp: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date(timestamp));

  const hourPart = parts.find(p => p.type === 'hour');
  if (!hourPart) throw new Error(`Failed to parse hour in timezone ${timezone}`);
  const hour = parseInt(hourPart.value);
  // Some ICU implementations return hour=24 for midnight; normalize to 0
  return hour === 24 ? 0 : hour;
}

/** Format timestamp as "YYYY-MM-DD" in specified IANA timezone */
export function formatDate(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));

  const yearPart = parts.find(p => p.type === 'year');
  const monthPart = parts.find(p => p.type === 'month');
  const dayPart = parts.find(p => p.type === 'day');
  if (!yearPart || !monthPart || !dayPart) throw new Error(`Failed to parse date in timezone ${timezone}`);
  return `${yearPart.value}-${monthPart.value}-${dayPart.value}`;
}

/**
 * Compute working date in the configured timezone.
 * If current hour < boundaryHour, attribute activity to previous calendar day.
 * boundaryHour is 24h format (e.g. 4 = 04:00 AM).
 */
export function computeWorkingDate(timestamp: number, boundaryHour: number, timezone: string): string {
  const hour = getHourInTimezone(timestamp, timezone);
  if (hour < boundaryHour) {
    return formatDate(timestamp - 86_400_000, timezone);
  }
  return formatDate(timestamp, timezone);
}

/** Extract task key from branch name. Returns null for generic/foreign branches. */
export function extractTask(branch: string, taskPattern: string, developer: string, genericBranches: readonly string[]): string | null {
  if (/^[0-9a-f]{7,40}$/.test(branch)) return null;
  if (genericBranches.includes(branch)) return null;
  if (!branch.includes(developer)) return null;
  const match = branch.match(new RegExp(taskPattern));
  return match ? match[0] : null;
}
