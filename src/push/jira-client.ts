import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import {
  ISSUE_CACHE_FILE,
  JIRA_SEARCH_CACHE_TTL_MS,
  JIRA_SEARCH_CACHE_MAX_ENTRIES,
} from '../core/constants.js';
import type { Secrets, JiraIssue, JiraSearchHit } from '../core/types.js';

const ACCOUNT_ID_CACHE_KEY = '__accountId__';

/** Jira HTTP failure with the status preserved — 404 means "no such issue". */
export class JiraApiError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** All three Jira fields present — the search/validation gate. */
export function isJiraConfigured(secrets: Secrets): boolean {
  return !!(secrets.Jira_BaseUrl?.trim() && secrets.Jira_Email?.trim() && secrets.Jira_Token?.trim());
}

function getCachePath(): string {
  return join(getDataDir(), ISSUE_CACHE_FILE);
}

function loadCache(): Record<string, unknown> {
  const path = getCachePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, unknown>): void {
  writeFileSync(getCachePath(), JSON.stringify(cache, null, 2), 'utf-8');
}

/** GET request to Jira REST API */
async function jiraGet(path: string, secrets: Secrets): Promise<unknown> {
  const url = new URL(path, secrets.Jira_BaseUrl);
  const auth = Buffer.from(`${secrets.Jira_Email}:${secrets.Jira_Token}`).toString('base64');

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new JiraApiError(res.status, `Jira API ${res.status} GET ${path}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

/** Get current user's Jira accountId (cached) */
export async function getAccountId(secrets: Secrets): Promise<string> {
  const cache = loadCache();
  if (cache[ACCOUNT_ID_CACHE_KEY]) {
    return cache[ACCOUNT_ID_CACHE_KEY] as string;
  }

  const data = await jiraGet('/rest/api/3/myself', secrets) as { accountId: string };
  cache[ACCOUNT_ID_CACHE_KEY] = data.accountId;
  saveCache(cache);
  return data.accountId;
}

// ─── Live search (log-cloud fallback) ────────────────────────────────────

interface PickerIssue {
  readonly key?: string;
  readonly summaryText?: string;  // plain text
  readonly summary?: string;      // may carry <b> highlighting
}

interface PickerResponse {
  readonly sections?: ReadonlyArray<{ readonly issues?: readonly PickerIssue[] }>;
}

// Recent queries only — perishable, in-memory, Map insertion order = LRU.
const searchCache = new Map<string, { hits: JiraSearchHit[]; expiresAt: number }>();

/**
 * Live issue search via the Jira Cloud issue picker (made for autocomplete:
 * matches key + summary text, ranks itself). Hits are deduped across picker
 * sections (history vs current search overlap).
 *
 * currentJQL is required even empty — without it the picker answers with the
 * History Search section only (recently viewed issues), so a user with no
 * view history gets zero hits for everything. showSubTasks keeps sub-task
 * issues findable (excluded by default).
 */
export async function searchIssues(query: string, secrets: Secrets): Promise<JiraSearchHit[]> {
  const cacheKey = query.trim().toLowerCase();
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.hits;

  const data = await jiraGet(
    `/rest/api/3/issue/picker?query=${encodeURIComponent(query.trim())}`
      + '&currentJQL=&showSubTasks=true&showSubTaskParent=true',
    secrets,
  ) as PickerResponse;

  const hits: JiraSearchHit[] = [];
  const seenKeys = new Set<string>();
  for (const section of data.sections ?? []) {
    for (const issue of section.issues ?? []) {
      if (!issue.key || seenKeys.has(issue.key)) continue;
      seenKeys.add(issue.key);
      const summary = issue.summaryText ?? (issue.summary ?? '').replace(/<[^>]*>/g, '');
      hits.push({ key: issue.key, summary });
    }
  }

  searchCache.delete(cacheKey);
  searchCache.set(cacheKey, { hits, expiresAt: Date.now() + JIRA_SEARCH_CACHE_TTL_MS });
  if (searchCache.size > JIRA_SEARCH_CACHE_MAX_ENTRIES) {
    searchCache.delete(searchCache.keys().next().value as string);
  }
  return hits;
}

/**
 * Existence probe for a task key: found → JiraIssue (cached in
 * issue-cache.json), 404 → null (never cached — the issue may be created a
 * minute later), network/5xx → throws. Callers treat "unreachable" as
 * soft-pass: offline must not block logging, push re-validates anyway.
 */
export async function checkIssueExists(key: string, secrets: Secrets): Promise<JiraIssue | null> {
  const cache = loadCache();
  const cached = cache[key] as JiraIssue | undefined;
  if (cached) return cached;

  let data: { id: string; fields?: { summary?: string } };
  try {
    data = await jiraGet(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
      secrets,
    ) as { id: string; fields?: { summary?: string } };
  } catch (err) {
    if (err instanceof JiraApiError && err.status === 404) return null;
    throw err;
  }

  const issue: JiraIssue = {
    issueId: Number(data.id),
    summary: data.fields?.summary ?? '',
  };
  cache[key] = issue;
  saveCache(cache);
  return issue;
}

/**
 * Resolve Jira issue IDs back to their keys — foreign worklogs carry only
 * issueId. The issue-cache covers every task we ever pushed (reverse lookup);
 * unknown ids are fetched one by one, failures are skipped (best-effort).
 */
export async function resolveIssueKeys(
  issueIds: readonly number[],
  secrets: Secrets,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const cache = loadCache();

  const reverse = new Map<number, string>();
  for (const [key, value] of Object.entries(cache)) {
    if (key === ACCOUNT_ID_CACHE_KEY) continue;
    const issue = value as JiraIssue;
    if (issue && typeof issue.issueId === 'number') reverse.set(issue.issueId, key);
  }

  const toFetch: number[] = [];
  for (const id of issueIds) {
    const known = reverse.get(id);
    if (known) result[String(id)] = known;
    else toFetch.push(id);
  }

  if (toFetch.length > 0) {
    for (const id of toFetch) {
      try {
        const data = await jiraGet(`/rest/api/3/issue/${id}?fields=summary`, secrets) as
          { id: string; key: string; fields?: { summary?: string } };
        result[String(id)] = data.key;
        cache[data.key] = { issueId: Number(data.id), summary: data.fields?.summary ?? '' };
      } catch (err) {
        console.error(`WARNING: Failed to resolve issue #${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    saveCache(cache);
  }

  return result;
}

/** Resolve task keys to Jira issue IDs and summaries (cached) */
export async function resolveIssueIds(keys: readonly string[], secrets: Secrets): Promise<Map<string, JiraIssue>> {
  const results = new Map<string, JiraIssue>();
  const cache = loadCache();
  const toFetch: string[] = [];

  for (const key of keys) {
    const cached = cache[key] as JiraIssue | undefined;
    if (cached) {
      results.set(key, cached);
    } else {
      toFetch.push(key);
    }
  }

  if (toFetch.length > 0) {
    for (const key of toFetch) {
      try {
        const data = await jiraGet(
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
          secrets,
        ) as { id: string; fields?: { summary?: string } };

        const issue: JiraIssue = {
          issueId: Number(data.id),
          summary: data.fields?.summary ?? '',
        };
        cache[key] = issue;
        results.set(key, issue);
      } catch (err) {
        console.error(`WARNING: Failed to resolve ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    saveCache(cache);
  }

  return results;
}

// ─── Cached summaries (Logged table / today response) ─────────────────────

/**
 * Ticket summaries straight from the issue-cache — synchronous, never hits the
 * network. Keys with no cached (or empty) summary are simply omitted.
 */
export function loadCachedSummaries(keys: readonly string[]): Record<string, string> {
  const cache = loadCache();
  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key === ACCOUNT_ID_CACHE_KEY) continue;
    const issue = cache[key] as JiraIssue | undefined;
    if (issue && typeof issue.summary === 'string' && issue.summary !== '') out[key] = issue.summary;
  }
  return out;
}

// Keys we recently tried and failed to resolve — a broken / 404 / not-yet-
// created key must not trigger a fetch on every ~30s today poll.
const backfillFailures = new Map<string, number>();
const BACKFILL_RETRY_MS = 10 * 60_000;

/**
 * Best-effort background fill of missing issue summaries into the cache.
 * Fetches only uncached keys that haven't just failed; never throws. Callers
 * fire-and-forget — the summaries surface on the next today poll.
 */
export async function backfillIssueSummaries(keys: readonly string[], secrets: Secrets): Promise<void> {
  const now = Date.now();
  const cache = loadCache();
  const toFetch = keys.filter(key => {
    if (key === ACCOUNT_ID_CACHE_KEY || cache[key]) return false;
    const failedAt = backfillFailures.get(key);
    return failedAt === undefined || now - failedAt > BACKFILL_RETRY_MS;
  });
  if (toFetch.length === 0) return;

  await resolveIssueIds(toFetch, secrets); // caches successes, logs per-key failures
  const after = loadCache();
  for (const key of toFetch) if (!after[key]) backfillFailures.set(key, now);
}
