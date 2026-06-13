import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { WORK_ATTRIBUTES_CACHE_FILE, ACTIVITY_ATTRIBUTE_KEY, FALLBACK_ACTIVITIES } from '../core/constants.js';
import type { Secrets, ActivityType, ActivityTypesResponse } from '../core/types.js';
import { TempoClient } from './tempo-client.js';

interface ActivityCache {
  readonly key: string;
  readonly values: readonly ActivityType[];
  readonly fetchedAt: string;
}

function getCachePath(): string {
  return join(getDataDir(), WORK_ATTRIBUTES_CACHE_FILE);
}

function readCache(): ActivityCache | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ActivityCache;
    if (parsed && Array.isArray(parsed.values) && parsed.values.length > 0) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeCache(cache: ActivityCache): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* best effort — cache is an optimization */ }
}

/** Bundled list, used when no Tempo token / fetch fails. fromCache=false. */
function fallback(): ActivityTypesResponse {
  return {
    key: ACTIVITY_ATTRIBUTE_KEY,
    activities: FALLBACK_ACTIVITIES.map(a => ({ value: a.value, name: a.name })),
    fromCache: false,
  };
}

/**
 * Resolve the `_Activity_` value/name list. Cached to file on first successful
 * fetch (these values change ~never). Falls back to the bundled list when no
 * Tempo token is configured or the request fails. Pass forceRefresh to bypass
 * the cache (future cache-clear path).
 */
export async function resolveActivityTypes(secrets: Secrets, forceRefresh = false): Promise<ActivityTypesResponse> {
  if (!forceRefresh) {
    const cached = readCache();
    if (cached) {
      return { key: cached.key, activities: cached.values, fromCache: true };
    }
  }

  if (!secrets.Tempo_Token || secrets.Tempo_Token.trim().length === 0) {
    return fallback();
  }

  try {
    const client = new TempoClient(secrets.Tempo_Token);
    const attributes = await client.getWorkAttributes();
    const activity = attributes.find(a => a.key === ACTIVITY_ATTRIBUTE_KEY);
    if (!activity?.values || activity.values.length === 0) {
      return fallback();
    }
    const values: ActivityType[] = activity.values.map(v => ({
      value: v,
      name: activity.names?.[v] ?? v,
    }));
    writeCache({ key: activity.key, values, fetchedAt: new Date().toISOString() });
    return { key: activity.key, activities: values, fromCache: true };
  } catch {
    return fallback();
  }
}

/** True when `value` is in the resolved activity list. */
export function isKnownActivity(resp: ActivityTypesResponse, value: string): boolean {
  return resp.activities.some(a => a.value === value);
}
