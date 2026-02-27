import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDataDir, getProjectRoot } from './core/config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'daemon':
      await handleDaemon(args.slice(1));
      break;
    default:
      printHelp();
  }
}

async function handleDaemon(args: string[]): Promise<void> {
  if (args.includes('stop')) {
    stopDaemon();
    return;
  }

  if (args.includes('--background')) {
    spawnBackground();
    return;
  }

  // Foreground: import and start directly
  const { Daemon } = await import('./daemon.js');
  const daemon = new Daemon();
  await daemon.start();
}

function spawnBackground(): void {
  // Validate config files exist before spawning (errors invisible in detached mode)
  const root = getProjectRoot();
  const configPath = join(root, 'config.json');
  const secretsPath = join(root, 'secrets.json');

  if (!existsSync(configPath)) {
    console.error(`Cannot start daemon: config.json not found at ${configPath}`);
    process.exit(1);
  }
  if (!existsSync(secretsPath)) {
    console.error(`Cannot start daemon: secrets.json not found at ${secretsPath}`);
    process.exit(1);
  }

  const daemonScript = resolveDaemonScript();
  const child = spawn(process.execPath, [...process.execArgv, daemonScript], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  console.log(`Daemon started in background (PID ${child.pid})`);
}

function stopDaemon(): void {
  const pidPath = join(getDataDir(), 'workday.pid');

  if (!existsSync(pidPath)) {
    console.log('Daemon is not running (no PID file)');
    return;
  }

  const pid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Stopping daemon (PID ${pid})...`);
  } catch {
    console.log(`Process ${pid} not found, removing stale PID file`);
    unlinkSync(pidPath);
  }
}

/** Resolve daemon entry point: .ts (dev/tsx) or .js (compiled) */
function resolveDaemonScript(): string {
  const tsPath = join(__dirname, 'daemon.ts');
  if (existsSync(tsPath)) return tsPath;
  return join(__dirname, 'daemon.js');
}

function printHelp(): void {
  console.log(`Workday — Activity Tracker & Timesheet Tool

Usage:
  workday daemon               Start daemon (foreground)
  workday daemon --background  Start daemon (background)
  workday daemon stop          Stop running daemon`);
}

await main();
