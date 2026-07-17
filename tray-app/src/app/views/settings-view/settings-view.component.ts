import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkdayApiService } from '../../services/workday-api.service';
import {
  ActivityType, CalendarFeedStatus, ProjectRef, SensitivityLevel, SettingsConfigSubset,
  SettingsResponse, TrackingConfig,
} from '../../models/workday.models';

type IndicatorState = 'idle' | 'saving' | 'saved' | 'error';
type UpdateState = 'idle' | 'checking' | 'available' | 'applying' | 'restarting' | 'done' | 'error';

interface PendingPatch {
  config?: Partial<SettingsConfigSubset>;
  secrets?: { jiraToken?: string; tempoToken?: string; calendarIcsUrl?: string };
}

@Component({
  selector: 'app-settings-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings-view.component.html',
  styleUrl: './settings-view.component.scss',
})
export class SettingsViewComponent implements OnInit, OnChanges, OnDestroy {
  // Daemon lifecycle lives in the app shell (stop = confirm modal there,
  // start = spawn + watchdog resume); settings just asks for it.
  @Output() stopDaemonRequested = new EventEmitter<void>();
  @Output() startDaemonRequested = new EventEmitter<void>();

  // Supervisor state from the shell's watchdog — drives the Start/Stop toggle.
  @Input() daemonReachable = true;
  @Input() daemonStarting = false;

  // Pending tray update announced by the shell's background check — lets the
  // App version row show "update available" without re-checking on open.
  @Input() appUpdateVersion: string | null = null;

  settings: SettingsResponse | null = null;
  loading = true;

  indicatorState: IndicatorState = 'idle';
  indicatorLabel = '';

  jiraTokenDraft: string | null = null;
  tempoTokenDraft: string | null = null;
  calendarUrlDraft: string | null = null;

  // Feed health for the calendar row — from /api/status, best-effort.
  calendarStatus: CalendarFeedStatus | null = null;
  private calendarStatusTimer: number | null = null;

  // Display labels only — backing enum values (low/normal/patient/always_on)
  // are unchanged. Mirrors the day-view scale naming.
  readonly sensitivityOptions: readonly { key: SensitivityLevel; label: string }[] = [
    { key: SensitivityLevel.Low,      label: 'Sharp' },
    { key: SensitivityLevel.Normal,   label: 'Normal' },
    { key: SensitivityLevel.Patient,  label: 'Relaxed' },
    { key: SensitivityLevel.AlwaysOn, label: 'Nonstop' },
  ];

  // Launch-at-login (Tauri autostart plugin via Rust commands). Loaded on
  // init; toggling is optimistic with revert on failure.
  autoStartWithOs = true;
  private autostartBusy = false;

  // Visual-only toggle (no backend yet — kept disabled in template)
  notifyOnIdle = false;

  // Daemon update flow (the "Check updates" button)
  updateState: UpdateState = 'idle';
  updateLabel = '';
  private updateTarget: string | null = null;
  private updatePollTimer: number | null = null;

  // Tray-app update flow — separate from the daemon's. Install is banner-driven
  // (the shell raises it), so there's no inline "Update now" here.
  appVersion = '';
  appUpdateState: UpdateState = 'idle';
  appUpdateLabel = '';

  private pending: PendingPatch = {};
  private debounceTimer: number | null = null;
  private inFlight = false;
  private savedFlashTimer: number | null = null;

  constructor(private api: WorkdayApiService) {}

  async ngOnInit(): Promise<void> {
    this.autoStartWithOs = await this.api.getAutostartEnabled();
    this.appVersion = await this.api.getAppVersion();
    await this.refresh();
    this.loading = false;
    // Activity catalog for the scope picker — cheap, served from the daemon's
    // work-attributes cache.
    void this.loadActivityCatalog();
  }

  private async loadActivityCatalog(): Promise<void> {
    const res = await this.api.getActivityTypes();
    if (res.ok && res.data) this.activityCatalog = res.data.activities;
  }

  // Self-heal: settings failed to load while the daemon was down — re-pull
  // the moment the watchdog reports it back.
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['daemonReachable'] && this.daemonReachable && !this.settings && !this.loading) {
      void this.refresh();
    }
  }

  async toggleAutostart(): Promise<void> {
    if (this.autostartBusy) return;
    this.autostartBusy = true;
    const next = !this.autoStartWithOs;
    this.autoStartWithOs = next;
    try {
      await this.api.setAutostartEnabled(next);
    } catch (e) {
      this.autoStartWithOs = !next;
      this.setIndicator('error', 'Failed to change autostart');
      console.error('Autostart toggle failed', e);
    } finally {
      this.autostartBusy = false;
    }
  }

  ngOnDestroy(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    if (this.savedFlashTimer !== null) window.clearTimeout(this.savedFlashTimer);
    if (this.updatePollTimer !== null) window.clearInterval(this.updatePollTimer);
    if (this.calendarStatusTimer !== null) window.clearTimeout(this.calendarStatusTimer);
  }

  // ─── Daemon updates ─────────────────────────────────────────────────────

  get daemonVersionLabel(): string {
    return this.settings?.daemonVersion ? `v${this.settings.daemonVersion}` : 'unknown';
  }

  get appVersionLabel(): string {
    return this.appVersion ? `v${this.appVersion}` : 'unknown';
  }

  get updateBusy(): boolean {
    return this.updateState === 'checking' || this.updateState === 'applying' || this.updateState === 'restarting';
  }

  get appUpdateBusy(): boolean {
    return this.appUpdateState === 'checking';
  }

  async checkUpdates(): Promise<void> {
    if (this.updateBusy) return;
    this.updateState = 'checking';
    this.updateLabel = 'Checking npm registry...';
    const res = await this.api.checkDaemonUpdate();
    if (!res.ok || !res.data) {
      this.updateState = 'error';
      this.updateLabel = res.error ?? 'Update check failed';
      return;
    }
    if (res.data.updateAvailable) {
      this.updateState = 'available';
      this.updateTarget = res.data.latest;
      this.updateLabel = `v${res.data.latest} available`;
    } else {
      this.updateState = 'done';
      this.updateLabel = `Up to date (v${res.data.current})`;
    }
  }

  async applyUpdate(): Promise<void> {
    if (this.updateBusy || this.updateTarget === null) return;
    this.updateState = 'applying';
    this.updateLabel = `Installing v${this.updateTarget}...`;
    const res = await this.api.applyDaemonUpdate();
    if (!res.ok || !res.data) {
      this.updateState = 'error';
      this.updateLabel = res.error ?? 'Update failed';
      return;
    }
    if (!res.data.updating) {
      this.updateState = 'done';
      this.updateLabel = res.data.message;
      return;
    }
    // Daemon restarts itself now — poll settings until the new version answers.
    this.updateState = 'restarting';
    this.updateLabel = 'Daemon restarting...';
    this.watchRestart(res.data.target);
  }

  private watchRestart(target: string): void {
    const startedAt = Date.now();
    if (this.updatePollTimer !== null) window.clearInterval(this.updatePollTimer);
    this.updatePollTimer = window.setInterval(async () => {
      const res = await this.api.getSettings();
      if (res.ok && res.data?.daemonVersion === target) {
        this.stopRestartWatch();
        this.settings = res.data;
        this.updateState = 'done';
        this.updateTarget = null;
        this.updateLabel = `Updated to v${target}`;
      } else if (Date.now() - startedAt > 60_000) {
        this.stopRestartWatch();
        this.updateState = 'error';
        this.updateLabel = 'Daemon did not come back in 60s — check `workday status`';
      }
    }, 2_000);
  }

  private stopRestartWatch(): void {
    if (this.updatePollTimer !== null) {
      window.clearInterval(this.updatePollTimer);
      this.updatePollTimer = null;
    }
  }

  // ─── Tray-app updates ───────────────────────────────────────────────────

  // Check-only: a found version raises the shell's install banner (Rust emits
  // 'app-update-available'). Install itself is the banner's job — no inline
  // "Update now" here (a mid-work restart would kill a half-typed entry).
  async checkAppUpdates(): Promise<void> {
    if (this.appUpdateBusy) return;
    this.appUpdateState = 'checking';
    this.appUpdateLabel = 'Checking for app updates…';
    try {
      const version = await this.api.checkAppUpdate();
      if (version) {
        this.appUpdateVersion = version;
        this.appUpdateState = 'available';
        this.appUpdateLabel = `v${version} ready — install from the banner above`;
      } else {
        this.appUpdateState = 'done';
        this.appUpdateLabel = `Up to date (v${this.appVersion})`;
      }
    } catch {
      this.appUpdateState = 'error';
      this.appUpdateLabel = 'Update check failed';
    }
  }

  // ─── Optimistic field setters ──────────────────────────────────────────

  selectSensitivity(level: SensitivityLevel): void {
    this.applyLocal(c => ({ ...c, sensitivity: { ...c.sensitivity, default: level } }));
    this.queue({ sensitivity: { default: level } }, 'immediate');
  }

  onDayBoundaryChange(value: string): void {
    const hour = parseInt(value.split(':')[0] ?? '4', 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;
    this.applyLocal(c => ({ ...c, boundaryHour: hour }));
    this.queue({ boundaryHour: hour }, 'debounced', 300);
  }

  // ─── Tracking scope (projects to follow · branch owners) ───────────────

  trackingOpen = false;
  trackingFilter = '';

  get tracking(): TrackingConfig {
    return this.settings?.config.tracking ?? { projectKeys: [], branchOwners: [] };
  }

  get trackedProjectKeys(): readonly string[] {
    return this.tracking.projectKeys;
  }

  get trackingSummary(): string {
    return this.trackedProjectKeys.join(' · ') || 'none';
  }

  get branchOwnersText(): string {
    return this.tracking.branchOwners.join(', ');
  }

  get filteredTrackingProjects(): readonly ProjectRef[] {
    const q = this.trackingFilter.trim().toLowerCase();
    if (!q) return this.knownProjects;
    return this.knownProjects.filter(p =>
      p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }

  isTrackingProjectSelected(key: string): boolean {
    return this.trackedProjectKeys.includes(key);
  }

  toggleTrackingProject(key: string): void {
    const cur = this.trackedProjectKeys;
    if (cur.includes(key)) {
      if (cur.length === 1) {
        this.setIndicator('error', 'At least one tracked project is required');
        return;
      }
      this.setTracking({ projectKeys: cur.filter(k => k !== key) });
    } else {
      this.setTracking({ projectKeys: [...cur, key] });
    }
  }

  // Comma/space separated names → owner list. Strict token match happens
  // daemon-side; here we only parse the field.
  onBranchOwnersChange(value: string): void {
    const branchOwners = value.split(/[,\s]+/).map(o => o.trim()).filter(Boolean);
    this.setTracking({ branchOwners });
  }

  // Persist tracking. Carries both fields so the daemon's deep-merge always
  // sees a full TrackingConfig regardless of which side was edited.
  private setTracking(patch: Partial<TrackingConfig>): void {
    const tracking: TrackingConfig = {
      projectKeys: [...(patch.projectKeys ?? this.tracking.projectKeys)],
      branchOwners: [...(patch.branchOwners ?? this.tracking.branchOwners)],
    };
    this.applyLocal(c => ({ ...c, tracking }));
    this.queue({ tracking }, 'debounced', 400);
  }

  // ─── Scope pickers (Jira projects · Tempo activity types) ──────────────
  // Twin dropdowns, both closed by default — the summary line is the whole
  // rest-state footprint.

  projectsOpen = false;
  projectFilter = '';
  projectsRefreshing = false;

  activitiesOpen = false;
  activityFilter = '';
  activitiesRefreshing = false;
  activityCatalog: readonly ActivityType[] = [];

  get knownProjects(): readonly ProjectRef[] {
    return this.settings?.config.search?.knownProjects ?? [];
  }

  get selectedProjectKeys(): readonly string[] {
    return this.settings?.config.search?.projectKeys ?? [];
  }

  get projectsSummary(): string {
    return this.selectedProjectKeys.join(' · ') || 'all projects';
  }

  get filteredProjects(): readonly ProjectRef[] {
    const q = this.projectFilter.trim().toLowerCase();
    if (!q) return this.knownProjects;
    return this.knownProjects.filter(p =>
      p.key.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  }

  isProjectSelected(key: string): boolean {
    return this.selectedProjectKeys.includes(key);
  }

  toggleProject(key: string): void {
    const cur = this.selectedProjectKeys;
    this.setProjectKeys(cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key]);
  }

  // Persist the selection. Carries the current catalog so the daemon's
  // deep-merge keeps it (and the type wants a full SearchConfig).
  private setProjectKeys(keys: readonly string[]): void {
    const knownProjects = this.knownProjects.map(p => ({ ...p }));
    const search = { projectKeys: [...keys], knownProjects };
    this.applyLocal(c => ({ ...c, search }));
    this.queue({ search }, 'debounced', 400);
  }

  async refreshProjects(): Promise<void> {
    if (this.projectsRefreshing) return;
    this.projectsRefreshing = true;
    this.setIndicator('saving', 'Fetching projects…');
    const res = await this.api.refreshJiraProjects();
    this.projectsRefreshing = false;
    if (res.ok && res.data) {
      const search = { projectKeys: [...res.data.selected], knownProjects: res.data.projects.map(p => ({ ...p })) };
      this.applyLocal(c => ({ ...c, search }));
      this.setIndicator('saved', `Fetched ${res.data.projects.length} projects`);
      this.scheduleSavedFlash();
    } else {
      this.setIndicator('error', res.error ?? 'Failed to fetch projects');
    }
  }

  // ── Activity types — the projects picker's twin ──

  get selectedActivityValues(): readonly string[] {
    return this.settings?.config.activities?.values ?? [];
  }

  get activitiesSummary(): string {
    const values = this.selectedActivityValues;
    if (values.length === 0) return 'all types';
    const byValue = new Map(this.activityCatalog.map(a => [a.value, a.name]));
    return values.map(v => byValue.get(v) ?? v).join(' · ');
  }

  get filteredActivities(): readonly ActivityType[] {
    const q = this.activityFilter.trim().toLowerCase();
    if (!q) return this.activityCatalog;
    return this.activityCatalog.filter(a =>
      a.value.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
  }

  isActivitySelected(value: string): boolean {
    return this.selectedActivityValues.includes(value);
  }

  toggleActivity(value: string): void {
    const cur = this.selectedActivityValues;
    this.setActivityValues(cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value]);
  }

  private setActivityValues(values: readonly string[]): void {
    const activities = { values: [...values] };
    this.applyLocal(c => ({ ...c, activities }));
    this.queue({ activities }, 'debounced', 400);
  }

  async refreshActivities(): Promise<void> {
    if (this.activitiesRefreshing) return;
    this.activitiesRefreshing = true;
    this.setIndicator('saving', 'Fetching activity types…');
    const res = await this.api.refreshActivityTypes();
    this.activitiesRefreshing = false;
    if (res.ok && res.data) {
      this.activityCatalog = res.data.activities;
      this.setIndicator('saved', `Fetched ${res.data.activities.length} activity types`);
      this.scheduleSavedFlash();
    } else {
      this.setIndicator('error', res.error ?? 'Failed to fetch activity types');
    }
  }

  // ─── Repo list ────────────────────────────────────────────────────────

  repoName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }

  repoDot(idx: number): string {
    const palette = ['#89b4fa', '#f38ba8', '#a6e3a1', '#fab387', '#cba6f7', '#f9e2af', '#94e2d5', '#f5c2e7'];
    return palette[idx % palette.length];
  }

  async removeRepo(path: string): Promise<void> {
    if (!this.settings) return;
    if (this.settings.config.repos.length <= 1) {
      this.setIndicator('error', 'Cannot remove last repo');
      return;
    }
    const prev = this.settings;
    this.applyLocal(c => ({ ...c, repos: c.repos.filter(r => r !== path) }));
    this.setIndicator('saving', 'Saving...');
    const res = await this.api.removeRepo(path);
    if (res.ok && res.data) {
      this.applyLocal(c => ({ ...c, repos: [...res.data!.repos] }));
      this.setIndicator('saved', 'Saved');
      this.scheduleSavedFlash();
    } else {
      this.settings = prev;
      this.setIndicator('error', res.error ?? 'Failed to remove repo');
    }
  }

  async addRepo(): Promise<void> {
    const path = await this.pickRepoPath();
    if (!path) return;
    this.setIndicator('saving', 'Saving...');
    const res = await this.api.addRepo(path);
    if (res.ok && res.data) {
      this.applyLocal(c => ({ ...c, repos: [...res.data!.repos] }));
      this.setIndicator('saved', 'Saved');
      this.scheduleSavedFlash();
    } else {
      this.setIndicator('error', res.error ?? 'Failed to add repo');
    }
  }

  private async pickRepoPath(): Promise<string | null> {
    const isInTauri = !!(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
    if (isInTauri) {
      try {
        // Dynamic import keeps the browser bundle from failing to resolve the
        // plugin module in mock / dev-server mode.
        const dialog = await import('@tauri-apps/plugin-dialog');
        const selected = await dialog.open({ directory: true, multiple: false, title: 'Select repository folder' });
        return typeof selected === 'string' ? selected : null;
      } catch (e) {
        console.error('Folder picker failed', e);
        return window.prompt('Enter absolute path to git repository:') ?? null;
      }
    }
    return window.prompt('Enter absolute path to git repository:');
  }

  // ─── Token editing (explicit commit on Enter / ✓) ─────────────────────

  startEditJira():      void { this.jiraTokenDraft   = ''; }
  startEditTempo():     void { this.tempoTokenDraft  = ''; }
  startEditCalendar():  void { this.calendarUrlDraft = ''; }
  cancelEditJira():     void { this.jiraTokenDraft   = null; }
  cancelEditTempo():    void { this.tempoTokenDraft  = null; }
  cancelEditCalendar(): void { this.calendarUrlDraft = null; }

  async saveJiraToken(): Promise<void> {
    if (this.jiraTokenDraft === null || this.jiraTokenDraft.trim() === '') return;
    const token = this.jiraTokenDraft;
    this.jiraTokenDraft = null;
    this.setIndicator('saving', 'Saving...');
    const res = await this.api.updateSettings({ secrets: { jiraToken: token } });
    if (res.ok) {
      await this.refresh();
      this.setIndicator('saved', 'Saved');
      this.scheduleSavedFlash();
    } else {
      this.setIndicator('error', res.error ?? 'Failed to save token');
    }
  }

  async saveTempoToken(): Promise<void> {
    if (this.tempoTokenDraft === null || this.tempoTokenDraft.trim() === '') return;
    const token = this.tempoTokenDraft;
    this.tempoTokenDraft = null;
    this.setIndicator('saving', 'Saving...');
    const res = await this.api.updateSettings({ secrets: { tempoToken: token } });
    if (res.ok) {
      await this.refresh();
      this.setIndicator('saved', 'Saved');
      this.scheduleSavedFlash();
    } else {
      this.setIndicator('error', res.error ?? 'Failed to save token');
    }
  }

  // ─── Calendar feed (ICS URL secret + status + private filter) ──────────

  async saveCalendarUrl(): Promise<void> {
    if (this.calendarUrlDraft === null || this.calendarUrlDraft.trim() === '') return;
    const url = this.calendarUrlDraft.trim();
    this.calendarUrlDraft = null;
    this.setIndicator('saving', 'Saving...');
    const res = await this.api.updateSettings({ secrets: { calendarIcsUrl: url } });
    if (res.ok) {
      await this.refresh();
      this.setIndicator('saved', 'Saved');
      this.scheduleSavedFlash();
      // The daemon kicked off a feed fetch — pull the status again once it
      // had a chance to land, so the row shows the result without a reopen.
      if (this.calendarStatusTimer !== null) window.clearTimeout(this.calendarStatusTimer);
      this.calendarStatusTimer = window.setTimeout(() => void this.refreshCalendarStatus(), 4000);
    } else {
      this.setIndicator('error', res.error ?? 'Failed to save the feed URL');
    }
  }

  get calendarBlockVisible(): boolean {
    return this.settings?.config.calendar !== undefined;
  }

  get calendarConfigured(): boolean {
    return this.settings?.secretsMeta.calendarConfigured === true;
  }

  get hidePrivateOn(): boolean {
    return this.settings?.config.calendar?.hidePrivate === true;
  }

  toggleHidePrivate(): void {
    const cal = this.settings?.config.calendar;
    if (!cal) return;
    const next = { enabled: cal.enabled, hidePrivate: !cal.hidePrivate };
    this.applyLocal(c => ({ ...c, calendar: next }));
    this.queue({ calendar: next }, 'immediate');
  }

  /** One quiet line under the URL field: health of the configured feed. */
  get calendarStatusLabel(): string {
    if (!this.calendarConfigured) return 'Feed not configured — meeting suggestions stay off.';
    const s = this.calendarStatus;
    if (!s) return '';
    if (s.lastError) return `Feed error: ${s.lastError}`;
    if (!s.lastFetchAt) return 'Waiting for the first fetch…';
    return `Fetched ${this.agoLabel(s.lastFetchAt)} · ${s.instanceCount} meetings cached`;
  }

  get calendarStatusIsError(): boolean {
    return this.calendarConfigured && !!this.calendarStatus?.lastError;
  }

  private async refreshCalendarStatus(): Promise<void> {
    const res = await this.api.getStatus();
    if (res.ok && res.data) this.calendarStatus = res.data.calendar ?? null;
  }

  private agoLabel(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const min = Math.round(ms / 60_000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  // ─── Queue / flush ─────────────────────────────────────────────────────

  private queue(patchConfig: Partial<SettingsConfigSubset>, mode: 'immediate' | 'debounced', debounceMs = 600): void {
    this.pending.config = mergeConfigPatch(this.pending.config, patchConfig);
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    if (mode === 'immediate') {
      void this.flush();
    } else {
      this.debounceTimer = window.setTimeout(() => void this.flush(), debounceMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return;
    if (!this.pending.config && !this.pending.secrets) return;
    this.inFlight = true;
    const patch = this.pending;
    this.pending = {};
    this.setIndicator('saving', 'Saving...');
    const res = await this.api.updateSettings(patch);
    this.inFlight = false;
    if (res.ok) {
      await this.refresh();
      this.setIndicator('saved', 'Saved');
      this.scheduleSavedFlash();
    } else {
      await this.refresh();
      this.setIndicator('error', res.error ?? 'Save failed');
    }
    // New edits arrived while we were saving — flush again.
    if (this.pending.config || this.pending.secrets) void this.flush();
  }

  retrySave(): void {
    if (this.indicatorState !== 'error') return;
    void this.flush();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private async refresh(): Promise<void> {
    const res = await this.api.getSettings();
    if (res.ok && res.data) this.settings = res.data;
    void this.refreshCalendarStatus();
  }

  private applyLocal(updater: (cfg: SettingsConfigSubset) => SettingsConfigSubset): void {
    if (!this.settings) return;
    this.settings = { ...this.settings, config: updater(this.settings.config) };
  }

  private setIndicator(state: IndicatorState, label: string): void {
    this.indicatorState = state;
    this.indicatorLabel = label;
  }

  private scheduleSavedFlash(): void {
    if (this.savedFlashTimer !== null) window.clearTimeout(this.savedFlashTimer);
    this.savedFlashTimer = window.setTimeout(() => this.setIndicator('idle', ''), 2000);
  }

  get dayBoundaryLabel(): string {
    return this.settings ? `${String(this.settings.config.boundaryHour).padStart(2, '0')}:00` : '';
  }

  isSensitivityActive(level: SensitivityLevel): boolean {
    return this.settings?.config.sensitivity.default === level;
  }
}

function mergeConfigPatch(
  a: Partial<SettingsConfigSubset> | undefined,
  b: Partial<SettingsConfigSubset>,
): Partial<SettingsConfigSubset> {
  return {
    ...(a ?? {}),
    ...b,
    sensitivity: b.sensitivity ?? a?.sensitivity,
    tracking: b.tracking ?? a?.tracking,
    search: b.search ?? a?.search,
    activities: b.activities ?? a?.activities,
  };
}
