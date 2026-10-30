import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { APPROVAL_CACHE_TTL_MS, BALANCE_CACHE_FILE, BALANCE_CLOSED_TTL_MS } from '../core/constants.js';
import type { Secrets, TempoBalanceMonth, TempoBalanceResponse, TempoMetaUnavailableReason } from '../core/types.js';
import { TempoClient, TempoApiError, type TempoTimesheetApproval } from './tempo-client.js';
import { getAccountId, isJiraConfigured } from './jira-client.js';
import { isClosedStatus } from './tempo-approvals.js';
import { monthsBetween } from './approval-watch.js';

// data/balance-cache.json: "YYYY-MM" → the month as the balance counts it.
// Its own file: the approval cache is dropped by every push and its reads of
// a closed month kick the daemon's tick.
interface BalanceCacheEntry {
  readonly fetchedAt: string;
  readonly statusKey: string | null;
  readonly requiredSeconds: number;
  readonly timeSpentSeconds: number;
}

type BalanceCache = Record<string, BalanceCacheEntry>;

function getCachePath(): string {
  return join(getDataDir(), BALANCE_CACHE_FILE);
}

function readCache(): BalanceCache {
  const path = getCachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as BalanceCache;
  } catch {
    return {};
  }
}

function writeCache(cache: BalanceCache): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* best effort — cache is an optimization */ }
}

/** A push changed these months in Tempo — the balance asks them again. */
export function invalidateBalanceMonths(from: string, to: string): void {
  const cache = readCache();
  const stale = monthsBetween(from, to).filter(month => cache[month]);
  if (stale.length === 0) return;
  for (const month of stale) delete cache[month];
  writeCache(cache);
}

export function balanceUnavailable(year: number, reason: TempoMetaUnavailableReason): TempoBalanceResponse {
  return { available: false, reason, year, months: [], balanceSeconds: 0, fromCache: false };
}

/** "YYYY-MM" of the year's months before today's — the ones the balance sums. */
export function settledMonths(year: number, today: string): string[] {
  const todayMonth = today.slice(0, 7);
  const months: string[] = [];
  for (let month = 1; month <= 12; month++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key >= todayMonth) break;
    months.push(key);
  }
  return months;
}

// A closed month counts as it was submitted: Tempo recounts a past period's
// norm from today's holiday scheme, so the live number drifts.
function toEntry(raw: TempoTimesheetApproval): BalanceCacheEntry {
  const statusKey = raw.status?.key ?? null;
  const submitted = isClosedStatus(statusKey) ? raw.status : undefined;
  const required = submitted?.requiredSecondsAtSubmit;
  const spent = submitted?.timeSpentSecondsAtSubmit;
  const asSubmitted = required !== undefined && spent !== undefined;
  return {
    fetchedAt: new Date().toISOString(),
    statusKey,
    requiredSeconds: asSubmitted ? required : raw.requiredSeconds ?? 0,
    timeSpentSeconds: asSubmitted ? spent : raw.timeSpentSeconds ?? 0,
  };
}

function isFresh(entry: BalanceCacheEntry, now: number): boolean {
  const ttl = isClosedStatus(entry.statusKey) ? BALANCE_CLOSED_TTL_MS : APPROVAL_CACHE_TTL_MS;
  return now - Date.parse(entry.fetchedAt) < ttl;
}

// Callers asking the same year at once share one walk through Tempo.
const inFlight = new Map<number, Promise<TempoBalanceResponse>>();

/**
 * The year's balance as Tempo sums it: Σ (logged − required) over the
 * year's months before today's. Months before the first one with logged time
 * are left out — Tempo keeps a norm for them, but nothing was ever logged
 * there. All or nothing: a sum missing a month would lie, so a month Tempo
 * can't give (and the cache never had) makes the whole answer unavailable.
 */
export async function resolveYearBalance(year: number, today: string, secrets: Secrets): Promise<TempoBalanceResponse> {
  if (!secrets.Tempo_Token || secrets.Tempo_Token.trim().length === 0 || !isJiraConfigured(secrets)) {
    return balanceUnavailable(year, 'no-token');
  }
  const pending = inFlight.get(year);
  if (pending) return pending;
  const request = walkYear(year, today, secrets).finally(() => inFlight.delete(year));
  inFlight.set(year, request);
  return request;
}

async function walkYear(year: number, today: string, secrets: Secrets): Promise<TempoBalanceResponse> {
  const cached = readCache();
  const now = Date.now();
  const fetched: BalanceCache = {};
  const entries: [string, BalanceCacheEntry][] = [];
  let client: TempoClient | null = null;
  let accountId: string | null = null;
  let failure: TempoMetaUnavailableReason | null = null;

  for (const month of settledMonths(year, today)) {
    let entry = cached[month];
    if (!entry || !isFresh(entry, now)) {
      try {
        accountId ??= await getAccountId(secrets);
        client ??= new TempoClient(secrets.Tempo_Token);
        entry = toEntry(await client.getUserTimesheetApproval(accountId, `${month}-01`));
        fetched[month] = entry;
      } catch (err) {
        if (err instanceof TempoApiError && err.status === 403) { failure = 'scope'; break; }
        if (!entry) { failure = 'error'; break; } // stale beats nothing
      }
    }
    entries.push([month, entry]);
  }

  if (Object.keys(fetched).length > 0) writeCache({ ...readCache(), ...fetched });
  if (failure) return balanceUnavailable(year, failure);

  const first = entries.findIndex(([, entry]) => entry.timeSpentSeconds > 0);
  const months: TempoBalanceMonth[] = (first < 0 ? [] : entries.slice(first)).map(([month, entry]) => ({
    month,
    statusKey: entry.statusKey,
    requiredSeconds: entry.requiredSeconds,
    timeSpentSeconds: entry.timeSpentSeconds,
  }));
  return {
    available: true,
    year,
    months,
    balanceSeconds: months.reduce((sum, m) => sum + m.timeSpentSeconds - m.requiredSeconds, 0),
    fromCache: Object.keys(fetched).length === 0,
  };
}
