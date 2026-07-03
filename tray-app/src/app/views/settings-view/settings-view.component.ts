import { Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkdayApiService } from '../../services/workday-api.service';
import { SensitivityLevel, SettingsConfigSubset, SettingsPatch, SettingsResponse } from '../../models/workday.models';

type IndicatorState = 'idle' | 'saving' | 'saved' | 'error';
type UpdateState = 'idle' | 'checking' | 'available' | 'applying' | 'restarting' | 'done' | 'error';

interface PendingPatch {
  config?: Partial<SettingsConfigSubset>;
  secrets?: { jiraToken?: string; tempoToken?: string };
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

  settings: SettingsResponse | null = null;
  loading = true;

  indicatorState: IndicatorState = 'idle';
  indicatorLabel = '';

  jiraTokenDraft: string | null = null;
  tempoTokenDraft: string | null = null;

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

  private pending: PendingPatch = {};
  private debounceTimer: number | null = null;
  private inFlight = false;
  private savedFlashTimer: number | null = null;

  constructor(private api: WorkdayApiService) {}

  async ngOnInit(): Promise<void> {
    this.autoStartWithOs = await this.api.getAutostartEnabled();
    await this.refresh();
    this.loading = false;
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
  }

  // ─── Daemon updates ─────────────────────────────────────────────────────

  get daemonVersionLabel(): string {
    return this.settings?.daemonVersion ? `v${this.settings.daemonVersion}` : 'unknown';
  }

  get updateBusy(): boolean {
    return this.updateState === 'checking' || this.updateState === 'applying' || this.updateState === 'restarting';
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

  // ─── Optimistic field setters ──────────────────────────────────────────

  selectSensitivity(level: SensitivityLevel): void {
    this.applyLocal(c => ({ ...c, sensitivity: { ...c.sensitivity, default: level } }));
    this.queue({ sensitivity: { default: level } }, 'immediate');
  }

  onDayBoundaryChange(value: string): void {
    const hour = parseInt(value.split(':')[0] ?? '4', 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;
    this.applyLocal(c => ({ ...c, schedule: { ...c.schedule, end: hour } }));
    this.queue({ schedule: { start: this.settings!.config.schedule.start, end: hour } }, 'debounced', 300);
  }

  onTaskPatternChange(value: string): void {
    this.applyLocal(c => ({ ...c, taskPattern: value }));
    this.queue({ taskPattern: value }, 'debounced', 800);
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

  startEditJira():   void { this.jiraTokenDraft  = ''; }
  startEditTempo():  void { this.tempoTokenDraft = ''; }
  cancelEditJira():  void { this.jiraTokenDraft  = null; }
  cancelEditTempo(): void { this.tempoTokenDraft = null; }

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
    return this.settings ? `${String(this.settings.config.schedule.end).padStart(2, '0')}:00` : '';
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
    schedule:
      a?.schedule || b.schedule
        ? ({ ...(a?.schedule ?? {}), ...(b.schedule ?? {}) } as { start: number; end: number })
        : undefined,
    sensitivity: b.sensitivity ?? a?.sensitivity,
  };
}
