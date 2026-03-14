import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { ISSUE_CACHE_FILE } from '../core/constants.js';
import type { Secrets, JiraIssue } from '../core/types.js';

const ACCOUNT_ID_CACHE_KEY = '__accountId__';

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
    throw new Error(`Jira API ${res.status} GET ${path}: ${body.slice(0, 300)}`);
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
