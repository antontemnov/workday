import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir, loadConfig, loadSecrets } from '../core/config.js';
import { readDailyLog, writeDailyLog } from '../core/daily-log.js';
import { PUSH_LOG_FILE, TEMPO_TOLERANCE_SECONDS } from '../core/constants.js';
import { DayStatus, type AppConfig, type Secrets, type TaskDayReport, type TempoWorklog, type JiraIssue, type PushPlanEntry, type PushLogEntry, type PushResult, type PushResponse } from '../core/types.js';
import { buildReport, buildReportResponse, getDefaultFromDate, getDefaultToDate } from './report-builder.js';
import { getAccountId, resolveIssueIds } from './jira-client.js';
import { TempoClient } from './tempo-client.js';

// ─── Push log persistence ────────────────────────────────────────────────

function getPushLogPath(): string {
  return join(getDataDir(), PUSH_LOG_FILE);
}

function loadPushLog(): Record<string, PushLogEntry> {
  const path = getPushLogPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function savePushLog(log: Record<string, PushLogEntry>): void {
  writeFileSync(getPushLogPath(), JSON.stringify(log, null, 2), 'utf-8');
}

function pushLogKey(date: string, task: string): string {
  return `${date}|${task}`;
}

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

  // Track which Tempo worklogs are accounted for by our report
  const accountedTempoIds = new Set<number>();

  for (const entry of report) {
    const jira = jiraMap.get(entry.task);
    if (!jira) {
      plan.push({
        date: entry.date,
        task: entry.task,
        targetSeconds: entry.totalSeconds,
        action: 'error',
        detail: 'Unresolved in Jira',
      });
      continue;
    }

    const key = pushLogKey(entry.date, entry.task);
    const logEntry = pushLog[key];
    const tempoKey = `${entry.date}|${jira.issueId}`;
    const tempoMatches = tempoByKey.get(tempoKey) ?? [];

    // Verify push-log worklog still exists in Tempo
    const validLogEntry = logEntry && tempoMatches.some(w => w.tempoWorklogId === logEntry.tempoWorklogId)
      ? logEntry
      : null;

    if (validLogEntry) {
      // We pushed this before and worklog still exists — check if it needs update
      accountedTempoIds.add(validLogEntry.tempoWorklogId);
      const diff = Math.abs(validLogEntry.timeSpentSeconds - entry.totalSeconds);
      if (diff <= TEMPO_TOLERANCE_SECONDS) {
        plan.push({
          date: entry.date,
          task: entry.task,
          targetSeconds: entry.totalSeconds,
          action: 'skip',
          detail: `Already pushed (${formatHours(validLogEntry.timeSpentSeconds)})`,
          issueId: jira.issueId,
          existingWorklogId: validLogEntry.tempoWorklogId,
        });
      } else {
        plan.push({
          date: entry.date,
          task: entry.task,
          targetSeconds: entry.totalSeconds,
          action: 'update',
          detail: `${formatHours(validLogEntry.timeSpentSeconds)} → ${formatHours(entry.totalSeconds)}`,
          issueId: jira.issueId,
          existingWorklogId: validLogEntry.tempoWorklogId,
        });
      }
      // Mark other Tempo worklogs for same issue+date
      for (const wl of tempoMatches) {
        accountedTempoIds.add(wl.tempoWorklogId);
      }
    } else if (tempoMatches.length > 0) {
      // Not in push log but exists in Tempo — could be manual entry
      for (const wl of tempoMatches) accountedTempoIds.add(wl.tempoWorklogId);
      const existingTotal = tempoMatches.reduce((s, w) => s + w.timeSpentSeconds, 0);
      const diff = Math.abs(existingTotal - entry.totalSeconds);
      if (diff <= TEMPO_TOLERANCE_SECONDS) {
        plan.push({
          date: entry.date,
          task: entry.task,
          targetSeconds: entry.totalSeconds,
          action: 'skip',
          detail: `Exists in Tempo (${formatHours(existingTotal)})`,
          issueId: jira.issueId,
          extraWorklogIds: tempoMatches.map(w => w.tempoWorklogId),
        });
      } else {
        // Create new — Tempo already has something, but we don't own it
        plan.push({
          date: entry.date,
          task: entry.task,
          targetSeconds: entry.totalSeconds,
          action: 'create',
          detail: `Tempo has ${formatHours(existingTotal)}, adding ${formatHours(entry.totalSeconds)}`,
          issueId: jira.issueId,
          extraWorklogIds: tempoMatches.map(w => w.tempoWorklogId),
        });
      }
    } else {
      // Not in push log and not in Tempo — create
      plan.push({
        date: entry.date,
        task: entry.task,
        targetSeconds: entry.totalSeconds,
        action: 'create',
        detail: `New (${formatHours(entry.totalSeconds)})`,
        issueId: jira.issueId,
      });
    }
  }

  // Show Tempo-only entries (not in our report)
  for (const wl of tempoWorklogs) {
    if (accountedTempoIds.has(wl.tempoWorklogId)) continue;
    // Find task key for this issueId from jiraMap
    let taskKey = `issue:${wl.issueId}`;
    for (const [key, jira] of jiraMap) {
      if (jira.issueId === wl.issueId) {
        taskKey = key;
        break;
      }
    }
    plan.push({
      date: wl.startDate,
      task: taskKey,
      targetSeconds: wl.timeSpentSeconds,
      action: 'skip',
      detail: `Tempo only (${formatHours(wl.timeSpentSeconds)})`,
      existingWorklogId: wl.tempoWorklogId,
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
    const key = pushLogKey(entry.date, entry.task);

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
          });
          pushLog[key] = {
            tempoWorklogId: result.tempoWorklogId,
            timeSpentSeconds: entry.targetSeconds,
            pushedAt: new Date().toISOString(),
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
          });
          pushLog[key] = {
            tempoWorklogId: result.tempoWorklogId,
            timeSpentSeconds: entry.targetSeconds,
            pushedAt: new Date().toISOString(),
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
    return { dryRun: false, plan, result: { posted: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 } };
  }

  console.log(`Executing ${actionable.length} mutation(s)...`);
  const result = await executePlan(plan, tempoClient, accountId);

  // Mark daily logs as pushed
  markDaysPushed(from, to);

  return { dryRun: false, plan, result };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function formatHours(seconds: number): string {
  const hours = seconds / 3600;
  const rounded1 = parseFloat(hours.toFixed(1));
  if (Math.abs(hours - rounded1) < 0.01) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(2)}h`;
}
