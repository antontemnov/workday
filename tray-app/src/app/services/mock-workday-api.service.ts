import { Injectable } from '@angular/core';
import { WorkdayApiService } from './workday-api.service';
import {
  ApiResponse,
  TodayResponse,
  StatusResponse,
  SensitivityResponse,
  SensitivityLevel,
  SessionDeleteResponse,
  TaskDeleteResponse,
  DaysResponse,
  MonthResponse,
  MonthDaySummary,
  MonthDayStatus,
  MonthDayTask,
  ScheduleDay,
  TempoScheduleResponse,
  TempoApprovalResponse,
  TempoSyncResponse,
  TempoImportRequest,
  TempoImportResponse,
  PushResponse,
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
  DEVELOPMENT_ACTIVITY,
  Favorite,
  FavoritesResponse,
  FavoriteAddResponse,
  FavoriteRemoveResponse,
  FavoriteInput,
  normalizeFavName,
  JiraSearchHit,
  JiraSearchResponse,
  JiraProjectsResponse,
  ProjectRef,
  NotificationsResponse,
  NotificationAckAction,
  NotificationAckResponse,
  CalendarRefreshResponse,
  Suggestion,
  SuggestionsResponse,
  SuggestionsDayState,
  SuggestionAcceptRequest,
  SuggestionAcceptResponse,
  SuggestionsMutedResponse,
  SuggestionUnmuteResponse,
  MutedSuggestionSeries,
  suggestionSourceRef,
} from '../models/workday.models';

// Local-only preview service — returns rich mock data so the UI can be
// inspected end-to-end without a running daemon. Selected through a query
// flag in app.config.ts (?mock=1) — never wired in production builds.
@Injectable()
export class MockWorkdayApiService extends WorkdayApiService {

  // Mutable so addRepo/removeRepo feels real in mock mode.
  private mockRepos: string[] = ['D:/work/web-frontend', 'D:/work/api-backend'];
  private mockSensitivity: SensitivityLevel = SensitivityLevel.Normal;
  private mockJiraConfigured = true;
  private mockTempoConfigured = true;
  private mockBoundaryHour = 4;
  private mockTimezone = 'Europe/Moscow';
  private mockTracking = { projectKeys: ['ATL'], branchOwners: ['jdoe'] };
  private mockProjectKeys: string[] = ['ATL'];
  private mockKnownProjects: ProjectRef[] = [
    { key: 'ATL', name: 'Core Platform', id: '10001' },
    { key: 'APP', name: 'Mobile App', id: '10002' },
    { key: 'OPS', name: 'Infra & Ops', id: '10003' },
    { key: 'WEB', name: 'Web Portal', id: '10004' },
  ];
  private mockActivityValues: string[] = ['Development', 'CodeReview', 'Other'];
  private mockCalendar = { enabled: true, hidePrivate: false };
  private mockCalendarConfigured = true;
  private mockCalendarFetchedAt = new Date(Date.now() - 25 * 60_000).toISOString();

  // Mutable so add/edit manual entries feel real in mock mode.
  private mockManualEntries: ManualEntry[] = [
    { id: 'm1', task: 'ATL-6781', minutes: 15, description: 'daily standup',
      activity: 'Other', createdAt: this.iso(10, 0) },
    { id: 'm2', task: 'ATL-6712', minutes: 30, description: 'PR #214 review with team',
      activity: 'CodeReview', createdAt: this.iso(13, 30) },
    { id: 'm3', task: 'APP-1024', minutes: 45, description: 'sprint planning',
      activity: 'Other', createdAt: this.iso(15, 0) },
    // Session-born add on a ticket with closed sessions — merges into the
    // ATL-6712 group card between its two sessions.
    { id: 'm4', task: 'ATL-6712', minutes: 55, description: '',
      activity: 'Development', createdAt: this.iso(12, 15), sourceSessionId: 'c1' },
    // Session-born add on a ticket with no closed sessions (s1 is live) —
    // births its own group card with a manual-only breakdown.
    { id: 'm5', task: 'ATL-6781', minutes: 45, description: '',
      activity: 'Development', createdAt: this.iso(14, 40), sourceSessionId: 's1' },
    // Unnamed standalone Development (LOG-born, no sourceSessionId) — folds
    // into the same "manual added" row as the session-born m4.
    { id: 'm6', task: 'ATL-6712', minutes: 30, description: '',
      activity: 'Development', createdAt: this.iso(16, 5) },
    // Named entry on the tracked ticket — the canonical 4-row block:
    // observed + manual added + Meeting + Code review.
    { id: 'm7', task: 'ATL-6712', minutes: 30, description: 'sprint planning',
      activity: 'Other', createdAt: this.iso(15, 30) },
  ];
  private mockEntrySeq = 8;
  // Sessions "removed" via deleteSession/deleteTask — filtered out of getToday.
  private mockDeletedSessionIds = new Set<string>();

  private readonly today = (() => {
    const d = new Date();
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  })();

  private iso(h: number, m: number): string {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }

  // The mock day runs on fictional clocks (presets stamped 09:00–15:00), so
  // new entries must NOT use the real wall clock — at night it sorts them to
  // the bottom of the newest-first feed. Monotonic stamps after every preset
  // keep them on top, like the real daemon's "now" does.
  private mockClockMin = 0;
  private nextCreatedAt(): string {
    return this.iso(17, this.mockClockMin++);
  }

  // Mock calendar behind the suggestion rows: two finished meetings and one
  // "happening now" (born at DTSTART), plus a private one — accept/dismiss
  // round-trip like the daemon's derived engine.
  // One row per resolution outcome: learned series prefill, a titleKey
  // conflict (candidates), an unknown meeting, a private one.
  private readonly mockMeetings: Suggestion[] = [
    { uid: 'ev-standup', date: this.today, title: 'Daily standup',
      start: this.iso(9, 30), end: this.iso(9, 45), plannedMinutes: 15,
      ongoing: false, isPrivate: false, source: 'meeting',
      resolved: { task: 'ATL-101', activity: 'Other', description: 'Daily', level: 'series' } },
    { uid: 'ev-groom', date: this.today, title: 'Backlog grooming — payments squad',
      start: this.iso(13, 0), end: this.iso(14, 0), plannedMinutes: 60,
      ongoing: false, isPrivate: false, source: 'meeting',
      candidates: [
        { task: 'ATL-205', activity: 'Other', lastUsedAt: this.iso(9, 0) },
        { task: 'ATL-118', activity: 'CodeReview', lastUsedAt: this.iso(8, 0) },
      ] },
    { uid: 'ev-sync', date: this.today, title: 'Design sync',
      start: this.iso(16, 0), end: this.iso(16, 30), plannedMinutes: 30,
      ongoing: true, isPrivate: false, source: 'meeting' },
    { uid: 'ev-private', date: this.today, title: 'Private appointment',
      start: this.iso(11, 0), end: this.iso(11, 30), plannedMinutes: 30,
      ongoing: false, isPrivate: true, source: 'meeting' },
    // Review suggestion: a colleague-branch checkout — always resolved,
    // static 30m default, title = the branch.
    { uid: 'ATL-4512', date: this.today, title: 'ATL-4512-ivanov-payment-retry',
      start: this.iso(11, 40), end: this.iso(11, 40), plannedMinutes: 30,
      ongoing: false, isPrivate: false, source: 'review',
      resolved: { task: 'ATL-4512', activity: 'CodeReview', description: 'code review', level: 'source' } },
  ];
  private readonly mockDismissed = new Set<string>();
  private mockMuted: MutedSuggestionSeries[] = [];

  private buildToday(): TodayResponse {
    return {
      date: this.today,
      dayType: 'workday',
      status: 'active',
      sessions: [
        {
          id: 's1',
          repo: 'D:/work/web-frontend',
          task: 'ATL-6781',
          branch: 'ATL-6781-atemnov-save-fee-endpoints',
          state: 'active',
          startedAt: this.iso(9, 18),
          activatedAt: this.iso(9, 22),
          lastSeenAt: this.iso(16, 25),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 4 * 3600_000 + 12 * 60_000,
          score: 0.62,
          normalizedScore: 0.62,
          isLeader: true,
          sensitivity: SensitivityLevel.Normal,
          closedBy: null,
          evidence: { commits: 5, reflogEvents: 7, linesAdded: 312, linesRemoved: 88, filesChanged: 14 },
          pauseCount: 2,
          totalPauseDurationMs: 25 * 60_000,
        },
        {
          id: 's2',
          repo: 'D:/work/api-backend',
          task: 'APP-1024',
          branch: 'APP-1024-refactor-pricing-engine',
          state: 'pending',
          startedAt: this.iso(16, 5),
          activatedAt: null,
          lastSeenAt: this.iso(16, 25),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 5 * 60_000,
          score: 0.1,
          normalizedScore: 0.1,
          isLeader: false,
          sensitivity: SensitivityLevel.Normal,
          closedBy: null,
          evidence: { commits: 0, reflogEvents: 1, linesAdded: 4, linesRemoved: 0, filesChanged: 1 },
          pauseCount: 0,
          totalPauseDurationMs: 0,
        },
        {
          id: 's3',
          repo: 'D:/work/infra-scripts',
          task: 'OPS-512',
          branch: 'OPS-512-pipeline-tweak',
          // Idle = activated then auto-paused; a never-activated session can't
          // be idle (real-data invariant, add-time gate relies on it).
          state: 'active',
          startedAt: this.iso(11, 30),
          activatedAt: this.iso(11, 33),
          lastSeenAt: this.iso(11, 55),
          paused: true,
          pauseSource: 'idle_timeout',
          effectiveDurationMs: 22 * 60_000,
          score: 0.18,
          normalizedScore: 0.18,
          isLeader: false,
          sensitivity: SensitivityLevel.Patient,
          closedBy: null,
          evidence: { commits: 0, reflogEvents: 1, linesAdded: 18, linesRemoved: 4, filesChanged: 2 },
          pauseCount: 1,
          totalPauseDurationMs: 8 * 60_000,
        },
        // Closed sessions
        {
          id: 'c1',
          repo: 'D:/work/web-frontend',
          task: 'ATL-6712',
          branch: 'ATL-6712-fix-leak',
          state: 'active',
          startedAt: this.iso(9, 18),
          activatedAt: this.iso(9, 22),
          lastSeenAt: this.iso(10, 45),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 1 * 3600_000 + 27 * 60_000,
          score: 0.6,
          normalizedScore: 0.6,
          isLeader: false,
          sensitivity: SensitivityLevel.Normal,
          closedBy: 'idle_timeout',
          evidence: { commits: 1, reflogEvents: 2, linesAdded: 88, linesRemoved: 14, filesChanged: 5 },
          pauseCount: 0,
          totalPauseDurationMs: 0,
        },
        {
          // Second closed session on the same ticket, different repo — the
          // Logged tracked row folds them: Σ time, "2 repos", 2 breakdown rows.
          id: 'c4',
          repo: 'D:/work/api-backend',
          task: 'ATL-6712',
          branch: 'ATL-6712-fix-leak-backend-endpoints',
          state: 'active',
          startedAt: this.iso(13, 5),
          activatedAt: this.iso(13, 8),
          lastSeenAt: this.iso(13, 50),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 45 * 60_000,
          score: 0.5,
          normalizedScore: 0.5,
          isLeader: false,
          sensitivity: SensitivityLevel.Normal,
          closedBy: 'checkout_other_task',
          evidence: { commits: 1, reflogEvents: 2, linesAdded: 40, linesRemoved: 9, filesChanged: 3 },
          pauseCount: 0,
          totalPauseDurationMs: 0,
        },
        {
          id: 'c2',
          repo: 'D:/work/api-backend',
          task: 'APP-1019',
          branch: 'APP-1019-cleanup',
          state: 'active',
          startedAt: this.iso(11, 35),
          activatedAt: this.iso(11, 40),
          lastSeenAt: this.iso(12, 50),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 1 * 3600_000 + 15 * 60_000,
          score: 0.7,
          normalizedScore: 0.7,
          isLeader: false,
          sensitivity: SensitivityLevel.Normal,
          closedBy: 'superseded',
          evidence: { commits: 2, reflogEvents: 3, linesAdded: 124, linesRemoved: 22, filesChanged: 6 },
          pauseCount: 0,
          totalPauseDurationMs: 0,
        },
        {
          id: 'c3',
          repo: 'D:/work/infra-scripts',
          task: null,
          branch: 'main',
          state: 'pending',
          startedAt: this.iso(14, 10),
          activatedAt: null,
          lastSeenAt: this.iso(14, 30),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 20 * 60_000,
          score: 0.2,
          normalizedScore: 0.2,
          isLeader: false,
          sensitivity: SensitivityLevel.Patient,
          closedBy: 'manual',
          evidence: { commits: 0, reflogEvents: 1, linesAdded: 3, linesRemoved: 1, filesChanged: 1 },
          pauseCount: 0,
          totalPauseDurationMs: 0,
        },
      ],
      manualEntries: [...this.mockManualEntries],
      totalEffectiveMs: 7 * 3600_000,
      signalCount: 42,
      claimedMs: this.mockManualMinutes() * 60_000,
      dayStart: this.iso(9, 18),
      activeIntervals: [
        { from: this.iso(9, 18),  to: this.iso(10, 45), sessionId: 'c1', repo: 'D:/work/web-frontend' },
        { from: this.iso(11, 0),  to: this.iso(11, 30), sessionId: 's1', repo: 'D:/work/web-frontend' },
        { from: this.iso(11, 35), to: this.iso(11, 55), sessionId: 's3', repo: 'D:/work/infra-scripts' },
        { from: this.iso(13, 8),  to: this.iso(14, 50), sessionId: 'c2', repo: 'D:/work/api-backend' },
        { from: this.iso(15, 5),  to: this.iso(16, 10), sessionId: 's1', repo: 'D:/work/web-frontend' },
        { from: this.iso(16, 12), to: this.iso(16, 25), sessionId: 's2', repo: 'D:/work/api-backend' },
      ],
      downtimeMs: 1 * 3600_000 + 12 * 60_000,
      issueSummaries: {
        'ATL-6781': 'Daily standup and team sync',
        'ATL-6712': 'Existing Transaction: add missing reactive behaviour for Policy Dictionaries',
        'APP-1019': 'Pricing engine: clean up dead code branches',
        // Accepted-suggestion tickets — the real daemon backfills these too.
        'ATL-101': 'Team ceremonies & sync rituals',
        'ATL-205': 'Payments backlog refinement',
        'ATL-118': 'Payments squad: grooming & planning',
        'ATL-4512': '[DEV] Payment retry: dedupe idempotency keys',
        // APP-1024 left unmapped → its Logged row shows the "name not cached" placeholder
      },
    };
  }

  async getToday(): Promise<ApiResponse<TodayResponse>> {
    const day = this.buildToday();
    return { ok: true, data: { ...day, sessions: day.sessions.filter(s => !this.mockDeletedSessionIds.has(s.id)) } };
  }

  async getDay(_date: string): Promise<ApiResponse<TodayResponse>> {
    return this.getToday();
  }

  async getDays(): Promise<ApiResponse<DaysResponse>> {
    return { ok: true, data: { dates: [this.today] } };
  }

  async getStatus(): Promise<ApiResponse<StatusResponse>> {
    return {
      ok: true,
      data: {
        running: true, pid: 1234, date: this.today, uptime: 3600,
        jiraBaseUrl: 'https://your-company.atlassian.net',
        calendar: {
          configured: this.mockCalendarConfigured,
          lastFetchAt: this.mockCalendarConfigured ? this.mockCalendarFetchedAt : null,
          lastError: null,
          instanceCount: this.mockCalendarConfigured ? this.mockMeetings.length : 0,
        },
      },
    };
  }

  async pause(): Promise<ApiResponse<{ paused: string[] }>> {
    return { ok: true, data: { paused: [] } };
  }

  async resume(): Promise<ApiResponse<{ resumed: string[] }>> {
    return { ok: true, data: { resumed: [] } };
  }

  async sensitivity(level: SensitivityLevel): Promise<ApiResponse<SensitivityResponse>> {
    return { ok: true, data: { repo: null, level } };
  }

  async addSessionTime(sessionId: string, minutes: number): Promise<ApiResponse<ManualEntryResponse>> {
    await delay(150);
    const entry: ManualEntry = {
      id: `m${this.mockEntrySeq++}`,
      task: 'ATL-6781',
      minutes,
      description: '',
      activity: 'Development',
      createdAt: this.iso(12, 0),
      sourceSessionId: sessionId,
    };
    this.mockManualEntries = [...this.mockManualEntries, entry];
    return { ok: true, data: this.toEntryResponse(entry) };
  }

  async deleteSession(target: string, _date?: string): Promise<ApiResponse<SessionDeleteResponse>> {
    await delay(150);
    this.mockDeletedSessionIds.add(target);
    return {
      ok: true,
      data: { id: target, repo: 'mock', task: null, effectiveDurationMs: 0,
              date: this.today, dayFileDeleted: false, dayWasPushed: false },
    };
  }

  async deleteTask(task: string, _date?: string): Promise<ApiResponse<TaskDeleteResponse>> {
    await delay(150);
    for (const s of this.buildToday().sessions) {
      if (s.task === task && s.closedBy) this.mockDeletedSessionIds.add(s.id);
    }
    const entries = this.mockManualEntries.filter(e => e.sourceSessionId && e.task === task);
    this.mockManualEntries = this.mockManualEntries.filter(e => !(e.sourceSessionId && e.task === task));
    return {
      ok: true,
      data: { task, date: this.today, deletedSessions: 0, deletedEntries: entries.length,
              removedMs: entries.reduce((sum, e) => sum + e.minutes, 0) * 60_000,
              dayFileDeleted: false, dayWasPushed: false },
    };
  }

  async stop(): Promise<ApiResponse<unknown>> {
    return { ok: true, data: {} };
  }

  async startDaemon(): Promise<void> {
    // no-op in mock
  }

  private mockAutostart = true;

  async isDaemonManuallyStopped(): Promise<boolean> {
    return false;
  }

  async getAutostartEnabled(): Promise<boolean> {
    return this.mockAutostart;
  }

  async setAutostartEnabled(enabled: boolean): Promise<void> {
    this.mockAutostart = enabled;
  }

  // ─── Manual entries mocks ─────────────────────────────────────────────

  private mockManualMinutes(): number {
    return this.mockManualEntries.reduce((sum, e) => sum + e.minutes, 0);
  }

  async getActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>> {
    return { ok: true, data: { key: '_Activity_', fromCache: true, activities: MOCK_ACTIVITIES, allowed: [...this.mockActivityValues] } };
  }

  async refreshActivityTypes(): Promise<ApiResponse<ActivityTypesResponse>> {
    await delay(500); // simulates the Tempo work-attributes round-trip
    return this.getActivityTypes();
  }

  async addManualEntry(input: ManualEntryInput): Promise<ApiResponse<ManualEntryResponse>> {
    await delay(150);
    if (!input.task) return { ok: false, error: 'Missing task' };
    const activity = input.activity || 'Other';
    if (!input.description.trim() && activity !== DEVELOPMENT_ACTIVITY) {
      return { ok: false, error: 'Description is required (only Development may omit it)' };
    }
    const entry: ManualEntry = {
      id: `m${this.mockEntrySeq++}`,
      task: input.task,
      minutes: input.minutes,
      description: input.description.trim(),
      activity,
      createdAt: this.nextCreatedAt(),
    };
    this.mockManualEntries = [...this.mockManualEntries, entry];
    return { ok: true, data: this.toEntryResponse(entry) };
  }

  async updateManualEntry(target: string, patch: ManualEntryPatch, _date?: string): Promise<ApiResponse<ManualEntryResponse>> {
    await delay(150);
    const idx = this.mockManualEntries.findIndex(e => e.id === target);
    if (idx < 0) return { ok: false, error: `Manual entry not found: ${target}` };
    const updated: ManualEntry = {
      ...this.mockManualEntries[idx],
      minutes: patch.minutes ?? this.mockManualEntries[idx].minutes,
      description: (patch.description ?? this.mockManualEntries[idx].description).trim(),
      activity: patch.activity ?? this.mockManualEntries[idx].activity,
    };
    if (!updated.description && updated.activity !== DEVELOPMENT_ACTIVITY) {
      return { ok: false, error: 'Description is required (only Development may omit it)' };
    }
    this.mockManualEntries = this.mockManualEntries.map((e, i) => i === idx ? updated : e);
    return { ok: true, data: this.toEntryResponse(updated) };
  }

  async deleteManualEntry(target: string, _date?: string): Promise<ApiResponse<ManualEntryDeleteResponse>> {
    await delay(150);
    const removed = this.mockManualEntries.find(e => e.id === target);
    if (!removed) return { ok: false, error: `Manual entry not found: ${target}` };
    this.mockManualEntries = this.mockManualEntries.filter(e => e.id !== target);
    return {
      ok: true,
      data: { id: removed.id, task: removed.task, minutes: removed.minutes,
              totalManualMinutes: this.mockManualMinutes() },
    };
  }

  private toEntryResponse(entry: ManualEntry): ManualEntryResponse {
    return {
      id: entry.id, task: entry.task, minutes: entry.minutes,
      description: entry.description, activity: entry.activity,
      totalManualMinutes: this.mockManualMinutes(),
    };
  }

  // ─── Favorites mocks ──────────────────────────────────────────────────

  private mockFavorites: Favorite[] = [
    { id: 'f1', name: 'standup',      task: 'ATL-10',   minutes: 15, activity: 'Other',          createdAt: this.iso(9, 0) },
    { id: 'f2', name: 'code review',  task: 'ATL-6712', minutes: 30, activity: 'CodeReview',     createdAt: this.iso(9, 0) },
    { id: 'f3', name: 'planning',     task: 'ATL-10',   minutes: 60, activity: 'Other',          createdAt: this.iso(9, 0) },
    { id: 'f4', name: 'estimation',   task: 'ATL-6802', minutes: 45, activity: 'Estimation',     createdAt: this.iso(9, 0) },
    { id: 'f5', name: 'arch review',  task: 'ATL-6900', minutes: 45, activity: 'DesignAnalysis', createdAt: this.iso(9, 0) },
  ];
  private mockFavSeq = 6;

  async getFavorites(): Promise<ApiResponse<FavoritesResponse>> {
    return { ok: true, data: { favorites: [...this.mockFavorites] } };
  }

  async addFavorite(input: FavoriteInput): Promise<ApiResponse<FavoriteAddResponse>> {
    await delay(150);
    if (!input.task) return { ok: false, error: 'Task is required' };
    if (!input.name) return { ok: false, error: 'Name is required' };
    // Duplicate rule mirrors the daemon: task + name + minutes is the identity.
    const dup = this.mockFavorites.some(f =>
      f.task.toLowerCase() === input.task.toLowerCase()
      && normalizeFavName(f.name) === normalizeFavName(input.name)
      && f.minutes === input.minutes);
    if (dup) return { ok: false, error: `Already in favorites: ${input.task} — "${input.name}"` };
    const added: Favorite = {
      id: `f${this.mockFavSeq++}`,
      name: input.name,
      task: input.task,
      minutes: input.minutes,
      activity: input.activity || 'Other',
      createdAt: this.iso(12, 0),
    };
    this.mockFavorites = [...this.mockFavorites, added];
    return { ok: true, data: { added, favorites: [...this.mockFavorites] } };
  }

  async removeFavorite(target: string): Promise<ApiResponse<FavoriteRemoveResponse>> {
    await delay(150);
    const removed = this.mockFavorites.find(f => f.id === target);
    if (!removed) return { ok: false, error: `Favorite not found: ${target}` };
    this.mockFavorites = this.mockFavorites.filter(f => f !== removed);
    return { ok: true, data: { removed, favorites: [...this.mockFavorites] } };
  }

  // ─── Jira search mock ─────────────────────────────────────────────────

  private static readonly MOCK_JIRA_ISSUES: readonly JiraSearchHit[] = [
    { key: 'ATL-7001', summary: 'Payment gateway timeout on 3DS callback' },
    { key: 'ATL-7002', summary: 'Reactivity: stale premium after coverage change' },
    { key: 'ATL-7014', summary: 'Save pipeline drops middle names on import' },
    { key: 'ATL-7020', summary: 'Organization tree: drag-and-drop reorder' },
    { key: 'ATL-7031', summary: 'Feature flags cleanup for Q3 release' },
    { key: 'ATL-6712', summary: 'Code review automation for policy terms' },
  ];

  async searchJira(query: string): Promise<ApiResponse<JiraSearchResponse>> {
    await delay(400); // simulates the live-search latency the UI must absorb
    const q = query.trim().toLowerCase();
    if (q.length < 2) return { ok: true, data: { hits: [] } };
    const hits = MockWorkdayApiService.MOCK_JIRA_ISSUES.filter(issue =>
      issue.key.toLowerCase().includes(q) || issue.summary.toLowerCase().includes(q));
    return { ok: true, data: { hits } };
  }

  async getJiraProjects(): Promise<ApiResponse<JiraProjectsResponse>> {
    await delay(120);
    return { ok: true, data: { projects: this.mockKnownProjects.map(p => ({ ...p })), selected: [...this.mockProjectKeys] } };
  }

  async refreshJiraProjects(): Promise<ApiResponse<JiraProjectsResponse>> {
    await delay(500); // simulates the Jira /project/search round-trip
    return { ok: true, data: { projects: this.mockKnownProjects.map(p => ({ ...p })), selected: [...this.mockProjectKeys] } };
  }

  // ─── Timesheets / Settings mocks ──────────────────────────────────────

  async getMonth(year: number, month: number): Promise<ApiResponse<MonthResponse>> {
    await delay(200);
    return { ok: true, data: buildMockMonth(year, month, this.today) };
  }

  async pushToTempo(_from: string, _to: string, _force = false): Promise<ApiResponse<PushResponse>> {
    await delay(400);
    return {
      ok: true,
      data: { dryRun: false, plan: [], result: { posted: 3, updated: 1, deleted: 0, skipped: 12, failed: 0 } },
    };
  }

  async syncTempo(year: number, month: number): Promise<ApiResponse<TempoSyncResponse>> {
    await delay(600);
    const mm = `${year}-${String(month).padStart(2, '0')}`;
    return { ok: true, data: { month: mm, syncedAt: new Date().toISOString(), worklogCount: 42 } };
  }

  async importTempo(request: TempoImportRequest): Promise<ApiResponse<TempoImportResponse>> {
    await delay(500);
    const mm = request.date?.slice(0, 7)
      ?? `${request.year ?? 2026}-${String(request.month ?? 1).padStart(2, '0')}`;
    return { ok: true, data: { month: mm, syncedAt: new Date().toISOString(), imported: request.worklogIds?.length ?? 1, failed: 0, items: [] } };
  }

  async getTempoSchedule(year: number, month: number): Promise<ApiResponse<TempoScheduleResponse>> {
    await delay(150);
    const days = buildMockSchedule(year, month);
    return {
      ok: true,
      data: {
        available: true,
        days,
        requiredSecondsTotal: days.reduce((s, d) => s + d.requiredSeconds, 0),
        fromCache: true,
      },
    };
  }

  async getTempoApproval(year: number, month: number): Promise<ApiResponse<TempoApprovalResponse>> {
    await delay(150);
    const [ty, tm] = this.today.split('-').map(Number);
    const isPast = year < ty || (year === ty && month < tm);
    const isFuture = year > ty || (year === ty && month > tm);
    return {
      ok: true,
      data: {
        available: true,
        period: null,
        statusKey: isFuture ? null : (isPast ? 'APPROVED' : 'OPEN'),
        requiredSeconds: null,
        timeSpentSeconds: null,
        canSubmit: false,
        fromCache: true,
      },
    };
  }

  // Notifications: mock mode never toasts — empty list, echo ack.
  async getNotifications(): Promise<ApiResponse<NotificationsResponse>> {
    return { ok: true, data: { notifications: [] } };
  }

  async ackNotification(id: string, action: NotificationAckAction): Promise<ApiResponse<NotificationAckResponse>> {
    return { ok: true, data: { id, status: action === 'shown' ? 'delivered' : 'consumed' } };
  }

  async refreshCalendar(): Promise<ApiResponse<CalendarRefreshResponse>> {
    return { ok: true, data: { fetchedAt: new Date().toISOString(), instanceCount: this.mockMeetings.length } };
  }

  // Same derivation as the daemon: calendar minus covered (an entry carrying
  // the meeting's sourceRef) minus dismissed.
  async getSuggestions(date?: string): Promise<ApiResponse<SuggestionsResponse>> {
    await delay(100);
    const day = date ?? this.today;
    return { ok: true, data: this.suggestionsDay(day) };
  }

  async acceptSuggestion(request: SuggestionAcceptRequest): Promise<ApiResponse<SuggestionAcceptResponse>> {
    await delay(200);
    const meeting = this.mockMeetings.find(s => s.uid === request.uid && s.date === request.date);
    if (!meeting) return { ok: false, error: `No suggestion ${request.uid} in the mock calendar` };
    const sourceRef = suggestionSourceRef(meeting);
    if (this.mockManualEntries.some(e => e.sourceRef === sourceRef)) {
      return { ok: false, error: 'Meeting is already logged' };
    }
    const task = request.task || meeting.resolved?.task;
    if (!task) return { ok: false, error: 'Missing task (no learned resolution for this meeting)' };
    const entry: ManualEntry = {
      id: `m${this.mockEntrySeq++}`,
      task,
      minutes: request.minutes ?? meeting.plannedMinutes,
      description: request.description ?? meeting.resolved?.description ?? (meeting.isPrivate ? '' : meeting.title),
      activity: request.activity || meeting.resolved?.activity || 'Other',
      createdAt: this.nextCreatedAt(),
      sourceRef,
    };
    this.mockManualEntries.push(entry);
    return { ok: true, data: { entry: this.toEntryResponse(entry), day: this.suggestionsDay(meeting.date) } };
  }

  async dismissSuggestion(uid: string, date: string): Promise<ApiResponse<SuggestionsResponse>> {
    await delay(150);
    if (!this.mockMeetings.some(s => s.uid === uid && s.date === date)) {
      return { ok: false, error: 'Meeting not found in the calendar cache' };
    }
    this.mockDismissed.add(`${uid}:${date}`);
    return { ok: true, data: this.suggestionsDay(date) };
  }

  private suggestionsDay(date: string): SuggestionsResponse {
    const suggestions = this.mockMeetings.filter(s =>
      s.date === date
      && !(s.isPrivate && this.mockCalendar.hidePrivate)
      && !this.mockDismissed.has(`${s.uid}:${s.date}`)
      && !this.mockMuted.some(m => m.uid === s.uid)
      && !this.mockManualEntries.some(e => e.sourceRef === suggestionSourceRef(s)));
    return {
      date, state: SuggestionsDayState.Active, suggestions,
      // ATL-118 left unmapped → its candidate chip shows the bare key.
      issueSummaries: {
        'ATL-101': 'Team ceremonies & sync rituals',
        'ATL-205': 'Payments backlog refinement',
        'ATL-4512': '[DEV] Payment retry: dedupe idempotency keys',
      },
    };
  }

  async muteSuggestion(uid: string, date: string, days?: number): Promise<ApiResponse<SuggestionsResponse>> {
    await delay(150);
    const meeting = this.mockMeetings.find(s => s.uid === uid);
    if (!meeting) return { ok: false, error: 'Meeting not found in the calendar cache' };
    this.mockMuted = [
      ...this.mockMuted.filter(m => m.uid !== uid),
      {
        uid,
        mutedAt: new Date().toISOString(),
        until: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        title: meeting.title,
      },
    ];
    return { ok: true, data: this.suggestionsDay(date) };
  }

  async getMutedSuggestions(): Promise<ApiResponse<SuggestionsMutedResponse>> {
    return { ok: true, data: { muted: [...this.mockMuted] } };
  }

  async unmuteSuggestion(uid: string): Promise<ApiResponse<SuggestionUnmuteResponse>> {
    await delay(150);
    this.mockMuted = this.mockMuted.filter(m => m.uid !== uid);
    return { ok: true, data: { uids: [uid] } };
  }

  async unmuteAllSuggestions(): Promise<ApiResponse<SuggestionUnmuteResponse>> {
    await delay(150);
    const uids = this.mockMuted.map(m => m.uid);
    this.mockMuted = [];
    return { ok: true, data: { uids } };
  }

  async getSettings(): Promise<ApiResponse<SettingsResponse>> {
    return {
      ok: true,
      data: {
        config: {
          repos: [...this.mockRepos],
          boundaryHour: this.mockBoundaryHour,
          timezone: this.mockTimezone,
          tracking: { projectKeys: [...this.mockTracking.projectKeys], branchOwners: [...this.mockTracking.branchOwners] },
          sensitivity: { default: this.mockSensitivity },
          search: { projectKeys: [...this.mockProjectKeys], knownProjects: this.mockKnownProjects.map(p => ({ ...p })) },
          activities: { values: [...this.mockActivityValues] },
          calendar: { ...this.mockCalendar },
        },
        secretsMeta: {
          jiraConfigured: this.mockJiraConfigured,
          tempoConfigured: this.mockTempoConfigured,
          calendarConfigured: this.mockCalendarConfigured,
        },
      },
    };
  }

  async updateSettings(patch: SettingsPatch): Promise<ApiResponse<unknown>> {
    await delay(200);
    if (patch.config) {
      if (patch.config.repos) this.mockRepos = [...patch.config.repos];
      if (patch.config.boundaryHour !== undefined) this.mockBoundaryHour = patch.config.boundaryHour;
      if (patch.config.timezone) this.mockTimezone = patch.config.timezone;
      if (patch.config.tracking) {
        this.mockTracking = {
          projectKeys: [...(patch.config.tracking.projectKeys ?? this.mockTracking.projectKeys)],
          branchOwners: [...(patch.config.tracking.branchOwners ?? this.mockTracking.branchOwners)],
        };
      }
      if (patch.config.sensitivity?.default) this.mockSensitivity = patch.config.sensitivity.default;
      if (patch.config.search?.projectKeys) this.mockProjectKeys = [...patch.config.search.projectKeys];
      if (patch.config.activities?.values) this.mockActivityValues = [...patch.config.activities.values];
      if (patch.config.calendar) {
        this.mockCalendar = {
          enabled: patch.config.calendar.enabled ?? this.mockCalendar.enabled,
          hidePrivate: patch.config.calendar.hidePrivate ?? this.mockCalendar.hidePrivate,
        };
      }
    }
    if (patch.secrets) {
      if (patch.secrets.jiraToken !== undefined) {
        this.mockJiraConfigured = patch.secrets.jiraToken.trim() !== '';
      }
      if (patch.secrets.tempoToken !== undefined) {
        this.mockTempoConfigured = patch.secrets.tempoToken.trim() !== '';
      }
      if (patch.secrets.calendarIcsUrl !== undefined) {
        this.mockCalendarConfigured = patch.secrets.calendarIcsUrl.trim() !== '';
        this.mockCalendarFetchedAt = new Date().toISOString();
      }
    }
    return { ok: true, data: {} };
  }

  async addRepo(path: string): Promise<ApiResponse<AddRepoResponse>> {
    await delay(150);
    if (!path) return { ok: false, error: 'Missing path' };
    if (this.mockRepos.includes(path)) return { ok: false, error: 'Already added' };
    this.mockRepos.push(path);
    return { ok: true, data: { repos: [...this.mockRepos] } };
  }

  async removeRepo(path: string): Promise<ApiResponse<AddRepoResponse>> {
    await delay(150);
    if (!this.mockRepos.includes(path)) return { ok: false, error: 'Not in list' };
    if (this.mockRepos.length === 1) return { ok: false, error: 'Cannot remove last repo' };
    this.mockRepos = this.mockRepos.filter(r => r !== path);
    return { ok: true, data: { repos: [...this.mockRepos] } };
  }

  async checkDaemonUpdate(): Promise<ApiResponse<UpdateCheckResponse>> {
    await delay(600);
    return { ok: true, data: { current: '0.6.0', latest: '0.6.1', updateAvailable: true } };
  }

  async applyDaemonUpdate(): Promise<ApiResponse<UpdateApplyResponse>> {
    await delay(1200);
    return { ok: true, data: { updating: true, target: '0.6.1', message: 'Installed v0.6.1 — daemon restarting' } };
  }

  async getAppVersion(): Promise<string> {
    return '0.0.0-mock';
  }

  async checkAppUpdate(): Promise<string | null> {
    await delay(600);
    return null; // mock: always up to date (no Tauri updater in browser)
  }
}

// ─── Mock activity types (mirrors daemon FALLBACK_ACTIVITIES) ─────────────

const MOCK_ACTIVITIES: ReadonlyArray<{ readonly value: string; readonly name: string }> = [
  { value: 'AutomationPerformanceTesting', name: 'Automation/Performance Testing' },
  { value: 'Bugfixing', name: 'Bugfixing' },
  { value: 'CodeReview', name: 'Code Review' },
  { value: 'CodeReviewFixes', name: 'Code Review Fixes' },
  { value: 'DesignAnalysis', name: 'Design/Analysis' },
  { value: 'Development', name: 'Development' },
  { value: 'EnvironmentSetup', name: 'Environment Setup' },
  { value: 'Estimation', name: 'Estimation' },
  { value: 'IntegrationTesting', name: 'Integration Testing' },
  { value: 'Merge', name: 'Merge' },
  { value: 'Other', name: 'Other' },
  { value: "QAlead'sactivities", name: "QA lead's activities" },
  { value: 'PM', name: 'PM' },
  { value: 'TechnicalControl', name: 'Technical Control' },
  { value: 'Testing', name: 'Testing' },
  { value: 'TestReview', name: 'Test Review' },
];

// ─── Mock month dataset ──────────────────────────────────────────────────
// Deterministic generator for any requested month: weekdays carry pushed
// 7-8h, the last few days before today are pending, one day is outdated.

const HOLIDAY_DAY = 6; // every mock month has one named holiday on the 6th

function mockIso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function mockDow(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day).getDay(); // 0=Sun..6=Sat
}

function buildMockMonth(year: number, month: number, today: string): MonthResponse {
  const lastDay = new Date(year, month, 0).getDate();
  const from = mockIso(year, month, 1);
  const to = mockIso(year, month, lastDay);
  const days: MonthDaySummary[] = [];
  const totals = {
    claimedMs: 0, reportedSeconds: 0,
    daysWithData: 0, pendingDays: 0, outdatedDays: 0, pushedDays: 0,
  };
  let lastPushAt: string | null = null;

  for (let d = 1; d <= lastDay; d++) {
    const date = mockIso(year, month, d);
    const dow = mockDow(year, month, d);
    const isWeekend = dow === 0 || dow === 6;
    const empty = isWeekend || date > today || (d === HOLIDAY_DAY && d % 2 === 0);
    if (empty) {
      days.push({ date, dayType: null, status: MonthDayStatus.None, claimedMs: 0,
                  reportedSeconds: 0, taskCount: 0, tasks: [], pushedAt: null });
      continue;
    }

    // Recent days pending, one mid-month day outdated, the rest pushed.
    const age = daysBetween(date, today);
    const status = age <= 4 ? MonthDayStatus.Pending
      : (d === 9 ? MonthDayStatus.Outdated : MonthDayStatus.Pushed);
    const tasks: MonthDayTask[] = d % 3 === 0
      ? [
          { task: 'ATL-6781', seconds: 4.5 * 3600, kind: 'session', sessionCount: 2 },
          { task: 'ATL-6442', seconds: 2.25 * 3600, kind: 'session', sessionCount: 1 },
          { task: 'ATL-10', seconds: 900, kind: 'manual', sessionCount: 0,
            entryId: `mock-${date}-standup`, description: 'standup', activity: 'Other' },
        ]
      : [
          { task: 'ATL-6781', seconds: 7.5 * 3600, kind: 'session', sessionCount: 3 },
          { task: 'ATL-6892', seconds: 1800, kind: 'manual', sessionCount: 0,
            entryId: `mock-${date}-review`, description: 'review: saga retries', activity: 'CodeReview' },
        ];
    const reportedSeconds = tasks.reduce((s, t) => s + t.seconds, 0);
    const pushedAt = status === MonthDayStatus.Pending ? null : `${date}T18:40:00.000Z`;

    days.push({
      date, dayType: 'workday', status,
      claimedMs: reportedSeconds * 1000 - 600_000,
      reportedSeconds,
      taskCount: new Set(tasks.map(t => t.task)).size,
      tasks, pushedAt,
    });

    totals.claimedMs += reportedSeconds * 1000 - 600_000;
    totals.reportedSeconds += reportedSeconds;
    totals.daysWithData++;
    if (status === MonthDayStatus.Pending) totals.pendingDays++;
    if (status === MonthDayStatus.Outdated) totals.outdatedDays++;
    if (status === MonthDayStatus.Pushed) totals.pushedDays++;
    if (pushedAt && (!lastPushAt || pushedAt > lastPushAt)) lastPushAt = pushedAt;
  }

  return {
    year, month, from, to, days, totals, lastPushAt,
    issueSummaries: {
      'ATL-6781': 'Daily standup and team sync',
      'ATL-6442': 'Existing Transaction: reactive save for Policy Dictionaries',
      'ATL-6892': 'Saga retries: harden the outbox dispatcher',
      // ATL-10 left unmapped → its drawer row shows an empty name column
    },
  };
}

function buildMockSchedule(year: number, month: number): ScheduleDay[] {
  const lastDay = new Date(year, month, 0).getDate();
  const days: ScheduleDay[] = [];
  for (let d = 1; d <= lastDay; d++) {
    const dow = mockDow(year, month, d);
    const isWeekend = dow === 0 || dow === 6;
    const isHoliday = d === HOLIDAY_DAY && !isWeekend;
    days.push({
      date: mockIso(year, month, d),
      requiredSeconds: isWeekend || isHoliday ? 0 : 8 * 3600,
      type: isHoliday ? 'HOLIDAY' : (isWeekend ? 'NON_WORKING_DAY' : 'WORKING_DAY'),
      holidayName: isHoliday ? 'National Holiday' : null,
    });
  }
  return days;
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
