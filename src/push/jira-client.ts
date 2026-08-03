import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import {
  ISSUE_CACHE_FILE,
  ISSUE_SUMMARY_TTL_MS,
  JIRA_SEARCH_CACHE_TTL_MS,
  JIRA_SEARCH_CACHE_MAX_ENTRIES,
  JQL_SEARCH_MAX_RESULTS,
  SEARCH_MAX_HITS,
  SEARCH_PICKER_FILL_THRESHOLD,
} from '../core/constants.js';
import type { Secrets, JiraIssue, JiraSearchHit, ProjectRef } from '../core/types.js';
import {
  parseSearchQuery, buildKeyJql, buildWordJql, rankCandidates, projectKeyOf,
  type SearchCandidate,
} from './issue-search.js';

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

export interface JiraMyself {
  readonly accountId: string;
  readonly displayName?: string;
}

/** Live credential probe for the setup flow — explicit secrets, no caching. */
export async function fetchMyself(secrets: Secrets): Promise<JiraMyself> {
  return await jiraGet('/rest/api/3/myself', secrets) as JiraMyself;
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
  // Section id: "hs" = History Search (recently viewed), "cs" = Current Search.
  readonly sections?: ReadonlyArray<{ readonly id?: string; readonly issues?: readonly PickerIssue[] }>;
}

// Recent searches only — perishable, in-memory, Map insertion order = LRU.
// Keyed by query + project scope (scope changes the result set).
const searchCache = new Map<string, { hits: JiraSearchHit[]; expiresAt: number }>();

function cacheGet(key: string): JiraSearchHit[] | null {
  const entry = searchCache.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.hits : null;
}

function cachePut(key: string, hits: JiraSearchHit[]): void {
  searchCache.delete(key);
  searchCache.set(key, { hits, expiresAt: Date.now() + JIRA_SEARCH_CACHE_TTL_MS });
  if (searchCache.size > JIRA_SEARCH_CACHE_MAX_ENTRIES) {
    searchCache.delete(searchCache.keys().next().value as string);
  }
}

/**
 * Relevance-ranked live issue search. Builds a bounded JQL (project scope +
 * exact `key in` + prefix `summary ~`, AND then OR fallback), fills recency /
 * key-number-prefix gaps from the picker, then re-ranks locally. projectKeys
 * is the configured allow-list (order = priority); empty = no project scope.
 */
export async function searchIssues(
  query: string,
  secrets: Secrets,
  projectKeys: readonly string[] = [],
): Promise<JiraSearchHit[]> {
  const cacheKey = `${query.trim().toLowerCase()}\u0000${projectKeys.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const parsed = parseSearchQuery(query, projectKeys);

  // Exact keys and the word search run as independent bounded queries — folded
  // into one, a flood of recent `summary ~` hits could push a matched key out
  // of the result window. The word search widens AND → OR when AND is empty.
  const jobs: Promise<SearchCandidate[]>[] = [];
  const keyJql = buildKeyJql(parsed, projectKeys);
  if (keyJql) jobs.push(jqlSearch(keyJql, secrets));
  if (parsed.searchWords.length > 0) {
    jobs.push((async () => {
      let hits = await jqlSearch(buildWordJql(parsed, projectKeys, 'and')!, secrets);
      if (hits.length === 0 && parsed.searchWords.length > 1) {
        hits = await jqlSearch(buildWordJql(parsed, projectKeys, 'or')!, secrets);
      }
      return hits;
    })());
  }

  let candidates: SearchCandidate[] = [];
  for (const part of await Promise.all(jobs)) candidates = mergeCandidates(candidates, part);

  // The picker adds what /search/jql can't: key-number prefix (typing "775"
  // surfaces ATL-775x) and recently-viewed issues. Pull it only when JQL
  // didn't already fill a page.
  if (candidates.length < SEARCH_PICKER_FILL_THRESHOLD) {
    try {
      candidates = mergeCandidates(candidates, await pickerSearch(parsed.raw, secrets, projectKeys));
    } catch { /* picker is best-effort — JQL results stand on their own */ }
  }

  const hits = rankCandidates(candidates, parsed, projectKeys, SEARCH_MAX_HITS);
  cachePut(cacheKey, hits);
  return hits;
}

/** Enhanced JQL search (bounded). Candidates keep the ORDER BY updated order. */
async function jqlSearch(jql: string, secrets: Secrets): Promise<SearchCandidate[]> {
  const data = await jiraGet(
    `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}`
      + `&fields=summary&maxResults=${JQL_SEARCH_MAX_RESULTS}`,
    secrets,
  ) as { issues?: ReadonlyArray<{ key?: string; fields?: { summary?: string } }> };

  const out: SearchCandidate[] = [];
  (data.issues ?? []).forEach((it, i) => {
    if (it.key) out.push({ key: it.key, summary: it.fields?.summary ?? '', projectKey: projectKeyOf(it.key), rank: i });
  });
  return out;
}

/**
 * Issue-picker autocomplete, scoped to the allow-list via currentJQL. A
 * supplementary candidate source (recency + key-number prefix), never the
 * primary. showSubTasks keeps sub-tasks findable; sections are deduped.
 */
async function pickerSearch(
  query: string,
  secrets: Secrets,
  projectKeys: readonly string[],
): Promise<SearchCandidate[]> {
  const currentJql = projectKeys.length > 0 ? `project in (${projectKeys.join(', ')})` : '';
  const data = await jiraGet(
    `/rest/api/3/issue/picker?query=${encodeURIComponent(query)}`
      + `&currentJQL=${encodeURIComponent(currentJql)}&showSubTasks=true&showSubTaskParent=true`,
    secrets,
  ) as PickerResponse;

  const out: SearchCandidate[] = [];
  const seen = new Set<string>();
  for (const section of data.sections ?? []) {
    const fromHistory = section.id === 'hs';
    (section.issues ?? []).forEach((issue, i) => {
      if (!issue.key || seen.has(issue.key)) return;
      seen.add(issue.key);
      const summary = issue.summaryText ?? (issue.summary ?? '').replace(/<[^>]*>/g, '');
      out.push({ key: issue.key, summary, projectKey: projectKeyOf(issue.key), fromHistory, rank: i });
    });
  }
  return out;
}

/** Merge picker candidates into JQL ones: JQL summary/rank wins, picker adds new keys + the history flag. */
function mergeCandidates(primary: SearchCandidate[], extra: SearchCandidate[]): SearchCandidate[] {
  const byKey = new Map(primary.map(c => [c.key, c]));
  for (const e of extra) {
    const existing = byKey.get(e.key);
    if (!existing) byKey.set(e.key, e);
    else if (e.fromHistory && !existing.fromHistory) byKey.set(e.key, { ...existing, fromHistory: true });
  }
  return [...byKey.values()];
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
          fetchedAt: new Date().toISOString(),
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

// ─── Project catalog (search-scope settings picker) ───────────────────────

interface ProjectSearchPage {
  readonly values?: ReadonlyArray<{ id?: string; key?: string; name?: string }>;
  readonly isLast?: boolean;
}

const PROJECT_SEARCH_PAGE_SIZE = 50;
const PROJECT_SEARCH_MAX_PAGES = 40; // 2000 projects — a hard runaway cap.

/** Map one /project/search page to ProjectRefs, dropping malformed entries. */
export function parseProjectSearchPage(page: ProjectSearchPage): ProjectRef[] {
  const out: ProjectRef[] = [];
  for (const v of page.values ?? []) {
    if (typeof v.key === 'string' && typeof v.name === 'string' && v.id != null) {
      out.push({ key: v.key, name: v.name, id: String(v.id) });
    }
  }
  return out;
}

/**
 * Fetch the full Jira project catalog (all pages) for the search-scope picker.
 * Sorted by key. Throws on network/auth failure — caller decides how to surface.
 */
export async function fetchProjects(secrets: Secrets): Promise<ProjectRef[]> {
  const all: ProjectRef[] = [];
  let startAt = 0;
  for (let pageNum = 0; pageNum < PROJECT_SEARCH_MAX_PAGES; pageNum++) {
    const page = await jiraGet(
      `/rest/api/3/project/search?maxResults=${PROJECT_SEARCH_PAGE_SIZE}&startAt=${startAt}&orderBy=key`,
      secrets,
    ) as ProjectSearchPage;
    const refs = parseProjectSearchPage(page);
    all.push(...refs);
    if (page.isLast || refs.length === 0) break;
    startAt += PROJECT_SEARCH_PAGE_SIZE;
  }
  return all.sort((a, b) => a.key.localeCompare(b.key));
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
// created key must not trigger a fetch on every ~30s today poll. Refresh
// failures throttle the same way (the stale entry keeps serving meanwhile).
const backfillFailures = new Map<string, number>();
const BACKFILL_RETRY_MS = 10 * 60_000;

/**
 * Best-effort background fill of issue summaries into the cache. Always
 * fetches uncached keys; with `refreshStale` also re-fetches entries older
 * than ISSUE_SUMMARY_TTL_MS so Jira-side renames surface. Skips keys that
 * just failed; never throws. Callers fire-and-forget — updates surface on
 * the next poll.
 */
export async function backfillIssueSummaries(
  keys: readonly string[], secrets: Secrets, refreshStale = false,
): Promise<void> {
  const now = Date.now();
  const cache = loadCache();
  const staleBefore = now - ISSUE_SUMMARY_TTL_MS;
  const toFetch = keys.filter(key => {
    if (key === ACCOUNT_ID_CACHE_KEY) return false;
    const cached = cache[key] as JiraIssue | undefined;
    if (cached) {
      if (!refreshStale) return false;
      // No stamp (legacy entry) counts as stale.
      const fetchedAt = cached.fetchedAt ? Date.parse(cached.fetchedAt) : 0;
      if (fetchedAt > staleBefore) return false;
    }
    const failedAt = backfillFailures.get(key);
    return failedAt === undefined || now - failedAt > BACKFILL_RETRY_MS;
  });
  if (toFetch.length === 0) return;

  // Fire-and-forget callers rely on this never rejecting — an unhandled
  // rejection would crash the daemon (no global handler). Fetches directly
  // rather than via resolveIssueIds, whose cache-hit shortcut would skip the
  // stale keys; a failed re-fetch keeps the old entry.
  try {
    let dirty = false;
    for (const key of toFetch) {
      try {
        const data = await jiraGet(
          `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary`,
          secrets,
        ) as { id: string; fields?: { summary?: string } };
        cache[key] = {
          issueId: Number(data.id),
          summary: data.fields?.summary ?? '',
          fetchedAt: new Date().toISOString(),
        } satisfies JiraIssue;
        dirty = true;
      } catch (err) {
        backfillFailures.set(key, now);
        console.error(`WARNING: Failed to resolve ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (dirty) saveCache(cache);
  } catch (err) {
    console.error(`WARNING: Issue-summary backfill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
