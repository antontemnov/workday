import { readFileSync } from 'node:fs';
import { loadConfig, loadSecrets } from '../core/config.js';
import { readDailyLog, writeDailyLog } from '../core/daily-log.js';
import { DayStatus, type AppConfig, type Secrets, type TaskDayReport, type PushPlanEntry, type PushResult, type PushResponse } from '../core/types.js';
import { buildReport, buildReportResponse, getDefaultFromDate, getDefaultToDate } from './report-builder.js';
import { getAccountId, resolveIssueIds } from './jira-client.js';
import { TempoClient } from './tempo-client.js';
import { invalidateApprovalCache, resolveMonthApproval } from './tempo-approvals.js';
import { loadPushLog, savePushLog, pushLogKey, loadTombstones, removeTombstonesByWorklogIds } from './push-log.js';
import { acquirePushLock } from './push-lock.js';
import { refreshSnapshotsInRange } from './tempo-snapshot.js';
import { buildPushPlan, formatHours } from './reconcile.js';

// ─── Push plan ───────────────────────────────────────────────────────────

// The diff engine lives in reconcile.ts; re-exported here for existing callers.
export { buildPushPlan };

// ─── Execute plan ────────────────────────────────────────────────────────

/** Execute mutations from the plan, update push log */
export async function executePlan(
  plan: readonly PushPlanEntry[],
  tempoClient: TempoClient,
  accountId: string,
): Promise<PushResult> {
  const pushLog = loadPushLog();
  const deletedWorklogIds = new Set<number>();
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

      case 'delete': {
        if (!entry.existingWorklogId) { failed++; break; }
        try {
          await tempoClient.deleteWorklog(entry.existingWorklogId);
          delete pushLog[key];                       // stray ownership, if any
          deletedWorklogIds.add(entry.existingWorklogId);
          deleted++;
          console.log(`  DEL  ${entry.date} ${entry.task} ${formatHours(entry.targetSeconds)}`);
        } catch (err) {
          failed++;
          console.error(`  FAIL DEL ${entry.date} ${entry.task}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'error':
        failed++;
        break;
    }
  }

  savePushLog(pushLog);
  if (deletedWorklogIds.size > 0) {
    removeTombstonesByWorklogIds(deletedWorklogIds);
  }
  return { posted, updated, deleted, skipped, failed };
}

// ─── Mark daily logs as pushed ───────────────────────────────────────────

/** Dates in [from, to] whose local day file exists — the stray-delete guard. */
function collectDatesWithData(from: string, to: string): Set<string> {
  const dates = new Set<string>();
  const current = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (current <= end) {
    const date = current.toISOString().slice(0, 10);
    if (readDailyLog(date)) dates.add(date);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

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
  // Overwrite Tempo-side edits (conflict entries). Without it a commit push
  // containing conflicts is refused so the caller can confirm the choice.
  readonly force?: boolean;
}

// A submitted timesheet is on the reviewer's desk — mutating worklogs under
// review (or after approval) is never what the user meant.
const APPROVAL_BLOCKED_STATUSES = new Set(['IN_REVIEW', 'APPROVED']);

function* monthsInRange(from: string, to: string): Generator<{ year: number; month: number }> {
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    yield { year, month };
    month++;
    if (month > 12) { month = 1; year++; }
  }
}

/** Refuse commit pushes into IN_REVIEW/APPROVED months. Unavailable approval
 *  (no scope, Tempo down) never blocks — the check is a live safety gate,
 *  not a dependency. */
async function assertRangePushable(from: string, to: string, secrets: Secrets): Promise<void> {
  for (const { year, month } of monthsInRange(from, to)) {
    const approval = await resolveMonthApproval(year, month, secrets, true);
    if (approval.available && approval.statusKey && APPROVAL_BLOCKED_STATUSES.has(approval.statusKey)) {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      throw new Error(`Timesheet ${key} is ${approval.statusKey} in Tempo — pushing is disabled until the reviewer releases it`);
    }
  }
}

/** Full push pipeline: build report → resolve Jira → fetch Tempo → plan → execute */
export async function runPush(options: RunPushOptions): Promise<PushResponse> {
  // Dry runs are read-only. Commit pushes take the cross-process lock, so a
  // second push cannot plan against the same pre-push Tempo state and create
  // every pending worklog twice.
  if (!options.commit) return runPushPipeline(options);
  const releaseLock = acquirePushLock('push');
  try {
    await assertRangePushable(options.from, options.to, options.secrets);
    return await runPushPipeline(options);
  } finally {
    releaseLock();
  }
}

async function runPushPipeline(options: RunPushOptions): Promise<PushResponse> {
  const { from, to, commit, config, secrets, filePath, force } = options;

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

  // Local deletions may still need Tempo-side propagation even when the
  // report is empty (a fully cleared pushed day, tombstoned entries).
  const pushLog = loadPushLog();
  const rangeTombstones = loadTombstones().filter(t => t.date >= from && t.date <= to);
  const hasRangeOwnership = Object.keys(pushLog).some(k => {
    const date = k.slice(0, 10);
    return date >= from && date <= to;
  });

  if (report.length === 0 && rangeTombstones.length === 0 && !hasRangeOwnership) {
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

  // Step 4: Build plan. Tombstones whose worklog is already gone from Tempo
  // (deleted remotely too) have nothing left to do — purge them silently.
  const aliveIds = new Set(tempoWorklogs.map(w => w.tempoWorklogId));
  const deadTombstones = rangeTombstones.filter(t => !aliveIds.has(t.tempoWorklogId));
  if (deadTombstones.length > 0) {
    removeTombstonesByWorklogIds(new Set(deadTombstones.map(t => t.tempoWorklogId)));
  }

  const plan = buildPushPlan(report, jiraMap, pushLog, tempoWorklogs, {
    tombstones: rangeTombstones.filter(t => aliveIds.has(t.tempoWorklogId)),
    from,
    to,
    datesWithData: collectDatesWithData(from, to),
  });

  if (!commit) {
    return { dryRun: true, plan };
  }

  // Conflict gate: "local wins" is a choice, not a default. A commit push
  // that would overwrite Tempo-side edits stops here until the caller
  // explicitly forces it — nothing (conflicted or not) is executed.
  if (!force) {
    const conflicted = plan.filter(e => e.conflict);
    if (conflicted.length > 0) {
      console.log(`Push blocked: ${conflicted.length} worklog(s) edited in Tempo since our push.`);
      return { dryRun: false, plan, blockedByConflicts: true };
    }
  }

  // Step 5: Execute
  const actionable = plan.filter(e => e.action === 'create' || e.action === 'update' || e.action === 'delete');
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

  // Tempo-side state changed: approval cache is stale; worklog snapshots are
  // refetched right away so month statuses turn diff-based after every push.
  if (result.posted > 0 || result.updated > 0 || result.deleted > 0) {
    invalidateApprovalCache();
    await refreshSnapshotsInRange(from, to, secrets, accountId);
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

