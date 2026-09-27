import { readFileSync, unlinkSync } from 'node:fs';
import { readDailyLog, writeDailyLog } from '../core/daily-log.js';
import { DayStatus, type AdoptedEntry, type AppConfig, type Secrets, type TaskDayReport, type PushFailure, type PushLogEntry, type PushPlanEntry, type PushResult, type PushResponse, type TempoMonthSnapshot, type TempoWorklog } from '../core/types.js';
import { buildReport, getDefaultToDate } from './report-builder.js';
import { getAccountId, resolveIssueIds } from './jira-client.js';
import { TempoClient, tempoRefusalReason } from './tempo-client.js';
import { invalidateApprovalCache, resolveMonthApproval } from './tempo-approvals.js';
import { loadPushLog, savePushLog, pushLogKey, loadTombstones, removeTombstonesByWorklogIds } from './push-log.js';
import { acquirePushLock } from './push-lock.js';
import { fetchMonthSnapshot, getSnapshotPath } from './tempo-snapshot.js';
import { applyMonthSync, readMonthModel, type LiveToday } from './tempo-sync.js';
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
): Promise<PushResult & { readonly failures: readonly PushFailure[] }> {
  // Push-log deltas (null = drop key), applied to a fresh read right before
  // the final save. Holding a full copy across the Tempo calls and saving it
  // whole would resurrect keys dropped by a concurrent recordEntryDeletion —
  // entry deletes run outside the push lock.
  const pushLogDeltas = new Map<string, PushLogEntry | null>();
  const deletedWorklogIds = new Set<number>();
  const failures: PushFailure[] = [];
  let posted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;
  let failed = 0;

  const fail = (entry: PushPlanEntry, reason: string): void => {
    failed++;
    failures.push({
      date: entry.date, task: entry.task, kind: entry.kind,
      ...(entry.entryId !== undefined ? { entryId: entry.entryId } : {}),
      action: entry.action, reason,
    });
  };

  for (const entry of plan) {
    const key = pushLogKey(entry.date, entry.task, entry.kind === 'manual' ? entry.entryId : undefined);

    switch (entry.action) {
      case 'skip':
        skipped++;
        break;

      case 'create': {
        if (!entry.issueId) { fail(entry, 'Unresolved in Jira'); break; }
        try {
          const result = await tempoClient.createWorklog({
            issueId: entry.issueId,
            authorAccountId: accountId,
            timeSpentSeconds: entry.targetSeconds,
            startDate: entry.date,
            description: entry.description,
            activity: entry.activity,
          });
          pushLogDeltas.set(key, {
            tempoWorklogId: result.tempoWorklogId,
            timeSpentSeconds: entry.targetSeconds,
            pushedAt: new Date().toISOString(),
            description: entry.description,
            activity: entry.activity,
          });
          posted++;
          console.log(`  POST ${entry.date} ${entry.task} ${formatHours(entry.targetSeconds)}`);
        } catch (err) {
          fail(entry, tempoRefusalReason(err));
          console.error(`  FAIL POST ${entry.date} ${entry.task}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'update': {
        if (!entry.issueId || !entry.existingWorklogId) { fail(entry, 'Unresolved in Jira'); break; }
        try {
          const result = await tempoClient.updateWorklog(entry.existingWorklogId, {
            issueId: entry.issueId,
            authorAccountId: accountId,
            timeSpentSeconds: entry.targetSeconds,
            startDate: entry.date,
            description: entry.description,
            activity: entry.activity,
          });
          pushLogDeltas.set(key, {
            tempoWorklogId: result.tempoWorklogId,
            timeSpentSeconds: entry.targetSeconds,
            pushedAt: new Date().toISOString(),
            description: entry.description,
            activity: entry.activity,
          });
          updated++;
          console.log(`  PUT  ${entry.date} ${entry.task} ${entry.detail}`);
        } catch (err) {
          fail(entry, tempoRefusalReason(err));
          console.error(`  FAIL PUT ${entry.date} ${entry.task}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'delete': {
        if (!entry.existingWorklogId) { fail(entry, 'No worklog to delete'); break; }
        try {
          await tempoClient.deleteWorklog(entry.existingWorklogId);
          pushLogDeltas.set(key, null);              // stray ownership, if any
          deletedWorklogIds.add(entry.existingWorklogId);
          deleted++;
          console.log(`  DEL  ${entry.date} ${entry.task} ${formatHours(entry.targetSeconds)}`);
        } catch (err) {
          fail(entry, tempoRefusalReason(err));
          console.error(`  FAIL DEL ${entry.date} ${entry.task}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case 'error':
        fail(entry, entry.detail);
        break;
    }
  }

  // A key tombstoned mid-push was deleted locally while we were pushing it —
  // re-adding ownership would let the stray pass claim the worklog and block
  // the tombstone's delete forever once the day file is gone.
  const pushLog = loadPushLog();
  const tombstonedKeys = new Set(loadTombstones().map(t => pushLogKey(t.date, t.task, t.entryId)));
  for (const [key, entry] of pushLogDeltas) {
    if (entry === null) delete pushLog[key];
    else if (!tombstonedKeys.has(key)) pushLog[key] = entry;
  }
  savePushLog(pushLog);
  if (deletedWorklogIds.size > 0) {
    removeTombstonesByWorklogIds(deletedWorklogIds);
  }
  return { posted, updated, deleted, skipped, failed, failures };
}

// ─── Mark daily logs as pushed ───────────────────────────────────────────

function* datesInRange(from: string, to: string): Generator<string> {
  const current = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (current <= end) {
    yield current.toISOString().slice(0, 10);
    current.setUTCDate(current.getUTCDate() + 1);
  }
}

/** Dates in [from, to] whose local day file exists — the stray-delete guard. */
function collectDatesWithData(from: string, to: string): Set<string> {
  const dates = new Set<string>();
  for (const date of datesInRange(from, to)) {
    if (readDailyLog(date)) dates.add(date);
  }
  return dates;
}

/** Seal the range's days as pushed — all but the ones whose worklogs did not go. */
export function markDaysPushed(from: string, to: string, except: ReadonlySet<string> = new Set()): void {
  for (const date of datesInRange(from, to)) {
    if (except.has(date)) continue;
    const log = readDailyLog(date);
    if (log && log.status !== DayStatus.Pushed) {
      log.status = DayStatus.Pushed;
      log.pushedAt = new Date().toISOString();
      writeDailyLog(log);
    }
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
  // The working date: adoption stops there. Defaults to the calendar today.
  readonly today?: string;
  // Today's log writer (the live tracker) — without it today is not adopted.
  readonly live?: LiveToday | null;
  // Stop tracking & push: runs once the read passed the gates, before the
  // report is built — the push then carries today whole.
  readonly stopTracking?: () => Promise<void>;
}

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

/** Refuse commit pushes into any month that is not OPEN in Tempo — nothing
 *  can change there, here or in Tempo. Unavailable approval (no scope, Tempo
 *  down) never blocks — the check is a live safety gate, not a dependency. */
async function assertRangePushable(from: string, to: string, secrets: Secrets): Promise<void> {
  for (const { year, month } of monthsInRange(from, to)) {
    const approval = await resolveMonthApproval(year, month, secrets, true);
    if (approval.available && approval.statusKey && approval.statusKey !== 'OPEN') {
      const key = `${year}-${String(month).padStart(2, '0')}`;
      throw new Error(`Timesheet ${key} is ${approval.statusKey} in Tempo — a month that is not open is left alone`);
    }
  }
}

/** Full push pipeline: build report → resolve Jira → fetch Tempo → plan → execute */
export async function runPush(options: RunPushOptions): Promise<PushResponse> {
  // Dry runs are read-only. Commit pushes take the cross-process lock, so a
  // second push cannot plan against the same pre-push Tempo state and create
  // every pending worklog twice.
  if (!options.commit) {
    const accountId = await accountIdOf(options.secrets);
    const tempoWorklogs = await new TempoClient(options.secrets.Tempo_Token).getUserWorklogs(accountId, options.from, options.to);
    return { dryRun: true, plan: await planRange(options, tempoWorklogs) };
  }
  const releaseLock = acquirePushLock('push');
  try {
    await assertRangePushable(options.from, options.to, options.secrets);
    return await runCommitPush(options);
  } finally {
    releaseLock();
  }
}

async function accountIdOf(secrets: Secrets): Promise<string> {
  try {
    return await getAccountId(secrets);
  } catch (err) {
    throw new Error(`Jira auth failed (check secrets.json): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The desired report (disk or file) against the given Tempo worklogs. */
async function planRange(options: RunPushOptions, tempoWorklogs: readonly TempoWorklog[]): Promise<PushPlanEntry[]> {
  const { from, to, config, secrets, filePath } = options;

  let report: TaskDayReport[];
  if (filePath) {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as { entries: TaskDayReport[] };
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
  if (report.length === 0 && rangeTombstones.length === 0 && !hasRangeOwnership) return [];

  const uniqueTasks = [...new Set(report.map(e => e.task))];
  console.log(`Resolving ${uniqueTasks.length} Jira issue(s)...`);
  const jiraMap = await resolveIssueIds(uniqueTasks, secrets);

  // Tombstones whose worklog is already gone from Tempo (deleted remotely
  // too) have nothing left to do — purge them silently.
  const aliveIds = new Set(tempoWorklogs.map(w => w.tempoWorklogId));
  const deadTombstones = rangeTombstones.filter(t => !aliveIds.has(t.tempoWorklogId));
  if (deadTombstones.length > 0) {
    removeTombstonesByWorklogIds(new Set(deadTombstones.map(t => t.tempoWorklogId)));
  }

  return buildPushPlan(report, jiraMap, pushLog, tempoWorklogs, {
    tombstones: rangeTombstones.filter(t => aliveIds.has(t.tempoWorklogId)),
    from,
    to,
    datesWithData: collectDatesWithData(from, to),
  });
}

/** Read Tempo for every month of the range and sync the mirror with it. */
async function syncRange(options: RunPushOptions, accountId: string): Promise<{ snapshots: TempoMonthSnapshot[]; adopted: AdoptedEntry[] }> {
  const { config, secrets } = options;
  const today = options.today ?? getDefaultToDate(config);
  const snapshots: TempoMonthSnapshot[] = [];
  const adopted: AdoptedEntry[] = [];
  for (const { year, month } of monthsInRange(options.from, options.to)) {
    const snapshot = await fetchMonthSnapshot(year, month, secrets, accountId);
    adopted.push(...applyMonthSync(snapshot, { config, today, live: options.live ?? null }).adopted);
    snapshots.push(snapshot);
  }
  return { snapshots, adopted };
}

function conflictsInRange(snapshots: readonly TempoMonthSnapshot[], options: RunPushOptions): number {
  let count = 0;
  for (const snapshot of snapshots) {
    for (const [date, day] of readMonthModel(snapshot, options.config).days) {
      if (date >= options.from && date <= options.to) count += day.conflicts.length;
    }
  }
  return count;
}

async function runCommitPush(options: RunPushOptions): Promise<PushResponse> {
  const { from, to, secrets, force } = options;
  const accountId = await accountIdOf(secrets);
  console.log(`Account: ${accountId}`);

  // Never blind: the push reads Tempo first — a sync. Worklogs created there
  // without us are adopted and shown before anything is sent.
  console.log(`Reading Tempo (${from} → ${to})...`);
  const { snapshots, adopted } = await syncRange(options, accountId);
  if (adopted.length > 0) {
    console.log(`Push stopped: ${adopted.length} worklog(s) created in Tempo were adopted — look at them first.`);
    return { dryRun: false, plan: [], adopted, blockedByAdoption: true };
  }

  const inRange = (): TempoWorklog[] => snapshots.flatMap(s => s.worklogs).filter(w => w.startDate >= from && w.startDate <= to);
  let plan = await planRange(options, inRange());

  // Conflict gate: "local wins" is a choice, not a default. A commit push
  // that would overwrite Tempo-side edits stops here until the caller
  // explicitly forces it — nothing (conflicted or not) is executed.
  if (!force && (conflictsInRange(snapshots, options) > 0 || plan.some(e => e.conflict))) {
    console.log('Push blocked: manual entries were changed in Tempo — resolve the conflicts first.');
    return { dryRun: false, plan, blockedByConflicts: true };
  }

  if (options.stopTracking) {
    await options.stopTracking();
    plan = await planRange(options, inRange());
  }

  const actionable = plan.filter(e => e.action === 'create' || e.action === 'update' || e.action === 'delete');
  const errors = plan.filter(e => e.action === 'error');
  if (actionable.length === 0) {
    console.log('Nothing to push.');
    // Parity with Tempo is still a successful sync — seal the days, or an
    // edited-then-reverted day stays Outdated forever (no mutation ever
    // triggers the seal below). A plan error keeps its day open.
    const failed = new Set(errors.map(e => e.date));
    markDaysPushed(from, to, failed);
    const failures: PushFailure[] = errors.map(e => ({
      date: e.date, task: e.task, kind: e.kind,
      ...(e.entryId !== undefined ? { entryId: e.entryId } : {}),
      action: e.action, reason: e.detail,
    }));
    return {
      dryRun: false, plan,
      result: { posted: 0, updated: 0, deleted: 0, skipped: plan.length - errors.length, failed: errors.length },
      ...(failures.length > 0 ? { failures } : {}),
    };
  }

  console.log(`Executing ${actionable.length} mutation(s)...`);
  const { failures, ...result } = await executePlan(plan, new TempoClient(secrets.Tempo_Token), accountId);

  // Tempo changed: the approval cache is stale, and the month is read again —
  // a sync, so worklogs created there meanwhile are adopted (and reported).
  let adoptedAfter: AdoptedEntry[] = [];
  if (result.posted > 0 || result.updated > 0 || result.deleted > 0) {
    invalidateApprovalCache();
    adoptedAfter = await resyncAfterPush(options, accountId);
  }

  // Each day seals on its own: a worklog Tempo refused keeps its day open,
  // the rest of the push stands.
  markDaysPushed(from, to, new Set(failures.map(f => f.date)));
  if (failures.length > 0) console.log(`Not sealing ${new Set(failures.map(f => f.date)).size} day(s): ${failures.length} worklog(s) did not go — re-run push.`);

  return {
    dryRun: false, plan, result,
    ...(failures.length > 0 ? { failures } : {}),
    ...(adoptedAfter.length > 0 ? { adopted: adoptedAfter } : {}),
  };
}

// A month that fails to read after the push drops its stale snapshot —
// it must never lie about the post-push state.
async function resyncAfterPush(options: RunPushOptions, accountId: string): Promise<AdoptedEntry[]> {
  const adopted: AdoptedEntry[] = [];
  const today = options.today ?? getDefaultToDate(options.config);
  for (const { year, month } of monthsInRange(options.from, options.to)) {
    try {
      const snapshot = await fetchMonthSnapshot(year, month, options.secrets, accountId);
      adopted.push(...applyMonthSync(snapshot, { config: options.config, today, live: options.live ?? null }).adopted);
    } catch {
      try { unlinkSync(getSnapshotPath(year, month)); } catch { /* absent is fine */ }
    }
  }
  return adopted;
}
