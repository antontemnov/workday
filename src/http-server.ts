import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { SessionTracker } from './core/session-tracker.js';
import {
  computeEffectiveDuration,
  computeTotalPauseDuration,
  computeManualMinutes,
  computeBudgetMs,
  computeTotalClaimedMs,
  getRemainingBudgetMs,
  readDailyLog,
} from './core/daily-log.js';
import { computeWorkingDate } from './core/config.js';
import type {
  AppConfig,
  ApiResponse,
  StatusResponse,
  SessionSummary,
  TodayResponse,
  SessionDetail,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  AutoPauseResponse,
  AdjustResponse,
  SetStartResponse,
  Session,
} from './core/types.js';

const MAX_BODY_BYTES = 4096;

export interface HttpServerDeps {
  readonly sessionTracker: SessionTracker;
  readonly config: AppConfig;
  readonly stopCallback: () => Promise<void>;
  readonly getStartedAt: () => number;
  readonly getCurrentDate: () => string;
  readonly onBudgetFreed: () => void;
}

export class HttpServer {
  private server: Server | null = null;
  private readonly port: number;
  private readonly deps: HttpServerDeps;

  public constructor(port: number, deps: HttpServerDeps) {
    this.port = port;
    this.deps = deps;
  }

  public async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = createServer((req, res) => void this.handleRequest(req, res));

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} already in use`));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  public async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
    });
  }

  // ─── Router ─────────────────────────────────────────────────────────

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    try {
      if (method === 'GET' && path === '/api/status') {
        return this.sendJson(res, 200, this.handleStatus());
      }
      if (method === 'GET' && path === '/api/today') {
        return this.sendJson(res, 200, this.handleToday());
      }
      if (method === 'POST' && path === '/api/pause') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handlePause(body));
      }
      if (method === 'POST' && path === '/api/resume') {
        return this.sendJson(res, 200, this.handleResume());
      }
      if (method === 'POST' && path === '/api/autopause') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handleAutoPause(body));
      }
      if (method === 'POST' && path === '/api/adjust') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handleAdjust(body));
      }
      if (method === 'POST' && path === '/api/set-start') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handleSetStart(body));
      }
      if (method === 'GET' && path === '/api/day') {
        const date = url.searchParams.get('date');
        return this.sendJson(res, 200, this.handleDay(date));
      }
      if (method === 'POST' && path === '/api/stop') {
        const response: ApiResponse<StopResponse> = { ok: true, data: { message: 'Daemon stopping...' } };
        this.sendJson(res, 200, response);
        setImmediate(() => void this.deps.stopCallback());
        return;
      }

      this.sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendJson(res, 500, { ok: false, error: message });
    }
  }

  // ─── Handlers ─────────────────────────────────────────────────────

  private handleStatus(): ApiResponse<StatusResponse> {
    const tracker = this.deps.sessionTracker;
    const openSessions = tracker.getOpenSessions();
    const summaries: SessionSummary[] = openSessions.map(s => this.toSessionSummary(s, tracker));

    return {
      ok: true,
      data: {
        running: true,
        pid: process.pid,
        date: this.deps.getCurrentDate(),
        uptime: Math.floor((Date.now() - this.deps.getStartedAt()) / 1000),
        openSessions: summaries,
      },
    };
  }

  private handleToday(): ApiResponse<TodayResponse> {
    const tracker = this.deps.sessionTracker;
    const log = tracker.getDailyLog();
    const config = this.deps.config;

    const sessions: SessionDetail[] = log.sessions.map(s => ({
      ...this.toSessionSummary(s, tracker),
      closedBy: s.closedBy,
      evidence: s.evidence,
      pauseCount: s.pauses.length,
      totalPauseDurationMs: computeTotalPauseDuration(s),
    }));

    const totalEffectiveMs = log.sessions.reduce(
      (sum, s) => sum + computeEffectiveDuration(s), 0,
    );

    return {
      ok: true,
      data: {
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
      },
    };
  }

  private handlePause(body: Record<string, unknown>): ApiResponse<PauseResponse> {
    const tracker = this.deps.sessionTracker;
    const repo = typeof body.repo === 'string' ? body.repo : null;
    const paused: string[] = [];

    if (repo) {
      if (tracker.pauseRepoSession(repo)) {
        paused.push(repo);
      }
    } else {
      const before = tracker.getOpenSessions().filter(s => !tracker.isSessionPaused(s));
      tracker.pauseAllSessions();
      paused.push(...before.map(s => s.repo));
    }

    tracker.flush();
    return { ok: true, data: { paused } };
  }

  private handleAutoPause(body: Record<string, unknown>): ApiResponse<AutoPauseResponse> {
    const tracker = this.deps.sessionTracker;
    // { enabled: boolean, repo?: string } — enabled=true means autopause ON (not disabled)
    const enabled = body.enabled !== false;
    const repo = typeof body.repo === 'string' ? body.repo : undefined;
    const disabled = !enabled;

    const affected = tracker.setAutoPauseDisabled(disabled, repo);
    tracker.flush();

    return {
      ok: true,
      data: {
        repo: repo ?? null,
        autoPauseDisabled: disabled,
      },
    };
  }

  private handleResume(): ApiResponse<ResumeResponse> {
    const tracker = this.deps.sessionTracker;
    const before = tracker.getOpenSessions().filter(s => tracker.isSessionPaused(s));
    tracker.resumeAllSessions();
    tracker.flush();

    return { ok: true, data: { resumed: before.map(s => s.repo) } };
  }

  private handleAdjust(body: Record<string, unknown>): ApiResponse<AdjustResponse> {
    const target = typeof body.target === 'string' ? body.target : '';
    const minutes = typeof body.minutes === 'number' ? body.minutes : 0;
    const reason = typeof body.reason === 'string' ? body.reason : '';

    if (!target) return { ok: false, error: 'Missing target (session index or id)' };
    if (!reason) return { ok: false, error: 'Missing reason' };

    const tracker = this.deps.sessionTracker;
    const result = tracker.addAdjustment(target, minutes, reason);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    tracker.flush();

    const log = tracker.getDailyLog();
    const session = log.sessions.find(s => s.id === result.sessionId)!;

    return {
      ok: true,
      data: {
        sessionId: session.id,
        repo: session.repo,
        task: session.task,
        addedMinutes: minutes,
        totalManualMinutes: computeManualMinutes(session),
        remainingBudgetMs: getRemainingBudgetMs(log, this.deps.config),
      },
    };
  }

  private handleSetStart(body: Record<string, unknown>): ApiResponse<SetStartResponse> {
    const time = typeof body.time === 'string' ? body.time : '';
    if (!time) return { ok: false, error: 'Missing time (HH:MM format)' };

    // Parse HH:MM to ISO timestamp for current working date
    const match = time.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return { ok: false, error: 'Invalid time format. Use HH:MM' };

    const tracker = this.deps.sessionTracker;
    const log = tracker.getDailyLog();
    const config = this.deps.config;

    // Build ISO timestamp from current date + provided time in config timezone
    const isoTimestamp = this.buildTimestamp(log.date, parseInt(match[1]), parseInt(match[2]), config.timezone);

    const result = tracker.setManualDayStart(isoTimestamp);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    tracker.flush();

    // If budget was exhausted and now freed, notify daemon
    if (!tracker.isBudgetExhausted()) {
      this.deps.onBudgetFreed();
    }

    return {
      ok: true,
      data: {
        dayStart: isoTimestamp,
        budgetMs: computeBudgetMs(log, config),
        remainingBudgetMs: getRemainingBudgetMs(log, config),
      },
    };
  }

  private handleDay(date: string | null): ApiResponse<TodayResponse> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: 'Missing or invalid date. Use ?date=YYYY-MM-DD' };
    }

    const config = this.deps.config;

    // If requesting today, delegate to handleToday
    const today = computeWorkingDate(Date.now(), config.dayBoundaryHour, config.timezone);
    if (date === today) {
      return this.handleToday();
    }

    // Read past day from disk
    const log = readDailyLog(date);
    if (!log) {
      return { ok: false, error: `No data for ${date}` };
    }

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

    return {
      ok: true,
      data: {
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
      },
    };
  }

  /** Build ISO timestamp from date + hour:minute in timezone */
  private buildTimestamp(date: string, hour: number, minute: number, timezone: string): string {
    const [year, month, day] = date.split('-').map(Number);
    // Start with UTC guess, then adjust for timezone offset
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
      minute: 'numeric',
    }).formatToParts(guess);
    const actualHour = parseInt(parts.find(p => p.type === 'hour')!.value);
    const actualMinute = parseInt(parts.find(p => p.type === 'minute')!.value);
    const h = actualHour === 24 ? 0 : actualHour;
    const diffMs = ((hour - h) * 60 + (minute - actualMinute)) * 60_000;
    return new Date(guess.getTime() + diffMs).toISOString();
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private toSessionSummary(session: Session, tracker: SessionTracker): SessionSummary {
    const evalResult = tracker.getLastEvaluatorResult();
    const sessionScore = evalResult?.scores.get(session.id);
    const openPause = session.pauses.find(p => p.to === null);

    return {
      id: session.id,
      repo: session.repo,
      task: session.task,
      branch: session.branch,
      state: session.state,
      startedAt: session.startedAt,
      activatedAt: session.activatedAt ?? null,
      lastSeenAt: session.lastSeenAt,
      paused: tracker.isSessionPaused(session),
      pauseSource: openPause?.source ?? null,
      effectiveDurationMs: computeEffectiveDuration(session),
      manualMinutes: computeManualMinutes(session),
      score: sessionScore?.score ?? 0,
      normalizedScore: sessionScore?.normalizedScore ?? 0,
      isLeader: evalResult?.leaderId === session.id,
      autoPauseDisabled: tracker.isAutoPauseDisabled(session.id),
    };
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  private readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (size === 0) { resolve({}); return; }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          reject(new Error('Invalid JSON body'));
        }
      });

      req.on('error', reject);
    });
  }
}
