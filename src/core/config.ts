import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ActivityScopeConfig, AppConfig, CalendarConfig, NotificationsConfig, Secrets, SensitivityConfig, SearchConfig, ProjectRef, TimesheetReminderConfig, TrackingConfig } from './types.js';
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
  // Empty repos is valid: a fresh install tracks nothing until the setup
  // wizard (or a hand edit) adds repositories.
  if (!config.repos || !Array.isArray(config.repos)) {
    throw new Error('config.json: repos must be an array');
  }

  for (const repo of config.repos) {
    if (!existsSync(repo)) {
      console.warn(`WARNING: repo path not found: ${repo}`);
    }
  }

  validateTrackingConfig(config.tracking);

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
  validateCalendarConfig(config.calendar);

  if (config.browser !== undefined && config.browser !== null && typeof config.browser !== 'string') {
    throw new Error('config.json: browser must be a string path or null');
  }

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

function validateTrackingConfig(tracking: TrackingConfig): void {
  if (!tracking || typeof tracking !== 'object') {
    throw new Error('config.json: tracking must be an object');
  }
  if (!Array.isArray(tracking.projectKeys) || tracking.projectKeys.length === 0) {
    throw new Error('config.json: tracking.projectKeys must be a non-empty array (Jira project keys to track)');
  }
  for (const key of tracking.projectKeys) {
    if (typeof key !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(key)) {
      throw new Error(`config.json: tracking.projectKeys entry "${key}" must be an uppercase Jira project key`);
    }
  }
  if (!Array.isArray(tracking.branchOwners) || tracking.branchOwners.some(o => typeof o !== 'string' || o.trim() === '')) {
    throw new Error('config.json: tracking.branchOwners must be an array of non-empty strings');
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

function validateCalendarConfig(calendar: CalendarConfig): void {
  if (!calendar || typeof calendar !== 'object') {
    throw new Error('config.json: calendar must be an object');
  }
  if (typeof calendar.enabled !== 'boolean') {
    throw new Error('config.json: calendar.enabled must be a boolean');
  }
  if (typeof calendar.hidePrivate !== 'boolean') {
    throw new Error('config.json: calendar.hidePrivate must be a boolean');
  }
}

/**
 * Uppercase project keys embedded in a legacy taskPattern regex — e.g.
 * "ATL-\\d+" → ["ATL"], "(?:ATL|CNF)-\\d+" → ["ATL", "CNF"]. Migration only:
 * seeds tracking.projectKeys (and, historically, search.projectKeys) from a
 * pre-tracking config.json that still carries the raw regex.
 */
export function deriveProjectKeysFromTaskPattern(pattern: string): string[] {
  const matches = pattern.match(/[A-Z][A-Z0-9]+/g) ?? [];
  return [...new Set(matches)];
}

/**
 * Branch task regex derived from the tracked project keys:
 * ["ATL", "CNF"] → "(?:ATL|CNF)-\d+". The single source of the pattern —
 * config no longer stores a user-written regex.
 */
export function buildTaskPattern(projectKeys: readonly string[]): string {
  return `(?:${projectKeys.join('|')})-\\d+`;
}

/** Delimiter-separated lowercase tokens of a branch/owner string. */
function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Whether a branch belongs to one of the configured owners. Match is strict:
 * the owner must appear as an exact token (sequence) between delimiters,
 * case-insensitively — "at" matches "ATL-1-at-fix" but not
 * "ATL-1-atribute-fix"; "atemn" never matches "atemnov". A multi-token owner
 * ("anton-temnov") matches the same tokens appearing consecutively.
 * Empty owner list = every branch matches.
 */
export function branchMatchesOwner(branch: string, owners: readonly string[]): boolean {
  if (owners.length === 0) return true;
  const tokens = tokenize(branch);
  return owners.some(owner => {
    const seq = tokenize(owner);
    if (seq.length === 0) return false;
    for (let i = 0; i + seq.length <= tokens.length; i++) {
      if (seq.every((t, j) => tokens[i + j] === t)) return true;
    }
    return false;
  });
}

function isValidSensitivity(level: string): level is SensitivityLevel {
  return level === SensitivityLevel.Low
    || level === SensitivityLevel.Normal
    || level === SensitivityLevel.Patient
    || level === SensitivityLevel.AlwaysOn;
}

function validateSecrets(secrets: Secrets): void {
  if (!secrets || typeof secrets !== 'object') {
    throw new Error('secrets.json: must be a JSON object');
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

  // tracking config: migrate a legacy config in place — projectKeys from the
  // old taskPattern regex, branchOwners from the old secrets.Developer field.
  const rawTracking = (raw.tracking ?? {}) as Partial<TrackingConfig>;
  const legacyTaskPattern = (raw.taskPattern as string) ?? '';
  const legacyDeveloper = tryLoadSecrets()?.Developer?.trim();
  const tracking: TrackingConfig = {
    projectKeys: rawTracking.projectKeys ?? deriveProjectKeysFromTaskPattern(legacyTaskPattern),
    branchOwners: rawTracking.branchOwners ?? (legacyDeveloper ? [legacyDeveloper] : []),
  };
  delete raw.taskPattern;

  // search config: default on first run — legacy configs seed from the old
  // taskPattern, fresh ones from the tracking scope.
  const rawSearch = (raw.search ?? {}) as Partial<SearchConfig>;
  const search: SearchConfig = {
    projectKeys: rawSearch.projectKeys
      ?? (legacyTaskPattern ? deriveProjectKeysFromTaskPattern(legacyTaskPattern) : [...tracking.projectKeys]),
    knownProjects: rawSearch.knownProjects ?? [],
  };

  // activity scope: empty allow-list = all known activities (legacy behaviour).
  const rawActivities = (raw.activities ?? {}) as Partial<ActivityScopeConfig>;
  const activities: ActivityScopeConfig = { values: rawActivities.values ?? [] };

  const rawCalendar = (raw.calendar ?? {}) as Partial<CalendarConfig>;
  const calendar: CalendarConfig = {
    enabled: rawCalendar.enabled ?? true,
    hidePrivate: rawCalendar.hidePrivate ?? false,
  };

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
    tracking,
    search,
    activities,
    notifications,
    calendar,
    session: {
      ...rawSession,
      idleCloseHours: rawSession.idleCloseHours ?? DEFAULT_IDLE_CLOSE_HOURS,
    },
  } as AppConfig;
  validateConfig(config);
  return config;
}

/** Fresh-install config.json template — shared by `workday init` and the
 *  daemon's self-bootstrap. repos stays empty (nothing tracked yet); PROJ is
 *  the documented tracking placeholder the setup wizard replaces. */
export function buildConfigTemplate(): Record<string, unknown> {
  return {
    repos: [],
    boundaryHour: 4,
    tracking: { projectKeys: ['PROJ'], branchOwners: [] },
    genericBranches: ['develop', 'main', 'master'],
    session: {
      diffPollSeconds: 30,
      signalDeduplicationSeconds: 300,
      dayBoundaryCheckSeconds: 60,
      reflogCount: 20,
    },
    report: { roundingMinutes: 15 },
    workDays: [1, 2, 3, 4, 5],
    holidays: [],
  };
}

/** Fresh-install secrets.json template. Empty strings, not example values —
 *  the setup wizard prefills its inputs from here and must not show
 *  placeholder text as if it were saved data. */
export function buildSecretsTemplate(): Secrets {
  return { Jira_Email: '', Jira_BaseUrl: '', Jira_Token: '', Tempo_Token: '' };
}

/**
 * Self-bootstrap for a clean machine: create WORKDAY_HOME and template
 * config/secrets when missing, so the daemon (and the tray setup wizard
 * talking to it) can start without any manual file editing.
 */
export function ensureConfigFiles(): { createdConfig: boolean; createdSecrets: boolean } {
  if (!existsSync(WORKDAY_HOME)) {
    mkdirSync(WORKDAY_HOME, { recursive: true });
  }
  const configPath = join(WORKDAY_HOME, CONFIG_FILE_NAME);
  const secretsPath = join(WORKDAY_HOME, SECRETS_FILE_NAME);
  const createdConfig = !existsSync(configPath);
  if (createdConfig) {
    writeFileSync(configPath, JSON.stringify(buildConfigTemplate(), null, 2) + '\n', 'utf-8');
  }
  const createdSecrets = !existsSync(secretsPath);
  if (createdSecrets) {
    writeFileSync(secretsPath, JSON.stringify(buildSecretsTemplate(), null, 2) + '\n', 'utf-8');
  }
  return { createdConfig, createdSecrets };
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
    // Deep-merge: a patch that only reselects projects must not wipe the
    // owner list, and vice versa.
    tracking: {
      projectKeys: patch.tracking?.projectKeys ?? current.tracking.projectKeys,
      branchOwners: patch.tracking?.branchOwners ?? current.tracking.branchOwners,
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
    calendar: {
      enabled: patch.calendar?.enabled ?? current.calendar.enabled,
      hidePrivate: patch.calendar?.hidePrivate ?? current.calendar.hidePrivate,
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
export function extractTask(branch: string, tracking: TrackingConfig, genericBranches: readonly string[]): string | null {
  if (/^[0-9a-f]{7,40}$/.test(branch)) return null;
  if (genericBranches.includes(branch)) return null;
  if (!branchMatchesOwner(branch, tracking.branchOwners)) return null;
  const match = branch.match(new RegExp(buildTaskPattern(tracking.projectKeys)));
  return match ? match[0] : null;
}

/**
 * Extract task key from a COLLEAGUE'S branch: the ticket pattern matches but
 * the owner check fails — the review-suggestion signal. Null when the owner
 * list is empty (every branch counts as the developer's own, so the review
 * source is silently off).
 */
export function extractForeignTask(branch: string, tracking: TrackingConfig, genericBranches: readonly string[]): string | null {
  if (tracking.branchOwners.length === 0) return null;
  if (/^[0-9a-f]{7,40}$/.test(branch)) return null;
  if (genericBranches.includes(branch)) return null;
  if (branchMatchesOwner(branch, tracking.branchOwners)) return null;
  const match = branch.match(new RegExp(buildTaskPattern(tracking.projectKeys)));
  return match ? match[0] : null;
}
