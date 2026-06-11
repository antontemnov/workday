import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SessionTracker } from './core/session-tracker.js';
import {
  computeEffectiveDuration,
  computeTotalPauseDuration,
  computeManualMinutes,
  computeBudgetMs,
  computeTotalClaimedMs,
  getRemainingBudgetMs,
  computeActiveIntervals,
  computeDaySummary,
  resolveUiDayStart,
  readDailyLog,
  getOpenPause,
  listAvailableDates,
} from './core/daily-log.js';
import {
  computeWorkingDate,
  buildTimestamp,
  buildPatchedConfig,
  writeConfig,
  writeSecrets,
  loadSecrets,
} from './core/config.js';
import { MAX_BODY_BYTES, API_VERSION } from './core/constants.js';
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
  SensitivityResponse,
  AdjustResponse,
  SetStartResponse,
  DaysResponse,
  Session,
  Secrets,
  SettingsResponse,
  AddRepoResponse,
} from './core/types.js';
import { SensitivityLevel } from './core/types.js';

export interface HttpServerDeps {
  readonly sessionTracker: SessionTracker;
  readonly config: AppConfig;
  readonly stopCallback: () => Promise<void>;
  readonly getStartedAt: () => number;
  readonly getCurrentDate: () => string;
  readonly onBudgetFreed: () => void;
  /**
   * Forces an immediate evaluator tick — used after mutating actions so the
   * next read reflects leadership/auto-pause decisions without waiting for
   * the scheduled poll interval.
   */
  readonly forceTick: () => Promise<void>;
  /** Hot-apply config patch (serialized through tickQueue inside Daemon). */
  readonly applyConfigUpdate: (patch: Partial<AppConfig>) => Promise<void>;
  /** Add a repo to the tracked list (persists config.json on success). */
  readonly addRepo: (path: string) => Promise<{ ok: boolean; error?: string }>;
  /** Remove a repo (closes its open sessions, persists config.json). */
  readonly removeRepo: (path: string) => Promise<{ ok: boolean; error?: string }>;
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

  private setCorsHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    this.setCorsHeaders(res);

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      if (method === 'GET' && path === '/api/status') {
        return this.sendJson(res, 200, this.handleStatus());
      }
      if (method === 'GET' && path === '/api/today') {
        return this.sendJson(res, 200, this.handleToday());
      }
      if (method === 'POST' && path === '/api/pause') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handlePause(body));
      }
      if (method === 'POST' && path === '/api/resume') {
        return this.sendJson(res, 200, await this.handleResume());
      }
      if (method === 'POST' && path === '/api/sensitivity') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleSensitivity(body));
      }
      if (method === 'POST' && path === '/api/adjust') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleAdjust(body));
      }
      if (method === 'POST' && path === '/api/set-start') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleSetStart(body));
      }
      if (method === 'GET' && path === '/api/day') {
        const date = url.searchParams.get('date');
        return this.sendJson(res, 200, this.handleDay(date));
      }
      if (method === 'GET' && path === '/api/days') {
        return this.sendJson(res, 200, this.handleDays());
      }
      if (method === 'POST' && path === '/api/stop') {
        const response: ApiResponse<StopResponse> = { ok: true, data: { message: 'Daemon stopping...' } };
        this.sendJson(res, 200, response);
        setImmediate(() => void this.deps.stopCallback());
        return;
      }
      if (method === 'GET' && path === '/api/settings') {
        return this.sendJson(res, 200, this.handleGetSettings());
      }
      if (method === 'POST' && path === '/api/settings') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handlePostSettings(body));
      }
      if (method === 'POST' && path === '/api/repo') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleAddRepo(body));
      }
      if (method === 'POST' && path === '/api/repo/remove') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleRemoveRepo(body));
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
        dayStartedAt: resolveUiDayStart(log),
        manualStart: log.manualStart,
        schedule: { start: config.schedule.start, end: config.schedule.end },
        activeIntervals: computeActiveIntervals(log.sessions),
        downtimeMs: computeDaySummary(log.sessions).downtimeMs,
      },
    };
  }

  private async handlePause(body: Record<string, unknown>): Promise<ApiResponse<PauseResponse>> {
    const tracker = this.deps.sessionTracker;
    const repo = typeof body.repo === 'string' ? body.repo : null;
    const paused: string[] = [];

    if (repo) {
      if (tracker.pauseRepoSession(repo)) {
        paused.push(repo);
      }
    } else {
      const before = tracker.getOpenSessions().filter(s => !tracker.hasOpenPause(s));
      tracker.pauseAllSessions();
      paused.push(...before.map(s => s.repo));
    }

    tracker.flush();
    // Re-run evaluator so the remaining non-paused sessions settle leadership now.
    await this.deps.forceTick();
    return { ok: true, data: { paused } };
  }

  private async handleSensitivity(body: Record<string, unknown>): Promise<ApiResponse<SensitivityResponse>> {
    const tracker = this.deps.sessionTracker;
    // { level: 'low' | 'normal' | 'patient' | 'always_on', repo?: string }
    const rawLevel = typeof body.level === 'string' ? body.level : '';
    if (!isSensitivityLevel(rawLevel)) {
      return { ok: false, error: `Invalid level: ${rawLevel}. Use low|normal|patient|always_on` };
    }
    const repo = typeof body.repo === 'string' ? body.repo : undefined;

    tracker.setSensitivity(rawLevel, repo);
    tracker.flush();
    // Re-run evaluator so the new maxTicks takes effect immediately.
    await this.deps.forceTick();

    return {
      ok: true,
      data: {
        repo: repo ?? null,
        level: rawLevel,
      },
    };
  }

  private async handleResume(): Promise<ApiResponse<ResumeResponse>> {
    const tracker = this.deps.sessionTracker;
    const before = tracker.getOpenSessions().filter(s => tracker.hasOpenPause(s));
    tracker.resumeAllSessions();
    tracker.flush();
    // Re-run evaluator immediately so Superseded/IdleTimeout are re-applied
    // before the client fetches the next state snapshot.
    await this.deps.forceTick();

    return { ok: true, data: { resumed: before.map(s => s.repo) } };
  }

  private async handleAdjust(body: Record<string, unknown>): Promise<ApiResponse<AdjustResponse>> {
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
    const response: ApiResponse<AdjustResponse> = {
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

    // Re-run evaluator so a tick after manual adjustment picks up any
    // budget-exhaustion implications (may close sessions).
    await this.deps.forceTick();
    return response;
  }

  private async handleSetStart(body: Record<string, unknown>): Promise<ApiResponse<SetStartResponse>> {
    const tracker = this.deps.sessionTracker;
    const log = tracker.getDailyLog();
    const config = this.deps.config;

    const rawTime = typeof body.time === 'string' ? body.time : '';
    const wantClear = body.clear === true || rawTime === '';

    let isoTimestamp: string | null = null;
    if (!wantClear) {
      const match = rawTime.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) return { ok: false, error: 'Invalid time format. Use HH:MM' };
      isoTimestamp = buildTimestamp(log.date, parseInt(match[1]), parseInt(match[2]), config.timezone);
    }

    const result = tracker.setManualDayStart(isoTimestamp);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    tracker.flush();

    // If budget was exhausted and now freed, notify daemon
    if (!tracker.isBudgetExhausted()) {
      this.deps.onBudgetFreed();
    }

    const response: ApiResponse<SetStartResponse> = {
      ok: true,
      data: {
        dayStart: isoTimestamp ?? '',
        budgetMs: computeBudgetMs(log, config),
        remainingBudgetMs: getRemainingBudgetMs(log, config),
      },
    };

    // Re-run evaluator so budget state settles before the next read.
    await this.deps.forceTick();
    return response;
  }

  // ─── Settings ────────────────────────────────────────────────────

  private handleGetSettings(): ApiResponse<SettingsResponse> {
    const c = this.deps.config;
    let jiraConfigured = false;
    let tempoConfigured = false;
    try {
      const s = loadSecrets();
      jiraConfigured = !!s.Jira_Token && s.Jira_Token.trim().length > 0;
      tempoConfigured = !!s.Tempo_Token && s.Tempo_Token.trim().length > 0;
    } catch { /* secrets missing → both false */ }

    return {
      ok: true,
      data: {
        config: {
          repos: [...c.repos],
          schedule: { start: c.schedule.start, end: c.schedule.end },
          timezone: c.timezone,
          taskPattern: c.taskPattern,
          sensitivity: {
            default: c.sensitivity.default,
            perRepo: { ...c.sensitivity.perRepo },
          },
        },
        secretsMeta: { jiraConfigured, tempoConfigured },
      },
    };
  }

  private async handlePostSettings(body: Record<string, unknown>): Promise<ApiResponse<SettingsResponse>> {
    const patch = body as {
      config?: Partial<AppConfig>;
      secrets?: { jiraToken?: string; tempoToken?: string };
    };

    if (patch.config) {
      const forbidden = ['apiPort', 'session', 'report', 'workDays', 'holidays', 'genericBranches'];
      for (const f of forbidden) {
        if (f in patch.config) {
          return { ok: false, error: `Field "${f}" cannot be changed via API` };
        }
      }
      try {
        const merged = buildPatchedConfig(this.deps.config, patch.config);
        await this.deps.applyConfigUpdate(patch.config);
        writeConfig(merged);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (patch.secrets) {
      try {
        let current: Secrets;
        try { current = loadSecrets(); }
        catch {
          current = { Developer: '', Jira_Email: '', Jira_BaseUrl: '', Jira_Token: '', Tempo_Token: '' };
        }
        const next: Secrets = {
          ...current,
          ...(patch.secrets.jiraToken !== undefined ? { Jira_Token: patch.secrets.jiraToken } : {}),
          ...(patch.secrets.tempoToken !== undefined ? { Tempo_Token: patch.secrets.tempoToken } : {}),
        };
        writeSecrets(next);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    await this.deps.forceTick();
    return this.handleGetSettings();
  }

  private async handleAddRepo(body: Record<string, unknown>): Promise<ApiResponse<AddRepoResponse>> {
    const path = typeof body.path === 'string' ? body.path.trim() : '';
    if (!path) return { ok: false, error: 'Missing path' };
    if (!isAbsolute(path)) return { ok: false, error: 'Path must be absolute' };
    if (!existsSync(path)) return { ok: false, error: `Directory not found: ${path}` };
    if (!existsSync(join(path, '.git'))) return { ok: false, error: `Not a git repository: ${path}` };
    if (this.deps.config.repos.includes(path)) return { ok: false, error: 'Already added' };

    const r = await this.deps.addRepo(path);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: { repos: [...this.deps.config.repos] } };
  }

  private async handleRemoveRepo(body: Record<string, unknown>): Promise<ApiResponse<AddRepoResponse>> {
    const path = typeof body.path === 'string' ? body.path : '';
    if (!path) return { ok: false, error: 'Missing path' };
    const r = await this.deps.removeRepo(path);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, data: { repos: [...this.deps.config.repos] } };
  }

  private handleDay(date: string | null): ApiResponse<TodayResponse> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: 'Missing or invalid date. Use ?date=YYYY-MM-DD' };
    }

    const config = this.deps.config;

    // If requesting today, delegate to handleToday
    const today = computeWorkingDate(Date.now(), config.schedule.end, config.timezone);
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
      sensitivity: SensitivityLevel.Normal,
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
        dayStartedAt: resolveUiDayStart(log),
        manualStart: log.manualStart,
        schedule: { start: config.schedule.start, end: config.schedule.end },
        activeIntervals: computeActiveIntervals(log.sessions),
        downtimeMs: computeDaySummary(log.sessions).downtimeMs,
      },
    };
  }

  private handleDays(): ApiResponse<DaysResponse> {
    return { ok: true, data: { dates: listAvailableDates() } };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private toSessionSummary(session: Session, tracker: SessionTracker): SessionSummary {
    const evalResult = tracker.getLastEvaluatorResult();
    const sessionScore = evalResult?.scores.get(session.id);
    const openPause = getOpenPause(session);

    return {
      id: session.id,
      repo: session.repo,
      task: session.task,
      branch: session.branch,
      state: session.state,
      startedAt: session.startedAt,
      activatedAt: session.activatedAt ?? null,
      lastSeenAt: session.lastSeenAt,
      paused: tracker.hasOpenPause(session),
      pauseSource: openPause?.source ?? null,
      effectiveDurationMs: computeEffectiveDuration(session),
      manualMinutes: computeManualMinutes(session),
      score: sessionScore?.score ?? 0,
      normalizedScore: sessionScore?.normalizedScore ?? 0,
      isLeader: evalResult?.leaderId === session.id,
      sensitivity: tracker.getSensitivity(session.repo),
    };
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    const enriched = { ...(data as Record<string, unknown>), apiVersion: API_VERSION };
    const body = JSON.stringify(enriched);
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

function isSensitivityLevel(value: string): value is SensitivityLevel {
  return value === SensitivityLevel.Low
    || value === SensitivityLevel.Normal
    || value === SensitivityLevel.Patient
    || value === SensitivityLevel.AlwaysOn;
}
