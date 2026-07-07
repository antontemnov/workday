// Remote snapshot of the user's Tempo worklogs, one file per month
// (data/tempo-cache/YYYY-MM.json, atomic write). This is the remote side of
// mirror-sync: reconcile compares the desired report against this snapshot,
// not against push-log memory. No TTL — a snapshot stays valid until a push
// mutates Tempo (invalidated) or the caller forces a refresh.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { TEMPO_CACHE_DIR, TMP_EXTENSION } from '../core/constants.js';
import type { Secrets, TempoMonthSnapshot } from '../core/types.js';
import { TempoClient } from './tempo-client.js';
import { getAccountId, resolveIssueKeys } from './jira-client.js';
import { getMonthRange } from './month-report.js';

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function getSnapshotPath(year: number, month: number): string {
  return join(getDataDir(), TEMPO_CACHE_DIR, `${monthKey(year, month)}.json`);
}

/** Cached snapshot for a month, or null when absent/corrupted. */
export function loadMonthSnapshot(year: number, month: number): TempoMonthSnapshot | null {
  const path = getSnapshotPath(year, month);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as TempoMonthSnapshot;
  } catch {
    return null;
  }
}

export function saveMonthSnapshot(snapshot: TempoMonthSnapshot): void {
  const [year, month] = snapshot.month.split('-').map(Number);
  const path = getSnapshotPath(year, month);
  mkdirSync(join(getDataDir(), TEMPO_CACHE_DIR), { recursive: true });
  const tmpPath = path + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}

/** Fetch the month from Tempo and persist it as the current snapshot. */
export async function fetchMonthSnapshot(
  year: number,
  month: number,
  secrets: Secrets,
  knownAccountId?: string,
): Promise<TempoMonthSnapshot> {
  const accountId = knownAccountId ?? await getAccountId(secrets);
  const client = new TempoClient(secrets.Tempo_Token);
  const { from, to } = getMonthRange(year, month);
  const worklogs = await client.getUserWorklogs(accountId, from, to);

  // Foreign rows render offline by ticket key, but Tempo carries only
  // issueId — resolve here while we are online. Best-effort: Jira being
  // unreachable must not fail the snapshot itself.
  let issueKeys: Record<string, string> = {};
  try {
    issueKeys = await resolveIssueKeys([...new Set(worklogs.map(w => w.issueId))], secrets);
  } catch { /* keys stay partial — foreign rows fall back to issue #id */ }

  const snapshot: TempoMonthSnapshot = {
    month: monthKey(year, month),
    accountId,
    fetchedAt: new Date().toISOString(),
    worklogs,
    issueKeys,
  };
  saveMonthSnapshot(snapshot);
  return snapshot;
}

/**
 * Drop cached snapshots for every month intersecting [from, to] — called
 * after a push mutates Tempo, so the next sync refetches fresh state.
 */
export function invalidateSnapshotsInRange(from: string, to: string): void {
  let [year, month] = from.slice(0, 7).split('-').map(Number);
  const lastKey = to.slice(0, 7);
  while (monthKey(year, month) <= lastKey) {
    try { unlinkSync(getSnapshotPath(year, month)); } catch { /* absent is fine */ }
    month++;
    if (month > 12) { month = 1; year++; }
  }
}

/**
 * Refetch snapshots for every month intersecting [from, to] — best effort:
 * a month that fails to fetch gets its stale cache dropped instead, so it
 * can never lie about the post-push state.
 */
export async function refreshSnapshotsInRange(
  from: string,
  to: string,
  secrets: Secrets,
  knownAccountId?: string,
): Promise<void> {
  let [year, month] = from.slice(0, 7).split('-').map(Number);
  const lastKey = to.slice(0, 7);
  while (monthKey(year, month) <= lastKey) {
    try {
      await fetchMonthSnapshot(year, month, secrets, knownAccountId);
    } catch {
      try { unlinkSync(getSnapshotPath(year, month)); } catch { /* absent is fine */ }
    }
    month++;
    if (month > 12) { month = 1; year++; }
  }
}
