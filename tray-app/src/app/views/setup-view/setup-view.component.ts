import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkdayApiService } from '../../services/workday-api.service';
import {
  ProjectRef,
  SetupLinks,
  SetupProbeResult,
} from '../../models/workday.models';

type SetupStep = 1 | 2 | 3 | 4;

// First-run wizard: connection → tokens → tracking → calendar. Every value
// persists through the daemon (tokens never linger tray-side), and the flow
// is re-enterable — prefilled from whatever is already configured.
@Component({
  selector: 'app-setup-view',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './setup-view.component.html',
  styleUrl: './setup-view.component.scss',
})
export class SetupViewComponent implements OnInit {
  @Output() done = new EventEmitter<void>();

  step: SetupStep = 1;
  loading = true;
  stepError: string | null = null;

  readonly stepLabels: readonly string[] = ['Connection', 'Tokens', 'Tracking', 'Calendar'];

  // Step 1 — identity
  jiraBaseUrl = '';
  jiraEmail = '';
  savingIdentity = false;

  // Step 2 — tokens
  links: SetupLinks | null = null;
  jiraToken = '';
  tempoToken = '';
  jiraProbe: SetupProbeResult | null = null;
  tempoProbe: SetupProbeResult | null = null;
  jiraChecking = false;
  tempoChecking = false;
  jiraSaved = false;
  tempoSaved = false;

  // Step 3 — tracking
  repos: readonly string[] = [];
  knownProjects: readonly ProjectRef[] = [];
  selectedKeys: string[] = [];
  branchOwners = '';
  projectsLoading = false;
  savingTracking = false;

  // Step 4 — calendar
  calendarUrl = '';
  calendarSaved = false;
  savingCalendar = false;
  meetingsFound: number | null = null;

  public constructor(private api: WorkdayApiService) {}

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const [setupRes, settingsRes] = await Promise.all([this.api.getSetup(), this.api.getSettings()]);
    if (setupRes.ok && setupRes.data) {
      const d = setupRes.data;
      this.jiraBaseUrl = d.jiraBaseUrl;
      this.jiraEmail = d.jiraEmail;
      this.links = d.links;
      this.jiraSaved = d.configured.jira;
      this.tempoSaved = d.configured.tempo;
      this.calendarSaved = d.configured.calendar;
    } else {
      // Older daemon without /api/setup — the wizard can't drive it.
      this.stepError = 'The daemon is older than the app — update it from Settings first';
    }
    if (settingsRes.ok && settingsRes.data) {
      const c = settingsRes.data.config;
      this.repos = c.repos;
      this.branchOwners = c.tracking.branchOwners.join(', ');
      this.knownProjects = c.search?.knownProjects ?? [];
      this.selectedKeys = c.tracking.projectKeys.filter(k => k !== 'PROJ');
    }
    this.loading = false;
  }

  // ─── Navigation ────────────────────────────────────────────────────────

  get primaryLabel(): string {
    if (this.step === 4) return 'Finish';
    if ((this.step === 1 && this.savingIdentity) || (this.step === 3 && this.savingTracking)) return 'Saving…';
    return 'Continue';
  }

  get primaryDisabled(): boolean {
    if (this.step === 1) return this.savingIdentity;
    if (this.step === 2) return !this.jiraSaved;
    if (this.step === 3) return this.savingTracking;
    return false;
  }

  async primaryAction(): Promise<void> {
    if (this.step === 1) return this.submitIdentity();
    if (this.step === 2) return this.toTracking();
    if (this.step === 3) return this.submitTracking();
    this.done.emit();
  }

  back(): void {
    if (this.step > 1) {
      this.step = (this.step - 1) as SetupStep;
      this.stepError = null;
    }
  }

  skip(): void {
    this.done.emit();
  }

  async openLink(url: string | null | undefined): Promise<void> {
    if (!url) return;
    // Failure is silent by design — the URL is printed next to the button.
    await this.api.openUrl(url);
  }

  // ─── Step 1: identity ──────────────────────────────────────────────────

  private normalizeBaseUrl(raw: string): string {
    let v = raw.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = `https://${v}`;
    return v;
  }

  async submitIdentity(): Promise<void> {
    const base = this.normalizeBaseUrl(this.jiraBaseUrl);
    const email = this.jiraEmail.trim();
    if (!base || !email) {
      this.stepError = 'Both the site URL and the email are required';
      return;
    }
    this.savingIdentity = true;
    this.stepError = null;
    const res = await this.api.updateSettings({ secrets: { jiraBaseUrl: base, jiraEmail: email } });
    this.savingIdentity = false;
    if (!res.ok) {
      this.stepError = res.error ?? 'Failed to save';
      return;
    }
    this.jiraBaseUrl = base;
    // Re-pull links: the Tempo page resolves against the just-saved base URL.
    const setup = await this.api.getSetup();
    if (setup.ok && setup.data) this.links = setup.data.links;
    this.step = 2;
  }

  // ─── Step 2: tokens ────────────────────────────────────────────────────

  async checkJira(): Promise<void> {
    const token = this.jiraToken.trim();
    if (!token || this.jiraChecking) return;
    this.jiraChecking = true;
    this.jiraProbe = null;
    const res = await this.api.validateSetup({
      jira: { baseUrl: this.normalizeBaseUrl(this.jiraBaseUrl), email: this.jiraEmail.trim(), token },
    });
    const probe: SetupProbeResult | null = res.ok
      ? res.data?.jira ?? null
      : { ok: false, error: res.error ?? 'Validation failed' };
    if (probe?.ok) {
      const save = await this.api.updateSettings({ secrets: { jiraToken: token } });
      if (save.ok) {
        this.jiraSaved = true;
        this.jiraToken = '';
        this.jiraProbe = probe;
      } else {
        this.jiraProbe = { ok: false, error: save.error ?? 'Failed to save the token' };
      }
    } else {
      this.jiraProbe = probe;
    }
    this.jiraChecking = false;
  }

  async checkTempo(): Promise<void> {
    const token = this.tempoToken.trim();
    if (!token || this.tempoChecking) return;
    this.tempoChecking = true;
    this.tempoProbe = null;
    const res = await this.api.validateSetup({ tempo: { token } });
    const probe: SetupProbeResult | null = res.ok
      ? res.data?.tempo ?? null
      : { ok: false, error: res.error ?? 'Validation failed' };
    if (probe?.ok) {
      const save = await this.api.updateSettings({ secrets: { tempoToken: token } });
      if (save.ok) {
        this.tempoSaved = true;
        this.tempoToken = '';
        this.tempoProbe = probe;
      } else {
        this.tempoProbe = { ok: false, error: save.error ?? 'Failed to save the token' };
      }
    } else {
      this.tempoProbe = probe;
    }
    this.tempoChecking = false;
  }

  // ─── Step 3: tracking ──────────────────────────────────────────────────

  private async toTracking(): Promise<void> {
    this.step = 3;
    this.stepError = null;
    if (this.knownProjects.length === 0) void this.loadProjects();
  }

  private async loadProjects(): Promise<void> {
    this.projectsLoading = true;
    const res = await this.api.refreshJiraProjects();
    this.projectsLoading = false;
    if (res.ok && res.data) this.knownProjects = res.data.projects;
  }

  async addRepo(): Promise<void> {
    const path = window.prompt('Absolute path to a git repository:');
    if (!path?.trim()) return;
    const res = await this.api.addRepo(path.trim());
    if (res.ok && res.data) {
      this.repos = res.data.repos;
      this.stepError = null;
    } else {
      this.stepError = res.error ?? 'Failed to add repository';
    }
  }

  async removeRepo(path: string): Promise<void> {
    const res = await this.api.removeRepo(path);
    if (res.ok && res.data) this.repos = res.data.repos;
  }

  toggleKey(key: string): void {
    this.selectedKeys = this.selectedKeys.includes(key)
      ? this.selectedKeys.filter(k => k !== key)
      : [...this.selectedKeys, key];
  }

  isKeySelected(key: string): boolean {
    return this.selectedKeys.includes(key);
  }

  private async submitTracking(): Promise<void> {
    if (this.selectedKeys.length === 0) {
      this.stepError = 'Pick at least one project to track';
      return;
    }
    this.savingTracking = true;
    this.stepError = null;
    const owners = this.branchOwners.split(/[,\s]+/).map(o => o.trim()).filter(Boolean);
    const tracking = { projectKeys: [...this.selectedKeys], branchOwners: owners };
    // Search scope mirrors the tracking pick — full SearchConfig so the
    // daemon's deep-merge keeps the cached catalog.
    const search = { projectKeys: [...this.selectedKeys], knownProjects: this.knownProjects.map(p => ({ ...p })) };
    const res = await this.api.updateSettings({ config: { tracking, search } });
    this.savingTracking = false;
    if (!res.ok) {
      this.stepError = res.error ?? 'Failed to save';
      return;
    }
    this.step = 4;
  }

  // ─── Step 4: calendar (optional) ───────────────────────────────────────

  async saveCalendar(): Promise<void> {
    const url = this.calendarUrl.trim();
    if (!url || this.savingCalendar) return;
    this.savingCalendar = true;
    this.stepError = null;
    const res = await this.api.updateSettings({ secrets: { calendarIcsUrl: url } });
    if (!res.ok) {
      this.stepError = res.error ?? 'Failed to save';
      this.savingCalendar = false;
      return;
    }
    const refresh = await this.api.refreshCalendar();
    this.savingCalendar = false;
    if (refresh.ok && refresh.data) {
      this.calendarSaved = true;
      this.meetingsFound = refresh.data.instanceCount;
      this.calendarUrl = '';
    } else {
      this.stepError = refresh.error ?? 'Feed saved, but the fetch failed — check the URL';
    }
  }

  repoName(path: string): string {
    return path.split(/[\\/]/).pop() ?? path;
  }
}
