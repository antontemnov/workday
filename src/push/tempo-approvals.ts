import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { APPROVAL_CACHE_FILE, APPROVAL_CACHE_TTL_MS } from '../core/constants.js';
import type { Secrets, TempoApprovalResponse, TempoMetaUnavailableReason } from '../core/types.js';
import { TempoClient, TempoApiError } from './tempo-client.js';
import { getAccountId, isJiraConfigured } from './jira-client.js';
import { getMonthRange } from './month-report.js';

// data/approval-cache.json: "YYYY-MM" → cached approval snapshot
interface ApprovalCacheEntry {
  readonly fetchedAt: string;
  readonly period: { readonly from: string; readonly to: string } | null;
  readonly statusKey: string | null;
  readonly requiredSeconds: number | null;
  readonly timeSpentSeconds: number | null;
  readonly canSubmit: boolean;
}

type ApprovalCache = Record<string, ApprovalCacheEntry>;

function getCachePath(): string {
  return join(getDataDir(), APPROVAL_CACHE_FILE);
}

function readCache(): ApprovalCache {
  const path = getCachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ApprovalCache;
  } catch {
    return {};
  }
}

function writeCache(cache: ApprovalCache): void {
  try {
    writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
  } catch { /* best effort — cache is an optimization */ }
}

/** Drop the whole cache — Tempo-side timeSpentSeconds just changed. */
export function invalidateApprovalCache(): void {
  try {
    rmSync(getCachePath(), { force: true });
  } catch { /* best effort */ }
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function fromEntry(entry: ApprovalCacheEntry, fromCache: boolean): TempoApprovalResponse {
  return {
    available: true,
    period: entry.period,
    statusKey: entry.statusKey,
    requiredSeconds: entry.requiredSeconds,
    timeSpentSeconds: entry.timeSpentSeconds,
    canSubmit: entry.canSubmit,
    fromCache,
  };
}

/** Empty degraded response — also used by callers with no secrets at all. */
export function approvalUnavailable(reason: TempoMetaUnavailableReason): TempoApprovalResponse {
  return {
    available: false,
    reason,
    period: null,
    statusKey: null,
    requiredSeconds: null,
    timeSpentSeconds: null,
    canSubmit: false,
    fromCache: false,
  };
}

/**
 * Timesheet approval for the period containing the given month (period =
 * calendar month on approvalPeriod=MONTH instances). Needs both a Jira
 * account (accountId lookup) and a Tempo token with approvals:view. Cached
 * briefly; the cache is dropped after every successful push.
 */
export async function resolveMonthApproval(
  year: number,
  month: number,
  secrets: Secrets,
  forceRefresh = false,
): Promise<TempoApprovalResponse> {
  if (!secrets.Tempo_Token || secrets.Tempo_Token.trim().length === 0 || !isJiraConfigured(secrets)) {
    return approvalUnavailable('no-token');
  }

  const key = monthKey(year, month);
  const cache = readCache();
  const cached = cache[key];
  if (!forceRefresh && cached
    && Date.now() - Date.parse(cached.fetchedAt) < APPROVAL_CACHE_TTL_MS) {
    return fromEntry(cached, true);
  }

  const { from } = getMonthRange(year, month);
  try {
    const accountId = await getAccountId(secrets);
    const client = new TempoClient(secrets.Tempo_Token);
    const raw = await client.getUserTimesheetApproval(accountId, from);
    const entry: ApprovalCacheEntry = {
      fetchedAt: new Date().toISOString(),
      period: raw.period ?? null,
      statusKey: raw.status?.key ?? null,
      requiredSeconds: raw.requiredSeconds ?? null,
      timeSpentSeconds: raw.timeSpentSeconds ?? null,
      canSubmit: raw.actions?.submit !== undefined,
    };
    cache[key] = entry;
    writeCache(cache);
    return fromEntry(entry, false);
  } catch (err) {
    if (err instanceof TempoApiError && err.status === 403) return approvalUnavailable('scope');
    if (cached) return fromEntry(cached, true); // stale beats nothing
    return approvalUnavailable('error');
  }
}
