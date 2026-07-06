// Mirror-sync diff engine. Desired state (the local report) is compared
// against the ACTUAL Tempo state (worklog snapshot); push-log serves only as
// the ownership map localKey → tempoWorklogId, never as a source of truth
// about worklog content. Matching is identity-based (tempoWorklogId): field
// edits — time, text, activity, even a day move — keep the id on the Tempo
// side (verified live 2026-07-07); only a ticket move recreates the worklog.

import { TEMPO_TOLERANCE_SECONDS } from '../core/constants.js';
import type { JiraIssue, PushLogEntry, PushPlanEntry, TaskDayReport, TempoWorklog } from '../core/types.js';
import { pushLogKey } from './push-log.js';

export function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  const rounded1 = parseFloat(hours.toFixed(1));
  if (Math.abs(hours - rounded1) < 0.01) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(2)}h`;
}

function timeDrifts(a: number, b: number): boolean {
  return Math.abs(a - b) > TEMPO_TOLERANCE_SECONDS;
}

function manualTextDrifts(entry: TaskDayReport, wl: TempoWorklog): boolean {
  return (wl.description ?? '') !== (entry.description ?? '')
    || (wl.activity ?? '') !== (entry.activity ?? '');
}

/** The worklog no longer matches what we sent — someone edited it in Tempo. */
function remoteChanged(own: PushLogEntry, wl: TempoWorklog, entryDate: string, kind: TaskDayReport['kind']): boolean {
  if (own.timeSpentSeconds !== wl.timeSpentSeconds) return true;
  if (wl.startDate !== entryDate) return true;
  if (kind === 'manual') {
    return (own.description ?? '') !== (wl.description ?? '')
      || (own.activity ?? '') !== (wl.activity ?? '');
  }
  return false;
}

/** Worklog content equals a manual entry (adoption criterion). */
function contentMatches(entry: TaskDayReport, wl: TempoWorklog): boolean {
  return !timeDrifts(wl.timeSpentSeconds, entry.totalSeconds) && !manualTextDrifts(entry, wl);
}

interface PendingEntry {
  readonly entry: TaskDayReport;
  readonly issueId: number;
  readonly hadOwnership: boolean; // key existed but its worklog is gone from Tempo (remote delete / ticket move)
}

/**
 * Build the push plan: desired report vs Tempo snapshot, ownership from
 * push-log. Orphaned desired entries re-adopt unowned worklogs on the same
 * (date, issue) — by exact content for manual entries, by being the only
 * candidate for session aggregates — instead of blindly creating duplicates.
 */
export function buildPushPlan(
  report: readonly TaskDayReport[],
  jiraMap: Map<string, JiraIssue>,
  pushLog: Record<string, PushLogEntry>,
  tempoWorklogs: readonly TempoWorklog[],
): PushPlanEntry[] {
  const plan: PushPlanEntry[] = [];

  const snapById = new Map<number, TempoWorklog>();
  const byDateIssue = new Map<string, TempoWorklog[]>();
  for (const wl of tempoWorklogs) {
    snapById.set(wl.tempoWorklogId, wl);
    const key = `${wl.startDate}|${wl.issueId}`;
    const list = byDateIssue.get(key) ?? [];
    list.push(wl);
    byDateIssue.set(key, list);
  }

  // Every worklog id claimed by ANY ownership key — never an adoption candidate.
  const ownedIds = new Set<number>();
  for (const logEntry of Object.values(pushLog)) ownedIds.add(logEntry.tempoWorklogId);

  const accounted = new Set<number>();
  const pending = new Map<string, { manuals: PendingEntry[]; sessions: PendingEntry[] }>();

  // ── Pass 1: desired entries with a live owned worklog → field diff ──
  for (const entry of report) {
    const jira = jiraMap.get(entry.task);
    if (!jira) {
      plan.push({
        date: entry.date, task: entry.task, targetSeconds: entry.totalSeconds,
        action: 'error', detail: 'Unresolved in Jira',
        kind: entry.kind, entryId: entry.entryId, description: entry.description, activity: entry.activity,
      });
      continue;
    }

    const base = {
      date: entry.date, task: entry.task, targetSeconds: entry.totalSeconds,
      issueId: jira.issueId, kind: entry.kind, entryId: entry.entryId,
    };
    const key = pushLogKey(entry.date, entry.task, entry.kind === 'manual' ? entry.entryId : undefined);
    const own = pushLog[key];
    const wl = own ? snapById.get(own.tempoWorklogId) : undefined;

    if (own && wl) {
      accounted.add(wl.tempoWorklogId);

      if (wl.issueId !== jira.issueId) {
        // Same id on a different issue — identity is confused; never guess.
        plan.push({ ...base, action: 'error', existingWorklogId: wl.tempoWorklogId, detail: `Worklog #${wl.tempoWorklogId} sits on another issue in Tempo — resolve manually` });
        continue;
      }

      const moved = wl.startDate !== entry.date;
      const time = timeDrifts(wl.timeSpentSeconds, entry.totalSeconds);
      const text = entry.kind === 'manual' && manualTextDrifts(entry, wl);

      if (!moved && !time && !text) {
        plan.push({ ...base, action: 'skip', detail: `In sync (${formatHours(wl.timeSpentSeconds)})`, existingWorklogId: wl.tempoWorklogId, description: entry.description, activity: entry.activity });
        continue;
      }

      const parts: string[] = [];
      if (time) parts.push(`${formatHours(wl.timeSpentSeconds)} → ${formatHours(entry.totalSeconds)}`);
      if (text) parts.push('text/activity changed');
      if (moved) parts.push(`moved to ${wl.startDate} in Tempo → restoring ${entry.date}`);

      plan.push({
        ...base,
        action: 'update',
        detail: parts.join('; '),
        existingWorklogId: wl.tempoWorklogId,
        // Session worklogs: text/activity are Tempo-side cosmetics we do not
        // manage — carry the current remote values through the PUT untouched.
        description: entry.kind === 'manual' ? entry.description : wl.description,
        activity: entry.kind === 'manual' ? entry.activity : wl.activity,
        ...(remoteChanged(own, wl, entry.date, entry.kind) ? { conflict: true } : {}),
      });
      continue;
    }

    // Ownerless (never pushed) or orphaned (worklog vanished remotely).
    const group = pending.get(`${entry.date}|${jira.issueId}`) ?? { manuals: [], sessions: [] };
    const item: PendingEntry = { entry, issueId: jira.issueId, hadOwnership: !!own };
    (entry.kind === 'manual' ? group.manuals : group.sessions).push(item);
    pending.set(`${entry.date}|${jira.issueId}`, group);
  }

  // ── Pass 2: adoption / creation per (date, issue) ──
  for (const [dateIssueKey, group] of pending) {
    const pool = (byDateIssue.get(dateIssueKey) ?? [])
      .filter(w => !accounted.has(w.tempoWorklogId) && !ownedIds.has(w.tempoWorklogId))
      .sort((a, b) => a.tempoWorklogId - b.tempoWorklogId);

    // Manual entries adopt by exact content — an identical unowned worklog
    // IS this entry (either our lost push or the user logging the same thing
    // directly in Tempo); any assignment among equals is semantically equal.
    for (const { entry, issueId, hadOwnership } of [...group.manuals].sort((a, b) => (a.entry.entryId ?? '').localeCompare(b.entry.entryId ?? ''))) {
      const base = {
        date: entry.date, task: entry.task, targetSeconds: entry.totalSeconds,
        issueId, kind: entry.kind, entryId: entry.entryId,
        description: entry.description, activity: entry.activity,
      };
      const idx = pool.findIndex(w => contentMatches(entry, w));
      if (idx !== -1) {
        const wl = pool.splice(idx, 1)[0];
        accounted.add(wl.tempoWorklogId);
        plan.push({ ...base, action: 'update', existingWorklogId: wl.tempoWorklogId, detail: `Re-adopted worklog #${wl.tempoWorklogId}` });
      } else {
        plan.push({ ...base, action: 'create', detail: `New (${formatHours(entry.totalSeconds)})`, ...(hadOwnership ? { conflict: true } : {}) });
      }
    }

    // Session aggregate: adopt the single remaining candidate; a multi-way
    // ambiguity is only accepted when the candidates sum to the desired time
    // (a split done in Tempo) — otherwise refuse to guess.
    for (const { entry, issueId, hadOwnership } of group.sessions) {
      const base = {
        date: entry.date, task: entry.task, targetSeconds: entry.totalSeconds,
        issueId, kind: entry.kind,
      };
      if (pool.length === 1) {
        const wl = pool.pop()!;
        accounted.add(wl.tempoWorklogId);
        const detail = timeDrifts(wl.timeSpentSeconds, entry.totalSeconds)
          ? `Re-adopted worklog #${wl.tempoWorklogId}: ${formatHours(wl.timeSpentSeconds)} → ${formatHours(entry.totalSeconds)}`
          : `Re-adopted worklog #${wl.tempoWorklogId}`;
        plan.push({ ...base, action: 'update', existingWorklogId: wl.tempoWorklogId, detail, description: wl.description, activity: wl.activity });
      } else if (pool.length > 1) {
        const sum = pool.reduce((s, w) => s + w.timeSpentSeconds, 0);
        const ids = pool.map(w => w.tempoWorklogId);
        for (const w of pool) accounted.add(w.tempoWorklogId);
        pool.length = 0;
        if (!timeDrifts(sum, entry.totalSeconds)) {
          plan.push({ ...base, action: 'skip', detail: `Exists in Tempo (${ids.length} worklogs, ${formatHours(sum)})`, extraWorklogIds: ids });
        } else {
          plan.push({ ...base, action: 'error', detail: `Ambiguous: ${ids.length} unowned worklogs (${formatHours(sum)}) vs local ${formatHours(entry.totalSeconds)} — resolve in Tempo`, extraWorklogIds: ids });
        }
      } else {
        plan.push({ ...base, action: 'create', detail: `New (${formatHours(entry.totalSeconds)})`, ...(hadOwnership ? { conflict: true } : {}) });
      }
    }
  }

  // ── Pass 3: unmatched Tempo worklogs — show, never mutate ──
  for (const wl of tempoWorklogs) {
    if (accounted.has(wl.tempoWorklogId)) continue;
    let taskKey = `issue:${wl.issueId}`;
    for (const [key, jira] of jiraMap) {
      if (jira.issueId === wl.issueId) { taskKey = key; break; }
    }
    plan.push({
      date: wl.startDate, task: taskKey, targetSeconds: wl.timeSpentSeconds,
      action: 'skip', detail: `Tempo only (${formatHours(wl.timeSpentSeconds)})`,
      existingWorklogId: wl.tempoWorklogId, kind: 'session',
    });
  }

  plan.sort((a, b) => a.date.localeCompare(b.date) || a.task.localeCompare(b.task));
  return plan;
}

/**
 * Offline drift check for one day — the status side of the same diff. Works
 * without Jira (ownership keys carry date|task), against a month snapshot.
 * Returns human-readable drift lines; empty array = verified parity.
 */
export function computeDayDrift(
  date: string,
  entries: readonly TaskDayReport[],
  pushLog: Record<string, PushLogEntry>,
  snapById: ReadonlyMap<number, TempoWorklog>,
): string[] {
  const drift: string[] = [];

  for (const entry of entries) {
    const key = pushLogKey(date, entry.task, entry.kind === 'manual' ? entry.entryId : undefined);
    const label = entry.kind === 'manual' ? `${entry.task} (manual)` : entry.task;
    const own = pushLog[key];
    const wl = own ? snapById.get(own.tempoWorklogId) : undefined;

    if (!own || !wl) {
      drift.push(`${label}: not pushed (${formatHours(entry.totalSeconds)})`);
      continue;
    }
    if (wl.startDate !== date) {
      drift.push(`${label}: moved to ${wl.startDate} in Tempo`);
    }
    if (timeDrifts(wl.timeSpentSeconds, entry.totalSeconds)) {
      drift.push(`${label}: ${formatHours(wl.timeSpentSeconds)} in Tempo vs ${formatHours(entry.totalSeconds)} local`);
    }
    if (entry.kind === 'manual' && manualTextDrifts(entry, wl)) {
      drift.push(`${label}: description/activity differ`);
    }
  }

  return drift;
}
