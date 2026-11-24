import { SessionDetail, TimerState, TimerView, TimersResponse } from './models/workday.models';
import { formatMinutes, liveShareMs } from './timer/timer-clock.util';

export type TrayKind = 'live' | 'timer' | 'pending' | 'idle' | 'paused' | 'none';

export interface TrayStatus {
  readonly kind: TrayKind;
  readonly tooltip: string;
}

const APP_NAME = 'Workday';
// A timer without a ticket is named by the start of its description.
const TIMER_NAME_MAX = 24;

/**
 * What the tray icon says. The eyes burn with the colour of whoever counts:
 * green — a session, orange — a manual timer, empty sockets — nobody. A
 * paused timer does not change the icon. Times read to the minute.
 */
export function trayStatus(openSessions: readonly SessionDetail[], timers: TimersResponse | null, nowMs: number): TrayStatus {
  const running = timers?.timers.find(t => t.state === TimerState.Running);
  if (timers && running) {
    return { kind: 'timer', tooltip: `${APP_NAME} — timer ${timerLabel(running, timers, nowMs)}` };
  }
  return sessionStatus(openSessions);
}

function sessionStatus(open: readonly SessionDetail[]): TrayStatus {
  const live = open.find(s => !s.paused && s.state === 'active');
  if (live) return { kind: 'live', tooltip: `${APP_NAME} — ${repoName(live.repo)}${live.task ? ' · ' + live.task : ''}` };
  const pending = open.find(s => !s.paused && s.state !== 'active');
  if (pending) return { kind: 'pending', tooltip: `${APP_NAME} — ${repoName(pending.repo)} (pending)` };
  const idle = open.find(s => s.paused && s.pauseSource === 'idle_timeout');
  if (idle) return { kind: 'idle', tooltip: `${APP_NAME} — idle (${repoName(idle.repo)})` };
  const paused = open.find(s => s.paused);
  if (paused) return { kind: 'paused', tooltip: `${APP_NAME} — paused (${repoName(paused.repo)})` };
  return { kind: 'none', tooltip: APP_NAME };
}

// 47m · ATL-6712 — the time, then the ticket or the start of the description.
function timerLabel(timer: TimerView, timers: TimersResponse, nowMs: number): string {
  const time = formatMinutes(liveShareMs(timer, Date.parse(timers.asOf), nowMs));
  const name = timer.task ?? shortened(timer.description.trim());
  return name ? `${time} · ${name}` : time;
}

function shortened(text: string): string {
  return text.length > TIMER_NAME_MAX ? `${text.slice(0, TIMER_NAME_MAX - 1).trimEnd()}…` : text;
}

function repoName(repoPath: string): string {
  return repoPath.split('/').pop() ?? repoPath;
}
