#!/usr/bin/env node

/**
 * Tempo Push — post timesheet worklogs to Tempo.
 *
 * DRY RUN by default. Use --commit to actually send data.
 *
 * Usage:
 *   node tempo-push.mjs [--month N] [--year YYYY] [--commit]
 *
 * Options:
 *   --month <1-12>   Month number (default: current)
 *   --year <YYYY>    Year (default: current)
 *   --commit         Actually post to Tempo (default: dry run)
 */

import { buildTimesheetData } from './timesheet.mjs';
import { resolveIssueIds, getMyAccountId } from './jira-client.mjs';
import { getUserWorklogs, createWorklog } from './tempo-client.mjs';

// ─── CLI args ─────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    // Timesheet defaults (same as timesheet.mjs)
    repos: [
      'D:/projects/atlas-frontend',
      'D:/projects/appone-backend',
    ],
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    dayStart: '13:00',
    // Push-specific
    commit: false,
    date: null, // optional: filter to single date "YYYY-MM-DD"
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--month':
        opts.month = parseInt(args[++i], 10);
        break;
      case '--year':
        opts.year = parseInt(args[++i], 10);
        break;
      case '--day-start':
        opts.dayStart = args[++i];
        break;
      case '--date':
        opts.date = args[++i];
        break;
      case '--commit':
        opts.commit = true;
        break;
      case '--help':
      case '-h':
        console.log(`Tempo Push — post timesheet worklogs to Tempo

Usage:
  node tempo-push.mjs [--month N] [--year YYYY] [--date YYYY-MM-DD] [--commit]

Options:
  --month <1-12>       Month number (default: current)
  --year <YYYY>        Year (default: current)
  --day-start <HH:MM>  Assumed work start time (default: 13:00)
  --date <YYYY-MM-DD>  Push only a single date (default: all)
  --commit             Actually post to Tempo (default: dry run)`);
        process.exit(0);
    }
  }

  return opts;
}

// ─── Table formatting ─────────────────────────────────────────────────────

const COL_DATE   = 12;
const COL_TASK   = 14;
const COL_HOURS  = 8;
const COL_STATUS = 42;
const TABLE_W    = COL_DATE + COL_TASK + COL_HOURS + COL_STATUS;

function fmtRow(date, task, hours, status) {
  return date.padEnd(COL_DATE)
    + task.padEnd(COL_TASK)
    + hours.padStart(COL_HOURS)
    + '   ' + status;
}

// ─── Deduplication ────────────────────────────────────────────────────────

const TOLERANCE_SECONDS = 60;

function buildDeduplicationKey(startDate, issueId) {
  return `${startDate}|${issueId}`;
}

// ─── Main flow ────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const monthStr = String(opts.month).padStart(2, '0');

  console.log(`Tempo Push: ${opts.year}-${monthStr}`);
  if (!opts.commit) {
    console.log('DRY RUN mode — use --commit to actually post\n');
  } else {
    console.log('COMMIT mode — will post to Tempo\n');
  }

  // Step 1: Build timesheet from git reflog
  console.log('Step 1/4: Building timesheet from git reflog...');
  const { results, taskTotals, totalHours } = buildTimesheetData(opts);

  if (totalHours === 0) {
    console.log('  No reflog activity found. Nothing to push.');
    return;
  }

  const uniqueTasks = new Set();
  for (const [key] of results) {
    uniqueTasks.add(key.split('|')[1]);
  }
  console.log(`  Found ${results.size} entries across ${uniqueTasks.size} tasks`);

  // Step 2: Resolve Jira issue IDs
  console.log('Step 2/4: Resolving Jira issue IDs...');
  const allTaskKeys = [...uniqueTasks];
  const jiraData = await resolveIssueIds(allTaskKeys);

  let unresolvedCount = 0;
  for (const key of allTaskKeys) {
    if (!jiraData.has(key)) unresolvedCount++;
  }
  if (unresolvedCount > 0) {
    console.log(`  WARNING: ${unresolvedCount} task(s) could not be resolved in Jira`);
  }

  // Step 3: Fetch existing Tempo worklogs
  console.log('Step 3/4: Fetching existing Tempo worklogs...');
  const accountId = await getMyAccountId();
  console.log(`  Account ID: ${accountId}`);

  const fromDate = `${opts.year}-${monthStr}-01`;
  const lastDay = new Date(opts.year, opts.month, 0).getDate();
  const toDate = `${opts.year}-${monthStr}-${String(lastDay).padStart(2, '0')}`;

  const existingWorklogs = await getUserWorklogs(accountId, fromDate, toDate);
  console.log(`  Found ${existingWorklogs.length} existing worklog(s) in Tempo`);

  // Build lookup map: (startDate, issueId) -> worklog
  const existingMap = new Map();
  for (const wl of existingWorklogs) {
    const key = buildDeduplicationKey(wl.startDate, String(wl.issueId));
    existingMap.set(key, wl);
  }

  // Step 4: Plan & execute
  console.log('Step 4/4: Planning...\n');

  console.log(fmtRow('DATE', 'TASK', 'HOURS', 'STATUS'));
  console.log('─'.repeat(TABLE_W));

  const plan = []; // entries to post
  let skipCount = 0;
  let topUpCount = 0;
  let tempoHigherCount = 0;
  let errorCount = 0;

  // Sort entries by date, then by task
  const sortedEntries = [...results.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [key, hours] of sortedEntries) {
    const [date, taskKey] = key.split('|');

    // Single-date filter
    if (opts.date != null && date !== opts.date) continue;

    const hoursStr = `${hours.toFixed(1)}h`;
    const issueData = jiraData.get(taskKey);

    if (issueData == null) {
      console.log(fmtRow(date, taskKey, hoursStr, 'ERROR (unresolved in Jira)'));
      errorCount++;
      continue;
    }

    const issueId = String(issueData.issueId);
    const dedupKey = buildDeduplicationKey(date, issueId);
    const existing = existingMap.get(dedupKey);

    if (existing == null) {
      // No existing worklog — will post full hours
      console.log(fmtRow(date, taskKey, hoursStr, 'WILL POST'));
      plan.push({ date, taskKey, issueId, hours, timeSpentSeconds: hours * 3600 });
    } else {
      const existingSeconds = existing.timeSpentSeconds;
      const gitSeconds = hours * 3600;
      const diffSeconds = Math.abs(existingSeconds - gitSeconds);

      if (diffSeconds <= TOLERANCE_SECONDS) {
        // Hours match within tolerance — nothing to do
        console.log(fmtRow(date, taskKey, hoursStr, 'skip (exists)'));
        skipCount++;
      } else if (gitSeconds > existingSeconds) {
        // Git has more hours — post the difference as a new entry
        const topUpSeconds = gitSeconds - existingSeconds;
        const topUpHours = topUpSeconds / 3600;
        const existingHours = existingSeconds / 3600;
        const detail = `[Tempo: ${existingHours.toFixed(1)}h + ${topUpHours.toFixed(1)}h = ${hours.toFixed(1)}h]`;
        console.log(fmtRow(date, taskKey, `+${topUpHours.toFixed(1)}h`, `TOP-UP  ${detail}`));
        plan.push({
          date, taskKey, issueId,
          hours: topUpHours,
          timeSpentSeconds: topUpSeconds,
          description: `Top-up: git ${hours.toFixed(1)}h - Tempo ${existingHours.toFixed(1)}h`,
        });
        topUpCount++;
      } else {
        // Tempo has more hours — Tempo wins, skip
        const existingHours = existingSeconds / 3600;
        const detail = `[Tempo: ${existingHours.toFixed(1)}h >= git: ${hours.toFixed(1)}h]`;
        console.log(fmtRow(date, taskKey, hoursStr, `skip (Tempo >= git)  ${detail}`));
        tempoHigherCount++;
      }
    }
  }

  console.log('─'.repeat(TABLE_W));
  const stats = [`New: ${plan.length - topUpCount}`, `Top-up: ${topUpCount}`, `Skip: ${skipCount}`, `Tempo>=git: ${tempoHigherCount}`, `Error: ${errorCount}`];
  console.log(stats.join('  |  ') + '\n');

  if (plan.length === 0) {
    console.log('Nothing to post.');
    return;
  }

  if (!opts.commit) {
    console.log(`Would post ${plan.length} worklog(s). Run with --commit to proceed.`);
    return;
  }

  // Execute: post worklogs
  console.log(`Posting ${plan.length} worklog(s) to Tempo...`);
  let posted = 0;
  let failed = 0;

  for (const entry of plan) {
    try {
      await createWorklog({
        issueId: entry.issueId,
        authorAccountId: accountId,
        timeSpentSeconds: entry.timeSpentSeconds,
        startDate: entry.date,
        description: entry.description,
      });
      posted++;
      process.stdout.write(`  Posted ${posted}/${plan.length}: ${entry.date} ${entry.taskKey} ${entry.hours.toFixed(1)}h\n`);
    } catch (e) {
      failed++;
      console.error(`  FAILED ${entry.date} ${entry.taskKey}: ${e.message}`);
    }
  }

  console.log(`\nDone. Posted: ${posted}, Failed: ${failed}`);
}

await main();
