import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadSecrets, getProjectRoot, getDataDir } from './core/config.js';
import {
  CONFIG_FILE_NAME,
  SECRETS_FILE_NAME,
  DAEMON_SCRIPT_TS,
  DAEMON_SCRIPT_JS,
  TEMPO_REPORT_DIR,
} from './core/constants.js';
import {
  readDailyLog,
  writeDailyLog,
  resolveSessionTarget,
  addManualAdjustment,
  setDayManualStart,
  computeManualMinutes,
  computeEffectiveDuration,
  computeTotalPauseDuration,
  computeBudgetMs,
  computeTotalClaimedMs,
  getRemainingBudgetMs,
} from './core/daily-log.js';
import type {
  ApiResponse,
  StatusResponse,
  TodayResponse,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  AutoPauseResponse,
  AdjustResponse,
  SetStartResponse,
  SessionDetail,
  SessionSummary,
  TaskDayReport,
  PushPlanEntry,
  ReportResponse,
} from './core/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── HTTP client helpers ────────────────────────────────────────────────

function getApiBaseUrl(): string {
  const config = loadConfig();
  return `http://127.0.0.1:${config.apiPort}`;
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
  const totalMinutes = Math.floor(ms / 60_000);
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
  if (s.autoPauseDisabled) parts.push('AUTOPAUSE OFF');
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

  if (data.budgetMs > 0) {
    console.log(`Budget: ${formatDuration(data.budgetMs)} | Claimed: ${formatDuration(data.claimedMs)} | Remaining: ${formatDuration(data.remainingBudgetMs)}`);
  }

  if (data.sessions.length === 0) {
    console.log('No sessions.');
    return;
  }

  console.log('');
  for (let i = 0; i < data.sessions.length; i++) {
    printSessionDetail(data.sessions[i], i + 1);
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

async function handleStart(): Promise<void> {
  // Check if already running
  const check = await apiGet<StatusResponse>('/api/status');
  if (check.ok) {
    console.log('Daemon is already running.');
    printStatusData(check.data!);
    return;
  }

  spawnBackground();

  // Poll for HTTP readiness
  const baseUrl = getApiBaseUrl();
  const maxAttempts = 25; // 5s total
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(200);
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

async function handleAutoPause(args: string[]): Promise<void> {
  const toggle = args[0]; // on | off
  if (toggle !== 'on' && toggle !== 'off') {
    console.log('Usage: workday autopause on|off [repo]');
    return;
  }
  const repo = args[1];
  const enabled = toggle === 'on';
  const body: Record<string, unknown> = { enabled };
  if (repo) body.repo = repo;

  const result = await apiPost<AutoPauseResponse>('/api/autopause', body);
  if (!result.ok) {
    console.log(result.error);
    return;
  }

  const target = result.data!.repo ?? 'all sessions';
  const state = result.data!.autoPauseDisabled ? 'disabled' : 'enabled';
  console.log(`Autopause ${state} for ${target}.`);
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
    console.log(`Remaining budget: ${formatDuration(d.remainingBudgetMs)}`);
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
  console.log(`Remaining budget: ${formatDuration(getRemainingBudgetMs(log, config))}`);
}

async function handleSetStart(args: string[]): Promise<void> {
  // workday set-start HH:MM [--date YYYY-MM-DD]
  const dateIdx = args.indexOf('--date');
  let date: string | null = null;
  let cmdArgs = args;
  if (dateIdx !== -1) {
    date = args[dateIdx + 1];
    cmdArgs = [...args.slice(0, dateIdx), ...args.slice(dateIdx + 2)];
  }

  const time = cmdArgs[0];
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
    console.log('Usage: workday set-start HH:MM [--date YYYY-MM-DD]');
    return;
  }

  if (date) {
    handleSetStartOffline(date, time);
  } else {
    const result = await apiPost<SetStartResponse>('/api/set-start', { time });
    if (!result.ok) {
      console.log(result.error);
      return;
    }
    const d = result.data!;
    console.log(`Day start set to: ${d.dayStart}`);
    console.log(`Budget: ${formatDuration(d.budgetMs)} | Remaining: ${formatDuration(d.remainingBudgetMs)}`);
  }
}

function handleSetStartOffline(date: string, time: string): void {
  const config = loadConfig();
  const log = readDailyLog(date);
  if (!log) {
    console.log(`No data for ${date}`);
    return;
  }

  const [h, m] = time.split(':').map(Number);
  // Build ISO timestamp for date+time in config timezone
  const [year, month, day] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, h, m, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: config.timezone,
    hour: 'numeric',
    hour12: false,
    minute: 'numeric',
  }).formatToParts(guess);
  const actualHour = parseInt(parts.find(p => p.type === 'hour')!.value);
  const actualMinute = parseInt(parts.find(p => p.type === 'minute')!.value);
  const ah = actualHour === 24 ? 0 : actualHour;
  const diffMs = ((h - ah) * 60 + (m - actualMinute)) * 60_000;
  const isoTimestamp = new Date(guess.getTime() + diffMs).toISOString();

  try {
    setDayManualStart(log, isoTimestamp, config);
  } catch (err) {
    console.log(err instanceof Error ? err.message : String(err));
    return;
  }

  writeDailyLog(log);
  console.log(`Day start set to: ${isoTimestamp}`);
  console.log(`Budget: ${formatDuration(computeBudgetMs(log, config))} | Remaining: ${formatDuration(getRemainingBudgetMs(log, config))}`);
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
    autoPauseDisabled: false,
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
    totalEffectiveMs,
    signalCount: log.signals.length,
    budgetMs: computeBudgetMs(log, config),
    claimedMs: computeTotalClaimedMs(log),
    remainingBudgetMs: getRemainingBudgetMs(log, config),
    dayStartedAt: log.dayStartedAt,
  });
}

async function handleDaemon(): Promise<void> {
  // Foreground mode with live status dashboard
  const { Daemon } = await import('./daemon.js');
  const daemon = new Daemon();
  await daemon.start({ foreground: true });
}

// ─── Background spawn ───────────────────────────────────────────────────

function spawnBackground(): void {
  const root = getProjectRoot();
  const configPath = join(root, CONFIG_FILE_NAME);
  const secretsPath = join(root, SECRETS_FILE_NAME);

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
      const hoursStr = formatReportHours(entries[i].totalSeconds);
      dayTotal += entries[i].totalSeconds;
      console.log(
        (i === 0 ? date : '').padEnd(COL_DATE)
        + entries[i].task.padEnd(COL_TASK)
        + hoursStr.padStart(COL_HOURS),
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
    console.log(
      entry.date.padEnd(COL_DATE)
      + entry.task.padEnd(COL_TASK)
      + hoursStr.padStart(COL_HOURS)
      + '  ' + actionStr.padEnd(COL_ACTION)
      + '  ' + entry.detail,
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
    case 'autopause':
      await handleAutoPause(args.slice(1));
      break;
    case 'adjust':
      await handleAdjust(args.slice(1));
      break;
    case 'set-start':
      await handleSetStart(args.slice(1));
      break;
    case 'day':
      await handleDay(args.slice(1));
      break;
    case 'tempo':
      await handleTempo(args.slice(1));
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
  workday start              Start daemon and print status
  workday stop               Stop running daemon
  workday status             Show daemon status and open sessions
  workday today              Show today's full summary
  workday day YYYY-MM-DD     Show summary for a specific date
  workday pause              Pause all active sessions
  workday pause <repo>       Pause a specific repo session
  workday resume             Resume all paused sessions
  workday autopause on|off   Toggle autopause for all sessions
  workday autopause on|off <repo>  Toggle autopause for a specific repo
  workday adjust <target> +<N> "<reason>"              Add manual time (today)
  workday adjust <target> +<N> "<reason>" --date DATE  Add manual time (past day)
  workday set-start HH:MM                              Set day start earlier (today)
  workday set-start HH:MM --date DATE                  Set day start earlier (past day)
  workday tempo                                        Show report (1st of month → today)
  workday tempo --from DATE --to DATE                  Report for a custom range
  workday tempo --file report.json                     Save report to JSON file
  workday tempo --file report.json --push              Push from saved report
  workday tempo --push                                 Push computed data to Tempo

Target: session index (#1, #2) or session id (hex)`);
}

await main();
