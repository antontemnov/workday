#!/usr/bin/env node

/**
 * Timesheet generator from git reflog.
 *
 * Uses timeline-based algorithm: time = sum of intervals between events.
 * Checkout = task boundary. DayStart = assumed work start time.
 *
 * Usage:
 *   node timesheet.mjs [options]
 *
 * Options:
 *   --repos <paths>      Comma-separated repo paths (default: config)
 *   --month <1-12>       Month number (default: current month)
 *   --year <YYYY>        Year (default: current year)
 *   --day-start <HH:MM>  Assumed work start time (default: 13:00)
 *   --format <table|csv> Output format (default: table)
 *   --help               Show this help
 *
 * Examples:
 *   node timesheet.mjs
 *   node timesheet.mjs --month 1 --year 2026
 *   node timesheet.mjs --repos "D:/projects/atlas-frontend,D:/projects/appone-backend"
 *   node timesheet.mjs --day-start 11:00 --month 2
 *   node timesheet.mjs --format csv > february.csv
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveIssueIds } from './jira-client.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ─── Secrets ──────────────────────────────────────────────────────────────

function loadSecrets() {
  const p = join(SCRIPT_DIR, 'secrets.json');
  if (!existsSync(p)) throw new Error('secrets.json not found');
  return JSON.parse(readFileSync(p, 'utf-8'));
}

const SECRETS = loadSecrets();
const DEVELOPER = SECRETS.Developer; // branch ownership filter

// ─── Config ────────────────────────────────────────────────────────────────

const DEFAULT_REPOS = [
  'D:/projects/atlas-frontend',
  'D:/projects/appone-backend',
];

const TASK_PATTERN = /ATL-\d+/g;

const WEEKDAYS_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const MONTHS_RU = [
  '', 'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];

// Branches that never carry a task context
const GENERIC_BRANCHES = /^(develop|main|master|HEAD)$/;

// ─── CLI args ──────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    repos: DEFAULT_REPOS,
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    dayStart: '13:00',
    format: 'table',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--repos':
        opts.repos = args[++i].split(',').map(s => s.trim());
        break;
      case '--month':
        opts.month = parseInt(args[++i], 10);
        break;
      case '--year':
        opts.year = parseInt(args[++i], 10);
        break;
      case '--day-start':
        opts.dayStart = args[++i];
        break;
      case '--format':
        opts.format = args[++i];
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
    }
  }

  return opts;
}

function printUsage() {
  console.log(`Timesheet — git reflog time tracker (timeline model)

Usage:
  node timesheet.mjs [options]

Options:
  --repos <paths>      Comma-separated repo paths
  --month <1-12>       Month number (default: current)
  --year <YYYY>        Year (default: current)
  --day-start <HH:MM>  Assumed work start time (default: 13:00)
  --format <table|csv> Output format (default: table)
  --help               Show this help

Default repos:
${DEFAULT_REPOS.map(r => '  - ' + r).join('\n')}

Examples:
  node timesheet.mjs
  node timesheet.mjs --month 1 --year 2026
  node timesheet.mjs --day-start 11:00 --month 2
  node timesheet.mjs --format csv > february.csv`);
}

// ─── Helper functions ─────────────────────────────────────────────────────

/** Extract first ATL-XXXX from a commit message */
function extractTaskFromMessage(msg) {
  const m = msg.match(/ATL-\d+/);
  return m ? m[0] : null;
}

/** Extract target branch from checkout message ("moving from X to Y" → Y) */
function extractCheckoutTarget(msg) {
  const m = msg.match(/moving from \S+ to (\S+)/);
  return m ? m[1] : null;
}

/** Extract ATL-XXXX from own branch. Returns null for other developers' branches */
function extractTaskFromBranch(branch) {
  if (branch == null) return null;
  if (/^[0-9a-f]{7,40}$/.test(branch)) return null;
  if (GENERIC_BRANCHES.test(branch)) return null;
  // Only count branches that belong to this developer
  if (DEVELOPER && !branch.includes(DEVELOPER)) return null;
  const m = branch.match(/ATL-\d+/);
  return m ? m[0] : null;
}

/** Compute working date: if hour < 4, attribute to previous calendar day */
function computeWorkingDate(ts) {
  const d = new Date(ts);
  if (d.getHours() < 4) {
    d.setDate(d.getDate() - 1);
  }
  return formatLocalDate(d);
}

/** Format Date as "YYYY-MM-DD" using local timezone */
function formatLocalDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Parse "HH:MM" → minutes from midnight */
function parseDayStartTime(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ─── Git reflog ───────────────────────────────────────────────────────────

function getReflog(repoPath, sinceDate, untilDate) {
  if (!existsSync(repoPath)) {
    console.error(`WARNING: repo not found: ${repoPath}`);
    return '';
  }

  try {
    const cmd = `git -C "${repoPath}" reflog --date=iso --format="%gd %gs" --since="${sinceDate}" --until="${untilDate}"`;
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    console.error(`WARNING: git reflog failed for ${repoPath}: ${e.message}`);
    return '';
  }
}

/**
 * Parse raw reflog text into structured entries sorted ascending by time.
 * Classifies each entry: 'commit', 'checkout', or 'other'.
 */
function parseReflogEntries(text) {
  const entries = [];
  const lines = text.split('\n');

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const m = line.match(/HEAD@\{(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) [+-]\d{4}\}\s+(.*)/);
    if (!m) continue;

    const ts = Date.parse(`${m[1]}T${m[2]}`);
    const action = m[3];

    let type;
    if (action.startsWith('commit')) {
      type = 'commit';
    } else if (action.startsWith('checkout')) {
      type = 'checkout';
    } else {
      type = 'other';
    }

    entries.push({ ts, type, message: action, lineIndex });
  }

  // Ascending by time; for same-second ties, higher lineIndex first
  // (older reflog line = earlier chronological event)
  entries.sort((a, b) => a.ts - b.ts || b.lineIndex - a.lineIndex);
  return entries;
}

/**
 * Build a task-annotated timeline from parsed reflog entries.
 * Filters noise (rebase, reset, etc.), tracks current branch context.
 */
function buildTimeline(entries) {
  const timeline = [];
  let currentBranchTask = null;

  for (const entry of entries) {
    if (entry.type === 'other') continue;

    if (entry.type === 'checkout') {
      const target = extractCheckoutTarget(entry.message);
      const task = extractTaskFromBranch(target);
      currentBranchTask = task;
      timeline.push({ ts: entry.ts, task, type: 'checkout' });
    } else if (entry.type === 'commit') {
      const task = extractTaskFromMessage(entry.message) ?? currentBranchTask;
      timeline.push({ ts: entry.ts, task, type: 'commit' });
    }
  }

  return timeline;
}

/**
 * Core algorithm: compute minutes per (date, task) from timeline events.
 *
 * For each working day:
 *  - Skip days without any commits (only checkouts = no real work)
 *  - Prepend synthetic DAY_START if dayStart is before first event
 *  - Sum intervals: time between event[i] and event[i+1] → event[i].task
 *  - Skip intervals where task is null
 */
function computeHours(timeline, dayStartMin, year, month) {
  const minutesMap = new Map();

  // Group events by working date
  const byDay = new Map();
  for (const event of timeline) {
    const wd = computeWorkingDate(event.ts);
    if (!byDay.has(wd)) byDay.set(wd, []);
    byDay.get(wd).push(event);
  }

  const targetPrefix = `${year}-${String(month).padStart(2, '0')}`;

  for (const [date, events] of byDay) {
    if (!date.startsWith(targetPrefix)) continue;

    // Skip days without any commits — only checkouts means no real work
    if (!events.some(e => e.type === 'commit')) continue;

    // Determine task for synthetic DAY_START (prefer first commit's task)
    const firstCommit = events.find(e => e.type === 'commit');
    const dayStartTask = firstCommit?.task ?? events[0].task;

    // Synthetic DAY_START: timestamp at dayStartMin on this working date
    const syntheticTs = new Date(date + 'T00:00:00').getTime() + dayStartMin * 60000;

    if (syntheticTs < events[0].ts && dayStartTask != null) {
      events.unshift({ ts: syntheticTs, task: dayStartTask, type: 'day_start' });
    }

    // Sum intervals between consecutive events
    for (let i = 0; i < events.length - 1; i++) {
      const current = events[i];
      const next = events[i + 1];
      const minutes = (next.ts - current.ts) / 60000;

      if (current.task == null) continue;
      if (minutes <= 0) continue;

      const key = `${date}|${current.task}`;
      minutesMap.set(key, (minutesMap.get(key) || 0) + minutes);
    }
  }

  return minutesMap;
}

// ─── Output formatters ────────────────────────────────────────────────────

// Column layout constants
const COL_DATE = 12;  // "2026-02-02  "
const COL_DAY  = 6;   // "Пн    "
const COL_TASK = 12;  // "ATL-6466    "
const COL_HRS  = 8;   // "  12.5h"
const TABLE_W  = COL_DATE + COL_DAY + COL_TASK + COL_HRS;
const SEPARATOR = '─'.repeat(TABLE_W);
const THIN_SEP  = '· '.repeat(Math.ceil(TABLE_W / 2)).slice(0, TABLE_W);

function fmtRow(date, day, task, hours) {
  return date.padEnd(COL_DATE)
    + day.padEnd(COL_DAY)
    + task.padEnd(COL_TASK)
    + hours.padStart(COL_HRS);
}

function formatTable(byDate, taskTotals, totalHours, opts, summaries = new Map()) {
  const lines = [];
  const out = (s = '') => lines.push(s);

  out(`Timesheet: ${MONTHS_RU[opts.month]} ${opts.year}`);
  out(`Repos: ${opts.repos.map(r => basename(r)).join(', ')}`);
  out('');
  out(fmtRow('Дата', 'День', 'Задача', 'Часы'));
  out(SEPARATOR);

  const dates = [...byDate.keys()].sort();
  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    const dt = new Date(date + 'T12:00:00');
    const dayName = WEEKDAYS_RU[dt.getDay()];
    const tasks = byDate.get(date).sort((a, b) => b.hours - a.hours);
    let dayTotal = 0;

    for (let i = 0; i < tasks.length; i++) {
      const { task, hours } = tasks[i];
      dayTotal += hours;
      const hStr = `${hours.toFixed(1)}h`;
      out(i === 0
        ? fmtRow(date, dayName, task, hStr)
        : fmtRow('', '', task, hStr));
    }

    if (tasks.length > 1) {
      out(fmtRow('', '', '── итого', `${dayTotal.toFixed(1)}h`));
    }

    // Day separator (except after last day)
    if (di < dates.length - 1) {
      out(THIN_SEP);
    }
  }

  out(SEPARATOR);
  out(fmtRow('', '', 'ИТОГО', `${totalHours.toFixed(1)}h`));

  const hasSummaries = summaries.size > 0;
  const COL_SUMMARY = 50;
  const SUMMARY_W = COL_TASK + COL_HRS + (hasSummaries ? 2 + COL_SUMMARY : 0);
  out('');
  out('Сводка по задачам:');
  const header = 'Задача'.padEnd(COL_TASK) + 'Часов'.padStart(COL_HRS);
  out(hasSummaries ? header + '  Описание' : header);
  out('─'.repeat(SUMMARY_W));
  for (const [task, hours] of taskTotals) {
    const line = task.padEnd(COL_TASK) + `${hours.toFixed(1)}h`.padStart(COL_HRS);
    const summary = summaries.get(task)?.summary;
    out(summary ? line + '  ' + summary : line);
  }

  return lines.join('\n');
}

function formatCsv(byDate, taskTotals, totalHours, opts) {
  const lines = ['Date,Day,Task,Hours'];
  const dates = [...byDate.keys()].sort();
  for (const date of dates) {
    const dt = new Date(date + 'T12:00:00');
    const dayName = WEEKDAYS_RU[dt.getDay()];
    const tasks = byDate.get(date).sort((a, b) => b.hours - a.hours);
    for (const { task, hours } of tasks) {
      lines.push(`${date},${dayName},${task},${hours.toFixed(1)}`);
    }
  }
  return lines.join('\n');
}

// ─── Data builder (reusable) ──────────────────────────────────────────────

/**
 * Build timesheet data from git reflog using timeline-based algorithm.
 *
 * Pipeline per repo: getReflog → parseReflogEntries → buildTimeline → computeHours
 * Then merge all repos, round to 0.5h, compute totals.
 *
 * @param {Object} opts - { repos, month, year, dayStart }
 * @returns {{ results: Map<string, number>, byDate: Map<string, Array>, taskTotals: [string, number][], totalHours: number }}
 */
export function buildTimesheetData(opts) {
  const dayStartMin = parseDayStartTime(opts.dayStart);

  // Extended range: -1 day for branch context, +1 day for 00:00-03:59 events
  const sinceDate = new Date(opts.year, opts.month - 1, 0); // last day of prev month
  const sinceDateStr = formatLocalDate(sinceDate);

  const lastDay = new Date(opts.year, opts.month, 0).getDate();
  const untilDate = new Date(opts.year, opts.month - 1, lastDay + 2); // +1 day past end
  const untilDateStr = formatLocalDate(untilDate);

  // Build per-repo timelines (to correctly resolve branch context), then merge
  const mergedTimeline = [];

  for (const repo of opts.repos) {
    const text = getReflog(repo, sinceDateStr, untilDateStr);
    const entries = parseReflogEntries(text);
    const timeline = buildTimeline(entries);
    mergedTimeline.push(...timeline);
  }

  // Sort merged timeline chronologically
  mergedTimeline.sort((a, b) => a.ts - b.ts);

  // Compute hours from merged timeline (single DAY_START per day)
  const mergedMinutes = computeHours(mergedTimeline, dayStartMin, opts.year, opts.month);

  if (mergedMinutes.size === 0) {
    return { results: new Map(), byDate: new Map(), taskTotals: [], totalHours: 0 };
  }

  // Convert minutes → hours, round to 0.5h, minimum 0.5h
  const results = new Map();
  for (const [key, min] of mergedMinutes) {
    const hours = Math.max(Math.round((min / 60) * 2) / 2, 0.5);
    results.set(key, hours);
  }

  // Group by date
  const byDate = new Map();
  for (const [key, hours] of results) {
    const [date, task] = key.split('|');
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ task, hours });
  }

  // Task totals
  const taskTotalsMap = new Map();
  for (const [key, hours] of results) {
    const task = key.split('|')[1];
    taskTotalsMap.set(task, (taskTotalsMap.get(task) || 0) + hours);
  }
  const taskTotals = [...taskTotalsMap.entries()].sort((a, b) => b[1] - a[1]);
  const totalHours = taskTotals.reduce((sum, [, h]) => sum + h, 0);

  return { results, byDate, taskTotals, totalHours };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  const { byDate, taskTotals, totalHours } = buildTimesheetData(opts);

  if (totalHours === 0) {
    console.log(`No reflog activity found for ${MONTHS_RU[opts.month]} ${opts.year}`);
    process.exit(0);
  }

  // Resolve Jira summaries for all tasks
  const allTaskKeys = taskTotals.map(([task]) => task);
  let summaries = new Map();
  try {
    summaries = await resolveIssueIds(allTaskKeys);
  } catch (e) {
    console.error(`WARNING: Jira resolution failed: ${e.message}`);
  }

  // Format output
  const ext = opts.format === 'csv' ? 'csv' : 'txt';
  const content = opts.format === 'csv'
    ? formatCsv(byDate, taskTotals, totalHours, opts)
    : formatTable(byDate, taskTotals, totalHours, opts, summaries);

  // Print to console
  console.log(content);

  // Save to file next to the script
  const filename = `timesheet-${opts.year}-${String(opts.month).padStart(2, '0')}.${ext}`;
  const filepath = join(SCRIPT_DIR, filename);
  writeFileSync(filepath, content, 'utf-8');
  console.log(`\nSaved: ${filepath}`);
}

const isMain = process.argv[1]
  && resolve(process.argv[1]).replace(/\\/g, '/') === fileURLToPath(import.meta.url).replace(/\\/g, '/');

if (isMain) { await main(); }
