import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename } from 'node:path';
import type { SessionTracker } from './core/session-tracker.js';
import { computeEffectiveDuration, computeTotalPauseDuration } from './core/daily-log.js';
import type {
  ApiResponse,
  StatusResponse,
  SessionSummary,
  TodayResponse,
  SessionDetail,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  AutoPauseResponse,
  Session,
} from './core/types.js';

const MAX_BODY_BYTES = 4096;

export interface HttpServerDeps {
  readonly sessionTracker: SessionTracker;
  readonly stopCallback: () => Promise<void>;
  readonly getStartedAt: () => number;
  readonly getCurrentDate: () => string;
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
      lastSeenAt: session.lastSeenAt,
      paused: tracker.isSessionPaused(session),
      pauseSource: openPause?.source ?? null,
      effectiveDurationMs: computeEffectiveDuration(session),
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
