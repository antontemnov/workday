// Mirrors the daemon HTTP API response types

export const EXPECTED_API_VERSION = 2;

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  apiVersion?: number;
}

export interface Evidence {
  commits: number;
  reflogEvents: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
}

export interface SessionDetail {
  id: string;
  repo: string;
  task: string | null;
  branch: string;
  state: string;            // 'pending' | 'active'
  startedAt: string;
  activatedAt: string | null;
  lastSeenAt: string;
  paused: boolean;
  pauseSource: string | null;
  effectiveDurationMs: number;
  manualMinutes: number;
  score: number;
  normalizedScore: number;
  isLeader: boolean;
  autoPauseDisabled: boolean;
  closedBy: string | null;
  evidence: Evidence;
  pauseCount: number;
  totalPauseDurationMs: number;
}

export interface TodayResponse {
  date: string;
  dayType: string;
  status: string;
  sessions: SessionDetail[];
  totalEffectiveMs: number;
  signalCount: number;
  budgetMs: number;
  claimedMs: number;
  remainingBudgetMs: number;
  dayStartedAt: string | null;
}

export interface StatusResponse {
  running: boolean;
  pid: number;
  date: string;
  uptime: number;
}
