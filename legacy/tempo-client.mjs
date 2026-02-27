#!/usr/bin/env node

/**
 * Isolated Tempo API client.
 *
 * SECURITY: This module makes exactly TWO types of HTTP requests:
 *   GET  /4/worklogs/user/{accountId}  — read existing worklogs for a period
 *   POST /4/worklogs                   — create a single worklog
 *
 * No DELETE, PUT, or other mutations are possible.
 * Rate limited to ~5 req/sec (210ms between requests).
 *
 * Standalone usage:
 *   node tempo-client.mjs get <accountId> <from> <to>
 */

import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const SECRETS_PATH = join(SCRIPT_DIR, 'secrets.json');

const BASE_URL = 'https://api.tempo.io';
const RATE_LIMIT_MS = 210; // ~5 req/sec

// ─── Secrets ──────────────────────────────────────────────────────────────

function loadTempoToken() {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`secrets.json not found at ${SECRETS_PATH}`);
  }
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf-8'));
  if (!secrets.Tempo_Token) {
    throw new Error('Tempo_Token not found in secrets.json');
  }
  return secrets.Tempo_Token;
}

// ─── Rate limiter ─────────────────────────────────────────────────────────

let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function tempoRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);

    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    };

    if (body != null) {
      headers['Content-Type'] = 'application/json';
    }

    const req = httpsRequest(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Tempo API ${res.statusCode} ${method} ${path}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Tempo response for ${path}: ${e.message}`));
        }
      });
    });

    req.on('error', reject);

    if (body != null) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Get existing worklogs for a user in a date range.
 * Handles pagination automatically.
 *
 * @param {string} accountId - Jira account ID
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate - YYYY-MM-DD
 * @returns {Promise<Array<{ issueId: number, startDate: string, timeSpentSeconds: number, tempoWorklogId: number }>>}
 */
export async function getUserWorklogs(accountId, fromDate, toDate) {
  const token = loadTempoToken();
  const allWorklogs = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    await rateLimit();
    const path = `/4/worklogs/user/${encodeURIComponent(accountId)}`
      + `?from=${fromDate}&to=${toDate}&offset=${offset}&limit=${limit}`;

    const response = await tempoRequest('GET', path, token);

    const results = response.results ?? [];
    for (const wl of results) {
      allWorklogs.push({
        tempoWorklogId: wl.tempoWorklogId,
        issueId: wl.issue?.id ?? wl.issueId,
        startDate: wl.startDate,
        timeSpentSeconds: wl.timeSpentSeconds,
      });
    }

    // Check pagination
    const meta = response.metadata;
    if (meta == null || offset + limit >= meta.count) {
      break;
    }
    offset += limit;
  }

  return allWorklogs;
}

/**
 * Create a single worklog in Tempo with Activity = Development.
 *
 * @param {{ issueId: number|string, authorAccountId: string, timeSpentSeconds: number, startDate: string, description?: string }} params
 * @returns {Promise<Object>} Created worklog response
 */
export async function createWorklog({ issueId, authorAccountId, timeSpentSeconds, startDate, description }) {
  const token = loadTempoToken();
  await rateLimit();

  const body = {
    issueId: Number(issueId),
    authorAccountId,
    timeSpentSeconds,
    startDate,
    startTime: '09:00:00',
    attributes: [
      { key: '_Activity_', value: 'Development' },
    ],
  };

  if (description) {
    body.description = description;
  }

  return tempoRequest('POST', '/4/worklogs', token, body);
}

// ─── Standalone execution ─────────────────────────────────────────────────

const isMain = process.argv[1]
  && resolve(process.argv[1]).replace(/\\/g, '/') === __filename.replace(/\\/g, '/');

if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'get' && rest.length === 3) {
    const [accountId, from, to] = rest;
    console.log(`Fetching worklogs for ${accountId} from ${from} to ${to}...`);
    const worklogs = await getUserWorklogs(accountId, from, to);
    console.log(`Found ${worklogs.length} worklog(s):\n`);
    for (const wl of worklogs) {
      const hours = (wl.timeSpentSeconds / 3600).toFixed(1);
      console.log(`  ${wl.startDate}  issue:${wl.issueId}  ${hours}h  (id:${wl.tempoWorklogId})`);
    }
  } else {
    console.log('Usage: node tempo-client.mjs get <accountId> <from> <to>');
    process.exit(1);
  }
}
