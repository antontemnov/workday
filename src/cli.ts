#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, tryLoadSecrets, getWorkdayHome, getPackageRoot, getDataDir, computeWorkingDate } from './core/config.js';
import { UpdateManager } from './core/update-manager.js';
import {
  CONFIG_FILE_NAME,
  SECRETS_FILE_NAME,
  DAEMON_SCRIPT_TS,
  DAEMON_SCRIPT_JS,
  TEMPO_REPORT_DIR,
  DAEMON_START_MAX_ATTEMPTS,
  DAEMON_START_POLL_MS,
  MS_PER_MINUTE,
  DEFAULT_MANUAL_ACTIVITY,
} from './core/constants.js';
import { isEmptyDayLog } from './core/janitor.js';
import {
  readDailyLog,
  writeDailyLog,
  deleteDailyLog,
  resolveSessionTarget,
  computeEffectiveDuration,
  computeTotalPauseDuration,
  computeTotalClaimedMs,
  computeActiveIntervals,
  computeDaySummary,
  resolveUiDayStart,
  computeTotalManualEntryMs,
} from './core/daily-log.js';
import { addEntryOnDate, editEntryOnDate, deleteEntryOnDate, deleteSessionOnDate, deleteTaskOnDate } from './core/day-edit.js';
import { loadFavorites, saveFavorites, addFavorite, removeFavorite } from './core/favorites.js';
import { isJiraConfigured, searchIssues, checkIssueExists } from './push/jira-client.js';
import { recordEntryDeletion } from './push/push-log.js';
import type {
  ApiResponse,
  StatusResponse,
  TodayResponse,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  SensitivityResponse,
  SessionDeleteResponse,
  TaskDeleteResponse,
  SessionDetail,
  SessionSummary,
  TaskDayReport,
  PushPlanEntry,
  ReportResponse,
  ManualEntry,
  ManualEntryResponse,
  ManualEntryDeleteResponse,
  ActivityTypesResponse,
  MonthResponse,
  TempoImportResponse,
  JiraProjectsResponse,
  SettingsResponse,
  NotificationsResponse,
  NotificationAckResponse,
  NotificationTestResponse,
  CalendarRefreshResponse,
  SuggestionsResponse,
  SuggestionAcceptResponse,
  SuggestionsMutedResponse,
  SuggestionUnmuteResponse,
  Suggestion,
} from './core/types.js';
import { SensitivityLevel, DayStatus, MonthDayStatus, SuggestionsDayState } from './core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── HTTP client helpers ────────────────────────────────────────────────

let cachedApiBaseUrl: string | null = null;

function getApiBaseUrl(): string {
  if (!cachedApiBaseUrl) {
    const config = loadConfig();
    cachedApiBaseUrl = `http://127.0.0.1:${config.apiPort}`;
  }
  return cachedApiBaseUrl;
}

async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const url = `${getApiBaseUrl()}${path}`;
  try {
    const res = await fetch(url);
    return await res.json() as ApiResponse<T>;
  } catch (err: unknown) {
    if (isConnectionRefused(err)) {
      return { ok: false, error: 'Daemon is not running.' };
    }
    throw err;
  }
}

async function apiPost<T>(path: string, body?: Record<string, unknown>): Promise<ApiResponse<T>> {
  const url = `${getApiBaseUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return await res.json() as ApiResponse<T>;
  } catch (err: unknown) {
    if (isConnectionRefused(err)) {
      return { ok: false, error: 'Daemon is not running.' };
    }
    throw err;
  }
}

function isConnectionRefused(err: unknown): boolean {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause: unknown }).cause;
    if (cause && typeof cause === 'object' && 'code' in cause) {
      const code = (cause as { code: string }).code;
      return code === 'ECONNREFUSED';
    }
  }
  return false;
}

// ─── Formatting helpers ─────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = totalMinutes / 60;
  return `${hours.toFixed(1)}h`;
}

/** Format seconds as hours with enough precision for quarter-hour values */
function formatReportHours(seconds: number): string {
  const hours = seconds / 3600;
  const rounded1 = parseFloat(hours.toFixed(1));
  if (Math.abs(hours - rounded1) < 0.01) return `${hours.toFixed(1)}h`;
  return `${hours.toFixed(2)}h`;
}

function formatSessionStatus(s: SessionSummary): string {
  const parts: string[] = [];
  if (s.isLeader) parts.push('LEADER');
  if (s.paused && s.pauseSource) parts.push(`PAUSED:${s.pauseSource}`);
  else if (s.paused) parts.push('PAUSED');
  parts.push(`SENS:${s.sensitivity}`);
  return parts.length > 0 ? ` [${parts.join(', ')}]` : '';
}

function printStatusData(data: StatusResponse): void {
  console.log(`Daemon running (PID ${data.pid})`);
  console.log(`  Date:   ${data.date}`);
  console.log(`  Uptime: ${formatDuration(data.uptime * 1000)}`);

  if (data.openSessions.length === 0) {
    console.log('  Sessions: none');
    return;
  }

  console.log(`  Sessions (${data.openSessions.length}):`);
  for (let i = 0; i < data.openSessions.length; i++) {
    const s = data.openSessions[i];
    const task = s.task ?? '—';
    const dur = formatDuration(s.effectiveDurationMs);
    const status = formatSessionStatus(s);
    const scoreStr = `score:${s.normalizedScore.toFixed(2)}`;
    console.log(`    #${i + 1} ${s.repo}  ${task}  ${s.branch}  ${s.state}  ${dur}  ${scoreStr}${status}`);
  }
}

function printTodayData(data: TodayResponse): void {
  console.log(`Date: ${data.date}  (${data.dayType})  Status: ${data.status}`);
  console.log(`Total: ${formatDuration(data.totalEffectiveMs)}  Signals: ${data.signalCount}`);
  console.log(`Claimed: ${formatDuration(data.claimedMs)}`);

  if (data.sessions.length === 0) {
    console.log('No sessions.');
  } else {
    console.log('');
    for (let i = 0; i < data.sessions.length; i++) {
      printSessionDetail(data.sessions[i], i + 1);
    }
  }

  if (data.manualEntries.length > 0) {
    console.log('');
    console.log('Manual entries:');
    printManualEntries(data.manualEntries);
  }
}

function printManualEntries(entries: readonly ManualEntry[]): void {
  if (entries.length === 0) { console.log('No manual entries.'); return; }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    console.log(`  #${i + 1} ${e.id}  ${e.task}  ${e.minutes}m  ${e.activity}  "${e.description}"`);
  }
}

function printSessionDetail(s: SessionDetail, index?: number): void {
  const task = s.task ?? '—';
  const dur = formatDuration(s.effectiveDurationMs);
  const status = s.closedBy ? `closed(${s.closedBy})` : (s.paused ? 'paused' : s.state);
  const ev = s.evidence;
  const added = ev.linesAdded ?? 0;
  const removed = ev.linesRemoved ?? 0;
  const files = ev.filesChanged ?? 0;

  const prefix = index !== undefined ? `#${index}` : s.id;
  console.log(`  [${prefix}] ${s.repo}  ${task}  ${dur}  ${status}`);
  console.log(`         branch: ${s.branch}  ${ev.commits} commits  +${added} -${removed}  ${files} files`);

  if (s.pauseCount > 0) {
    console.log(`         pauses: ${s.pauseCount} (${formatDuration(s.totalPauseDurationMs)} total)`);
  }
}

// ─── Command handlers ───────────────────────────────────────────────────

// ─── Auto-update ─────────────────────────────────────────────────────────

function getCurrentVersion(): string {
  const pkgPath = join(getPackageRoot(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

/**
 * Pre-spawn update: install (pinned) → verify → only then spawn. Runs only
 * when no daemon is alive — a running daemon owns its own update cycle.
 * Any failure falls through to starting the currently installed version.
 */
async function autoUpdate(): Promise<void> {
  try {
    const updater = new UpdateManager();
    const check = await updater.checkForUpdate();
    if (!check.updateAvailable) return;

    console.log(`Updating workday-daemon ${check.current} → ${check.latest}...`);
    await updater.installVersion(check.latest);
    console.log(`Updated to ${check.latest}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Update skipped (${message}) — starting installed version.`);
  }
}

// ─── Command handlers ───────────────────────────────────────────────────

async function handleStart(): Promise<void> {
  // Check if already running — never npm-install over a live daemon: the
  // old code would keep running while looking "updated". The daemon checks
  // for updates itself and restarts in a quiet window.
  const check = await apiGet<StatusResponse>('/api/status');
  if (check.ok) {
    console.log('Daemon is already running.');
    printStatusData(check.data!);
    return;
  }

  await autoUpdate();
  spawnBackground();

  // Poll for HTTP readiness
  const baseUrl = getApiBaseUrl();
  for (let i = 0; i < DAEMON_START_MAX_ATTEMPTS; i++) {
    await sleep(DAEMON_START_POLL_MS);
    try {
      const res = await fetch(`${baseUrl}/api/status`);
      if (res.ok) {
        const result = await res.json() as ApiResponse<StatusResponse>;
        if (result.ok && result.data) {
          printStatusData(result.data);
          return;
        }
      }
    } catch {
      // Not ready yet
    }
  }

  console.log('Daemon spawned but not responding yet. Check logs or try: workday status');
}

async function handleStop(): Promise<void> {
  const result = await apiPost<StopResponse>('/api/stop');
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  console.log(result.data!.message);
}

async function handleStatus(): Promise<void> {
  const result = await apiGet<StatusResponse>('/api/status');
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  printStatusData(result.data!);
}

async function handleToday(): Promise<void> {
  const result = await apiGet<TodayResponse>('/api/today');
  if (!result.ok) {
    console.log(result.error);
    return;
  }
  printTodayData(result.data!);
}

async function handlePause(args: string[]): Promise<void> {
  const repo = args[0];
  const body = repo ? { repo } : undefined;
  const result = await apiPost<PauseResponse>('/api/pause', body);
  if (!result.ok) {
    console.log(result.error);
    return;
  }

  const paused = result.data!.paused;
  if (paused.length === 0) {
    console.log('No sessions to pause.');
  } else {
    console.log(`Paused: ${paused.join(', ')}`);
  }
}

async function handleResume(): Promise<void> {
  const result = await apiPost<ResumeResponse>('/api/resume');
  if (!result.ok) {
    console.log(result.error);
    return;
  }

  const resumed = result.data!.resumed;
  if (resumed.length === 0) {
    console.log('No sessions to resume.');
  } else {
    console.log(`Resumed: ${resumed.join(', ')}`);
  }
}

async function handleSensitivity(args: string[]): Promise<void> {
  const level = args[0];
  const validLevels: readonly SensitivityLevel[] = [
    SensitivityLevel.Low,
    SensitivityLevel.Normal,
    SensitivityLevel.Patient,
    SensitivityLevel.AlwaysOn,
  ];
  if (!validLevels.includes(level as SensitivityLevel)) {
    console.log('Usage: workday sensitivity <low|normal|patient|always_on> [repo]');
    return;
  }
  const repo = args[1];
  const body: Record<string, unknown> = { level };
  if (repo) body.repo = repo;

  const result = await apiPost<SensitivityResponse>('/api/sensitivity', body);
  if (!result.ok) {
    console.log(result.error);
    return;
  }

  const target = result.data!.repo ?? 'global default';
  console.log(`Sensitivity for ${target}: ${result.data!.level}.`);
}

// ─── Session delete ───────────────────────────────────────────────────────

async function handleSessionDelete(args: string[]): Promise<void> {
  // workday session-delete <#index|id> [--date YYYY-MM-DD]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const target = cmdArgs[0];
  if (!target) {
    console.log('Usage: workday session-delete <#index|id> [--date YYYY-MM-DD]');
    return;
  }

  if (date) {
    handleSessionDeleteOffline(date, target);
    return;
  }

  const result = await apiPost<SessionDeleteResponse>('/api/session/delete', { target });
  if (!result.ok) { console.log(result.error); return; }
  const d = result.data!;
  console.log(`Deleted session ${d.id} — ${d.repo} (${d.task ?? '—'}), ${formatDuration(d.effectiveDurationMs)} observed`);
  if (d.dayFileDeleted) console.log('Day had no other facts — file removed.');
  if (d.dayWasPushed) console.log('Day was already pushed — run `workday tempo --push` to re-sync.');
}

function handleSessionDeleteOffline(date: string, target: string): void {
  try {
    const { deleted, dayFileDeleted, dayWasPushed } = deleteSessionOnDate(date, target);
    console.log(`Deleted session ${deleted.id} on ${date} — ${deleted.repo} (${deleted.task ?? '—'}), ${formatDuration(computeEffectiveDuration(deleted))} observed`);
    if (dayFileDeleted) console.log('Day had no other facts — file removed.');
    if (dayWasPushed) console.log('Day was already pushed — run `workday tempo --push` to re-sync.');
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

// ─── Task delete (whole tracked block) ────────────────────────────────────

async function handleTaskDelete(args: string[]): Promise<void> {
  // workday task-delete <KEY> [--date YYYY-MM-DD]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const task = cmdArgs[0];
  if (!task) {
    console.log('Usage: workday task-delete <KEY> [--date YYYY-MM-DD]');
    return;
  }

  if (date) {
    try {
      const { sessions, entries, dayFileDeleted, dayWasPushed } = deleteTaskOnDate(date, task);
      const observedMs = sessions.reduce((sum, s) => sum + computeEffectiveDuration(s), 0);
      console.log(`Deleted ${task} on ${date} — ${sessions.length} session(s) (${formatDuration(observedMs)} observed), ${entries.length} manual add(s)`);
      if (dayFileDeleted) console.log('Day had no other facts — file removed.');
      if (dayWasPushed) console.log('Day was already pushed — run `workday tempo --push` to re-sync.');
    } catch (err) {
      console.log(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  const result = await apiPost<TaskDeleteResponse>('/api/task/delete', { task });
  if (!result.ok) { console.log(result.error); return; }
  const d = result.data!;
  console.log(`Deleted ${d.task} — ${d.deletedSessions} session(s), ${d.deletedEntries} manual add(s), ${formatDuration(d.removedMs)} total`);
  if (d.dayFileDeleted) console.log('Day had no other facts — file removed.');
  if (d.dayWasPushed) console.log('Day was already pushed — run `workday tempo --push` to re-sync.');
}

// ─── Manual entries ──────────────────────────────────────────────────────

async function handleLog(args: string[]): Promise<void> {
  // workday log <task> <minutes> "<description>" [--activity <type>] [--date YYYY-MM-DD]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const actIdx = cmdArgs.indexOf('--activity');
  let activity = DEFAULT_MANUAL_ACTIVITY;
  if (actIdx !== -1) {
    activity = cmdArgs[actIdx + 1] ?? DEFAULT_MANUAL_ACTIVITY;
    cmdArgs = [...cmdArgs.slice(0, actIdx), ...cmdArgs.slice(actIdx + 2)];
  }

  const task = cmdArgs[0];
  const minutesStr = cmdArgs[1];
  // Description is optional syntactically; the core rejects an empty one
  // for every activity except Development.
  const description = cmdArgs.slice(2).join(' ');

  if (!task || !minutesStr) {
    console.log('Usage: workday log <task> <minutes> ["<description>"] [--activity <type>] [--date YYYY-MM-DD]');
    return;
  }
  const minutes = parseInt(minutesStr, 10);
  if (isNaN(minutes) || minutes <= 0) {
    console.log('Minutes must be a positive number');
    return;
  }

  if (date) {
    handleLogOffline(date, task, minutes, description, activity);
    return;
  }

  const result = await apiPost<ManualEntryResponse>('/api/manual-entry', { task, minutes, description, activity });
  if (!result.ok) { console.log(result.error); return; }
  const d = result.data!;
  console.log(`Logged ${d.task}: ${d.minutes}m ${d.activity} — "${d.description}"`);
  console.log(`Total manual: ${d.totalManualMinutes}m`);
}

function handleLogOffline(date: string, task: string, minutes: number, description: string, activity: string): void {
  const config = loadConfig();
  const today = computeWorkingDate(Date.now(), config.boundaryHour, config.timezone);
  if (date > today) {
    console.log(`Cannot log on a future date (${date} > ${today})`);
    return;
  }
  try {
    const { entry, log } = addEntryOnDate(date, { task, minutes, description, activity }, config);
    console.log(`Logged ${entry.task} on ${date}: ${entry.minutes}m ${entry.activity} — "${entry.description}"`);
    console.log(`Total manual: ${Math.round(computeTotalManualEntryMs(log) / MS_PER_MINUTE)}m`);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

async function handleLogEdit(args: string[]): Promise<void> {
  // workday log-edit <#index|id> [--minutes N] [--desc "..."] [--activity X] [--date D]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const target = cmdArgs[0];
  if (!target) {
    console.log('Usage: workday log-edit <#index|id> [--minutes N] [--desc "..."] [--activity X] [--date D]');
    return;
  }

  const patch: { minutes?: number; description?: string; activity?: string } = {};
  const minStr = parseArgValue(cmdArgs, '--minutes');
  if (minStr !== null) {
    const m = parseInt(minStr, 10);
    if (isNaN(m) || m <= 0) { console.log('Minutes must be positive'); return; }
    patch.minutes = m;
  }
  const desc = parseArgValue(cmdArgs, '--desc');
  if (desc !== null) patch.description = desc;
  const act = parseArgValue(cmdArgs, '--activity');
  if (act !== null) patch.activity = act;

  if (patch.minutes === undefined && patch.description === undefined && patch.activity === undefined) {
    console.log('Nothing to change. Provide --minutes, --desc, or --activity.');
    return;
  }

  if (date) {
    handleLogEditOffline(date, target, patch);
    return;
  }

  const result = await apiPost<ManualEntryResponse>('/api/manual-entry/update', { target, ...patch });
  if (!result.ok) { console.log(result.error); return; }
  const d = result.data!;
  console.log(`Updated ${d.task}: ${d.minutes}m ${d.activity} — "${d.description}"`);
  console.log(`Total manual: ${d.totalManualMinutes}m`);
}

function handleLogEditOffline(date: string, target: string, patch: { minutes?: number; description?: string; activity?: string }): void {
  try {
    const { entry } = editEntryOnDate(date, target, patch, loadConfig());
    console.log(`Updated ${entry.task} on ${date}: ${entry.minutes}m ${entry.activity} — "${entry.description}"`);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

async function handleLogDelete(args: string[]): Promise<void> {
  // workday log-delete <#index|id> [--date D]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const target = cmdArgs[0];
  if (!target) {
    console.log('Usage: workday log-delete <#index|id> [--date D]');
    return;
  }

  if (date) {
    handleLogDeleteOffline(date, target);
    return;
  }

  const result = await apiPost<ManualEntryDeleteResponse>('/api/manual-entry/delete', { target });
  if (!result.ok) { console.log(result.error); return; }
  const d = result.data!;
  console.log(`Deleted ${d.task}: ${d.minutes}m`);
  console.log(`Total manual: ${d.totalManualMinutes}m`);
}

function handleLogDeleteOffline(date: string, target: string): void {
  try {
    const { deleted, log, dayFileDeleted } = deleteEntryOnDate(date, target);
    recordEntryDeletion(date, deleted.task, deleted.id);
    console.log(`Deleted ${deleted.task} on ${date}: ${deleted.minutes}m`);
    if (dayFileDeleted) {
      console.log('Day had no other facts — file removed.');
      return;
    }
    console.log(`Total manual: ${Math.round(computeTotalManualEntryMs(log) / MS_PER_MINUTE)}m`);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

async function handleLogList(args: string[]): Promise<void> {
  const date = parseArgValue(args, '--date');
  let entries: readonly ManualEntry[] = [];
  if (date) {
    const log = readDailyLog(date);
    if (!log) { console.log(`No data for ${date}`); return; }
    entries = log.manualEntries ?? [];
  } else {
    const result = await apiGet<TodayResponse>('/api/today');
    if (!result.ok) { console.log(result.error); return; }
    entries = result.data!.manualEntries ?? [];
  }
  printManualEntries(entries);
}

// ─── Favorites (manual-entry templates) ───────────────────────────────────
// Direct file access on purpose: favorites.json is not daemon state (the
// daemon re-reads it per request), so these work with the daemon down too.

async function handleFavAdd(args: string[]): Promise<void> {
  // workday fav-add <task> <minutes> "<name>" [--activity <type>]
  const actIdx = args.indexOf('--activity');
  let activity = DEFAULT_MANUAL_ACTIVITY;
  let cmdArgs = args;
  if (actIdx !== -1) {
    activity = cmdArgs[actIdx + 1] ?? DEFAULT_MANUAL_ACTIVITY;
    cmdArgs = [...cmdArgs.slice(0, actIdx), ...cmdArgs.slice(actIdx + 2)];
  }

  const task = cmdArgs[0];
  const minutesStr = cmdArgs[1];
  const name = cmdArgs.slice(2).join(' ');

  if (!task || !minutesStr || !name) {
    console.log('Usage: workday fav-add <task> <minutes> "<name>" [--activity <type>]');
    return;
  }
  const minutes = parseInt(minutesStr, 10);
  if (isNaN(minutes) || minutes <= 0) {
    console.log('Minutes must be a positive number');
    return;
  }

  try {
    const favorites = loadFavorites();
    const added = addFavorite(favorites, { name, task, minutes, activity });
    // Existence gate, same soft rule as the daemon: 404 → reject,
    // unconfigured/unreachable → proceed (push re-validates).
    const secrets = tryLoadSecrets();
    if (secrets && isJiraConfigured(secrets)) {
      try {
        const issue = await checkIssueExists(added.task, secrets);
        if (!issue) {
          console.log(`${added.task} not found in Jira — favorite not added`);
          return;
        }
      } catch { /* Jira unreachable — skip the check */ }
    }
    saveFavorites(favorites);
    console.log(`Added favorite ${added.task}: ${added.minutes}m ${added.activity} — "${added.name}"`);
    console.log(`Favorites: ${favorites.length}`);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

async function handleJiraSearch(args: string[]): Promise<void> {
  const query = args.join(' ').trim();
  if (!query) {
    console.log('Usage: workday jira-search "<query>"');
    return;
  }

  const secrets = tryLoadSecrets();
  if (!secrets || !isJiraConfigured(secrets)) {
    console.log('Jira API is not configured — fill Jira_* fields in secrets.json');
    return;
  }

  try {
    const hits = await searchIssues(query, secrets, loadConfig().search.projectKeys);
    if (hits.length === 0) {
      console.log('No matches.');
      return;
    }
    for (const hit of hits) {
      console.log(`  ${hit.key.padEnd(12)} ${hit.summary}`);
    }
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

// workday projects [refresh | set <KEY...>]
// Manages the search-scope allow-list. Goes through the daemon so the running
// config stays consistent (list + cached catalog persisted together).
async function handleProjects(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'refresh') {
    const res = await apiPost<JiraProjectsResponse>('/api/jira/projects/refresh');
    if (!res.ok || !res.data) { console.log(res.error ?? 'Refresh failed.'); return; }
    console.log(`Fetched ${res.data.projects.length} projects from Jira.`);
    printProjects(res.data);
    return;
  }

  if (sub === 'set') {
    const keys = args.slice(1).map(k => k.toUpperCase());
    const res = await apiPost<SettingsResponse>('/api/settings', { config: { search: { projectKeys: keys } } });
    if (!res.ok || !res.data) { console.log(res.error ?? 'Update failed.'); return; }
    console.log(`Search scope set to: ${res.data.config.search.projectKeys.join(', ') || '(none — all projects)'}`);
    return;
  }

  const res = await apiGet<JiraProjectsResponse>('/api/jira/projects');
  if (!res.ok || !res.data) { console.log(res.error ?? 'Failed to load projects.'); return; }
  printProjects(res.data);
}

function printProjects(data: JiraProjectsResponse): void {
  const selected = new Set(data.selected.map(k => k.toUpperCase()));
  console.log(`Search scope (order = priority): ${data.selected.join(', ') || '(none — all projects)'}`);
  if (data.projects.length === 0) {
    console.log('Catalog is empty — run "workday projects refresh".');
    return;
  }
  console.log('Known projects:');
  for (const p of data.projects) {
    console.log(`  ${selected.has(p.key.toUpperCase()) ? '✓' : ' '} ${p.key.padEnd(10)} ${p.name}`);
  }
}

function handleFavRemove(args: string[]): void {
  const target = args[0];
  if (!target) {
    console.log('Usage: workday fav-remove <#index|id>');
    return;
  }
  try {
    const favorites = loadFavorites();
    const removed = removeFavorite(favorites, target);
    saveFavorites(favorites);
    console.log(`Removed favorite ${removed.task} — "${removed.name}"`);
    console.log(`Favorites: ${favorites.length}`);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

function handleFavList(): void {
  try {
    const favorites = loadFavorites();
    if (favorites.length === 0) { console.log('No favorites.'); return; }
    for (let i = 0; i < favorites.length; i++) {
      const f = favorites[i];
      console.log(`  #${i + 1} ${f.id}  ${f.task}  ${f.minutes}m  ${f.activity}  "${f.name}"`);
    }
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
  }
}

// workday activities [refresh | set <VALUE...>]
// Lists the Tempo _Activity_ catalog and manages the UI picker allow-list —
// the projects command's twin (catalog refresh + scope selection).
async function handleActivities(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'refresh') {
    const res = await apiPost<ActivityTypesResponse>('/api/activity-types/refresh');
    if (!res.ok || !res.data) { console.log(res.error ?? 'Refresh failed.'); return; }
    console.log(`Fetched ${res.data.activities.length} activity types from Tempo.`);
    printActivities(res.data);
    return;
  }

  if (sub === 'set') {
    const values = args.slice(1);
    const res = await apiPost<SettingsResponse>('/api/settings', { config: { activities: { values } } });
    if (!res.ok || !res.data) { console.log(res.error ?? 'Update failed.'); return; }
    console.log(`Activity scope set to: ${res.data.config.activities.values.join(', ') || '(none — all types)'}`);
    return;
  }

  const result = await apiGet<ActivityTypesResponse>('/api/activity-types');
  let data: ActivityTypesResponse;
  if (result.ok && result.data) {
    data = result.data;
  } else {
    // Daemon down — resolve directly from cache / Tempo.
    try {
      const { resolveActivityTypes } = await import('./push/activity-types.js');
      data = await resolveActivityTypes(loadSecrets());
    } catch (err) {
      console.log(result.error ?? (err instanceof Error ? err.message : String(err)));
      return;
    }
  }
  printActivities(data);
}

function printActivities(data: ActivityTypesResponse): void {
  const allowed = new Set(data.allowed ?? []);
  console.log(`Activity types (${data.key})${data.fromCache ? '' : '  [fallback — configure Tempo token for the live list]'}:`);
  if (allowed.size > 0) console.log(`UI picker scope: ${[...allowed].join(', ')}`);
  for (const a of data.activities) {
    console.log(`  ${allowed.size > 0 && allowed.has(a.value) ? '✓' : ' '} ${a.value.padEnd(30)} ${a.name}`);
  }
}

async function handleDay(args: string[]): Promise<void> {
  const date = args[0];
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.log('Usage: workday day YYYY-MM-DD');
    return;
  }

  // Try daemon first (it might be today)
  const result = await apiGet<TodayResponse>(`/api/day?date=${date}`);
  if (result.ok) {
    printTodayData(result.data!);
    return;
  }

  // Fallback: read from disk (daemon not running or past day)
  const config = loadConfig();
  const log = readDailyLog(date);
  if (!log) {
    console.log(`No data for ${date}`);
    return;
  }

  // Build a TodayResponse-like object from the raw log
  const sessions: SessionDetail[] = log.sessions.map(s => ({
    id: s.id,
    repo: s.repo,
    task: s.task,
    branch: s.branch,
    state: s.state,
    startedAt: s.startedAt,
    activatedAt: s.activatedAt,
    lastSeenAt: s.lastSeenAt,
    paused: false,
    pauseSource: null,
    effectiveDurationMs: computeEffectiveDuration(s),
    score: 0,
    normalizedScore: 0,
    isLeader: false,
    sensitivity: SensitivityLevel.Normal,
    closedBy: s.closedBy,
    evidence: s.evidence,
    pauseCount: s.pauses.length,
    totalPauseDurationMs: computeTotalPauseDuration(s),
  }));

  const totalEffectiveMs = log.sessions.reduce(
    (sum, s) => sum + computeEffectiveDuration(s), 0,
  );

  printTodayData({
    date: log.date,
    dayType: log.dayType,
    status: log.status,
    sessions,
    manualEntries: log.manualEntries ?? [],
    totalEffectiveMs,
    signalCount: log.signals.length,
    claimedMs: computeTotalClaimedMs(log),
    dayStart: resolveUiDayStart(log),
    activeIntervals: computeActiveIntervals(log.sessions),
    downtimeMs: computeDaySummary(log.sessions).downtimeMs,
  });
}

function handleInit(): void {
  const home = getWorkdayHome();

  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
    console.log(`Created ${home}`);
  }

  const configPath = join(home, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    const template = {
      repos: [],
      boundaryHour: 4,
      tracking: { projectKeys: ['PROJ'], branchOwners: [] },
      genericBranches: ['develop', 'main', 'master'],
      session: {
        diffPollSeconds: 30,
        signalDeduplicationSeconds: 300,
        dayBoundaryCheckSeconds: 60,
        reflogCount: 20,
      },
      report: { roundingMinutes: 15 },
      workDays: [1, 2, 3, 4, 5],
      holidays: [],
    };
    writeFileSync(configPath, JSON.stringify(template, null, 2) + '\n', 'utf-8');
    console.log(`Created ${configPath}`);
  } else {
    console.log(`Config already exists: ${configPath}`);
  }

  const secretsPath = join(home, SECRETS_FILE_NAME);
  if (!existsSync(secretsPath)) {
    const template = {
      Jira_Email: 'your-email@company.com',
      Jira_BaseUrl: 'https://your-company.atlassian.net',
      Jira_Token: '',
      Tempo_Token: '',
    };
    writeFileSync(secretsPath, JSON.stringify(template, null, 2) + '\n', 'utf-8');
    console.log(`Created ${secretsPath}`);
  } else {
    console.log(`Secrets already exists: ${secretsPath}`);
  }

  console.log('');
  console.log('Setup instructions:');
  console.log('');
  console.log(`  1. ${configPath}`);
  console.log('     - "repos": add absolute paths to your git repositories');
  console.log('       e.g. ["C:/projects/my-app", "C:/projects/my-api"]');
  console.log('       or   ["/home/user/projects/my-app"]');
  console.log('     - "tracking.projectKeys": change PROJ to your Jira project key(s)');
  console.log('       e.g. ["CORE"] for CORE-567, ["CORE", "WEB"] for both projects');
  console.log('     - "tracking.branchOwners": your username(s) as written in branch names');
  console.log('       e.g. ["jdoe"] tracks "CORE-1-jdoe-fix"; empty = track every branch');
  console.log('');
  console.log(`  2. ${secretsPath}`);
  console.log('     - Jira/Tempo tokens: optional, needed only for "workday tempo --push"');
  console.log('');
  console.log('  3. Run: workday start');
}

async function handleDaemon(): Promise<void> {
  // Foreground mode with live status dashboard
  const { Daemon } = await import('./daemon.js');
  const daemon = new Daemon();
  await daemon.start({ foreground: true });
}

// ─── Background spawn ───────────────────────────────────────────────────

function spawnBackground(): void {
  const home = getWorkdayHome();
  const configPath = join(home, CONFIG_FILE_NAME);
  const secretsPath = join(home, SECRETS_FILE_NAME);

  if (!existsSync(configPath)) {
    console.error(`Cannot start daemon: ${CONFIG_FILE_NAME} not found at ${configPath}`);
    process.exit(1);
  }
  if (!existsSync(secretsPath)) {
    console.error(`Cannot start daemon: ${SECRETS_FILE_NAME} not found at ${secretsPath}`);
    process.exit(1);
  }

  const daemonScript = resolveDaemonScript();
  const child = spawn(process.execPath, [...process.execArgv, daemonScript], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function resolveDaemonScript(): string {
  const tsPath = join(__dirname, DAEMON_SCRIPT_TS);
  if (existsSync(tsPath)) return tsPath;
  return join(__dirname, DAEMON_SCRIPT_JS);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tempo report & push ─────────────────────────────────────────────────

/** Extract value for a named flag (e.g. --from 2026-03-01) */
function parseArgValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

/** Resolve file path: relative names go to data/tempo/, absolute paths stay as-is */
function resolveTempoFilePath(filePath: string): string {
  if (isAbsolute(filePath) || filePath.includes('/') || filePath.includes('\\')) {
    return filePath;
  }
  const tempoDir = join(getDataDir(), TEMPO_REPORT_DIR);
  if (!existsSync(tempoDir)) {
    mkdirSync(tempoDir, { recursive: true });
  }
  return join(tempoDir, filePath);
}

async function handleTempo(args: string[]): Promise<void> {
  const { buildReportResponse, getDefaultFromDate, getDefaultToDate } = await import('./push/report-builder.js');
  const { runPush } = await import('./push/tempo-pusher.js');

  const config = loadConfig();
  const from = parseArgValue(args, '--from') ?? getDefaultFromDate(config);
  const to = parseArgValue(args, '--to') ?? getDefaultToDate(config);
  const rawFile = parseArgValue(args, '--file');
  const filePath = rawFile ? resolveTempoFilePath(rawFile) : null;
  const push = args.includes('--push');
  const force = args.includes('--force');

  if (push) {
    // Push mode
    const secrets = loadSecrets();
    let response;
    try {
      response = await runPush({ from, to, commit: true, config, secrets, filePath: filePath ?? undefined, force });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return;
    }
    printPushPlan(response.plan);
    if (response.blockedByConflicts) {
      console.log('');
      console.log('Push blocked: the ⚠ entries above were edited in Tempo after our last push.');
      console.log('Re-run with --force to overwrite them (local wins), or align the local data first.');
      return;
    }
    if (response.result) {
      console.log('');
      console.log(`Result: ${response.result.posted} posted, ${response.result.updated} updated, ${response.result.deleted} deleted, ${response.result.skipped} skipped, ${response.result.failed} failed`);
    }
  } else if (filePath) {
    // Save report to file
    const report = buildReportResponse(from, to, config);
    writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`Report saved to ${filePath}`);
    printReport(report);
  } else {
    // Display report
    const report = buildReportResponse(from, to, config);
    printReport(report);
  }
}

function printReport(report: ReportResponse): void {
  console.log(`Report: ${report.from} → ${report.to}`);
  console.log('');

  if (report.entries.length === 0) {
    console.log('No data.');
    return;
  }

  // Group by date
  const byDate = new Map<string, TaskDayReport[]>();
  for (const entry of report.entries) {
    const list = byDate.get(entry.date) ?? [];
    list.push(entry);
    byDate.set(entry.date, list);
  }

  const COL_DATE = 13;
  const COL_TASK = 14;
  const COL_HOURS = 8;

  console.log('DATE'.padEnd(COL_DATE) + 'TASK'.padEnd(COL_TASK) + 'HOURS'.padStart(COL_HOURS));
  console.log('─'.repeat(COL_DATE + COL_TASK + COL_HOURS));

  const sortedDates = [...byDate.keys()].sort();
  for (const date of sortedDates) {
    const entries = byDate.get(date)!.sort((a, b) => b.totalSeconds - a.totalSeconds);
    let dayTotal = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const hoursStr = formatReportHours(e.totalSeconds);
      dayTotal += e.totalSeconds;
      const suffix = e.kind === 'manual'
        ? `  · ${e.activity ?? ''}${e.description ? `: ${e.description}` : ''}`
        : '';
      console.log(
        (i === 0 ? date : '').padEnd(COL_DATE)
        + e.task.padEnd(COL_TASK)
        + hoursStr.padStart(COL_HOURS)
        + suffix,
      );
    }
    if (entries.length > 1) {
      console.log(''.padEnd(COL_DATE) + '── total'.padEnd(COL_TASK) + formatReportHours(dayTotal).padStart(COL_HOURS));
    }
  }

  console.log('─'.repeat(COL_DATE + COL_TASK + COL_HOURS));
  console.log(''.padEnd(COL_DATE) + 'TOTAL'.padEnd(COL_TASK) + formatReportHours(report.totalSeconds).padStart(COL_HOURS));

  // Task summary
  console.log('');
  console.log('Task totals:');
  const tasks = Object.entries(report.taskTotals).sort((a, b) => b[1] - a[1]);
  for (const [task, seconds] of tasks) {
    console.log(`  ${task.padEnd(14)} ${formatReportHours(seconds)}`);
  }
}

function printPushPlan(plan: readonly PushPlanEntry[]): void {
  if (plan.length === 0) {
    console.log('Empty plan.');
    return;
  }

  const COL_DATE = 13;
  const COL_TASK = 14;
  const COL_HOURS = 8;
  const COL_ACTION = 8;

  console.log('');
  console.log('DATE'.padEnd(COL_DATE) + 'TASK'.padEnd(COL_TASK) + 'HOURS'.padStart(COL_HOURS) + '  ' + 'ACTION'.padEnd(COL_ACTION) + '  DETAIL');
  console.log('─'.repeat(COL_DATE + COL_TASK + COL_HOURS + COL_ACTION + 40));

  for (const entry of plan) {
    const hoursStr = formatReportHours(entry.targetSeconds);
    const actionStr = entry.action.toUpperCase();
    const tag = entry.kind === 'manual'
      ? `  · ${entry.activity ?? ''}${entry.description ? `: ${entry.description}` : ''}`
      : '';
    console.log(
      entry.date.padEnd(COL_DATE)
      + entry.task.padEnd(COL_TASK)
      + hoursStr.padStart(COL_HOURS)
      + '  ' + actionStr.padEnd(COL_ACTION)
      + '  ' + (entry.conflict ? '⚠ edited in Tempo — ' : '') + entry.detail
      + tag,
    );
  }

  const counts = { create: 0, update: 0, delete: 0, skip: 0, error: 0 };
  for (const e of plan) counts[e.action]++;
  console.log('');
  console.log(`Create: ${counts.create}  Update: ${counts.update}  Delete: ${counts.delete}  Skip: ${counts.skip}  Error: ${counts.error}`);
}

// ─── Month view / Tempo meta ─────────────────────────────────────────────

function currentYearMonth(): { year: number; month: number } {
  const config = loadConfig();
  const today = computeWorkingDate(Date.now(), config.boundaryHour, config.timezone);
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
}

async function handleMonth(args: string[]): Promise<void> {
  const { parseYearMonth, buildMonthResponse } = await import('./push/month-report.js');
  let ym: { year: number; month: number } | null;
  if (args[0]) {
    ym = parseYearMonth(args[0]);
    if (!ym) { console.log('Usage: workday month [YYYY-MM]'); return; }
  } else {
    ym = currentYearMonth();
  }

  // Daemon first — it flushes today's live log before aggregating; the
  // disk fallback covers past months and a stopped daemon equally well.
  const result = await apiGet<MonthResponse>(`/api/month?year=${ym.year}&month=${ym.month}`);
  const data = (result.ok && result.data) ? result.data : buildMonthResponse(ym.year, ym.month, loadConfig());
  printMonth(data);
}

function printMonth(data: MonthResponse): void {
  const t = data.totals;
  console.log(`Month: ${data.from.slice(0, 7)}`);
  console.log(`Days with data: ${t.daysWithData}  (pending ${t.pendingDays} · outdated ${t.outdatedDays} · pushed ${t.pushedDays})`);
  if (data.lastPushAt) console.log(`Last push: ${data.lastPushAt}`);
  console.log(data.syncedAt
    ? `Statuses verified against Tempo snapshot of ${data.syncedAt}`
    : 'No Tempo snapshot — statuses from local flags (run `workday tempo-sync`)');
  console.log('');

  const COL_DATE = 13;
  const COL_STATUS = 10;
  const COL_HOURS = 8;
  console.log('DATE'.padEnd(COL_DATE) + 'STATUS'.padEnd(COL_STATUS) + 'HOURS'.padStart(COL_HOURS) + '  TASKS');
  console.log('─'.repeat(COL_DATE + COL_STATUS + COL_HOURS + 24));

  for (const day of data.days) {
    // Foreign-only days have no local data (status none) but still render.
    if (day.status === MonthDayStatus.None && day.tasks.length === 0) continue;
    const tasks = [...new Set(day.tasks.map(task => task.task))].join(', ');
    console.log(
      day.date.padEnd(COL_DATE)
      + (day.status === MonthDayStatus.None ? '' : day.status).padEnd(COL_STATUS)
      + formatReportHours(day.reportedSeconds).padStart(COL_HOURS)
      + (tasks ? `  ${tasks}` : ''),
    );
    if (day.status === MonthDayStatus.Outdated && day.drift) {
      for (const line of day.drift) {
        console.log(''.padEnd(COL_DATE) + `  ⚠ ${line}`);
      }
    }
  }

  console.log('─'.repeat(COL_DATE + COL_STATUS + COL_HOURS + 24));
  console.log('TOTAL'.padEnd(COL_DATE + COL_STATUS) + formatReportHours(t.reportedSeconds).padStart(COL_HOURS));
}

async function handleTempoSync(args: string[]): Promise<void> {
  const { parseYearMonth } = await import('./push/month-report.js');
  const ym = args[0] ? parseYearMonth(args[0]) : currentYearMonth();
  if (!ym) { console.log('Usage: workday tempo-sync [YYYY-MM]'); return; }

  const secrets = tryLoadSecrets();
  if (!secrets) { console.log('Secrets not configured — run "workday init".'); return; }

  const { fetchMonthSnapshot, getSnapshotPath } = await import('./push/tempo-snapshot.js');
  let snapshot;
  try {
    snapshot = await fetchMonthSnapshot(ym.year, ym.month, secrets);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return;
  }

  const totalSeconds = snapshot.worklogs.reduce((sum, w) => sum + w.timeSpentSeconds, 0);
  console.log(`Tempo snapshot ${snapshot.month}: ${snapshot.worklogs.length} worklog(s), ${formatReportHours(totalSeconds)}`);
  console.log(`Fetched: ${snapshot.fetchedAt}`);
  console.log(`Cache:   ${getSnapshotPath(ym.year, ym.month)}`);

  if (snapshot.worklogs.length === 0) return;
  console.log('');
  const byDate = new Map<string, { count: number; seconds: number }>();
  for (const wl of snapshot.worklogs) {
    const day = byDate.get(wl.startDate) ?? { count: 0, seconds: 0 };
    day.count++;
    day.seconds += wl.timeSpentSeconds;
    byDate.set(wl.startDate, day);
  }
  for (const date of [...byDate.keys()].sort()) {
    const day = byDate.get(date)!;
    console.log(`  ${date}  ${String(day.count).padStart(2)} worklog(s) ${formatReportHours(day.seconds).padStart(7)}`);
  }
  const withActivity = snapshot.worklogs.filter(w => w.activity !== undefined).length;
  console.log('');
  console.log(`Fields captured: activity on ${withActivity}/${snapshot.worklogs.length}, description on ${snapshot.worklogs.filter(w => !!w.description).length}, updatedAt on ${snapshot.worklogs.filter(w => !!w.updatedAt).length}`);
}

async function handleTempoImport(args: string[]): Promise<void> {
  // workday tempo-import [YYYY-MM] [--date YYYY-MM-DD] [--ids 1,2,3]
  // Goes through the daemon: today's entries must land in the live log.
  const usage = 'Usage: workday tempo-import [YYYY-MM] [--date YYYY-MM-DD] [--ids 1,2,3]';
  const body: Record<string, unknown> = {};

  const dateIdx = args.indexOf('--date');
  if (dateIdx !== -1) {
    const date = args[dateIdx + 1];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.log(usage); return; }
    body.date = date;
    args = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }
  const idsIdx = args.indexOf('--ids');
  if (idsIdx !== -1) {
    const ids = (args[idsIdx + 1] ?? '').split(',').map(s => parseInt(s.trim(), 10));
    if (ids.length === 0 || ids.some(isNaN)) { console.log(usage); return; }
    body.worklogIds = ids;
    args = [...args.slice(0, idsIdx), ...args.slice(idsIdx + 2)];
  }
  if (args[0]) {
    const { parseYearMonth } = await import('./push/month-report.js');
    const ym = parseYearMonth(args[0]);
    if (!ym) { console.log(usage); return; }
    body.year = ym.year;
    body.month = ym.month;
  }

  const result = await apiPost<TempoImportResponse>('/api/tempo-import', body);
  if (!result.ok || !result.data) { console.log(result.error); return; }

  const d = result.data;
  console.log(`Tempo import ${d.month}: ${d.imported} imported, ${d.failed} failed (snapshot ${d.syncedAt})`);
  for (const item of d.items) {
    const mark = item.error ? '✗' : '✓';
    const detail = item.error ?? `→ manual entry ${item.entryId}`;
    console.log(`  ${mark} ${item.date} ${item.task} ${formatReportHours(item.seconds).padStart(7)}  ${detail}`);
  }
  if (d.imported === 0 && d.items.length === 0) {
    console.log('  Nothing foreign to import — the mirror is complete.');
  }
}

async function handleSchedule(args: string[]): Promise<void> {
  const { parseYearMonth } = await import('./push/month-report.js');
  const ym = args[0] ? parseYearMonth(args[0]) : currentYearMonth();
  if (!ym) { console.log('Usage: workday schedule [YYYY-MM]'); return; }

  const secrets = tryLoadSecrets();
  if (!secrets) { console.log('Secrets not configured — run "workday init".'); return; }

  const { resolveMonthSchedule } = await import('./push/tempo-schedule.js');
  const data = await resolveMonthSchedule(ym.year, ym.month, secrets);
  if (!data.available) {
    const hint = data.reason === 'scope' ? ' — Tempo token needs the schemes:view scope' : '';
    console.log(`Schedule unavailable (${data.reason})${hint}`);
    return;
  }

  console.log(`Schedule ${ym.year}-${String(ym.month).padStart(2, '0')}: required ${formatReportHours(data.requiredSecondsTotal)}${data.fromCache ? '  [cache]' : ''}`);
  for (const day of data.days) {
    const holiday = day.holidayName ? `  ☀ ${day.holidayName}` : '';
    console.log(`  ${day.date}  ${day.type.padEnd(30)} ${formatReportHours(day.requiredSeconds).padStart(6)}${holiday}`);
  }
}

async function handleApproval(args: string[]): Promise<void> {
  const { parseYearMonth } = await import('./push/month-report.js');
  const ym = args[0] ? parseYearMonth(args[0]) : currentYearMonth();
  if (!ym) { console.log('Usage: workday approval [YYYY-MM]'); return; }

  const secrets = tryLoadSecrets();
  if (!secrets) { console.log('Secrets not configured — run "workday init".'); return; }

  const { resolveMonthApproval } = await import('./push/tempo-approvals.js');
  const data = await resolveMonthApproval(ym.year, ym.month, secrets);
  if (!data.available) {
    const hint = data.reason === 'scope' ? ' — Tempo token needs the approvals:view scope' : '';
    console.log(`Approval unavailable (${data.reason})${hint}`);
    return;
  }

  console.log(`Period: ${data.period?.from ?? '?'} → ${data.period?.to ?? '?'}${data.fromCache ? '  [cache]' : ''}`);
  console.log(`Status: ${data.statusKey ?? '—'}`);
  if (data.requiredSeconds !== null) console.log(`Required: ${formatReportHours(data.requiredSeconds)}`);
  if (data.timeSpentSeconds !== null) console.log(`Logged (Tempo side): ${formatReportHours(data.timeSpentSeconds)}`);
  if (data.canSubmit) console.log('Submit action is available for this period.');
}

// ─── Notifications ───────────────────────────────────────────────────────

async function handleNotifications(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'test') {
    const body: Record<string, unknown> = {};
    if (args[1]) {
      const minutes = parseInt(args[1], 10);
      if (isNaN(minutes)) { console.log('Usage: workday notifications test [minutes]'); return; }
      body.minutes = minutes;
    }
    const result = await apiPost<NotificationTestResponse>('/api/notifications/test', body);
    if (!result.ok || !result.data) { console.log(result.error); return; }
    const n = result.data.notification;
    console.log(`Injected ${n.id} — the tray toasts it within ~1 min while you are at the keyboard.`);
    return;
  }

  if (sub === 'ack') {
    const [, id, action] = args;
    if (!id || !['shown', 'opened', 'hidden'].includes(action ?? '')) {
      console.log('Usage: workday notifications ack <id> <shown|opened|hidden>');
      return;
    }
    const result = await apiPost<NotificationAckResponse>('/api/notifications/ack', { id, action });
    if (!result.ok || !result.data) { console.log(result.error); return; }
    console.log(`${result.data.id} → ${result.data.status}`);
    return;
  }

  if (sub !== undefined) {
    console.log('Usage: workday notifications [test [minutes] | ack <id> <action>]');
    return;
  }

  const result = await apiGet<NotificationsResponse>('/api/notifications');
  if (!result.ok || !result.data) { console.log(result.error); return; }
  const items = result.data.notifications;
  if (items.length === 0) { console.log('No active notifications.'); return; }
  for (const n of items) {
    console.log(`  [${n.kind}] ${n.id}`);
    console.log(`      ${n.title} — ${n.body}`);
  }
}

// ─── Calendar ────────────────────────────────────────────────────────────

async function handleCalendar(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'refresh') {
    const result = await apiPost<CalendarRefreshResponse>('/api/calendar/refresh');
    if (!result.ok || !result.data) { console.log(result.error); return; }
    console.log(`Calendar refreshed: ${result.data.instanceCount} instance(s), fetched ${result.data.fetchedAt}`);
    return;
  }

  if (sub !== undefined) {
    console.log('Usage: workday calendar [refresh]');
    return;
  }

  const result = await apiGet<StatusResponse>('/api/status');
  if (!result.ok || !result.data) { console.log(result.error); return; }
  const cal = result.data.calendar;
  if (!cal || !cal.configured) {
    console.log('Calendar feed: not configured (set Calendar_IcsUrl in secrets.json).');
    return;
  }
  console.log('Calendar feed: configured');
  console.log(`  Last fetch: ${cal.lastFetchAt ?? 'never'}`);
  console.log(`  Instances:  ${cal.instanceCount}`);
  if (cal.lastError) console.log(`  Last error: ${cal.lastError}`);
}

// ─── Meeting suggestions ────────────────────────────────────────────────

function fmtSuggestionTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Learned-ticket column: resolved prefill, a titleKey conflict, or nothing. */
function fmtSuggestionResolution(s: Suggestion): string {
  if (s.resolved) return `  → ${s.resolved.task} · ${s.resolved.activity}`;
  if (s.candidates?.length) return `  → task? (${s.candidates.map(c => c.task).join(' | ')})`;
  return '';
}

function printSuggestionsDay(day: SuggestionsResponse): void {
  if (day.state === SuggestionsDayState.Pushed) {
    console.log(`${day.date} is pushed to Tempo — suggestions are silenced.`);
    return;
  }
  if (day.suggestions.length === 0) {
    console.log(`No pending suggestions for ${day.date}.`);
    return;
  }
  console.log(`Suggestions for ${day.date}:`);
  day.suggestions.forEach((s, i) => {
    const flags = [s.ongoing ? 'ongoing' : null, s.isPrivate ? 'private' : null].filter(Boolean).join(' · ');
    const title = s.title || '(no title)';
    // Review rows: title = the checked-out branch, time = the checkout moment.
    const time = s.source === 'review'
      ? `${fmtSuggestionTime(s.start)} review`
      : `${fmtSuggestionTime(s.start)}–${fmtSuggestionTime(s.end)}`;
    console.log(`  #${i + 1}  ${time}  ${String(s.plannedMinutes).padStart(3)}m  ${title}${flags ? `  [${flags}]` : ''}${fmtSuggestionResolution(s)}`);
  });
  console.log('');
  console.log('Accept:  workday suggestions accept <#N> [--task <KEY>] [--minutes N] [--desc "..."] [--activity X]  (resolved rows accept without --task)');
  console.log('Dismiss: workday suggestions dismiss <#N>');
  console.log('Mute:    workday suggestions mute <#N> [--days N]  (no --days = forever)');
}

/** Resolve `#N` against the day's current list; a raw uid passes through. */
async function resolveSuggestionTarget(target: string, date: string | null): Promise<{ uid: string; date: string } | null> {
  const result = await apiGet<SuggestionsResponse>(`/api/suggestions${date ? `?date=${date}` : ''}`);
  if (!result.ok || !result.data) { console.log(result.error); return null; }
  const day = result.data;
  if (!target.startsWith('#')) return { uid: target, date: day.date };
  const index = parseInt(target.slice(1), 10);
  if (isNaN(index) || index < 1 || index > day.suggestions.length) {
    console.log(`No suggestion ${target} on ${day.date} (${day.suggestions.length} pending)`);
    return null;
  }
  return { uid: day.suggestions[index - 1].uid, date: day.date };
}

async function handleSuggestions(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'accept') {
    const rest = args.slice(1);
    const target = rest[0];
    const task = parseArgValue(rest, '--task');
    if (!target) {
      console.log('Usage: workday suggestions accept <#N|uid> [--task <KEY>] [--minutes N] [--desc "..."] [--activity X] [--date D]');
      console.log('--task is optional when the row shows a learned resolution (→ KEY).');
      return;
    }
    const resolved = await resolveSuggestionTarget(target, parseArgValue(rest, '--date'));
    if (!resolved) return;

    const payload: Record<string, unknown> = { uid: resolved.uid, date: resolved.date };
    if (task) payload.task = task;
    const minutesStr = parseArgValue(rest, '--minutes');
    if (minutesStr !== null) {
      const minutes = parseInt(minutesStr, 10);
      if (isNaN(minutes) || minutes <= 0) { console.log('Minutes must be positive'); return; }
      payload.minutes = minutes;
    }
    const desc = parseArgValue(rest, '--desc');
    if (desc !== null) payload.description = desc;
    const activity = parseArgValue(rest, '--activity');
    if (activity !== null) payload.activity = activity;

    const result = await apiPost<SuggestionAcceptResponse>('/api/suggestions/accept', payload);
    if (!result.ok || !result.data) { console.log(result.error); return; }
    const e = result.data.entry;
    console.log(`Logged ${e.task} on ${e.date}: ${e.minutes}m ${e.activity} — "${e.description}"`);
    console.log(`Pending suggestions left: ${result.data.day.suggestions.length}`);
    return;
  }

  if (sub === 'dismiss') {
    const rest = args.slice(1);
    const target = rest[0];
    if (!target) {
      console.log('Usage: workday suggestions dismiss <#N|uid> [--date D]');
      return;
    }
    const resolved = await resolveSuggestionTarget(target, parseArgValue(rest, '--date'));
    if (!resolved) return;
    const result = await apiPost<SuggestionsResponse>('/api/suggestions/dismiss', resolved);
    if (!result.ok || !result.data) { console.log(result.error); return; }
    console.log(`Dismissed. Pending suggestions left: ${result.data.suggestions.length}`);
    return;
  }

  if (sub === 'mute') {
    const rest = args.slice(1);
    const target = rest[0];
    if (!target) {
      console.log('Usage: workday suggestions mute <#N|uid> [--days N] [--date D]   (no --days = forever)');
      return;
    }
    let days: number | undefined;
    const daysStr = parseArgValue(rest, '--days');
    if (daysStr !== null) {
      days = parseInt(daysStr, 10);
      if (isNaN(days) || days <= 0) { console.log('Days must be positive'); return; }
    }
    const resolved = await resolveSuggestionTarget(target, parseArgValue(rest, '--date'));
    if (!resolved) return;
    const payload: Record<string, unknown> = { ...resolved };
    if (days !== undefined) payload.days = days;
    const result = await apiPost<SuggestionsResponse>('/api/suggestions/mute', payload);
    if (!result.ok || !result.data) { console.log(result.error); return; }
    console.log(`Muted ${days ? `for ${days} day${days === 1 ? '' : 's'}` : 'forever'}. Pending suggestions left: ${result.data.suggestions.length}`);
    return;
  }

  if (sub === 'muted') {
    const result = await apiGet<SuggestionsMutedResponse>('/api/suggestions/muted');
    if (!result.ok || !result.data) { console.log(result.error); return; }
    if (result.data.muted.length === 0) {
      console.log('No muted series.');
      return;
    }
    console.log('Muted series:');
    for (const m of result.data.muted) {
      const till = m.until ? `till ${m.until.slice(0, 10)}` : 'forever';
      console.log(`  ${m.title ?? '(unknown meeting)'}  ${till} · muted ${m.mutedAt.slice(0, 10)}`);
      console.log(`    uid: ${m.uid}`);
    }
    console.log('');
    console.log('Unmute: workday suggestions unmute <uid|--all>');
    return;
  }

  if (sub === 'unmute') {
    const target = args[1];
    if (!target) {
      console.log('Usage: workday suggestions unmute <uid|--all>   (uids: workday suggestions muted)');
      return;
    }
    const payload = target === '--all' ? { all: true } : { uid: target };
    const result = await apiPost<SuggestionUnmuteResponse>('/api/suggestions/unmute', payload);
    if (!result.ok || !result.data) { console.log(result.error); return; }
    console.log(target === '--all'
      ? `Unmuted ${result.data.uids.length} series.`
      : 'Unmuted — the series suggests again.');
    return;
  }

  if (sub !== undefined && sub !== '--date') {
    console.log('Usage: workday suggestions [--date D] | accept <#N|uid> [--task <KEY>] ... | dismiss <#N|uid> | mute <#N|uid> [--days N] | muted | unmute <uid|--all>');
    return;
  }

  const date = parseArgValue(args, '--date');
  const result = await apiGet<SuggestionsResponse>(`/api/suggestions${date ? `?date=${date}` : ''}`);
  if (!result.ok || !result.data) { console.log(result.error); return; }
  printSuggestionsDay(result.data);
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === '--version' || command === '-v') {
    console.log(getCurrentVersion());
    return;
  }

  switch (command) {
    case 'start':
      await handleStart();
      break;
    case 'stop':
      await handleStop();
      break;
    case 'status':
      await handleStatus();
      break;
    case 'today':
      await handleToday();
      break;
    case 'pause':
      await handlePause(args.slice(1));
      break;
    case 'resume':
      await handleResume();
      break;
    case 'sensitivity':
      await handleSensitivity(args.slice(1));
      break;
    case 'session-delete':
      await handleSessionDelete(args.slice(1));
      break;
    case 'task-delete':
      await handleTaskDelete(args.slice(1));
      break;
    case 'day':
      await handleDay(args.slice(1));
      break;
    case 'log':
      await handleLog(args.slice(1));
      break;
    case 'log-edit':
      await handleLogEdit(args.slice(1));
      break;
    case 'log-delete':
      await handleLogDelete(args.slice(1));
      break;
    case 'log-list':
      await handleLogList(args.slice(1));
      break;
    case 'fav-add':
      await handleFavAdd(args.slice(1));
      break;
    case 'fav-remove':
      handleFavRemove(args.slice(1));
      break;
    case 'fav-list':
      handleFavList();
      break;
    case 'jira-search':
      await handleJiraSearch(args.slice(1));
      break;
    case 'projects':
      await handleProjects(args.slice(1));
      break;
    case 'activities':
      await handleActivities(args.slice(1));
      break;
    case 'tempo':
      await handleTempo(args.slice(1));
      break;
    case 'month':
      await handleMonth(args.slice(1));
      break;
    case 'tempo-sync':
      await handleTempoSync(args.slice(1));
      break;
    case 'tempo-import':
      await handleTempoImport(args.slice(1));
      break;
    case 'schedule':
      await handleSchedule(args.slice(1));
      break;
    case 'approval':
      await handleApproval(args.slice(1));
      break;
    case 'notifications':
      await handleNotifications(args.slice(1));
      break;
    case 'calendar':
      await handleCalendar(args.slice(1));
      break;
    case 'suggestions':
      await handleSuggestions(args.slice(1));
      break;
    case 'init':
      handleInit();
      break;
    case 'daemon':
      await handleDaemon();
      break;
    default:
      printHelp();
  }
}

function printHelp(): void {
  console.log(`Workday — Activity Tracker & Timesheet Tool

Usage:
  workday init               Initialize config in ~/.workday/
  workday start              Start daemon and print status
  workday stop               Stop running daemon
  workday status             Show daemon status and open sessions
  workday today              Show today's full summary
  workday day YYYY-MM-DD     Show summary for a specific date
  workday pause              Pause all active sessions
  workday pause <repo>       Pause a specific repo session
  workday resume             Resume all paused sessions
  workday sensitivity <level>             Set global default (low|normal|patient|always_on)
  workday sensitivity <level> <repo>      Set per-repo sensitivity
  workday session-delete <target> [--date DATE]        Delete a junk session (review-time cleanup)
  workday task-delete <KEY> [--date DATE]              Delete a ticket's tracked block (sessions + manual adds)
  workday log <task> <min> ["<desc>"] [--activity T]   Log manual time (today; desc optional for Development)
  workday log <task> <min> ["<desc>"] --date DATE      Log manual time (past day)
  workday log-edit <#|id> [--minutes N] [--desc ..] [--activity T] [--date D]   Edit a manual entry
  workday log-delete <#|id> [--date D]                 Delete a manual entry
  workday log-list [--date DATE]                       List manual entries
  workday fav-add <task> <min> "<name>" [--activity T] Add a favorite (log template)
  workday fav-remove <#|id>                            Remove a favorite
  workday fav-list                                     List favorites
  workday jira-search "<query>"                        Live Jira issue search (key + summary)
  workday projects [refresh | set <KEY...>]            Show / refresh / set the search-scope projects
  workday activities [refresh | set <VALUE...>]        Show / refresh / scope Tempo activity types
  workday tempo                                        Show report (1st of month → today)
  workday tempo --from DATE --to DATE                  Report for a custom range
  workday tempo --file report.json                     Save report to JSON file
  workday tempo --file report.json --push              Push from saved report
  workday tempo --push                                 Push computed data to Tempo
  workday tempo --push --force                         Also overwrite worklogs edited in Tempo (conflicts)
  workday month [YYYY-MM]                              Month view: day statuses vs Tempo (pending/outdated/pushed)
  workday tempo-sync [YYYY-MM]                         Fetch the month's Tempo worklogs into the local snapshot cache
  workday tempo-import [YYYY-MM]                       Adopt Tempo-only worklogs as local entries (--date / --ids to narrow)
  workday schedule [YYYY-MM]                           Tempo work schedule: required hours, holidays
  workday approval [YYYY-MM]                           Tempo timesheet approval status for the period
  workday notifications                                Active notifications (what the tray would toast)
  workday notifications test [minutes]                 Inject a test notification (delivery pipeline check)
  workday notifications ack <id> <shown|opened|hidden> Acknowledge a notification
  workday calendar                                     Outlook ICS feed status (meeting suggestions)
  workday calendar refresh                             Re-fetch the calendar feed now
  workday suggestions [--date D]                       Pending meeting suggestions for a day (→ learned ticket)
  workday suggestions accept <#N|uid> [--task <KEY>]   Log a suggested meeting (--minutes/--desc/--activity/--date)
  workday suggestions dismiss <#N|uid> [--date D]      Dismiss a suggestion (per uid+date, permanent)
  workday suggestions mute <#N|uid> [--days N]         Mute a meeting series (no --days = forever)
  workday suggestions muted                            Manually muted series
  workday suggestions unmute <uid|--all>               Release muted series

Target: session index (#1, #2) or session id (hex)`);
}

await main();
