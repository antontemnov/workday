import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { SCHEDULE_CACHE_FILE, SCHEDULE_CACHE_TTL_MS } from '../core/constants.js';
import type { Secrets, ScheduleDay, TempoScheduleResponse, TempoMetaUnavailableReason } from '../core/types.js';
import { TempoClient, TempoApiError } from './tempo-client.js';
import { getMonthRange } from './month-report.js';

// data/schedule-cache.json: "YYYY-MM" → cached month
interface ScheduleCacheEntry {
  readonly fetchedAt: string;
  readonly days: readonly ScheduleDay[];
}

type ScheduleCache = Record<string, ScheduleCacheEntry>;

function getCachePath(): string {
  return join(getDataDir(), SCHEDULE_CACHE_FILE);
}

function readCache(): ScheduleCache {
  const path = getCachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ScheduleCache;
  } catch {
    return {};
  }
}

function writeCache(cache: ScheduleCache): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* best effort — cache is an optimization */ }
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function available(days: readonly ScheduleDay[], fromCache: boolean): TempoScheduleResponse {
  return {
    available: true,
    days,
    requiredSecondsTotal: days.reduce((sum, d) => sum + d.requiredSeconds, 0),
    fromCache,
  };
}

/** Empty degraded response — also used by callers with no secrets at all. */
export function scheduleUnavailable(reason: TempoMetaUnavailableReason): TempoScheduleResponse {
  return { available: false, reason, days: [], requiredSecondsTotal: 0, fromCache: false };
}

/**
 * Month schedule of the token's user (required seconds per day, holidays).
 * Cached for a day — schedules change ~never. On fetch failure a stale cache
 * still wins over nothing; a missing scope (403) reports 'scope' so the UI
 * can degrade silently.
 */
export async function resolveMonthSchedule(
  year: number,
  month: number,
  secrets: Secrets,
  forceRefresh = false,
): Promise<TempoScheduleResponse> {
  if (!secrets.Tempo_Token || secrets.Tempo_Token.trim().length === 0) {
    return scheduleUnavailable('no-token');
  }

  const key = monthKey(year, month);
  const cache = readCache();
  const cached = cache[key];
  if (!forceRefresh && cached
    && Date.now() - Date.parse(cached.fetchedAt) < SCHEDULE_CACHE_TTL_MS) {
    return available(cached.days, true);
  }

  const { from, to } = getMonthRange(year, month);
  try {
    const client = new TempoClient(secrets.Tempo_Token);
    const raw = await client.getUserSchedule(from, to);
    const days: ScheduleDay[] = raw.map(d => ({
      date: d.date,
      requiredSeconds: d.requiredSeconds,
      type: d.type,
      holidayName: d.holiday?.name ?? null,
    }));
    cache[key] = { fetchedAt: new Date().toISOString(), days };
    writeCache(cache);
    return available(days, false);
  } catch (err) {
    if (err instanceof TempoApiError && err.status === 403) return scheduleUnavailable('scope');
    if (cached) return available(cached.days, true); // stale beats nothing
    return scheduleUnavailable('error');
  }
}
