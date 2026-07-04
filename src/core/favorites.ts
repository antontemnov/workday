import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkdayHome } from './config.js';
import { generateSessionId, assertValidTask } from './daily-log.js';
import { FAVORITES_FILE_NAME, TMP_EXTENSION, MAX_ENTRY_MINUTES } from './constants.js';
import type { AppConfig, Favorite } from './types.js';

// Favorites — day-independent manual-entry templates ("log cloud" chips).
// Single source of truth is favorites.json in WORKDAY_HOME: the daemon holds
// no in-memory copy (re-reads per request), so direct CLI edits are safe
// with a running daemon. Callers follow the daily-log usage shape:
// loadFavorites() → mutate → saveFavorites().

function getFavoritesPath(): string {
  return join(getWorkdayHome(), FAVORITES_FILE_NAME);
}

/** Read favorites.json; missing file → empty list. Throws on corrupt JSON. */
export function loadFavorites(): Favorite[] {
  const filePath = getFavoritesPath();
  if (!existsSync(filePath)) return [];
  let parsed: { favorites?: Favorite[] };
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { favorites?: Favorite[] };
  } catch (err) {
    throw new Error(`${FAVORITES_FILE_NAME} is corrupted: ${err instanceof Error ? err.message : String(err)}`);
  }
  return Array.isArray(parsed.favorites) ? parsed.favorites : [];
}

/** Atomic write of favorites.json — tmp + rename, same as config.json. */
export function saveFavorites(favorites: readonly Favorite[]): void {
  const filePath = getFavoritesPath();
  const tmpPath = filePath + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify({ favorites }, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, filePath);
}

/** Resolve a favorite by 1-based index (#2) or id */
export function resolveFavoriteTarget(favorites: readonly Favorite[], target: string): Favorite | null {
  const index = parseInt(target.replace('#', ''), 10);
  if (!isNaN(index) && index >= 1 && index <= favorites.length) {
    return favorites[index - 1];
  }
  return favorites.find(f => f.id === target) ?? null;
}

/**
 * Add a favorite template. Duplicate rule mirrors the UI: same task + name
 * (case-insensitive) is one template regardless of minutes/activity.
 * Throws on validation failure.
 */
export function addFavorite(
  favorites: Favorite[],
  input: { name: string; task: string; minutes: number; activity: string },
  config: AppConfig,
): Favorite {
  const name = input.name.trim();
  if (!name) throw new Error('Name is required');

  const task = input.task.trim();
  if (!task) throw new Error('Task is required');
  assertValidTask(task, config);

  if (!Number.isFinite(input.minutes) || input.minutes <= 0) {
    throw new Error('Minutes must be positive');
  }
  if (input.minutes > MAX_ENTRY_MINUTES) {
    throw new Error(`Max is ${MAX_ENTRY_MINUTES} minutes (8h)`);
  }

  const activity = input.activity.trim();
  if (!activity) throw new Error('Activity is required');

  const dup = favorites.some(f =>
    f.task.toLowerCase() === task.toLowerCase()
    && f.name.toLowerCase() === name.toLowerCase());
  if (dup) throw new Error(`Already in favorites: ${task} — "${name}"`);

  const favorite: Favorite = {
    id: generateSessionId(),
    name,
    task,
    minutes: input.minutes,
    activity,
    createdAt: new Date().toISOString(),
  };
  favorites.push(favorite);
  return favorite;
}

/** Remove a favorite by #index or id. Throws when not found. */
export function removeFavorite(favorites: Favorite[], target: string): Favorite {
  const found = resolveFavoriteTarget(favorites, target);
  if (!found) throw new Error(`Favorite not found: ${target}`);
  favorites.splice(favorites.indexOf(found), 1);
  return found;
}
