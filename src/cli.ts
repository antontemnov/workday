#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, getWorkdayHome, getPackageRoot, getDataDir, computeWorkingDate } from './core/config.js';
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
import {
  readDailyLog,
  writeDailyLog,
  resolveSessionTarget,
  addManualAdjustment,
  computeManualMinutes,
  computeEffectiveDuration,
  computeTotalPauseDuration,
  computeTotalClaimedMs,
  computeActiveIntervals,
  computeDaySummary,
  resolveUiDayStart,
  addManualEntry,
  editManualEntry,
  findManualEntry,
  resolveManualEntryTarget,
  computeTotalManualEntryMs,
  createEmptyLog,
} from './core/daily-log.js';
import type {
  ApiResponse,
  StatusResponse,
  TodayResponse,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  SensitivityResponse,
  AdjustResponse,
  SessionDetail,
  SessionSummary,
  TaskDayReport,
  PushPlanEntry,
  ReportResponse,
  ManualEntry,
  ManualEntryResponse,
  ActivityTypesResponse,
} from './core/types.js';
import { SensitivityLevel } from './core/types.js';

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
    const manualStr = s.manualMinutes > 0 ? ` + ${s.manualMinutes}m manual` : '';
    const status = formatSessionStatus(s);
    const scoreStr = `score:${s.normalizedScore.toFixed(2)}`;
    console.log(`    #${i + 1} ${s.repo}  ${task}  ${s.branch}  ${s.state}  ${dur}${manualStr}  ${scoreStr}${status}`);
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
  const manualStr = s.manualMinutes > 0 ? ` + ${s.manualMinutes}m manual` : '';
  const status = s.closedBy ? `closed(${s.closedBy})` : (s.paused ? 'paused' : s.state);
  const ev = s.evidence;
  const added = ev.linesAdded ?? 0;
  const removed = ev.linesRemoved ?? 0;
  const files = ev.filesChanged ?? 0;

  const prefix = index !== undefined ? `#${index}` : s.id;
  console.log(`  [${prefix}] ${s.repo}  ${task}  ${dur}${manualStr}  ${status}`);
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

async function handleAdjust(args: string[]): Promise<void> {
  // workday adjust <target> +<N> "<reason>" [--date YYYY-MM-DD]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const target = cmdArgs[0];
  const minutesStr = cmdArgs[1];
  const reason = cmdArgs.slice(2).join(' ');

  if (!target || !minutesStr) {
    console.log('Usage: workday adjust <target> +<N> "<reason>" [--date YYYY-MM-DD]');
    return;
  }

  const minutes = parseInt(minutesStr.replace('+', ''), 10);
  if (isNaN(minutes) || minutes <= 0) {
    console.log('Minutes must be a positive number (e.g. +30)');
    return;
  }

  if (!reason) {
    console.log('Reason is required');
    return;
  }

  if (date) {
    // Offline mode — past day
    handleAdjustOffline(date, target, minutes, reason);
  } else {
    // Online mode — via HTTP
    const result = await apiPost<AdjustResponse>('/api/adjust', { target, minutes, reason });
    if (!result.ok) {
      console.log(result.error);
      return;
    }
    const d = result.data!;
    console.log(`Adjusted ${d.repo} (${d.task ?? '—'}): +${d.addedMinutes}m (total manual: ${d.totalManualMinutes}m)`);
  }
}

function handleAdjustOffline(date: string, target: string, minutes: number, reason: string): void {
  const config = loadConfig();
  const log = readDailyLog(date);
  if (!log) {
    console.log(`No data for ${date}`);
    return;
  }

  const session = resolveSessionTarget(log, target);
  if (!session) {
    console.log(`Session not found: ${target}`);
    return;
  }

  try {
    addManualAdjustment(log, session.id, minutes, reason, config);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
    return;
  }

  writeDailyLog(log);
  console.log(`Adjusted ${session.repo} (${session.task ?? '—'}): +${minutes}m`);
  console.log(`Total manual for session: ${computeManualMinutes(session)}m`);
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
  const description = cmdArgs.slice(2).join(' ');

  if (!task || !minutesStr || !description) {
    console.log('Usage: workday log <task> <minutes> "<description>" [--activity <type>] [--date YYYY-MM-DD]');
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
  const today = computeWorkingDate(Date.now(), config.schedule.end, config.timezone);
  if (date > today) {
    console.log(`Cannot log on a future date (${date} > ${today})`);
    return;
  }
  // Manual entry is standalone — create the day log if it doesn't exist yet.
  const log = readDailyLog(date) ?? createEmptyLog(date, config);
  try {
    const entry = addManualEntry(log, { task, minutes, description, activity }, config);
    writeDailyLog(log);
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
  const config = loadConfig();
  const log = readDailyLog(date);
  if (!log) { console.log(`No data for ${date}`); return; }
  const entry = resolveManualEntryTarget(log, target);
  if (!entry) { console.log(`Manual entry not found: ${target}`); return; }
  try {
    editManualEntry(log, entry.id, patch, config);
    writeDailyLog(log);
    const after = findManualEntry(log, entry.id)!;
    console.log(`Updated ${after.task} on ${date}: ${after.minutes}m ${after.activity} — "${after.description}"`);
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

async function handleActivities(): Promise<void> {
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
  console.log(`Activity types (${data.key})${data.fromCache ? '' : '  [fallback — configure Tempo token for the live list]'}:`);
  for (const a of data.activities) {
    console.log(`  ${a.value.padEnd(30)} ${a.name}`);
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
    manualMinutes: computeManualMinutes(s),
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
    dayStartedAt: resolveUiDayStart(log),
    schedule: { start: config.schedule.start, end: config.schedule.end },
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
      schedule: { start: 10, end: 4 },
      taskPattern: 'PROJ-\\d+',
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
      Developer: 'your-git-username',
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
  console.log('     - "taskPattern": change PROJ to your Jira prefix');
  console.log('       e.g. "CORE-\\\\d+" for CORE-567, "WEB-\\\\d+" for WEB-123');
  console.log('');
  console.log(`  2. ${secretsPath}`);
  console.log('     - "Developer": your git username (used to filter branches)');
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

  if (push) {
    // Push mode
    const secrets = loadSecrets();
    let response;
    try {
      response = await runPush({ from, to, commit: true, config, secrets, filePath: filePath ?? undefined });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return;
    }
    printPushPlan(response.plan);
    if (response.result) {
      console.log('');
      console.log(`Result: ${response.result.posted} posted, ${response.result.updated} updated, ${response.result.skipped} skipped, ${response.result.failed} failed`);
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
      + '  ' + entry.detail
      + tag,
    );
  }

  const counts = { create: 0, update: 0, skip: 0, error: 0 };
  for (const e of plan) counts[e.action]++;
  console.log('');
  console.log(`Create: ${counts.create}  Update: ${counts.update}  Skip: ${counts.skip}  Error: ${counts.error}`);
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
    case 'adjust':
      await handleAdjust(args.slice(1));
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
    case 'log-list':
      await handleLogList(args.slice(1));
      break;
    case 'activities':
      await handleActivities();
      break;
    case 'tempo':
      await handleTempo(args.slice(1));
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
  workday adjust <target> +<N> "<reason>"              Add manual time (today)
  workday adjust <target> +<N> "<reason>" --date DATE  Add manual time (past day)
  workday log <task> <min> "<desc>" [--activity T]     Log manual time (today)
  workday log <task> <min> "<desc>" --date DATE        Log manual time (past day)
  workday log-edit <#|id> [--minutes N] [--desc ..] [--activity T] [--date D]   Edit a manual entry
  workday log-list [--date DATE]                       List manual entries
  workday activities                                   Show Tempo activity types
  workday tempo                                        Show report (1st of month → today)
  workday tempo --from DATE --to DATE                  Report for a custom range
  workday tempo --file report.json                     Save report to JSON file
  workday tempo --file report.json --push              Push from saved report
  workday tempo --push                                 Push computed data to Tempo

Target: session index (#1, #2) or session id (hex)`);
}

await main();
