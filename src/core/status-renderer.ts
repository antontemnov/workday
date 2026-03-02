import { basename } from 'node:path';
import type { SessionTracker } from './session-tracker.js';
import { computeEffectiveDuration, computeTotalPauseDuration, computeDaySummary } from './daily-log.js';

// ANSI helpers
const CLEAR = '\x1b[2J\x1b[H';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';

const LINE_WIDTH = 60;
const LABEL_WIDTH = 10;
const INDENT = '    ';
const BAR_WIDTH = 10;

interface RenderContext {
  readonly sessionTracker: SessionTracker;
  currentDate: string;
  readonly startedAt: number;
  readonly timezone: string;
  readonly pollSeconds: number;
  readonly repos: readonly string[];
}

export class StatusRenderer {
  private readonly ctx: RenderContext;
  private tickCount: number = 0;

  public constructor(ctx: RenderContext) {
    this.ctx = ctx;
  }

  public updateDate(date: string): void {
    this.ctx.currentDate = date;
  }

  public renderError(message: string): void {
    this.render();
    process.stdout.write(`\n  ${RED}ERROR${RESET} ${message}\n`);
  }

  public render(): void {
    this.tickCount++;
    const lines: string[] = [];
    const now = Date.now();

    // Header
    lines.push(`${BOLD}${CYAN}  WORKDAY DAEMON${RESET}`);
    lines.push(`${DIM}${'─'.repeat(LINE_WIDTH)}${RESET}`);

    // Daemon info
    const uptime = formatDuration(now - this.ctx.startedAt);
    lines.push(`  ${DIM}PID${RESET} ${process.pid}  ${DIM}Date${RESET} ${this.ctx.currentDate}  ${DIM}Up${RESET} ${uptime} ${DIM}(#${this.tickCount})${RESET}`);
    lines.push('');

    // Sessions
    const tracker = this.ctx.sessionTracker;
    const log = tracker.getDailyLog();
    const openSessions = log.sessions.filter(s => !s.closedBy);
    const closedSessions = log.sessions.filter(s => s.closedBy);
    const evalResult = tracker.getLastEvaluatorResult();

    if (openSessions.length === 0 && closedSessions.length === 0) {
      lines.push(`  ${DIM}No sessions yet. Waiting for git activity...${RESET}`);
    } else {
      // Open sessions
      if (openSessions.length > 0) {
        lines.push(`${BOLD}  ACTIVE SESSIONS${RESET} ${DIM}(${openSessions.length})${RESET}`);
        lines.push(`${DIM}${'─'.repeat(LINE_WIDTH)}${RESET}`);

        for (const session of openSessions) {
          const sessionScore = evalResult?.scores.get(session.id);
          const isPaused = tracker.isSessionPaused(session);
          const openPause = session.pauses.find(p => p.to === null);

          const repoLabel = basename(session.repo);
          const dur = formatDuration(computeEffectiveDuration(session));
          const ema = sessionScore?.ema ?? 0;

          // Status badge + dot indicator
          let badge: string;
          if (isPaused && openPause) {
            badge = `${RED}PAUSED:${openPause.source}${RESET}`;
          } else if (session.state === 'active') {
            badge = `${GREEN}ACTIVE${RESET}`;
          } else {
            badge = `${YELLOW}PENDING${RESET}`;
          }
          const dot = (!isPaused && session.state === 'active') ? ` ${GREEN}●${RESET}` : '';
          const autoPauseOff = tracker.isAutoPauseDisabled(session.id) ? ` ${DIM}[AP OFF]${RESET}` : '';

          const COL1 = 18; // first value column width

          lines.push(`  ${BOLD}${repoLabel}${RESET}${dot}  ${badge}${autoPauseOff}`);
          const L = (label: string): string => `${INDENT}${DIM}${label.padEnd(LABEL_WIDTH)}${RESET}`;
          const R = (label: string): string => `${DIM}${label}${RESET} `;

          lines.push(`${L('Task')}${(session.task ?? '—').padEnd(COL1)}${R('branch')}${session.branch}`);
          const sinceTs = session.activatedAt ?? session.startedAt;
          const sinceTime = formatTime(new Date(sinceTs).getTime(), this.ctx.timezone);
          lines.push(`${L('Time')}${dur.padEnd(COL1)}${R('since')}${sinceTime}`);

          // Intensity bar (EMA) with autopause countdown
          const rawScore = sessionScore?.score ?? 0;
          const showAutopause = !isPaused && session.state === 'active' && rawScore > 0;
          const autoPauseStr = showAutopause
            ? `   ${DIM}auto-pause${RESET} ${formatDuration(rawScore * this.ctx.pollSeconds * 1000)}`
            : '';
          lines.push(`${L('Intensity')}${renderBar(ema, BAR_WIDTH)}${autoPauseStr}`);

          // Evidence: GitHub-style stats
          const ev = session.evidence;
          const filesStr = ev.filesChanged > 0 ? `${ev.filesChanged} files  ` : '';
          lines.push(`${L('Changes')}${ev.commits} commits  ${filesStr}${GREEN}+${ev.linesAdded}${RESET}  ${RED}-${ev.linesRemoved}${RESET}`);

          if (session.pauses.length > 0) {
            const totalPause = formatDuration(computeTotalPauseDuration(session));
            lines.push(`${L('Pauses')}${session.pauses.length} (${totalPause} total)`);
          }

          lines.push('');
        }
      }

      // Closed sessions summary
      if (closedSessions.length > 0) {
        lines.push(`${BOLD}  CLOSED SESSIONS${RESET} ${DIM}(${closedSessions.length})${RESET}`);
        lines.push(`${DIM}${'─'.repeat(LINE_WIDTH)}${RESET}`);

        for (const session of closedSessions) {
          const repoLabel = basename(session.repo).padEnd(18);
          const task = (session.task ?? '—').padEnd(14);
          const dur = formatDuration(computeEffectiveDuration(session)).padEnd(10);
          lines.push(`  ${DIM}${repoLabel}${task}${dur}closed(${session.closedBy})${RESET}`);
        }
        lines.push('');
      }
    }

    // Footer: actual work/downtime via interval merge
    const { workMs, downtimeMs, spanMs } = computeDaySummary(log.sessions);
    lines.push(`${DIM}${'─'.repeat(LINE_WIDTH)}${RESET}`);
    lines.push(`  ${BOLD}Worktime${RESET} ${formatDuration(workMs)}  ${BOLD}Idle${RESET} ${formatDuration(downtimeMs)}  ${BOLD}Total${RESET} ${formatDuration(spanMs)}`);

    // Write to stdout
    process.stdout.write(CLEAR + lines.join('\n') + '\n');
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

function formatTime(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(ts));
}

function renderBar(value: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const pct = (clamped * 100).toFixed(0).padStart(3);

  let color = RED;
  if (clamped >= 0.6) color = GREEN;
  else if (clamped >= 0.3) color = YELLOW;

  return `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET} ${pct}%`;
}
