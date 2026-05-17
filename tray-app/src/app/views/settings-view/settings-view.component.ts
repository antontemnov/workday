import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkdayApiService } from '../../services/workday-api.service';
import { SensitivityLevel, SettingsConfigSubset, SettingsPatch, SettingsResponse } from '../../models/workday.models';

@Component({
  selector: 'app-settings-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './settings-view.component.html',
  styleUrl: './settings-view.component.scss',
})
export class SettingsViewComponent implements OnInit {
  settings: SettingsResponse | null = null;
  loading = true;
  saving = false;

  // Mutable draft of the config — bound to inputs, applied on Save.
  draftConfig: SettingsConfigSubset | null = null;

  // Token edit state: when null, field shows masked decorative dots. When a
  // string (even empty), field is in edit mode and accepts a new value.
  jiraTokenDraft: string | null = null;
  tempoTokenDraft: string | null = null;

  // Sensitivity options for the Default row (drop 'pause' — it's a runtime state).
  readonly sensitivityOptions: readonly { key: SensitivityLevel; label: string }[] = [
    { key: SensitivityLevel.Low,      label: 'Low' },
    { key: SensitivityLevel.Normal,   label: 'Normal' },
    { key: SensitivityLevel.Patient,  label: 'Patient' },
    { key: SensitivityLevel.AlwaysOn, label: 'Always-on' },
  ];

  // UI-only toggles backed by no real config field yet — wired to ux for now.
  autoStartWithOs = true;
  notifyOnIdle = false;

  constructor(private api: WorkdayApiService) {}

  async ngOnInit(): Promise<void> {
    const res = await this.api.getSettings();
    if (res.ok && res.data) {
      this.settings = res.data;
      // Clone for mutation — readonly fields stay protected by the model type
      // but the draft itself is mutable.
      this.draftConfig = {
        repos: [...res.data.config.repos],
        schedule: { ...res.data.config.schedule },
        timezone: res.data.config.timezone,
        taskPattern: res.data.config.taskPattern,
        sensitivity: { ...res.data.config.sensitivity },
      };
    }
    this.loading = false;
  }

  // ─── Token editing ────────────────────────────────────────────────────

  startEditJira(): void  { this.jiraTokenDraft = ''; }
  cancelEditJira(): void { this.jiraTokenDraft = null; }

  startEditTempo(): void  { this.tempoTokenDraft = ''; }
  cancelEditTempo(): void { this.tempoTokenDraft = null; }

  // ─── Repo list ────────────────────────────────────────────────────────

  repoName(path: string): string {
    return path.split('/').pop() ?? path;
  }

  repoDot(idx: number): string {
    // Reuse the same palette stepping as Day view so a repo's colour is
    // recognisable across views.
    const palette = ['#89b4fa', '#f38ba8', '#a6e3a1', '#fab387', '#cba6f7', '#f9e2af', '#94e2d5', '#f5c2e7'];
    return palette[idx % palette.length];
  }

  removeRepo(repo: string): void {
    if (!this.draftConfig) return;
    this.draftConfig = { ...this.draftConfig, repos: this.draftConfig.repos.filter(r => r !== repo) };
  }

  // ─── Day boundary input (read 0-23 hour, render as HH:00) ─────────────

  get dayBoundaryLabel(): string {
    if (!this.draftConfig) return '';
    return `${String(this.draftConfig.schedule.end).padStart(2, '0')}:00`;
  }

  onDayBoundaryChange(value: string): void {
    if (!this.draftConfig) return;
    const hour = parseInt(value.split(':')[0] ?? '4', 10);
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return;
    this.draftConfig = {
      ...this.draftConfig,
      schedule: { ...this.draftConfig.schedule, end: hour },
    };
  }

  onTaskPatternChange(value: string): void {
    if (!this.draftConfig) return;
    this.draftConfig = { ...this.draftConfig, taskPattern: value };
  }

  selectSensitivity(level: SensitivityLevel): void {
    if (!this.draftConfig) return;
    this.draftConfig = {
      ...this.draftConfig,
      sensitivity: { default: level },
    };
  }

  isSensitivityActive(level: SensitivityLevel): boolean {
    return this.draftConfig?.sensitivity.default === level;
  }

  // ─── Save ─────────────────────────────────────────────────────────────

  get hasChanges(): boolean {
    if (!this.settings || !this.draftConfig) return false;
    const c = this.settings.config;
    const d = this.draftConfig;
    const configChanged =
      JSON.stringify([...c.repos]) !== JSON.stringify([...d.repos]) ||
      c.schedule.start !== d.schedule.start || c.schedule.end !== d.schedule.end ||
      c.timezone !== d.timezone ||
      c.taskPattern !== d.taskPattern ||
      c.sensitivity.default !== d.sensitivity.default;
    const secretsChanged = this.jiraTokenDraft !== null || this.tempoTokenDraft !== null;
    return configChanged || secretsChanged;
  }

  async save(): Promise<void> {
    if (!this.draftConfig || !this.hasChanges) return;
    this.saving = true;

    const patch: SettingsPatch = {
      config: this.draftConfig,
      secrets: {
        ...(this.jiraTokenDraft  !== null ? { jiraToken:  this.jiraTokenDraft  } : {}),
        ...(this.tempoTokenDraft !== null ? { tempoToken: this.tempoTokenDraft } : {}),
      },
    };

    const res = await this.api.updateSettings(patch);
    this.saving = false;
    if (res.ok) {
      // Optimistic — re-fetch to confirm settings/secrets meta.
      const re = await this.api.getSettings();
      if (re.ok && re.data) {
        this.settings = re.data;
        this.jiraTokenDraft = null;
        this.tempoTokenDraft = null;
      }
    }
  }

  // Danger zone — wired to existing mock action.
  async resetToday(): Promise<void> {
    // TODO: real reset-today endpoint
    console.log('TODO: reset today');
  }
}
