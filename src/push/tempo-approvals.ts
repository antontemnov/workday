import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import {
  APPROVAL_CACHE_FILE, APPROVAL_CACHE_TTL_MS, APPROVAL_EDIT_MAX_AGE_MS, EDITABLE_APPROVAL_STATUSES,
} from '../core/constants.js';
import { inSubmissionWindow } from '../core/month-lock.js';
import type { AppConfig, Secrets, TempoApprovalResponse, TempoMetaUnavailableReason } from '../core/types.js';
import { TempoClient, TempoApiError } from './tempo-client.js';
import { getAccountId, isJiraConfigured } from './jira-client.js';
import { getMonthRange } from './month-report.js';

// data/approval-cache.json: "YYYY-MM" → cached approval snapshot
interface ApprovalCacheEntry {
  readonly fetchedAt: string;
  readonly period: { readonly from: string; readonly to: string } | null;
  readonly statusKey: string | null;
  // Absent in entries written before 0.54.0.
  readonly statusUpdatedAt?: string | null;
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
  const closed = isClosedStatus(entry.statusKey);
  return {
    available: true,
    period: entry.period,
    statusKey: entry.statusKey,
    closed,
    closedAt: closed ? entry.statusUpdatedAt ?? null : null,
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
    closed: false,
    closedAt: null,
    requiredSeconds: null,
    timeSpentSeconds: null,
    canSubmit: false,
    fromCache: false,
  };
}

export function isClosedStatus(statusKey: string | null): boolean {
  return !!statusKey && !EDITABLE_APPROVAL_STATUSES.includes(statusKey);
}

export function closedMonthMessage(monthKey: string, statusKey: string): string {
  return `Timesheet ${monthKey} is ${statusKey} in Tempo — a closed month stays as it is`;
}

/** The Tempo status that closes the month, null while it is editable. Unknown = editable. */
export async function closedMonthStatus(
  year: number,
  month: number,
  secrets: Secrets,
  maxAgeMs = APPROVAL_CACHE_TTL_MS,
): Promise<string | null> {
  const approval = await resolveMonthApproval(year, month, secrets, maxAgeMs);
  return approval.available && approval.closed ? approval.statusKey : null;
}

/** Cached status per month ("YYYY-MM"), no network — the daemon's lock seed. */
export function cachedApprovals(): ReadonlyMap<string, TempoApprovalResponse> {
  return new Map(Object.entries(readCache()).map(([key, entry]) => [key, fromEntry(entry, true)]));
}

// How old a cached status an edit may trust. A past month is asked fresh
// (that is where approvals happen); the submit window and a closed month
// (a REJECTED must unlock it) trust a minute; the rest of the month rides
// the cache.
function editMaxAge(monthKey: string, today: string, config: AppConfig): number {
  const todayMonth = today.slice(0, 7);
  if (monthKey < todayMonth) return 0;
  if (monthKey === todayMonth && inSubmissionWindow(today, config)) return APPROVAL_EDIT_MAX_AGE_MS;
  if (isClosedStatus(readCache()[monthKey]?.statusKey ?? null)) return APPROVAL_EDIT_MAX_AGE_MS;
  return APPROVAL_CACHE_TTL_MS;
}

/** Why a day may not be edited: its month is closed in Tempo. */
export async function dayEditRefusal(date: string, today: string, secrets: Secrets | null, config: AppConfig): Promise<string | null> {
  if (!secrets) return null;
  const monthKey = date.slice(0, 7);
  const status = await closedMonthStatus(Number(date.slice(0, 4)), Number(date.slice(5, 7)), secrets, editMaxAge(monthKey, today, config));
  return status ? closedMonthMessage(monthKey, status) : null;
}

// Callers asking the same month at once share one request.
const inFlight = new Map<string, Promise<TempoApprovalResponse>>();

/**
 * Timesheet approval for the period containing the given month (period =
 * calendar month on approvalPeriod=MONTH instances). Needs both a Jira
 * account (accountId lookup) and a Tempo token with approvals:view. A cached
 * status younger than maxAgeMs is trusted (0 = always ask); the cache is
 * dropped after every successful push.
 */
export async function resolveMonthApproval(
  year: number,
  month: number,
  secrets: Secrets,
  maxAgeMs = APPROVAL_CACHE_TTL_MS,
): Promise<TempoApprovalResponse> {
  if (!secrets.Tempo_Token || secrets.Tempo_Token.trim().length === 0 || !isJiraConfigured(secrets)) {
    return approvalUnavailable('no-token');
  }

  const key = monthKey(year, month);
  const cached = readCache()[key];
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < maxAgeMs) {
    return fromEntry(cached, true);
  }

  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchApproval(year, month, secrets, cached).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

async function fetchApproval(
  year: number,
  month: number,
  secrets: Secrets,
  cached: ApprovalCacheEntry | undefined,
): Promise<TempoApprovalResponse> {
  const key = monthKey(year, month);
  const { from } = getMonthRange(year, month);
  try {
    const accountId = await getAccountId(secrets);
    const client = new TempoClient(secrets.Tempo_Token);
    const raw = await client.getUserTimesheetApproval(accountId, from);
    const entry: ApprovalCacheEntry = {
      fetchedAt: new Date().toISOString(),
      period: raw.period ?? null,
      statusKey: raw.status?.key ?? null,
      statusUpdatedAt: raw.status?.updatedAt ?? null,
      requiredSeconds: raw.requiredSeconds ?? null,
      timeSpentSeconds: raw.timeSpentSeconds ?? null,
      canSubmit: raw.actions?.submit !== undefined,
    };
    const cache = readCache();
    cache[key] = entry;
    writeCache(cache);
    return fromEntry(entry, false);
  } catch (err) {
    if (err instanceof TempoApiError && err.status === 403) return approvalUnavailable('scope');
    if (cached) return fromEntry(cached, true); // stale beats nothing
    return approvalUnavailable('error');
  }
}
