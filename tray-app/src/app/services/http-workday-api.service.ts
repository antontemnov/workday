import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { WorkdayApiService } from './workday-api.service';
import {
  ActiveInterval,
  ApiResponse,
  TodayResponse,
  SessionDetail,
  StatusResponse,
  SensitivityResponse,
  SensitivityLevel,
  SessionDeleteResponse,
  DaysResponse,
  EXPECTED_API_VERSION,
  MonthResponse,
  SettingsResponse,
  SettingsPatch,
  AddRepoResponse,
  UpdateCheckResponse,
  UpdateApplyResponse,
  ActivityTypesResponse,
  ManualEntry,
  ManualEntryResponse,
  ManualEntryDeleteResponse,
  ManualEntryInput,
  ManualEntryPatch,
  FavoritesResponse,
  FavoriteAddResponse,
  FavoriteRemoveResponse,
  FavoriteInput,
  JiraSearchResponse,
  JiraProjectsResponse,
  PushResponse,
  TempoScheduleResponse,
  TempoApprovalResponse,
  TempoSyncResponse,
  TempoImportRequest,
  TempoImportResponse,
  NotificationsResponse,
  NotificationAckAction,
  NotificationAckResponse,
} from '../models/workday.models';

const BASE_URL = 'http://127.0.0.1:9213';

@Injectable()
export class HttpWorkdayApiService extends WorkdayApiService {

  private upgrading = false;

  private upgradeError: string | null = null;

  // Cooldown between automatic repair attempts. Every API response carries
  // apiVersion, so without a cooldown a persistent mismatch retriggers on
  // each 10s poll — the old code restarted the daemon in a loop, closing
  // the day's sessions every cycle.
  private static readonly MISMATCH_RETRY_MS = 10 * 60 * 1000;
  private lastMismatchActionAt = 0;

  /**
   * Direction-aware version gate:
   * - daemon BEHIND the app → upgrade the daemon (it predates self-update);
   * - daemon AHEAD of the app → the tray is stale: trigger the app's own
   *   updater, never "upgrade" the daemon — npm would reinstall the same
   *   (new) version and the mismatch would persist forever.
   */
  private checkApiVersion(response: ApiResponse<unknown>): ApiResponse<unknown> {
    if (!response.ok || response.apiVersion === undefined || response.apiVersion === EXPECTED_API_VERSION) {
      return response;
    }

    const daemonIsBehind = response.apiVersion < EXPECTED_API_VERSION;
    const now = Date.now();
    if (!this.upgrading && now - this.lastMismatchActionAt > HttpWorkdayApiService.MISMATCH_RETRY_MS) {
      this.lastMismatchActionAt = now;
      if (daemonIsBehind) {
        void this.upgradeDaemon();
      } else {
        // Fire the tray's own update check; a found version raises the
        // update banner — install waits for the user's click.
        void invoke('check_app_update').catch(() => {});
      }
    }

    const msg = daemonIsBehind
      ? (this.upgradeError
          ? `Daemon upgrade failed: ${this.upgradeError}`
          : 'Updating daemon to match app version...')
      : 'Workday app is older than the daemon — update it via the banner above';
    return { ok: false, error: msg };
  }

  private async upgradeDaemon(): Promise<void> {
    this.upgrading = true;
    this.upgradeError = null;
    try {
      await invoke('upgrade_daemon');
    } catch (e: unknown) {
      this.upgradeError = String(e);
    } finally {
      this.upgrading = false;
    }
  }

  private async get<T>(path: string): Promise<ApiResponse<T>> {
    try {
      const res = await fetch(`${BASE_URL}${path}`);
      const json = await res.json();
      return this.checkApiVersion(json) as ApiResponse<T>;
    } catch {
      return { ok: false, error: 'Connection refused — is the daemon running?' };
    }
  }

  private async post<T>(path: string, body?: Record<string, unknown>): Promise<ApiResponse<T>> {
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      return this.checkApiVersion(json) as ApiResponse<T>;
    } catch {
      return { ok: false, error: 'Connection refused — is the daemon running?' };
    }
  }

  override async getToday(): Promise<ApiResponse<TodayResponse>> {
    return this.get('/api/today');
  }

  /**
   * Past-day read: HTTP first (daemon has computed budget / live state); on
   * failure, fall back to the raw DailyLog file via Tauri. The disk fallback
   * gives a partial view (no budget, score=0) but lets the user browse history
   * before pressing Start.
   */
  override async getDay(date: string): Promise<ApiResponse<TodayResponse>> {
    const httpRes = await this.get<TodayResponse>(`/api/day?date=${date}`);
    if (httpRes.ok) return httpRes;
    const fromDisk = await this.readDayFromDisk(date);
    return fromDisk ?? httpRes;
  }

  /**
   * Available dates: HTTP first; if the daemon is down, list the data folder
   * directly so the date navigation still works on a cold tray launch.
   */
  override async getDays(): Promise<ApiResponse<DaysResponse>> {
    const httpRes = await this.get<DaysResponse>('/api/days');
    if (httpRes.ok) return httpRes;
    try {
      const dates = await invoke<string[]>('list_local_days');
      return { ok: true, data: { dates } };
    } catch {
      return httpRes;
    }
  }

  override async getStatus(): Promise<ApiResponse<StatusResponse>> {
    return this.get('/api/status');
  }

  override async pause(repo?: string): Promise<ApiResponse<{ paused: string[] }>> {
    return this.post('/api/pause', repo ? { repo } : {});
  }

  override async resume(): Promise<ApiResponse<{ resumed: string[] }>> {
    return this.post('/api/resume');
  }

  override async sensitivity(level: SensitivityLevel, repo?: string): Promise<ApiResponse<SensitivityResponse>> {
    return this.post('/api/sensitivity', repo ? { level, repo } : { level });
  }

  override async addSessionTime(sessionId: string, minutes: number): Promise<ApiResponse<ManualEntryResponse>> {
    return this.post('/api/manual-entry', { sourceSessionId: sessionId, minutes });
  }

  override async deleteSession(target: string): Promise<ApiResponse<SessionDeleteResponse>> {
    return this.post('/api/session/delete', { target });
  }

  override async stop(): Promise<ApiResponse<unknown>> {
    return this.post('/api/stop');
  }

  override async startDaemon(): Promise<void> {
    try {
      await invoke('start_daemon');
    } catch {
      // Outside Tauri webview (e.g. browser dev mode) — invoke is unavailable
      throw new Error('Cannot start daemon outside Tauri app');
    }
  }

  override async isDaemonManuallyStopped(): Promise<boolean> {
    try {
      return await invoke<boolean>('daemon_stop_marker_present');
    } catch {
      return false; // outside Tauri — no marker to consult
    }
  }

  override async getAutostartEnabled(): Promise<boolean> {
    try {
      return await invoke<boolean>('get_autostart_enabled');
    } catch {
      return false;
    }
  }

  override async setAutostartEnabled(enabled: boolean): Promise<void> {
    await invoke('set_autostart_enabled', { enabled });
  }

  // ─── Manual entries ──────────────────────────────────────────────────
  // add targets the currently-tracked day. update/delete accept an optional
  // date for past-day edits (timesheets drawer) — the daemon routes today
  // through the live tracker and past days disk-to-disk.

  override async getActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>> {
    return this.get<ActivityTypesResponse>('/api/activity-types');
  }

  override async refreshActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>> {
    return this.post<ActivityTypesResponse>('/api/activity-types/refresh');
  }

  override async addManualEntry(input: ManualEntryInput): Promise<ApiResponse<ManualEntryResponse>> {
    return this.post<ManualEntryResponse>('/api/manual-entry', { ...input });
  }

  override async updateManualEntry(target: string, patch: ManualEntryPatch, date?: string): Promise<ApiResponse<ManualEntryResponse>> {
    return this.post<ManualEntryResponse>('/api/manual-entry/update', { target, ...patch, ...(date ? { date } : {}) });
  }

  override async deleteManualEntry(target: string, date?: string): Promise<ApiResponse<ManualEntryDeleteResponse>> {
    return this.post<ManualEntryDeleteResponse>('/api/manual-entry/delete', { target, ...(date ? { date } : {}) });
  }

  // ─── Favorites ───────────────────────────────────────────────────────

  override async getFavorites(): Promise<ApiResponse<FavoritesResponse>> {
    return this.get<FavoritesResponse>('/api/favorites');
  }

  override async addFavorite(input: FavoriteInput): Promise<ApiResponse<FavoriteAddResponse>> {
    return this.post<FavoriteAddResponse>('/api/favorites', { ...input });
  }

  override async removeFavorite(target: string): Promise<ApiResponse<FavoriteRemoveResponse>> {
    return this.post<FavoriteRemoveResponse>('/api/favorites/remove', { target });
  }

  override async searchJira(query: string): Promise<ApiResponse<JiraSearchResponse>> {
    return this.get<JiraSearchResponse>(`/api/jira/search?q=${encodeURIComponent(query)}`);
  }

  override async getJiraProjects(): Promise<ApiResponse<JiraProjectsResponse>> {
    return this.get<JiraProjectsResponse>('/api/jira/projects');
  }

  override async refreshJiraProjects(): Promise<ApiResponse<JiraProjectsResponse>> {
    return this.post<JiraProjectsResponse>('/api/jira/projects/refresh');
  }

  // ─── Timesheets (month view) ─────────────────────────────────────────

  override async getMonth(year: number, month: number): Promise<ApiResponse<MonthResponse>> {
    return this.get<MonthResponse>(`/api/month?year=${year}&month=${month}`);
  }

  override async pushToTempo(from: string, to: string, force = false): Promise<ApiResponse<PushResponse>> {
    return this.post<PushResponse>('/api/push', { from, to, force });
  }

  override async getTempoSchedule(year: number, month: number): Promise<ApiResponse<TempoScheduleResponse>> {
    return this.get<TempoScheduleResponse>(`/api/tempo/schedule?year=${year}&month=${month}`);
  }

  override async getTempoApproval(year: number, month: number): Promise<ApiResponse<TempoApprovalResponse>> {
    return this.get<TempoApprovalResponse>(`/api/tempo/approval?year=${year}&month=${month}`);
  }

  override async syncTempo(year: number, month: number): Promise<ApiResponse<TempoSyncResponse>> {
    return this.post<TempoSyncResponse>('/api/tempo-sync', { year, month });
  }

  override async importTempo(request: TempoImportRequest): Promise<ApiResponse<TempoImportResponse>> {
    return this.post<TempoImportResponse>('/api/tempo-import', request as Record<string, unknown>);
  }

  // ─── Notifications ───────────────────────────────────────────────────

  override async getNotifications(): Promise<ApiResponse<NotificationsResponse>> {
    return this.get<NotificationsResponse>('/api/notifications');
  }

  override async ackNotification(id: string, action: NotificationAckAction): Promise<ApiResponse<NotificationAckResponse>> {
    return this.post<NotificationAckResponse>('/api/notifications/ack', { id, action });
  }

  override async getSettings(): Promise<ApiResponse<SettingsResponse>> {
    return this.get<SettingsResponse>('/api/settings');
  }

  override async updateSettings(patch: SettingsPatch): Promise<ApiResponse<unknown>> {
    return this.post('/api/settings', patch as unknown as Record<string, unknown>);
  }

  override async addRepo(path: string): Promise<ApiResponse<AddRepoResponse>> {
    return this.post<AddRepoResponse>('/api/repo', { path });
  }

  override async removeRepo(path: string): Promise<ApiResponse<AddRepoResponse>> {
    return this.post<AddRepoResponse>('/api/repo/remove', { path });
  }

  // ─── Daemon updates ──────────────────────────────────────────────────

  override async checkDaemonUpdate(): Promise<ApiResponse<UpdateCheckResponse>> {
    return this.get<UpdateCheckResponse>('/api/update/check');
  }

  override async applyDaemonUpdate(): Promise<ApiResponse<UpdateApplyResponse>> {
    return this.post<UpdateApplyResponse>('/api/update/apply');
  }

  // ─── Tray-app self-update (Tauri commands, not daemon HTTP) ──────────

  override async getAppVersion(): Promise<string> {
    try {
      return await invoke<string>('get_app_version');
    } catch {
      return 'dev'; // outside Tauri (browser dev) — no bundled version
    }
  }

  override async checkAppUpdate(): Promise<string | null> {
    // Throws outside Tauri / on updater error — the caller surfaces it.
    return await invoke<string | null>('check_app_update');
  }

  // ─── Disk fallback (no daemon) ──────────────────────────────────────

  private async readDayFromDisk(date: string): Promise<ApiResponse<TodayResponse> | null> {
    try {
      const raw = await invoke<string>('read_local_day', { date });
      const log = JSON.parse(raw) as RawDailyLog;
      return { ok: true, data: this.buildTodayResponseFromLog(log) };
    } catch {
      return null;
    }
  }

  private buildTodayResponseFromLog(log: RawDailyLog): TodayResponse {
    const sessions: SessionDetail[] = (log.sessions ?? []).map(s => this.toSessionDetail(s));
    const totalEffectiveMs = sessions.reduce((sum, s) => sum + s.effectiveDurationMs, 0);
    const activeIntervals = this.computeActiveIntervals(log.sessions ?? []);

    return {
      date: log.date,
      dayType: log.dayType ?? 'workday',
      status: log.status ?? 'draft',
      sessions,
      manualEntries: log.manualEntries ?? [],
      totalEffectiveMs,
      signalCount: (log.signals ?? []).length,
      // Disk fallback: claimed is daemon-computed, surface as zero. Past-day
      // UI does not render against it anyway.
      claimedMs: 0,
      // Mirror the daemon's resolveUiDayStart: earliest activatedAt.
      dayStart: this.earliestActivatedAt(log.sessions ?? []),
      activeIntervals,
      downtimeMs: this.computeDowntime(activeIntervals),
    };
  }

  private earliestActivatedAt(sessions: readonly RawSession[]): string | null {
    let earliest: string | null = null;
    for (const s of sessions) {
      if (!s.activatedAt) continue;
      if (earliest === null || new Date(s.activatedAt).getTime() < new Date(earliest).getTime()) {
        earliest = s.activatedAt;
      }
    }
    return earliest;
  }

  private toSessionDetail(s: RawSession): SessionDetail {
    return {
      id: s.id,
      repo: s.repo,
      task: s.task ?? null,
      branch: s.branch,
      state: s.state,
      startedAt: s.startedAt,
      activatedAt: s.activatedAt ?? null,
      lastSeenAt: s.lastSeenAt,
      paused: false, // past day → no live open pause
      pauseSource: null,
      effectiveDurationMs: this.computeEffectiveDuration(s),
      score: 0,
      normalizedScore: 0,
      isLeader: false,
      sensitivity: SensitivityLevel.Normal,
      closedBy: s.closedBy ?? null,
      evidence: s.evidence ?? { commits: 0, reflogEvents: 0, linesAdded: 0, linesRemoved: 0, filesChanged: 0 },
      pauseCount: (s.pauses ?? []).length,
      totalPauseDurationMs: this.computeTotalPauseDuration(s),
    };
  }

  private computeEffectiveDuration(s: RawSession): number {
    if (!s.activatedAt) return 0;
    const start = new Date(s.activatedAt).getTime();
    const end = new Date(s.lastSeenAt).getTime();
    return Math.max(0, end - start - this.computeTotalPauseDuration(s));
  }

  private computeTotalPauseDuration(s: RawSession): number {
    return (s.pauses ?? []).reduce((sum, p) => {
      const from = new Date(p.from).getTime();
      const to = p.to ? new Date(p.to).getTime() : new Date(s.lastSeenAt).getTime();
      return sum + Math.max(0, to - from);
    }, 0);
  }

  private computeActiveIntervals(sessions: readonly RawSession[]): ActiveInterval[] {
    const intervals: ActiveInterval[] = [];
    for (const s of sessions) {
      if (!s.activatedAt) continue;
      const sessionStart = new Date(s.activatedAt).getTime();
      const sessionEnd = new Date(s.lastSeenAt).getTime();
      const pauses = [...(s.pauses ?? [])]
        .map(p => ({
          from: new Date(p.from).getTime(),
          to: p.to ? new Date(p.to).getTime() : sessionEnd,
        }))
        .filter(p => p.to > sessionStart && p.from < sessionEnd)
        .sort((a, b) => a.from - b.from);

      let cursor = sessionStart;
      for (const p of pauses) {
        if (p.from > cursor) {
          intervals.push({
            from: new Date(cursor).toISOString(),
            to: new Date(p.from).toISOString(),
            sessionId: s.id,
            repo: s.repo,
          });
        }
        cursor = Math.max(cursor, p.to);
      }
      if (cursor < sessionEnd) {
        intervals.push({
          from: new Date(cursor).toISOString(),
          to: new Date(sessionEnd).toISOString(),
          sessionId: s.id,
          repo: s.repo,
        });
      }
    }
    return intervals;
  }

  private computeDowntime(intervals: readonly ActiveInterval[]): number {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals]
      .map(iv => ({ from: new Date(iv.from).getTime(), to: new Date(iv.to).getTime() }))
      .sort((a, b) => a.from - b.from);
    const merged: { from: number; to: number }[] = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const curr = sorted[i];
      if (curr.from <= last.to) last.to = Math.max(last.to, curr.to);
      else merged.push({ ...curr });
    }
    const span = merged[merged.length - 1].to - merged[0].from;
    const work = merged.reduce((sum, iv) => sum + (iv.to - iv.from), 0);
    return Math.max(0, span - work);
  }
}

// ─── Disk JSON shape (mirrors daemon's DailyLog) ─────────────────────

interface RawDailyLog {
  readonly date: string;
  readonly status?: string;
  readonly dayType?: string;
  readonly sessions?: RawSession[];
  readonly signals?: unknown[];
  readonly manualEntries?: ManualEntry[];
}

interface RawSession {
  readonly id: string;
  readonly repo: string;
  readonly task: string | null;
  readonly branch: string;
  readonly state: string;
  readonly startedAt: string;
  readonly activatedAt: string | null;
  readonly lastSeenAt: string;
  readonly closedBy: string | null;
  readonly evidence?: {
    readonly commits: number;
    readonly reflogEvents: number;
    readonly linesAdded: number;
    readonly linesRemoved: number;
    readonly filesChanged: number;
  };
  readonly pauses?: { readonly from: string; readonly to: string | null; readonly source: string }[];
}
