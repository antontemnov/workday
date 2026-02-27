import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig, Secrets } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

function readJson<T>(filePath: string): T {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as T;
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

  if (!config.dayStart || !/^\d{2}:\d{2}$/.test(config.dayStart)) {
    throw new Error('config.json: dayStart must be in HH:MM format');
  }

  if (!config.taskPattern) {
    throw new Error('config.json: taskPattern is required');
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
  const configPath = join(PROJECT_ROOT, 'config.json');
  const config = readJson<AppConfig>(configPath);
  validateConfig(config);
  return config;
}

export function loadSecrets(): Secrets {
  const secretsPath = join(PROJECT_ROOT, 'secrets.json');
  const secrets = readJson<Secrets>(secretsPath);
  validateSecrets(secrets);
  return secrets;
}

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

export function getDataDir(): string {
  return join(PROJECT_ROOT, 'data');
}

/** Parse "HH:MM" to minutes from midnight */
export function parseDayStartTime(dayStart: string): number {
  const [h, m] = dayStart.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Compute working date: if hour < dayBoundaryHour, attribute to previous day */
export function computeWorkingDate(timestamp: number, dayBoundaryHour: number): string {
  const d = new Date(timestamp);
  if (d.getHours() < dayBoundaryHour) {
    d.setDate(d.getDate() - 1);
  }
  return formatLocalDate(d);
}

/** Format Date as "YYYY-MM-DD" using local timezone */
export function formatLocalDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Extract task key from branch name. Returns null for generic/foreign branches. */
export function extractTask(branch: string, taskPattern: string, developer: string, genericBranches: readonly string[]): string | null {
  if (/^[0-9a-f]{7,40}$/.test(branch)) return null;
  if (genericBranches.includes(branch)) return null;
  if (!branch.includes(developer)) return null;
  const match = branch.match(new RegExp(taskPattern));
  return match ? match[0] : null;
}
