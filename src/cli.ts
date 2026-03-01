import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getProjectRoot } from './core/config.js';
import {
  CONFIG_FILE_NAME,
  SECRETS_FILE_NAME,
  DAEMON_SCRIPT_TS,
  DAEMON_SCRIPT_JS,
} from './core/constants.js';
import type {
  ApiResponse,
  StatusResponse,
  TodayResponse,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  AutoPauseResponse,
  SessionDetail,
  SessionSummary,
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
  for (const s of data.openSessions) {
    const task = s.task ?? '—';
    const dur = formatDuration(s.effectiveDurationMs);
    const status = formatSessionStatus(s);
    const scoreStr = `score:${s.normalizedScore.toFixed(2)}`;
    console.log(`    ${s.repo}  ${task}  ${s.branch}  ${s.state}  ${dur}  ${scoreStr}${status}`);
  }
}

function printTodayData(data: TodayResponse): void {
  console.log(`Date: ${data.date}  (${data.dayType})  Status: ${data.status}`);
  console.log(`Total: ${formatDuration(data.totalEffectiveMs)}  Signals: ${data.signalCount}`);

  if (data.sessions.length === 0) {
    console.log('No sessions.');
    return;
  }

  console.log('');
  for (const s of data.sessions) {
    printSessionDetail(s);
  }
}

function printSessionDetail(s: SessionDetail): void {
  const task = s.task ?? '—';
  const dur = formatDuration(s.effectiveDurationMs);
  const status = s.closedBy ? `closed(${s.closedBy})` : (s.paused ? 'paused' : s.state);
  const ev = s.evidence;
  const evidence = `C:${ev.commits} D:${ev.dynamicsHeartbeats} S:${ev.totalSnapshots} R:${ev.reflogEvents}`;

  console.log(`  [${s.id}] ${s.repo}  ${task}  ${dur}  ${status}`);
  console.log(`         branch: ${s.branch}  evidence: ${evidence}`);

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

async function handleDaemon(): Promise<void> {
  // Foreground mode for dev/debug
  const { Daemon } = await import('./daemon.js');
  const daemon = new Daemon();
  await daemon.start();
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
  workday pause              Pause all active sessions
  workday pause <repo>       Pause a specific repo session
  workday resume             Resume all paused sessions
  workday autopause on|off   Toggle autopause for all sessions
  workday autopause on|off <repo>  Toggle autopause for a specific repo`);
}

await main();
