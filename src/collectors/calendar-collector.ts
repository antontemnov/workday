// Outlook published-calendar feed collector: fetches the ICS URL, expands
// recurrences into flat instances inside the [−90d, +1d] window and keeps
// data/calendar-cache.json as the daemon's single source of calendar facts.
//
// Cadence (checked from the daemon's 60s day-boundary timer): daemon start,
// manual POST /api/calendar/refresh, and a schedule — hourly during the
// 10:00–14:00 local morning window (re-shuffles are most likely at the start
// of the day), every ~3h otherwise.
//
// Reconciliation on every fetch (the DTEND watershed): an instance that
// vanished from the feed after its DTEND had passed is kept frozen — it
// happened; one that vanished before its DTEND was a cancellation and is
// dropped. The feed stays authoritative whenever the same uid+date is
// present (reschedules, edits).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeWorkingDate, getDataDir, getHourInTimezone } from '../core/config.js';
import {
  CALENDAR_CACHE_FILE,
  CALENDAR_FETCH_INTERVAL_MS,
  CALENDAR_MORNING_FETCH_INTERVAL_MS,
  CALENDAR_MORNING_FROM_HOUR,
  CALENDAR_MORNING_TO_HOUR,
  CALENDAR_WINDOW_FUTURE_DAYS,
  CALENDAR_WINDOW_PAST_DAYS,
  ICS_BROWSER_USER_AGENT,
  ICS_FETCH_TIMEOUT_MS,
  TMP_EXTENSION,
} from '../core/constants.js';
import type {
  AppConfig,
  CalendarCache,
  CalendarFeedStatus,
  CalendarInstance,
  CalendarRefreshResponse,
} from '../core/types.js';
import { expandInstances, parseIcs } from './ics-parser.js';

const DAY_MS = 86_400_000;

export interface CalendarCollectorDeps {
  readonly getConfig: () => AppConfig;
  readonly getIcsUrl: () => string | null;
  // Injectable for tests; defaults to the real feed fetch.
  readonly fetchIcs?: (url: string) => Promise<string>;
  readonly now?: () => number;
}

async function fetchIcsFeed(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': ICS_BROWSER_USER_AGENT, 'Accept': 'text/calendar,*/*' },
    signal: AbortSignal.timeout(ICS_FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`ICS feed returned HTTP ${res.status}`);
  const text = await res.text();
  // The new-style /calendar/published/ path serves an HTML SPA shell —
  // catch it (and auth walls) instead of caching garbage.
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('ICS feed returned non-calendar content');
  return text;
}

/**
 * Merge the previous cache into a fresh feed snapshot. Pure — exported for
 * tests. Feed wins per uid+date; missing instances split on the DTEND
 * watershed (passed → frozen fact, not passed → cancellation); everything
 * ages out of the window eventually.
 */
export function reconcileInstances(
  prev: readonly CalendarInstance[],
  fresh: readonly CalendarInstance[],
  nowMs: number,
  windowStartMs: number,
): CalendarInstance[] {
  const freshKeys = new Set(fresh.map(i => `${i.uid}|${i.date}`));
  const merged: CalendarInstance[] = [...fresh];
  for (const p of prev) {
    if (freshKeys.has(`${p.uid}|${p.date}`)) continue;
    const endMs = Date.parse(p.end);
    if (Number.isNaN(endMs) || endMs > nowMs) continue;   // vanished before it happened
    if (endMs < windowStartMs) continue;                  // aged out
    merged.push(p.frozen ? p : { ...p, frozen: true });
  }
  merged.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  return merged;
}

export class CalendarCollector {
  private readonly deps: CalendarCollectorDeps;
  private readonly fetchIcs: (url: string) => Promise<string>;
  private readonly now: () => number;
  private lastError: string | null = null;
  private lastAttemptAt: number = 0;
  private refreshPromise: Promise<CalendarRefreshResponse> | null = null;
  // undefined = not loaded from disk yet; null = no cache file.
  private cache: CalendarCache | null | undefined = undefined;

  public constructor(deps: CalendarCollectorDeps) {
    this.deps = deps;
    this.fetchIcs = deps.fetchIcs ?? fetchIcsFeed;
    this.now = deps.now ?? Date.now;
  }

  public isConfigured(): boolean {
    return this.deps.getConfig().calendar.enabled && this.deps.getIcsUrl() !== null;
  }

  public getStatus(): CalendarFeedStatus {
    const configured = this.isConfigured();
    const cache = configured ? this.readCache() : null;
    return {
      configured,
      lastFetchAt: cache?.fetchedAt ?? null,
      lastError: this.lastError,
      instanceCount: cache?.instances.length ?? 0,
    };
  }

  /** Cached instances (disk-backed, memoized). Empty when unconfigured. */
  public getInstances(): readonly CalendarInstance[] {
    return this.readCache()?.instances ?? [];
  }

  /** Serialized refresh — concurrent callers share the in-flight fetch. */
  public refresh(): Promise<CalendarRefreshResponse> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  /**
   * Cadence gate, piggybacked on the daemon's 60s day-boundary timer.
   * Fire-and-forget; failures surface in getStatus().lastError and retry at
   * the next due point.
   */
  public maybeScheduledRefresh(): void {
    if (!this.isConfigured() || this.refreshPromise) return;
    const now = this.now();
    if (now - this.lastAttemptAt < this.currentIntervalMs(now)) return;
    void this.refresh().catch(err => {
      console.warn(`[calendar] scheduled refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private currentIntervalMs(now: number): number {
    const hour = getHourInTimezone(now, this.deps.getConfig().timezone);
    return hour >= CALENDAR_MORNING_FROM_HOUR && hour < CALENDAR_MORNING_TO_HOUR
      ? CALENDAR_MORNING_FETCH_INTERVAL_MS
      : CALENDAR_FETCH_INTERVAL_MS;
  }

  private async doRefresh(): Promise<CalendarRefreshResponse> {
    const url = this.deps.getIcsUrl();
    const config = this.deps.getConfig();
    if (!url || !config.calendar.enabled) throw new Error('Calendar feed not configured');

    const now = this.now();
    this.lastAttemptAt = now;
    try {
      const text = await this.fetchIcs(url);
      const parsed = parseIcs(text);
      const windowStartMs = now - CALENDAR_WINDOW_PAST_DAYS * DAY_MS;
      const windowEndMs = now + CALENDAR_WINDOW_FUTURE_DAYS * DAY_MS;
      const occurrences = expandInstances(parsed, windowStartMs, windowEndMs, config.timezone);

      const fresh: CalendarInstance[] = occurrences.map(o => ({
        uid: o.uid,
        date: computeWorkingDate(o.startMs, config.boundaryHour, config.timezone),
        start: new Date(o.startMs).toISOString(),
        end: new Date(o.endMs).toISOString(),
        title: o.title,
        busyStatus: o.busyStatus,
        allDay: o.allDay,
        cancelled: o.cancelled,
        recurring: o.recurring,
      }));

      const prev = this.readCache()?.instances ?? [];
      const instances = reconcileInstances(prev, fresh, now, windowStartMs);
      const cache: CalendarCache = { fetchedAt: new Date(now).toISOString(), instances };
      this.writeCache(cache);
      this.lastError = null;
      return { fetchedAt: cache.fetchedAt, instanceCount: instances.length };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // ─── Cache IO ─────────────────────────────────────────────────────────

  private getCachePath(): string {
    return join(getDataDir(), CALENDAR_CACHE_FILE);
  }

  private readCache(): CalendarCache | null {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = readFileSync(this.getCachePath(), 'utf-8');
      const parsed = JSON.parse(raw) as CalendarCache;
      this.cache = Array.isArray(parsed?.instances) ? parsed : null;
    } catch {
      this.cache = null;
    }
    return this.cache;
  }

  private writeCache(cache: CalendarCache): void {
    const dataDir = getDataDir();
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const path = this.getCachePath();
    const tmpPath = path + TMP_EXTENSION;
    writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf-8');
    renameSync(tmpPath, path);
    this.cache = cache;
  }
}
