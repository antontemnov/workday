#!/usr/bin/env node

/**
 * Isolated Jira API client.
 *
 * SECURITY: This module makes exactly TWO types of HTTP GET requests:
 *   GET /rest/api/3/issue/{key}?fields=summary  — resolve issue key to id+summary
 *   GET /rest/api/3/myself                       — get current user's accountId
 *
 * No POST, PUT, DELETE, or any other mutation is possible.
 * The method is hardcoded to 'GET' with no parameter to change it.
 * Results are cached in issue-cache.json to minimize API calls.
 *
 * Standalone usage:
 *   node jira-client.mjs ATL-6466 ATL-6172
 *   node jira-client.mjs --myself
 */

import { request } from 'node:https';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const CACHE_PATH = join(SCRIPT_DIR, 'issue-cache.json');
const SECRETS_PATH = join(SCRIPT_DIR, 'secrets.json');

// ─── Cache ────────────────────────────────────────────────────────────────

function loadCache() {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
}

// ─── Secrets ──────────────────────────────────────────────────────────────

function loadSecrets() {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`secrets.json not found at ${SECRETS_PATH}`);
  }
  return JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'));
}

// ─── Single GET request ───────────────────────────────────────────────────

function fetchIssue(baseUrl, email, token, issueKey) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`, baseUrl);
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    const req = request(url, {
      method: 'GET', // Hardcoded: only GET is allowed
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Jira API ${res.statusCode} for ${issueKey}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve({
            issueId: data.id,
            summary: data.fields?.summary ?? '',
          });
        } catch (e) {
          reject(new Error(`Failed to parse Jira response for ${issueKey}: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── GET /rest/api/3/myself ───────────────────────────────────────────────

function fetchMyself(baseUrl, email, token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/rest/api/3/myself', baseUrl);
    const auth = Buffer.from(`${email}:${token}`).toString('base64');

    const req = request(url, {
      method: 'GET', // Hardcoded: only GET is allowed
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Jira API ${res.statusCode} for /myself: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const data = JSON.parse(body);
          resolve(data.accountId);
        } catch (e) {
          reject(new Error(`Failed to parse /myself response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Resolve a single issue key to { issueId, summary }.
 * Uses local cache to avoid redundant API calls.
 */
export async function resolveIssueId(issueKey) {
  const cache = loadCache();

  if (cache[issueKey]) {
    return cache[issueKey];
  }

  const secrets = loadSecrets();
  const result = await fetchIssue(
    secrets.Jira_BaseUrl,
    secrets.Jira_Email,
    secrets.Jira_Token,
    issueKey,
  );

  cache[issueKey] = result;
  saveCache(cache);

  return result;
}

/**
 * Resolve multiple issue keys at once.
 * Returns Map<issueKey, { issueId, summary }>.
 * Fetches only uncached keys from Jira (sequentially to stay gentle on API).
 */
export async function resolveIssueIds(issueKeys) {
  const results = new Map();
  const cache = loadCache();
  const toFetch = [];

  for (const key of issueKeys) {
    if (cache[key]) {
      results.set(key, cache[key]);
    } else {
      toFetch.push(key);
    }
  }

  if (toFetch.length > 0) {
    const secrets = loadSecrets();

    for (const key of toFetch) {
      try {
        const result = await fetchIssue(
          secrets.Jira_BaseUrl,
          secrets.Jira_Email,
          secrets.Jira_Token,
          key,
        );
        cache[key] = result;
        results.set(key, result);
      } catch (e) {
        console.error(`WARNING: Failed to resolve ${key}: ${e.message}`);
      }
    }

    saveCache(cache);
  }

  return results;
}

/**
 * Get the current user's Jira accountId.
 * Cached in issue-cache.json under "__accountId__" key.
 */
export async function getMyAccountId() {
  const CACHE_KEY = '__accountId__';
  const cache = loadCache();

  if (cache[CACHE_KEY]) {
    return cache[CACHE_KEY];
  }

  const secrets = loadSecrets();
  const accountId = await fetchMyself(
    secrets.Jira_BaseUrl,
    secrets.Jira_Email,
    secrets.Jira_Token,
  );

  cache[CACHE_KEY] = accountId;
  saveCache(cache);

  return accountId;
}

// ─── Standalone execution ─────────────────────────────────────────────────

const isMain = process.argv[1]
  && resolve(process.argv[1]).replace(/\\/g, '/') === __filename.replace(/\\/g, '/');

if (isMain) {
  const args = process.argv.slice(2);

  if (args[0] === '--myself') {
    const accountId = await getMyAccountId();
    console.log(`Account ID: ${accountId}`);
    console.log(`\nCache: ${CACHE_PATH}`);
  } else if (args.length === 0) {
    console.log('Usage: node jira-client.mjs <ATL-XXXX> [ATL-YYYY ...]');
    console.log('       node jira-client.mjs --myself');
    process.exit(1);
  } else {
    console.log(`Resolving ${args.length} issue(s)...`);
    const results = await resolveIssueIds(args);

    for (const [key, data] of results) {
      console.log(`  ${key} → id: ${data.issueId}, summary: "${data.summary}"`);
    }

    console.log(`\nCache: ${CACHE_PATH}`);
  }
}
