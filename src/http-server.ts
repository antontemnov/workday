import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { SessionTracker } from './core/session-tracker.js';
import {
  computeEffectiveDuration,
  computeTotalPauseDuration,
  computeTotalClaimedMs,
  computeTotalManualEntryMs,
  computeActiveIntervals,
  computeDaySummary,
  resolveUiDayStart,
  readDailyLog,
  getOpenPause,
  findManualEntry,
  resolveManualEntryTarget,
  listAvailableDates,
} from './core/daily-log.js';
import { resolveActivityTypes } from './push/activity-types.js';
import {
  addEntryOnDate,
  addSessionEntryOnDate,
  editEntryOnDate,
  deleteEntryOnDate,
} from './core/day-edit.js';
import { loadFavorites, saveFavorites, addFavorite, removeFavorite } from './core/favorites.js';
import {
  isJiraConfigured, searchIssues, checkIssueExists,
  loadCachedSummaries, backfillIssueSummaries,
} from './push/jira-client.js';
import { buildMonthResponse } from './push/month-report.js';
import { getDefaultFromDate, getDefaultToDate } from './push/report-builder.js';
import { runPush } from './push/tempo-pusher.js';
import { recordEntryDeletion } from './push/push-log.js';
import { fetchMonthSnapshot } from './push/tempo-snapshot.js';
import { importTempoWorklogs, type ImportEntryInput } from './push/tempo-import.js';
import { resolveMonthSchedule, scheduleUnavailable } from './push/tempo-schedule.js';
import { resolveMonthApproval, approvalUnavailable } from './push/tempo-approvals.js';
import {
  computeWorkingDate,
  buildPatchedConfig,
  writeConfig,
  writeSecrets,
  loadSecrets,
  tryLoadSecrets,
} from './core/config.js';
import {
  MAX_BODY_BYTES,
  API_VERSION,
  MS_PER_MINUTE,
  DEFAULT_MANUAL_ACTIVITY,
  JIRA_SEARCH_MIN_QUERY_LENGTH,
} from './core/constants.js';
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
  SessionDeleteResponse,
  ManualEntry,
  ManualEntryResponse,
  ManualEntryDeleteResponse,
  FavoritesResponse,
  FavoriteAddResponse,
  FavoriteRemoveResponse,
  JiraSearchResponse,
  ActivityTypesResponse,
  DaysResponse,
  Session,
  Secrets,
  SettingsResponse,
  AddRepoResponse,
  UpdateCheckResponse,
  UpdateApplyResponse,
  WatchingRepo,
  DailyLog,
  MonthResponse,
  PushResponse,
  TempoScheduleResponse,
  TempoApprovalResponse,
  TempoSyncResponse,
  TempoImportResponse,
} from './core/types.js';
import { ApiErrorCode, DayStatus, SensitivityLevel, SessionState } from './core/types.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface HttpServerDeps {
  readonly sessionTracker: SessionTracker;
  readonly config: AppConfig;
  readonly stopCallback: () => Promise<void>;
  readonly getStartedAt: () => number;
  readonly getCurrentDate: () => string;
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
  /** Installed daemon version (from package.json on disk). */
  readonly getVersion: () => string;
  /** Ask npm registry whether a newer daemon exists. */
  readonly checkUpdate: () => Promise<UpdateCheckResponse>;
  /** Install latest + graceful self-restart (skips the quiet window). */
  readonly applyUpdate: () => Promise<UpdateApplyResponse>;
  /** Repos on a task branch as of the last poll — watching-card synthesis. */
  readonly getWatchingRepos: () => readonly WatchingRepo[];
}

// ─── Watching-card synthesis (A-6) ─────────────────────────────────────
//
// The API session list is a live view: real sessions + candidates (honest
// PENDING) + a synthetic card per configured repo sitting on a task branch
// with neither. Synthetics exist ONLY in the response array — they never
// reach totals, intervals or the day summary.

/** Watching repos that still need a synthetic card (no session, no candidate). */
export function selectWatchingRepos(
  watching: readonly WatchingRepo[],
  occupiedRepos: ReadonlySet<string>,
): readonly WatchingRepo[] {
  return watching.filter(w => !occupiedRepos.has(w.repoName));
}

/** Synthetic PENDING card for a watched repo — zeros, real sensitivity. */
export function buildWatchingCard(
  repo: WatchingRepo,
  sensitivity: SensitivityLevel,
  now: string,
): SessionDetail {
  return {
    id: `watch:${repo.repoName}`,
    repo: repo.repoName,
    task: repo.task,
    branch: repo.branch,
    state: SessionState.Pending,
    startedAt: now,
    activatedAt: null,
    lastSeenAt: now,
    paused: false,
    pauseSource: null,
    effectiveDurationMs: 0,
    score: 0,
    normalizedScore: 0,
    isLeader: false,
    sensitivity,
    closedBy: null,
    evidence: { commits: 0, reflogEvents: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
    pauseCount: 0,
    totalPauseDurationMs: 0,
  };
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
      if (method === 'POST' && path === '/api/session/delete') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handleSessionDelete(body));
      }
      if (method === 'POST' && path === '/api/manual-entry') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleAddManualEntry(body));
      }
      if (method === 'POST' && path === '/api/manual-entry/update') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleUpdateManualEntry(body));
      }
      if (method === 'POST' && path === '/api/manual-entry/delete') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handleDeleteManualEntry(body));
      }
      if (method === 'GET' && path === '/api/favorites') {
        return this.sendJson(res, 200, this.handleGetFavorites());
      }
      if (method === 'POST' && path === '/api/favorites') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleAddFavorite(body));
      }
      if (method === 'POST' && path === '/api/favorites/remove') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, this.handleRemoveFavorite(body));
      }
      if (method === 'GET' && path === '/api/jira/search') {
        const query = url.searchParams.get('q') ?? '';
        return this.sendJson(res, 200, await this.handleJiraSearch(query));
      }
      if (method === 'GET' && path === '/api/activity-types') {
        return this.sendJson(res, 200, await this.handleActivityTypes());
      }
      if (method === 'GET' && path === '/api/day') {
        const date = url.searchParams.get('date');
        return this.sendJson(res, 200, this.handleDay(date));
      }
      if (method === 'GET' && path === '/api/days') {
        return this.sendJson(res, 200, this.handleDays());
      }
      if (method === 'GET' && path === '/api/month') {
        return this.sendJson(res, 200, this.handleMonth(url));
      }
      if (method === 'POST' && path === '/api/push') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handlePush(body));
      }
      if (method === 'POST' && path === '/api/tempo-sync') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleTempoSync(body));
      }
      if (method === 'POST' && path === '/api/tempo-import') {
        const body = await this.readBody(req);
        return this.sendJson(res, 200, await this.handleTempoImport(body));
      }
      if (method === 'GET' && path === '/api/tempo/schedule') {
        return this.sendJson(res, 200, await this.handleTempoSchedule(url));
      }
      if (method === 'GET' && path === '/api/tempo/approval') {
        return this.sendJson(res, 200, await this.handleTempoApproval(url));
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
      if (method === 'GET' && path === '/api/update/check') {
        try {
          const data = await this.deps.checkUpdate();
          return this.sendJson(res, 200, { ok: true, data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return this.sendJson(res, 200, { ok: false, error: `Update check failed: ${message}` });
        }
      }
      if (method === 'POST' && path === '/api/update/apply') {
        try {
          const data = await this.deps.applyUpdate();
          return this.sendJson(res, 200, { ok: true, data });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return this.sendJson(res, 200, { ok: false, error: `Update failed: ${message}` });
        }
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
    const { candidates, watching, now } = this.collectLiveExtras();
    const summaries: SessionSummary[] = [
      ...openSessions.map(s => this.toSessionSummary(s, tracker)),
      ...candidates.map(s => this.toSessionSummary(s, tracker)),
      ...watching.map(w => buildWatchingCard(w, tracker.getSensitivity(w.repoName), now)),
    ];

    return {
      ok: true,
      data: {
        running: true,
        pid: process.pid,
        version: this.deps.getVersion(),
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

    const toDetail = (s: Session): SessionDetail => ({
      ...this.toSessionSummary(s, tracker),
      closedBy: s.closedBy,
      evidence: s.evidence,
      pauseCount: s.pauses.length,
      totalPauseDurationMs: computeTotalPauseDuration(s),
    });

    // Live view: real sessions (log order) → candidates → watching cards.
    // Totals below are computed from log.sessions only — synthetics and
    // candidates never contribute time.
    const { candidates, watching, now } = this.collectLiveExtras();
    const sessions: SessionDetail[] = [
      ...log.sessions.map(toDetail),
      ...candidates.map(toDetail),
      ...watching.map(w => buildWatchingCard(w, tracker.getSensitivity(w.repoName), now)),
    ];

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
        manualEntries: log.manualEntries ?? [],
        totalEffectiveMs,
        signalCount: log.signals.length,
        claimedMs: computeTotalClaimedMs(log),
        dayStart: resolveUiDayStart(log),
        activeIntervals: computeActiveIntervals(log.sessions),
        downtimeMs: computeDaySummary(log.sessions).downtimeMs,
        issueSummaries: this.buildIssueSummaries(log),
      },
    };
  }

  // Ticket summaries for the day's tasks (Logged table). Cached lookups only —
  // synchronous, never blocks the response; a background fill pulls any missing
  // ones into the cache so they surface on the next poll.
  private buildIssueSummaries(log: DailyLog): Record<string, string> {
    const keys = [...new Set([
      ...(log.manualEntries ?? []).map(e => e.task),
      ...log.sessions.map(s => s.task).filter((t): t is string => !!t),
    ])];
    if (keys.length === 0) return {};
    const secrets = tryLoadSecrets();
    if (secrets && isJiraConfigured(secrets)) {
      // Fire-and-forget: a floating rejection would crash the daemon (no global
      // unhandledRejection handler), so neutralize it at the boundary too.
      backfillIssueSummaries(keys, secrets).catch(() => {});
    }
    return loadCachedSummaries(keys);
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

  private handleSessionDelete(body: Record<string, unknown>): ApiResponse<SessionDeleteResponse> {
    const target = typeof body.target === 'string' ? body.target : '';
    if (!target) return { ok: false, error: 'Missing target (session index or id)' };

    const tracker = this.deps.sessionTracker;
    const wasPushed = tracker.getDailyLog().pushedAt !== null;
    const result = tracker.deleteSession(target);
    if (!result.ok || !result.deleted) {
      return { ok: false, error: result.error };
    }

    const s = result.deleted;
    return {
      ok: true,
      data: {
        id: s.id,
        repo: s.repo,
        task: s.task,
        effectiveDurationMs: computeEffectiveDuration(s),
        dayFileDeleted: result.dayFileDeleted ?? false,
        dayWasPushed: wasPushed,
      },
    };
  }

  // ─── Manual entries ──────────────────────────────────────────────

  /**
   * Optional past-day override for manual-entry mutations. null = operate on
   * today via the tracker; a string = disk path through day-edit. Today's
   * own date normalizes to null so the in-memory log stays authoritative.
   */
  private resolveEditDate(body: Record<string, unknown>): { date: string | null } | { error: string } {
    if (body.date === undefined || body.date === null) return { date: null };
    const date = typeof body.date === 'string' ? body.date : '';
    if (!DATE_RE.test(date)) return { error: 'Invalid date. Use YYYY-MM-DD' };
    const today = this.deps.getCurrentDate();
    if (date > today) return { error: `Cannot log on a future date (${date} > ${today})` };
    return { date: date === today ? null : date };
  }

  private toEntryResponse(entry: ManualEntry, log: DailyLog): ApiResponse<ManualEntryResponse> {
    return {
      ok: true,
      data: {
        id: entry.id,
        task: entry.task,
        minutes: entry.minutes,
        description: entry.description,
        activity: entry.activity,
        date: log.date,
        totalManualMinutes: Math.round(computeTotalManualEntryMs(log) / MS_PER_MINUTE),
      },
    };
  }

  private async handleAddManualEntry(body: Record<string, unknown>): Promise<ApiResponse<ManualEntryResponse>> {
    const tracker = this.deps.sessionTracker;
    const minutes = typeof body.minutes === 'number' ? body.minutes : NaN;
    const parsed = this.resolveEditDate(body);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const pastDate = parsed.date;

    // Session-born ("+ Add time" on a card): the session is the source of
    // truth for the task; activity/description are fixed by the domain rule.
    const sourceSessionId = typeof body.sourceSessionId === 'string' ? body.sourceSessionId : '';
    if (sourceSessionId && pastDate) {
      try {
        const { entry, log } = addSessionEntryOnDate(pastDate, sourceSessionId, minutes, this.deps.config);
        return this.toEntryResponse(entry, log);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (sourceSessionId) {
      const result = tracker.addSessionEntry(sourceSessionId, minutes);
      if (!result.ok || !result.entry) return { ok: false, error: result.error };
      tracker.flush();
      return this.toEntryResponse(result.entry, tracker.getDailyLog());
    }

    const task = typeof body.task === 'string' ? body.task : '';
    const description = typeof body.description === 'string' ? body.description : '';
    const activity = typeof body.activity === 'string' && body.activity.trim()
      ? body.activity
      : DEFAULT_MANUAL_ACTIVITY;

    if (!task) return { ok: false, error: 'Missing task' };
    // Description validated in core against the activity rule (required
    // for everything but Development).
    // User-picked task must exist in Jira; session-born tasks come from
    // git and are validated at push time instead.
    const jiraError = await this.validateTaskInJira(task);
    if (jiraError) return jiraError;

    if (pastDate) {
      try {
        const { entry, log } = addEntryOnDate(pastDate, { task, minutes, description, activity }, this.deps.config);
        return this.toEntryResponse(entry, log);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const result = tracker.addManualEntry({ task, minutes, description, activity });
    if (!result.ok || !result.entry) return { ok: false, error: result.error };
    tracker.flush();
    return this.toEntryResponse(result.entry, tracker.getDailyLog());
  }

  private async handleUpdateManualEntry(body: Record<string, unknown>): Promise<ApiResponse<ManualEntryResponse>> {
    const target = typeof body.target === 'string' ? body.target
      : (typeof body.id === 'string' ? body.id : '');
    if (!target) return { ok: false, error: 'Missing target (manual entry #index or id)' };
    const parsed = this.resolveEditDate(body);
    if ('error' in parsed) return { ok: false, error: parsed.error };

    const patch: { minutes?: number; description?: string; activity?: string } = {};
    if (typeof body.minutes === 'number') patch.minutes = body.minutes;
    if (typeof body.description === 'string') patch.description = body.description;
    if (typeof body.activity === 'string') patch.activity = body.activity;

    if (parsed.date) {
      try {
        const { entry, log } = editEntryOnDate(parsed.date, target, patch, this.deps.config);
        return this.toEntryResponse(entry, log);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const tracker = this.deps.sessionTracker;
    const found = resolveManualEntryTarget(tracker.getDailyLog(), target);
    if (!found) return { ok: false, error: `Manual entry not found: ${target}` };
    const result = tracker.editManualEntry(found.id, patch);
    if (!result.ok) return { ok: false, error: result.error };
    tracker.flush();

    const log = tracker.getDailyLog();
    const entry = findManualEntry(log, found.id);
    if (!entry) return { ok: false, error: 'Manual entry not found after update' };
    return this.toEntryResponse(entry, log);
  }

  private handleDeleteManualEntry(body: Record<string, unknown>): ApiResponse<ManualEntryDeleteResponse> {
    const target = typeof body.target === 'string' ? body.target
      : (typeof body.id === 'string' ? body.id : '');
    if (!target) return { ok: false, error: 'Missing target (manual entry #index or id)' };
    const parsed = this.resolveEditDate(body);
    if ('error' in parsed) return { ok: false, error: parsed.error };

    if (parsed.date) {
      try {
        const { deleted, log, dayFileDeleted } = deleteEntryOnDate(parsed.date, target);
        recordEntryDeletion(parsed.date, deleted.task, deleted.id);
        return {
          ok: true,
          data: {
            id: deleted.id,
            task: deleted.task,
            minutes: deleted.minutes,
            date: parsed.date,
            totalManualMinutes: dayFileDeleted ? 0 : Math.round(computeTotalManualEntryMs(log) / MS_PER_MINUTE),
            dayFileDeleted,
          },
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const tracker = this.deps.sessionTracker;
    const found = resolveManualEntryTarget(tracker.getDailyLog(), target);
    if (!found) return { ok: false, error: `Manual entry not found: ${target}` };
    const result = tracker.deleteManualEntry(found.id);
    if (!result.ok || !result.deleted) return { ok: false, error: result.error };
    tracker.flush();
    recordEntryDeletion(tracker.getDailyLog().date, result.deleted.task, result.deleted.id);

    return {
      ok: true,
      data: {
        id: result.deleted.id,
        task: result.deleted.task,
        minutes: result.deleted.minutes,
        date: tracker.getDailyLog().date,
        totalManualMinutes: Math.round(computeTotalManualEntryMs(tracker.getDailyLog()) / MS_PER_MINUTE),
      },
    };
  }

  // ─── Favorites (manual-entry templates) ───────────────────────────

  private handleGetFavorites(): ApiResponse<FavoritesResponse> {
    try {
      return { ok: true, data: { favorites: loadFavorites() } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleAddFavorite(body: Record<string, unknown>): Promise<ApiResponse<FavoriteAddResponse>> {
    const name = typeof body.name === 'string' ? body.name : '';
    const task = typeof body.task === 'string' ? body.task : '';
    const minutes = typeof body.minutes === 'number' ? body.minutes : NaN;
    const activity = typeof body.activity === 'string' && body.activity.trim()
      ? body.activity
      : DEFAULT_MANUAL_ACTIVITY;

    try {
      const favorites = loadFavorites();
      const added = addFavorite(favorites, { name, task, minutes, activity }, this.deps.config);
      const jiraError = await this.validateTaskInJira(added.task);
      if (jiraError) return jiraError;
      saveFavorites(favorites);
      return { ok: true, data: { added, favorites } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Jira search & validation ─────────────────────────────────────

  private async handleJiraSearch(query: string): Promise<ApiResponse<JiraSearchResponse>> {
    const trimmed = query.trim();
    if (trimmed.length < JIRA_SEARCH_MIN_QUERY_LENGTH) {
      return { ok: true, data: { hits: [] } };
    }

    const secrets = tryLoadSecrets();
    if (!secrets || !isJiraConfigured(secrets)) {
      return {
        ok: false,
        error: 'Jira API is not configured — set the token in Settings',
        errorCode: ApiErrorCode.JiraNotConfigured,
      };
    }

    try {
      const hits = await searchIssues(trimmed, secrets, this.deps.config.search.projectKeys);
      return { ok: true, data: { hits } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Existence gate for user-picked tasks. Returns the error response to send,
   * or null when logging may proceed: issue found, Jira not configured, or
   * Jira unreachable (offline must not block logging — push re-validates).
   */
  private async validateTaskInJira(task: string): Promise<ApiResponse<never> | null> {
    const secrets = tryLoadSecrets();
    if (!secrets || !isJiraConfigured(secrets)) return null;
    try {
      const issue = await checkIssueExists(task, secrets);
      if (!issue) {
        return {
          ok: false,
          error: `${task} not found in Jira`,
          errorCode: ApiErrorCode.JiraNotFound,
        };
      }
    } catch { /* unreachable/5xx — soft-pass */ }
    return null;
  }

  private handleRemoveFavorite(body: Record<string, unknown>): ApiResponse<FavoriteRemoveResponse> {
    const target = typeof body.target === 'string' ? body.target
      : (typeof body.id === 'string' ? body.id : '');
    if (!target) return { ok: false, error: 'Missing target (favorite #index or id)' };

    try {
      const favorites = loadFavorites();
      const removed = removeFavorite(favorites, target);
      saveFavorites(favorites);
      return { ok: true, data: { removed, favorites } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>> {
    try {
      const secrets = loadSecrets();
      const data = await resolveActivityTypes(secrets);
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
          boundaryHour: c.boundaryHour,
          timezone: c.timezone,
          taskPattern: c.taskPattern,
          sensitivity: {
            default: c.sensitivity.default,
            perRepo: { ...c.sensitivity.perRepo },
          },
        },
        secretsMeta: { jiraConfigured, tempoConfigured },
        daemonVersion: this.deps.getVersion(),
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
    const today = computeWorkingDate(Date.now(), config.boundaryHour, config.timezone);
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
        manualEntries: log.manualEntries ?? [],
        totalEffectiveMs,
        signalCount: log.signals.length,
        claimedMs: computeTotalClaimedMs(log),
        dayStart: resolveUiDayStart(log),
        activeIntervals: computeActiveIntervals(log.sessions),
        downtimeMs: computeDaySummary(log.sessions).downtimeMs,
        issueSummaries: this.buildIssueSummaries(log),
      },
    };
  }

  private handleDays(): ApiResponse<DaysResponse> {
    return { ok: true, data: { dates: listAvailableDates() } };
  }

  // ─── Month view (timesheets tab) ──────────────────────────────────

  /** ?year&month with both defaulting to the current working month. */
  private resolveYearMonth(url: URL): { year: number; month: number } | { error: string } {
    const today = this.deps.getCurrentDate();
    const yearStr = url.searchParams.get('year');
    const monthStr = url.searchParams.get('month');
    const year = yearStr ? Number(yearStr) : Number(today.slice(0, 4));
    const month = monthStr ? Number(monthStr) : Number(today.slice(5, 7));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return { error: `Invalid year: ${yearStr}` };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { error: `Invalid month: ${monthStr}` };
    }
    return { year, month };
  }

  private handleMonth(url: URL): ApiResponse<MonthResponse> {
    const parsed = this.resolveYearMonth(url);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const { year, month } = parsed;

    // Today's log lives in memory — flush so the disk aggregate sees it.
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
    if (this.deps.getCurrentDate().startsWith(monthPrefix)) {
      this.deps.sessionTracker.flush();
    }
    return { ok: true, data: buildMonthResponse(year, month, this.deps.config) };
  }

  // ─── Push to Tempo ────────────────────────────────────────────────

  private async handlePush(body: Record<string, unknown>): Promise<ApiResponse<PushResponse>> {
    const config = this.deps.config;
    const from = typeof body.from === 'string' ? body.from : getDefaultFromDate(config);
    const to = typeof body.to === 'string' ? body.to : getDefaultToDate(config);
    const dryRun = body.dryRun === true;
    const force = body.force === true;
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return { ok: false, error: 'Invalid from/to. Use YYYY-MM-DD' };
    }
    if (from > to) return { ok: false, error: `from ${from} is after to ${to}` };

    const secrets = tryLoadSecrets();
    if (!secrets || !secrets.Tempo_Token?.trim() || !isJiraConfigured(secrets)) {
      return { ok: false, error: 'Jira/Tempo tokens are not configured — set them in Settings' };
    }

    // Report reads from disk — make sure today's live log is there.
    this.deps.sessionTracker.flush();
    try {
      const response = await runPush({ from, to, commit: !dryRun, config, secrets, force });

      // markDaysPushed sealed today's file behind the in-memory log — re-sync
      // so the next flush doesn't revert the day to draft.
      const today = this.deps.getCurrentDate();
      if (!dryRun && from <= today && today <= to) {
        const disk = readDailyLog(today);
        if (disk?.pushedAt && disk.status === DayStatus.Pushed) {
          this.deps.sessionTracker.markPushed(disk.pushedAt);
        }
      }
      return { ok: true, data: response };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Tempo snapshot sync (mirror pull) ────────────────────────────

  /**
   * Refetch the month's Tempo snapshot on demand — mirrors the CLI
   * `tempo-sync`. Body: {year?, month?}, both default to the current
   * working month. Read-only against Tempo; never blocks or gates push
   * (push does its own live fetch before planning).
   */
  private async handleTempoSync(body: Record<string, unknown>): Promise<ApiResponse<TempoSyncResponse>> {
    const today = this.deps.getCurrentDate();
    const year = typeof body.year === 'number' ? body.year : Number(today.slice(0, 4));
    const month = typeof body.month === 'number' ? body.month : Number(today.slice(5, 7));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return { ok: false, error: `Invalid year: ${body.year}` };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { ok: false, error: `Invalid month: ${body.month}` };
    }

    const secrets = tryLoadSecrets();
    if (!secrets || !secrets.Tempo_Token?.trim() || !isJiraConfigured(secrets)) {
      return { ok: false, error: 'Jira/Tempo tokens are not configured — set them in Settings' };
    }

    try {
      const snapshot = await fetchMonthSnapshot(year, month, secrets);
      return {
        ok: true,
        data: {
          month: snapshot.month,
          syncedAt: snapshot.fetchedAt,
          worklogCount: snapshot.worklogs.length,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Adopt foreign Tempo worklogs as local manual entries (mirror import).
   * Body: {year?, month?, date?, worklogIds?} — a date implies its month;
   * no filter imports every foreign worklog of the month. Today's entries
   * go through the live tracker, past days straight to disk.
   */
  private async handleTempoImport(body: Record<string, unknown>): Promise<ApiResponse<TempoImportResponse>> {
    const today = this.deps.getCurrentDate();

    let date: string | undefined;
    if (body.date !== undefined && body.date !== null) {
      if (typeof body.date !== 'string' || !DATE_RE.test(body.date)) {
        return { ok: false, error: 'Invalid date. Use YYYY-MM-DD' };
      }
      date = body.date;
    }

    const year = typeof body.year === 'number' ? body.year : Number((date ?? today).slice(0, 4));
    const month = typeof body.month === 'number' ? body.month : Number((date ?? today).slice(5, 7));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return { ok: false, error: `Invalid year: ${body.year}` };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { ok: false, error: `Invalid month: ${body.month}` };
    }

    let worklogIds: number[] | undefined;
    if (body.worklogIds !== undefined && body.worklogIds !== null) {
      if (!Array.isArray(body.worklogIds) || body.worklogIds.some(id => typeof id !== 'number')) {
        return { ok: false, error: 'worklogIds must be an array of numbers' };
      }
      worklogIds = body.worklogIds as number[];
      if (worklogIds.length === 0) return { ok: false, error: 'worklogIds is empty' };
    }

    const secrets = tryLoadSecrets();
    if (!secrets || !secrets.Tempo_Token?.trim() || !isJiraConfigured(secrets)) {
      return { ok: false, error: 'Jira/Tempo tokens are not configured — set them in Settings' };
    }

    const tracker = this.deps.sessionTracker;
    try {
      const result = await importTempoWorklogs(year, month, secrets, {
        config: this.deps.config,
        today,
        date,
        worklogIds,
        addEntryToday: (input: ImportEntryInput) => {
          const r = tracker.importManualEntry(input);
          if (!r.ok || !r.entry) throw new Error(r.error ?? 'Import failed');
          tracker.flush();
          return r.entry;
        },
      });
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Tempo month meta (schedule / approval) ───────────────────────

  private async handleTempoSchedule(url: URL): Promise<ApiResponse<TempoScheduleResponse>> {
    const parsed = this.resolveYearMonth(url);
    if ('error' in parsed) return { ok: false, error: parsed.error };

    const secrets = tryLoadSecrets();
    if (!secrets) return { ok: true, data: scheduleUnavailable('no-token') };
    try {
      return { ok: true, data: await resolveMonthSchedule(parsed.year, parsed.month, secrets) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleTempoApproval(url: URL): Promise<ApiResponse<TempoApprovalResponse>> {
    const parsed = this.resolveYearMonth(url);
    if ('error' in parsed) return { ok: false, error: parsed.error };

    const secrets = tryLoadSecrets();
    if (!secrets) return { ok: true, data: approvalUnavailable('no-token') };
    try {
      return { ok: true, data: await resolveMonthApproval(parsed.year, parsed.month, secrets) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  /** Candidates + watching repos that need synthetic cards (A-6). */
  private collectLiveExtras(): { candidates: readonly Session[]; watching: readonly WatchingRepo[]; now: string } {
    const tracker = this.deps.sessionTracker;
    const candidates = tracker.getCandidates();
    const occupied = new Set<string>([
      ...tracker.getOpenSessions().map(s => s.repo),
      ...candidates.map(s => s.repo),
    ]);
    return {
      candidates,
      watching: selectWatchingRepos(this.deps.getWatchingRepos(), occupied),
      now: new Date().toISOString(),
    };
  }

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
