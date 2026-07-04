import { Injectable } from '@angular/core';
import { WorkdayApiService } from './workday-api.service';
import {
  ApiResponse,
  TodayResponse,
  StatusResponse,
  SensitivityResponse,
  SensitivityLevel,
  AdjustResponse,
  SessionDeleteResponse,
  DaysResponse,
  MonthResponse,
  MonthDay,
  DayStatus,
  SettingsResponse,
  SettingsPatch,
  AddRepoResponse,
  UpdateCheckResponse,
  UpdateApplyResponse,
  ActivityTypesResponse,
  ManualEntry,
  ManualEntryResponse,
  ManualEntryInput,
  ManualEntryPatch,
} from '../models/workday.models';

// Local-only preview service — returns rich mock data so the UI can be
// inspected end-to-end without a running daemon. Selected through a query
// flag in app.config.ts (?mock=1) — never wired in production builds.
@Injectable()
export class MockWorkdayApiService extends WorkdayApiService {

  // Mutable so addRepo/removeRepo feels real in mock mode.
  private mockRepos: string[] = ['D:/work/atlas-frontend', 'D:/work/appone-backend'];
  private mockSensitivity: SensitivityLevel = SensitivityLevel.Normal;
  private mockJiraConfigured = true;
  private mockTempoConfigured = true;
  private mockBoundaryHour = 4;
  private mockTimezone = 'Europe/Moscow';
  private mockTaskPattern = 'ATL-\\d+';

  // Mutable so add/edit manual entries feel real in mock mode.
  private mockManualEntries: ManualEntry[] = [
    { id: 'm1', task: 'ATL-6781', minutes: 15, description: 'daily standup',
      activity: 'Other', createdAt: this.iso(10, 0) },
    { id: 'm2', task: 'ATL-6712', minutes: 30, description: 'PR #214 review with team',
      activity: 'CodeReview', createdAt: this.iso(13, 30) },
    { id: 'm3', task: 'APP-1024', minutes: 45, description: 'sprint planning',
      activity: 'Other', createdAt: this.iso(15, 0) },
  ];
  private mockEntrySeq = 4;

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

  private buildToday(): TodayResponse {
    return {
      date: this.today,
      dayType: 'workday',
      status: 'active',
      sessions: [
        {
          id: 's1',
          repo: 'D:/work/atlas-frontend',
          task: 'ATL-6781',
          branch: 'ATL-6781-atemnov-save-fee-endpoints',
          state: 'active',
          startedAt: this.iso(9, 18),
          activatedAt: this.iso(9, 22),
          lastSeenAt: this.iso(16, 25),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 4 * 3600_000 + 12 * 60_000,
          manualMinutes: 0,
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
          repo: 'D:/work/appone-backend',
          task: 'APP-1024',
          branch: 'APP-1024-refactor-pricing-engine',
          state: 'pending',
          startedAt: this.iso(16, 5),
          activatedAt: null,
          lastSeenAt: this.iso(16, 25),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 5 * 60_000,
          manualMinutes: 45,
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
          state: 'pending',
          startedAt: this.iso(11, 30),
          activatedAt: null,
          lastSeenAt: this.iso(11, 55),
          paused: true,
          pauseSource: 'idle_timeout',
          effectiveDurationMs: 22 * 60_000,
          manualMinutes: 0,
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
          repo: 'D:/work/atlas-frontend',
          task: 'ATL-6712',
          branch: 'ATL-6712-fix-leak',
          state: 'active',
          startedAt: this.iso(9, 18),
          activatedAt: this.iso(9, 22),
          lastSeenAt: this.iso(10, 45),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 1 * 3600_000 + 27 * 60_000,
          manualMinutes: 0,
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
          id: 'c2',
          repo: 'D:/work/appone-backend',
          task: 'APP-1019',
          branch: 'APP-1019-cleanup',
          state: 'active',
          startedAt: this.iso(11, 35),
          activatedAt: this.iso(11, 40),
          lastSeenAt: this.iso(12, 50),
          paused: false,
          pauseSource: null,
          effectiveDurationMs: 1 * 3600_000 + 15 * 60_000,
          manualMinutes: 0,
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
          manualMinutes: 0,
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
        { from: this.iso(9, 18),  to: this.iso(10, 45), sessionId: 'c1', repo: 'D:/work/atlas-frontend' },
        { from: this.iso(11, 0),  to: this.iso(11, 30), sessionId: 's1', repo: 'D:/work/atlas-frontend' },
        { from: this.iso(11, 35), to: this.iso(11, 55), sessionId: 's3', repo: 'D:/work/infra-scripts' },
        { from: this.iso(13, 8),  to: this.iso(14, 50), sessionId: 'c2', repo: 'D:/work/appone-backend' },
        { from: this.iso(15, 5),  to: this.iso(16, 10), sessionId: 's1', repo: 'D:/work/atlas-frontend' },
        { from: this.iso(16, 12), to: this.iso(16, 25), sessionId: 's2', repo: 'D:/work/appone-backend' },
      ],
      downtimeMs: 1 * 3600_000 + 12 * 60_000,
    };
  }

  async getToday(): Promise<ApiResponse<TodayResponse>> {
    return { ok: true, data: this.buildToday() };
  }

  async getDay(_date: string): Promise<ApiResponse<TodayResponse>> {
    return this.getToday();
  }

  async getDays(): Promise<ApiResponse<DaysResponse>> {
    return { ok: true, data: { dates: [this.today] } };
  }

  async getStatus(): Promise<ApiResponse<StatusResponse>> {
    return { ok: true, data: { running: true, pid: 1234, date: this.today, uptime: 3600 } };
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

  async adjust(target: string, minutes: number): Promise<ApiResponse<AdjustResponse>> {
    return {
      ok: true,
      data: { sessionId: target, repo: 'mock', task: null, addedMinutes: minutes,
              totalManualMinutes: minutes },
    };
  }

  async deleteSession(target: string): Promise<ApiResponse<SessionDeleteResponse>> {
    return {
      ok: true,
      data: { id: target, repo: 'mock', task: null, effectiveDurationMs: 0,
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
    return { ok: true, data: { key: '_Activity_', fromCache: true, activities: MOCK_ACTIVITIES } };
  }

  async addManualEntry(input: ManualEntryInput): Promise<ApiResponse<ManualEntryResponse>> {
    await delay(150);
    if (!input.task) return { ok: false, error: 'Missing task' };
    if (!input.description) return { ok: false, error: 'Missing description' };
    const entry: ManualEntry = {
      id: `m${this.mockEntrySeq++}`,
      task: input.task,
      minutes: input.minutes,
      description: input.description,
      activity: input.activity || 'Other',
      createdAt: this.iso(12, 0),
    };
    this.mockManualEntries = [...this.mockManualEntries, entry];
    return { ok: true, data: this.toEntryResponse(entry) };
  }

  async updateManualEntry(target: string, patch: ManualEntryPatch): Promise<ApiResponse<ManualEntryResponse>> {
    await delay(150);
    const idx = this.mockManualEntries.findIndex(e => e.id === target);
    if (idx < 0) return { ok: false, error: `Manual entry not found: ${target}` };
    const updated: ManualEntry = {
      ...this.mockManualEntries[idx],
      minutes: patch.minutes ?? this.mockManualEntries[idx].minutes,
      description: patch.description ?? this.mockManualEntries[idx].description,
      activity: patch.activity ?? this.mockManualEntries[idx].activity,
    };
    this.mockManualEntries = this.mockManualEntries.map((e, i) => i === idx ? updated : e);
    return { ok: true, data: this.toEntryResponse(updated) };
  }

  private toEntryResponse(entry: ManualEntry): ManualEntryResponse {
    return {
      id: entry.id, task: entry.task, minutes: entry.minutes,
      description: entry.description, activity: entry.activity,
      totalManualMinutes: this.mockManualMinutes(),
    };
  }

  // ─── Timesheets / Settings mocks ──────────────────────────────────────

  async getMonth(year: number, month: number): Promise<ApiResponse<MonthResponse>> {
    // For preview we always return the curated month sample, ignoring the
    // requested year/month. Real impl reads from disk via a daemon endpoint.
    return { ok: true, data: { year, month, days: MOCK_MONTH_DAYS } };
  }

  async confirmDay(_date: string): Promise<ApiResponse<unknown>> {
    await delay(150);
    return { ok: true, data: {} };
  }

  async pushToTempo(_from: string, _to: string): Promise<ApiResponse<unknown>> {
    await delay(400);
    return { ok: true, data: {} };
  }

  async getSettings(): Promise<ApiResponse<SettingsResponse>> {
    return {
      ok: true,
      data: {
        config: {
          repos: [...this.mockRepos],
          boundaryHour: this.mockBoundaryHour,
          timezone: this.mockTimezone,
          taskPattern: this.mockTaskPattern,
          sensitivity: { default: this.mockSensitivity },
        },
        secretsMeta: { jiraConfigured: this.mockJiraConfigured, tempoConfigured: this.mockTempoConfigured },
      },
    };
  }

  async updateSettings(patch: SettingsPatch): Promise<ApiResponse<unknown>> {
    await delay(200);
    if (patch.config) {
      if (patch.config.repos) this.mockRepos = [...patch.config.repos];
      if (patch.config.boundaryHour !== undefined) this.mockBoundaryHour = patch.config.boundaryHour;
      if (patch.config.timezone) this.mockTimezone = patch.config.timezone;
      if (patch.config.taskPattern !== undefined) this.mockTaskPattern = patch.config.taskPattern;
      if (patch.config.sensitivity?.default) this.mockSensitivity = patch.config.sensitivity.default;
    }
    if (patch.secrets) {
      if (patch.secrets.jiraToken !== undefined) {
        this.mockJiraConfigured = patch.secrets.jiraToken.trim() !== '';
      }
      if (patch.secrets.tempoToken !== undefined) {
        this.mockTempoConfigured = patch.secrets.tempoToken.trim() !== '';
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

const HOUR = 3_600_000;

function task(key: string, hours: number) {
  return { key, ms: Math.round(hours * HOUR) };
}

// May 2026 — past + today only; future days are dropped by the view layer.
// Ported from tray-app/design-preview/nav-options.html `mayDays()`.
const MOCK_MONTH_DAYS: readonly MonthDay[] = [
  { date: '2026-05-01', dayType: 'workday', status: DayStatus.Pushed,
    claimedMs: Math.round(4.5 * HOUR), tasks: [task('ATL-6781', 4.5)] },
  { date: '2026-05-02', dayType: 'weekend', status: DayStatus.Draft, claimedMs: 0, tasks: [] },
  { date: '2026-05-03', dayType: 'weekend', status: DayStatus.Draft, claimedMs: 0, tasks: [] },

  { date: '2026-05-04', dayType: 'workday', status: DayStatus.Pushed,
    claimedMs: Math.round(7.5 * HOUR), tasks: [task('ATL-6781', 7.5)] },
  { date: '2026-05-05', dayType: 'workday', status: DayStatus.Pushed,
    claimedMs: Math.round(8.0 * HOUR), tasks: [task('ATL-6781', 7), task('standup', 1)] },
  { date: '2026-05-06', dayType: 'workday', status: DayStatus.Pushed,
    claimedMs: Math.round(7.0 * HOUR), tasks: [task('ATL-6442', 7)] },
  { date: '2026-05-07', dayType: 'workday', status: DayStatus.Pushed,
    claimedMs: Math.round(8.0 * HOUR), tasks: [task('ATL-6442', 5), task('ATL-6701', 3)] },
  { date: '2026-05-08', dayType: 'workday', status: DayStatus.Pushed,
    claimedMs: Math.round(7.5 * HOUR), tasks: [task('ATL-6701', 7.5)] },
  { date: '2026-05-09', dayType: 'weekend', status: DayStatus.Draft, claimedMs: 0, tasks: [] },
  { date: '2026-05-10', dayType: 'weekend', status: DayStatus.Draft, claimedMs: 0, tasks: [] },

  { date: '2026-05-11', dayType: 'workday', status: DayStatus.Confirmed,
    claimedMs: Math.round(7.5 * HOUR), tasks: [task('ATL-6781', 4), task('ATL-6701', 3.5)] },
  { date: '2026-05-12', dayType: 'workday', status: DayStatus.Confirmed,
    claimedMs: Math.round(6.5 * HOUR), tasks: [task('ATL-6701', 6.5)] },
  { date: '2026-05-13', dayType: 'workday', status: DayStatus.Confirmed,
    claimedMs: Math.round(7.0 * HOUR), tasks: [task('ATL-6781', 4), task('ATL-6701', 3)] },
  { date: '2026-05-14', dayType: 'workday', status: DayStatus.Draft,
    claimedMs: Math.round(8.0 * HOUR),
    tasks: [task('ATL-6442', 3), task('ATL-6701', 2), task('ATL-6781', 1.5),
            task('ATL-6892', 0.5), task('review', 0.5), task('standup', 0.5)] },
  { date: '2026-05-15', dayType: 'workday', status: DayStatus.Draft,
    claimedMs: Math.round(7.5 * HOUR),
    tasks: [task('ATL-6781', 4), task('ATL-6442', 2.5), task('standup', 1)] },
  { date: '2026-05-16', dayType: 'weekend', status: DayStatus.Draft, claimedMs: 0, tasks: [] },
  { date: '2026-05-17', dayType: 'weekend', status: DayStatus.Draft,
    claimedMs: 0, tasks: [task('ATL-6781', 0)] },
];

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
