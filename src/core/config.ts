import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, Secrets } from './types.js';
import { CONFIG_FILE_NAME, SECRETS_FILE_NAME, DATA_DIR_NAME, DEFAULT_API_PORT } from './constants.js';

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('Could not find project root (no package.json found)');
}

const PROJECT_ROOT = findProjectRoot();

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

function validateConfig(config: AppConfig): void {
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

  if (!Number.isInteger(config.dayBoundaryHour) || config.dayBoundaryHour < 0 || config.dayBoundaryHour > 23) {
    throw new Error('config.json: dayBoundaryHour must be an integer 0-23');
  }

  if (!isValidTimezone(config.timezone)) {
    throw new Error(`config.json: invalid timezone "${config.timezone}"`);
  }

  if (!config.session?.diffPollSeconds || config.session.diffPollSeconds < 5) {
    throw new Error('config.json: session.diffPollSeconds must be >= 5');
  }
}

function validateSecrets(secrets: Secrets): void {
  if (!secrets.Developer) {
    throw new Error('secrets.json: Developer is required');
  }
}

export function loadConfig(): AppConfig {
  const configPath = join(PROJECT_ROOT, CONFIG_FILE_NAME);
  const raw = readJson<Record<string, unknown>>(configPath);
  const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const config = {
    ...raw,
    apiPort: raw.apiPort ?? DEFAULT_API_PORT,
    timezone: raw.timezone ?? systemTimezone,
  } as AppConfig;
  validateConfig(config);
  return config;
}

export function loadSecrets(): Secrets {
  const secretsPath = join(PROJECT_ROOT, SECRETS_FILE_NAME);
  const secrets = readJson<Secrets>(secretsPath);
  validateSecrets(secrets);
  return secrets;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function getDataDir(): string {
  return join(PROJECT_ROOT, DATA_DIR_NAME);
}

/** Get hour (0-23) in specified IANA timezone */
function getHourInTimezone(timestamp: number, timezone: string): number {
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
 * If current hour < dayBoundaryHour, attribute activity to previous calendar day.
 * dayBoundaryHour is 24h format (e.g. 4 = 04:00 AM).
 */
export function computeWorkingDate(timestamp: number, dayBoundaryHour: number, timezone: string): string {
  const hour = getHourInTimezone(timestamp, timezone);
  if (hour < dayBoundaryHour) {
    return formatDate(timestamp - 86_400_000, timezone);
  }
  return formatDate(timestamp, timezone);
}

/** Build ISO timestamp from date + hour:minute in timezone */
export function buildTimestamp(date: string, hour: number, minute: number, timezone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    minute: 'numeric',
  }).formatToParts(guess);
  const hourPart = parts.find(p => p.type === 'hour');
  const minutePart = parts.find(p => p.type === 'minute');
  if (!hourPart || !minutePart) throw new Error(`Failed to parse time in timezone ${timezone}`);
  const actualHour = parseInt(hourPart.value);
  const actualMinute = parseInt(minutePart.value);
  const h = actualHour === 24 ? 0 : actualHour;
  const diffMs = ((hour - h) * 60 + (minute - actualMinute)) * 60_000;
  return new Date(guess.getTime() + diffMs).toISOString();
}

/** Extract task key from branch name. Returns null for generic/foreign branches. */
export function extractTask(branch: string, taskPattern: string, developer: string, genericBranches: readonly string[]): string | null {
  if (/^[0-9a-f]{7,40}$/.test(branch)) return null;
  if (genericBranches.includes(branch)) return null;
  if (!branch.includes(developer)) return null;
  const match = branch.match(new RegExp(taskPattern));
  return match ? match[0] : null;
}
