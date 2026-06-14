import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { WorkdayApiService } from './services/workday-api.service';
import {
  TodayResponse,
  SessionDetail,
  ApiResponse,
  SensitivityLevel,
  SensitivityPill,
  ActivityType,
  ManualEntryInput,
  ManualEntryPatch,
} from './models/workday.models';
import { DayViewComponent } from './views/day-view/day-view.component';
import { TimesheetsViewComponent } from './views/timesheets-view/timesheets-view.component';
import { SettingsViewComponent } from './views/settings-view/settings-view.component';

type TrayKind = 'live' | 'pending' | 'idle' | 'paused' | 'none';
type ActiveView = 'day' | 'sheet' | 'set';

interface SensitivityPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DayViewComponent, TimesheetsViewComponent, SettingsViewComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  // ─── View routing (signal-style state via plain field for now) ─────────
  activeView: ActiveView = 'day';

  // ─── Data / lifecycle state ────────────────────────────────────────────
  data: TodayResponse | null = null;
  error: string | null = null;
  loading = true;
  daemonStarting = false;

  // Sensitivity = idle-patience scale. Pause/Resume is a separate per-card
  // button now, so it's no longer a pill here. Labels are display-only; the
  // backing enum values (low/normal/patient/always_on) are unchanged.
  readonly sensitivityPills: readonly SensitivityPillOption[] = [
    { key: SensitivityLevel.Low,      label: 'Sharp',   description: 'full stamina → 15 min idle', title: 'Short leash — at full stamina tolerates up to 15 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.Normal,   label: 'Normal',  description: '→ 45 min',                  title: 'Default — at full stamina tolerates up to 45 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.Patient,  label: 'Relaxed', description: '→ 90 min',                  title: 'Tolerant — at full stamina tolerates up to 90 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.AlwaysOn, label: 'Nonstop', description: 'never auto-pauses',          title: 'Never auto-paused by idle timeout — tracks until you pause it manually' },
  ];

  // Modal state (cross-cutting, triggered by DayView events)
  endDayModalOpen = false;
  adjustModalSession: SessionDetail | null = null;
  readonly adjustQuickPicks: readonly number[] = [15, 30, 45, 60, 90];

  // Tempo _Activity_ options for the manual-entry composer; prefetched once.
  activityTypes: readonly ActivityType[] = [];

  // Toast + action gate
  actionError: string | null = null;
  actionPending = false;

  // Day navigation: null = viewing today, otherwise a YYYY-MM-DD past date.
  viewedDate: string | null = null;
  private todayDate: string | null = null;
  private availableDates: string[] = [];
  private navLoaded = false;

  // Live ticker — advances the "now" cursor between polls.
  currentTimeMs: number = Date.now();

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: WorkdayApiService) {}

  ngOnInit(): void {
    void this.refreshAvailableDates();
    void this.refreshActivityTypes();
    this.refresh();
    this.pollTimer = setInterval(() => {
      if (this.isViewingToday) this.refresh();
    }, 10_000);
    this.tickTimer = setInterval(() => {
      if (this.isViewingToday) this.currentTimeMs = Date.now();
    }, 30_000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  private async refreshAvailableDates(): Promise<void> {
    const res = await this.api.getDays();
    if (res.ok && res.data) {
      this.availableDates = [...res.data.dates];
      this.navLoaded = true;
    }
  }

  // Activity options rarely change — fetch once on load (cached daemon-side).
  private async refreshActivityTypes(): Promise<void> {
    const res = await this.api.getActivityTypes();
    if (res.ok && res.data) {
      this.activityTypes = res.data.activities;
    }
  }

  async refresh(): Promise<void> {
    const date = this.viewedDate;
    const res = date
      ? await this.api.getDay(date)
      : await this.api.getToday();
    if (res.ok && res.data) {
      this.data = res.data;
      this.error = null;
      if (!date) this.todayDate = res.data.date;
      if (res.data.sessions.length > 0 && !this.availableDates.includes(res.data.date)) {
        this.availableDates = [res.data.date, ...this.availableDates].sort().reverse();
      }
      if (!this.navLoaded) {
        void this.refreshAvailableDates();
      }
    } else {
      this.error = res.error ?? 'Unknown error';
    }
    this.loading = false;
    if (this.isViewingToday) this.syncTrayStatus();
  }

  // ─── View switching ─────────────────────────────────────────────────────

  setView(v: ActiveView): void {
    this.activeView = v;
  }

  // Timesheets click on a day row → switch to Day view for that date.
  onDaySelected(date: string): void {
    this.viewedDate = date;
    this.activeView = 'day';
    this.data = null;
    this.error = null;
    this.loading = true;
    void this.refresh();
  }

  // DayView mode pill click → existing pause / sensitivity action.
  async onPillSelected(e: { session: SessionDetail; pill: SensitivityPill }): Promise<void> {
    if (e.pill === 'pause') {
      await this.runAction(() => this.api.pause(e.session.repo));
    } else {
      await this.runAction(() => this.api.sensitivity(e.pill as SensitivityLevel, e.session.repo));
    }
  }

  // ─── Header: weekday grid + date display ───────────────────────────────

  /** Full weekday label — shown as the tooltip on the day-grid cell. */
  get dayWeekdayLabel(): string {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en', { weekday: 'long' });
  }

  /** Week-day grid (Mon..Sun). Highlights the active cell for the currently viewed date. */
  readonly weekdayCells: ReadonlyArray<{ letter: string; full: string; idx: number; weekend: boolean }> = [
    { letter: 'M', full: 'Monday',    idx: 1, weekend: false },
    { letter: 'T', full: 'Tuesday',   idx: 2, weekend: false },
    { letter: 'W', full: 'Wednesday', idx: 3, weekend: false },
    { letter: 'T', full: 'Thursday',  idx: 4, weekend: false },
    { letter: 'F', full: 'Friday',    idx: 5, weekend: false },
    { letter: 'S', full: 'Saturday',  idx: 6, weekend: true  },
    { letter: 'S', full: 'Sunday',    idx: 0, weekend: true  },
  ];

  get activeWeekdayCell(): number {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    return this.weekdayCells.findIndex(c => c.idx === dow);
  }

  get formattedDate(): string {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  get isViewingToday(): boolean {
    return this.viewedDate === null;
  }

  goToday(): void {
    if (this.isViewingToday) return;
    this.navigateTo(null);
    void this.refreshAvailableDates();
  }

  private navigateTo(date: string | null): void {
    this.viewedDate = date;
    this.data = null;
    this.error = null;
    this.loading = true;
    void this.refresh();
  }

  private computeLocalToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ─── Tray icon sync ────────────────────────────────────────────────────

  private syncTrayStatus(): void {
    const open = this.openSessions;
    let kind: TrayKind = 'none';
    let label = 'Workday';

    if (open.length > 0) {
      const live    = open.find(s => !s.paused && s.state === 'active');
      const pending = open.find(s => !s.paused && s.state !== 'active');
      const idle    = open.find(s => s.paused && s.pauseSource === 'idle_timeout');
      const paused  = open.find(s => s.paused);

      if (live) {
        kind = 'live';
        label = `Workday — ${this.repoName(live.repo)}${live.task ? ' · ' + live.task : ''}`;
      } else if (pending) {
        kind = 'pending';
        label = `Workday — ${this.repoName(pending.repo)} (pending)`;
      } else if (idle) {
        kind = 'idle';
        label = `Workday — idle (${this.repoName(idle.repo)})`;
      } else if (paused) {
        kind = 'paused';
        label = `Workday — paused (${this.repoName(paused.repo)})`;
      }
    }

    void invoke('set_tray_status', { kind, tooltip: label }).catch(() => {});
  }

  private get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy) ?? [];
  }

  private repoName(repoPath: string): string {
    return repoPath.split('/').pop() ?? repoPath;
  }

  // ─── Modal flow ────────────────────────────────────────────────────────

  openAdjustModal(session: SessionDetail): void {
    this.adjustModalSession = session;
  }

  closeAdjustModal(): void {
    this.adjustModalSession = null;
  }

  async submitAdjust(minutesStr: string, reason: string): Promise<void> {
    const session = this.adjustModalSession;
    if (!session) return;
    const minutes = parseInt(minutesStr, 10);
    if (!Number.isFinite(minutes) || minutes <= 0) return;
    const reasonText = reason?.trim() || 'manual via tray';
    const ok = await this.runAction(() => this.api.adjust(session.id, minutes, reasonText));
    if (ok) this.closeAdjustModal();
  }

  async submitSetStart(time: string): Promise<void> {
    await this.runAction(() => this.api.setStart(time));
  }

  // ─── Manual entries ────────────────────────────────────────────────────

  async submitLog(input: ManualEntryInput): Promise<void> {
    await this.runAction(() => this.api.addManualEntry(input));
  }

  async submitEntryEdit(e: { target: string; patch: ManualEntryPatch }): Promise<void> {
    await this.runAction(() => this.api.updateManualEntry(e.target, e.patch));
  }

  async clearDayStart(): Promise<void> {
    await this.runAction(() => this.api.clearStart());
  }

  async confirmEndDay(): Promise<void> {
    const ok = await this.runAction(() => this.api.stop());
    if (ok) this.endDayModalOpen = false;
  }

  // ─── Daemon lifecycle ──────────────────────────────────────────────────

  async startDaemon(): Promise<void> {
    this.daemonStarting = true;
    try {
      await this.api.startDaemon();
      setTimeout(() => { void this.refresh(); void this.refreshAvailableDates(); }, 2000);
      setTimeout(() => { void this.refresh(); void this.refreshAvailableDates(); }, 5000);
    } catch (e: unknown) {
      this.showToast(e instanceof Error ? e.message : 'Failed to start daemon');
    } finally {
      this.daemonStarting = false;
    }
  }

  // ─── Action gate ───────────────────────────────────────────────────────

  private async runAction<T>(fn: () => Promise<ApiResponse<T>>): Promise<boolean> {
    if (this.actionPending) return false;
    this.actionPending = true;
    this.actionError = null;
    try {
      const res = await fn();
      if (!res.ok) {
        this.showToast(res.error ?? 'Action failed');
        return false;
      }
      await this.refresh();
      return true;
    } finally {
      this.actionPending = false;
    }
  }

  dismissToast(): void {
    this.actionError = null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  private showToast(msg: string): void {
    this.actionError = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.actionError = null, 4000);
  }
}
