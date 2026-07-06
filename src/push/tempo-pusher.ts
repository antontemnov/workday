import { readFileSync } from 'node:fs';
import { loadConfig, loadSecrets } from '../core/config.js';
import { readDailyLog, writeDailyLog } from '../core/daily-log.js';
import { TEMPO_TOLERANCE_SECONDS } from '../core/constants.js';
import { DayStatus, type AppConfig, type Secrets, type TaskDayReport, type TempoWorklog, type JiraIssue, type PushPlanEntry, type PushLogEntry, type PushResult, type PushResponse } from '../core/types.js';
import { buildReport, buildReportResponse, getDefaultFromDate, getDefaultToDate } from './report-builder.js';
import { getAccountId, resolveIssueIds } from './jira-client.js';
import { TempoClient } from './tempo-client.js';
import { invalidateApprovalCache } from './tempo-approvals.js';
import { loadPushLog, savePushLog, pushLogKey } from './push-log.js';

// ─── Push plan ───────────────────────────────────────────────────────────

/** Build a plan by comparing report entries with push log and existing Tempo worklogs */
export function buildPushPlan(
  report: readonly TaskDayReport[],
  jiraMap: Map<string, JiraIssue>,
  pushLog: Record<string, PushLogEntry>,
  tempoWorklogs: readonly TempoWorklog[],
): PushPlanEntry[] {
  const plan: PushPlanEntry[] = [];

  // Index Tempo worklogs by (date, issueId) for fast lookup
  const tempoByKey = new Map<string, TempoWorklog[]>();
  for (const wl of tempoWorklogs) {
    const key = `${wl.startDate}|${wl.issueId}`;
    const list = tempoByKey.get(key) ?? [];
    list.push(wl);
    tempoByKey.set(key, list);
  }

  // Worklogs we own as MANUAL entries — excluded from the session aggregate so a
  // session line never treats its own task's manual worklogs as extra/foreign.
  const manualOwnedTempoIds = new Set<number>();
  for (const [key, logEntry] of Object.entries(pushLog)) {
    if (key.includes('|m:')) manualOwnedTempoIds.add(logEntry.tempoWorklogId);
  }

  // Track which Tempo worklogs are accounted for by our report
  const accountedTempoIds = new Set<number>();

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

    const tempoMatches = tempoByKey.get(`${entry.date}|${jira.issueId}`) ?? [];

    // ── Manual entry: its own worklog, keyed by entryId (stable across edits) ──
    if (entry.kind === 'manual') {
      const base = {
        date: entry.date, task: entry.task, targetSeconds: entry.totalSeconds,
        issueId: jira.issueId, kind: 'manual' as const,
        entryId: entry.entryId, description: entry.description, activity: entry.activity,
      };
      const key = pushLogKey(entry.date, entry.task, entry.entryId);
      const logEntry = pushLog[key];
      const live = logEntry && tempoMatches.some(w => w.tempoWorklogId === logEntry.tempoWorklogId)
        ? logEntry : null;

      if (live) {
        accountedTempoIds.add(live.tempoWorklogId);
        const timeDrift = Math.abs(live.timeSpentSeconds - entry.totalSeconds) > TEMPO_TOLERANCE_SECONDS;
        const textDrift = (live.description ?? '') !== (entry.description ?? '')
          || (live.activity ?? '') !== (entry.activity ?? '');
        if (!timeDrift && !textDrift) {
          plan.push({ ...base, action: 'skip', detail: `Already pushed (${formatHours(live.timeSpentSeconds)})`, existingWorklogId: live.tempoWorklogId });
        } else {
          const detail = timeDrift
            ? `${formatHours(live.timeSpentSeconds)} → ${formatHours(entry.totalSeconds)}`
            : 'text/activity changed';
          plan.push({ ...base, action: 'update', detail, existingWorklogId: live.tempoWorklogId });
        }
      } else {
        // No live worklog of ours — create. Foreign worklogs on the same issue+date
        // are irrelevant: this entry has its own identity (entryId).
        plan.push({ ...base, action: 'create', detail: `New (${formatHours(entry.totalSeconds)})` });
      }
      continue;
    }

    // ── Session aggregate: one worklog per (date, task) ──
    const base = {
      date: entry.date, task: entry.task, targetSeconds: entry.totalSeconds,
      issueId: jira.issueId, kind: 'session' as const,
    };
    const logEntry = pushLog[pushLogKey(entry.date, entry.task)];
    // Drop manual-owned worklogs: they belong to manual lines, not this aggregate.
    const sessionMatches = tempoMatches.filter(w => !manualOwnedTempoIds.has(w.tempoWorklogId));
    const validLogEntry = logEntry && sessionMatches.some(w => w.tempoWorklogId === logEntry.tempoWorklogId)
      ? logEntry : null;

    if (validLogEntry) {
      accountedTempoIds.add(validLogEntry.tempoWorklogId);
      const diff = Math.abs(validLogEntry.timeSpentSeconds - entry.totalSeconds);
      if (diff <= TEMPO_TOLERANCE_SECONDS) {
        plan.push({ ...base, action: 'skip', detail: `Already pushed (${formatHours(validLogEntry.timeSpentSeconds)})`, existingWorklogId: validLogEntry.tempoWorklogId });
      } else {
        plan.push({ ...base, action: 'update', detail: `${formatHours(validLogEntry.timeSpentSeconds)} → ${formatHours(entry.totalSeconds)}`, existingWorklogId: validLogEntry.tempoWorklogId });
      }
      for (const wl of sessionMatches) accountedTempoIds.add(wl.tempoWorklogId);
    } else if (sessionMatches.length > 0) {
      for (const wl of sessionMatches) accountedTempoIds.add(wl.tempoWorklogId);
      const existingTotal = sessionMatches.reduce((s, w) => s + w.timeSpentSeconds, 0);
      const diff = Math.abs(existingTotal - entry.totalSeconds);
      if (diff <= TEMPO_TOLERANCE_SECONDS) {
        plan.push({ ...base, action: 'skip', detail: `Exists in Tempo (${formatHours(existingTotal)})`, extraWorklogIds: sessionMatches.map(w => w.tempoWorklogId) });
      } else {
        plan.push({ ...base, action: 'create', detail: `Tempo has ${formatHours(existingTotal)}, adding ${formatHours(entry.totalSeconds)}`, extraWorklogIds: sessionMatches.map(w => w.tempoWorklogId) });
      }
    } else {
      plan.push({ ...base, action: 'create', detail: `New (${formatHours(entry.totalSeconds)})` });
    }
  }

  // Tempo-only worklogs (not matched by our report) — show, never mutate.
  for (const wl of tempoWorklogs) {
    if (accountedTempoIds.has(wl.tempoWorklogId)) continue;
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

  // Sort by date, then task
  plan.sort((a, b) => a.date.localeCompare(b.date) || a.task.localeCompare(b.task));
  return plan;
}

// ─── Execute plan ────────────────────────────────────────────────────────

/** Execute mutations from the plan, update push log */
export async function executePlan(
  plan: readonly PushPlanEntry[],
  tempoClient: TempoClient,
  accountId: string,
): Promise<PushResult> {
  const pushLog = loadPushLog();
  let posted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of plan) {
    const key = pushLogKey(entry.date, entry.task, entry.kind === 'manual' ? entry.entryId : undefined);

    switch (entry.action) {
      case 'skip':
        skipped++;
        break;

      case 'create': {
        if (!entry.issueId) { failed++; break; }
        try {
          const result = await tempoClient.createWorklog({
            issueId: entry.issueId,
            authorAccountId: accountId,
            timeSpentSeconds: entry.targetSeconds,
            startDate: entry.date,
            description: entry.description,
            activity: entry.activity,
          });
          pushLog[key] = {
            tempoWorklogId: result.tempoWorklogId,
            timeSpentSeconds: entry.targetSeconds,
            pushedAt: new Date().toISOString(),
            description: entry.description,
            activity: entry.activity,
          };
          posted++;
          console.log(`  POST ${entry.date} ${entry.task} ${formatHours(entry.targetSeconds)}`);
        } catch (err) {
          failed++;
          console.error(`  FAIL POST ${entry.date} ${entry.task}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'update': {
        if (!entry.issueId || !entry.existingWorklogId) { failed++; break; }
        try {
          const result = await tempoClient.updateWorklog(entry.existingWorklogId, {
            issueId: entry.issueId,
            authorAccountId: accountId,
            timeSpentSeconds: entry.targetSeconds,
            startDate: entry.date,
            description: entry.description,
            activity: entry.activity,
          });
          pushLog[key] = {
            tempoWorklogId: result.tempoWorklogId,
            timeSpentSeconds: entry.targetSeconds,
            pushedAt: new Date().toISOString(),
            description: entry.description,
            activity: entry.activity,
          };
          updated++;
          console.log(`  PUT  ${entry.date} ${entry.task} ${entry.detail}`);
        } catch (err) {
          failed++;
          console.error(`  FAIL PUT ${entry.date} ${entry.task}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'error':
        failed++;
        break;
    }
  }

  savePushLog(pushLog);
  return { posted, updated, deleted, skipped, failed };
}

// ─── Mark daily logs as pushed ───────────────────────────────────────────

function markDaysPushed(from: string, to: string): void {
  const current = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (current <= end) {
    const y = current.getUTCFullYear();
    const m = String(current.getUTCMonth() + 1).padStart(2, '0');
    const d = String(current.getUTCDate()).padStart(2, '0');
    const date = `${y}-${m}-${d}`;

    const log = readDailyLog(date);
    if (log && log.status !== DayStatus.Pushed) {
      log.status = DayStatus.Pushed;
      log.pushedAt = new Date().toISOString();
      writeDailyLog(log);
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

// ─── Full orchestration ──────────────────────────────────────────────────

interface RunPushOptions {
  readonly from: string;
  readonly to: string;
  readonly commit: boolean;
  readonly config: AppConfig;
  readonly secrets: Secrets;
  readonly filePath?: string;
}

/** Full push pipeline: build report → resolve Jira → fetch Tempo → plan → execute */
export async function runPush(options: RunPushOptions): Promise<PushResponse> {
  const { from, to, commit, config, secrets, filePath } = options;

  // Step 1: Build or load report
  let report: TaskDayReport[];
  if (filePath) {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as { entries: TaskDayReport[] };
    report = parsed.entries;
    console.log(`Loaded ${report.length} entries from ${filePath}`);
  } else {
    report = buildReport(from, to, config);
    console.log(`Built report: ${report.length} entries (${from} → ${to})`);
  }

  if (report.length === 0) {
    return { dryRun: !commit, plan: [], result: { posted: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 } };
  }

  // Step 2: Resolve Jira issue IDs
  const uniqueTasks = [...new Set(report.map(e => e.task))];
  console.log(`Resolving ${uniqueTasks.length} Jira issue(s)...`);
  const jiraMap = await resolveIssueIds(uniqueTasks, secrets);

  // Step 3: Get Jira accountId + existing Tempo worklogs
  let accountId: string;
  try {
    accountId = await getAccountId(secrets);
  } catch (err) {
    throw new Error(`Jira auth failed (check secrets.json): ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Account: ${accountId}`);

  const tempoClient = new TempoClient(secrets.Tempo_Token);
  console.log(`Fetching Tempo worklogs (${from} → ${to})...`);
  const tempoWorklogs = await tempoClient.getUserWorklogs(accountId, from, to);
  console.log(`Found ${tempoWorklogs.length} existing worklog(s)`);

  // Step 4: Build plan
  const pushLog = loadPushLog();
  const plan = buildPushPlan(report, jiraMap, pushLog, tempoWorklogs);

  if (!commit) {
    return { dryRun: true, plan };
  }

  // Step 5: Execute
  const actionable = plan.filter(e => e.action === 'create' || e.action === 'update');
  if (actionable.length === 0) {
    console.log('Nothing to push.');
    // Parity with Tempo is still a successful sync — seal the days, or an
    // edited-then-reverted day stays Outdated forever (no mutation ever
    // triggers the seal below). Plan errors (unresolved Jira) block it.
    if (!plan.some(e => e.action === 'error')) {
      markDaysPushed(from, to);
    }
    return { dryRun: false, plan, result: { posted: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 } };
  }

  console.log(`Executing ${actionable.length} mutation(s)...`);
  const result = await executePlan(plan, tempoClient, accountId);

  // Tempo-side totals changed — the approval snapshot is stale now.
  if (result.posted > 0 || result.updated > 0) {
    invalidateApprovalCache();
  }

  // Seal the day only on a clean push. A failed mutation (network, Jira limit, etc.)
  // must NOT mark the day pushed, or it would silently drop out of future syncs.
  if (result.failed === 0) {
    markDaysPushed(from, to);
  } else {
    console.log(`Not sealing days as pushed: ${result.failed} mutation(s) failed — re-run push.`);
  }

  return { dryRun: false, plan, result };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  const rounded1 = parseFloat(hours.toFixed(1));
  if (Math.abs(hours - rounded1) < 0.01) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(2)}h`;
}
