import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkdayApiService } from './services/workday-api.service';
import { TodayResponse, SessionDetail, ApiResponse, SensitivityLevel, SensitivityPill } from './models/workday.models';

interface SensitivityPillOption {
  readonly key: SensitivityPill;
  readonly label: string;
  readonly title: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  // Stable palette, stepped by session order within the day.
  private static readonly SESSION_COLOR_PALETTE: readonly string[] = [
    '#89b4fa', '#f38ba8', '#a6e3a1', '#fab387', '#cba6f7',
    '#f9e2af', '#94e2d5', '#f5c2e7', '#74c7ec', '#eba0ac',
  ];

  data: TodayResponse | null = null;
  error: string | null = null;
  loading = true;
  daemonStarting = false;

  readonly sensitivityPills: readonly SensitivityPillOption[] = [
    { key: 'pause',                       label: 'Pause',     title: 'Pause this session' },
    { key: SensitivityLevel.Low,          label: 'Low',       title: 'Short timeout — pauses quickly (10–15 min)' },
    { key: SensitivityLevel.Normal,       label: 'Normal',    title: 'Default behaviour (15–45 min)' },
    { key: SensitivityLevel.Patient,      label: 'Patient',   title: 'Tolerant — long timeout (30–90 min)' },
    { key: SensitivityLevel.AlwaysOn,     label: 'Always-on', title: 'Never auto-paused by idle timeout' },
  ];

  // UI state
  setStartModalOpen = false;
  endDayModalOpen = false;
  adjustModalSession: SessionDetail | null = null;
  readonly adjustQuickPicks: readonly number[] = [15, 30, 45, 60, 90];
  actionError: string | null = null;
  actionPending = false;
  hoveredSessionId: string | null = null;

  // Day navigation: null = viewing today (live), otherwise a YYYY-MM-DD past date.
  viewedDate: string | null = null;
  // Latest known "today" date from the daemon — used to clamp the Next button.
  private todayDate: string | null = null;
  // Past days (with sessions), descending. Drives Prev/Next so navigation only
  // lands on days with real data instead of stepping through empty calendar days.
  private availableDates: string[] = [];
  // True once getDays() has returned at least once — keeps refresh() from
  // retrying the list call on every poll after a successful load.
  private navLoaded = false;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Used by lastActivity getters to advance the live marker between polls.
  currentTimeMs: number = Date.now();

  constructor(private api: WorkdayApiService) {}

  ngOnInit(): void {
    void this.refreshAvailableDates();
    this.refresh();
    // Polling and live ticks only make sense for today.
    this.pollTimer = setInterval(() => {
      if (this.isViewingToday) this.refresh();
    }, 10_000);
    this.tickTimer = setInterval(() => {
      if (this.isViewingToday) this.currentTimeMs = Date.now();
    }, 30_000);
  }

  private async refreshAvailableDates(): Promise<void> {
    const res = await this.api.getDays();
    if (res.ok && res.data) {
      this.availableDates = [...res.data.dates];
      this.navLoaded = true;
    }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
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
      // Keep navigation list in sync when a day first gains sessions.
      if (res.data.sessions.length > 0 && !this.availableDates.includes(res.data.date)) {
        this.availableDates = [res.data.date, ...this.availableDates].sort().reverse();
      }
      // Lazy-load the nav list on the first successful response — covers the
      // case where ngOnInit fired getDays() before the daemon was reachable.
      if (!this.navLoaded) {
        void this.refreshAvailableDates();
      }
    } else {
      this.error = res.error ?? 'Unknown error';
    }
    this.loading = false;
  }

  get isViewingToday(): boolean {
    return this.viewedDate === null;
  }

  goPrevDay(): void {
    const base = this.viewedDate ?? this.todayDate ?? this.data?.date ?? this.computeLocalToday();
    const target = this.findPrevDate(base);
    if (!target) return;
    this.navigateTo(target);
  }

  goNextDay(): void {
    if (this.isViewingToday) return;
    const base = this.viewedDate;
    if (!base) return;
    const target = this.findNextDate(base);
    // No later past day, or we'd land on/after today → back to live view.
    if (!target || (this.todayDate && target >= this.todayDate)) {
      this.navigateTo(null);
      return;
    }
    this.navigateTo(target);
  }

  goToday(): void {
    if (this.isViewingToday) return;
    this.navigateTo(null);
    void this.refreshAvailableDates();
  }

  private navigateTo(date: string | null): void {
    this.viewedDate = date;
    // Clear stale data so the header/badges/timeline don't reflect the previous day.
    this.data = null;
    this.error = null;
    this.loading = true;
    void this.refresh();
  }

  private findPrevDate(from: string): string | null {
    // availableDates is sorted descending — first match < from is the closest earlier day.
    for (const d of this.availableDates) {
      if (d < from) return d;
    }
    return null;
  }

  private findNextDate(from: string): string | null {
    // Walk from oldest upward to find the closest day > from.
    for (let i = this.availableDates.length - 1; i >= 0; i--) {
      const d = this.availableDates[i];
      if (d > from) return d;
    }
    return null;
  }

  get hasPrevDay(): boolean {
    const base = this.viewedDate ?? this.todayDate ?? this.data?.date ?? this.computeLocalToday();
    return this.findPrevDate(base) !== null;
  }

  get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy) ?? [];
  }

  get closedSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => s.closedBy) ?? [];
  }

  get scheduleWindowMs(): number {
    if (!this.data?.schedule) return 0;
    const { start, end } = this.data.schedule;
    const hours = end <= start ? (24 - start + end) : (end - start);
    return hours * 3_600_000;
  }

  timeToPercent(isoTimestamp: string): number {
    if (!this.data?.schedule) return 0;
    const windowMs = this.scheduleWindowMs;
    if (windowMs === 0) return 0;
    const ts = new Date(isoTimestamp).getTime();
    const offset = ts - this.getScheduleStartMs();
    return Math.max(0, Math.min(100, (offset / windowMs) * 100));
  }

  get totalActiveMs(): number {
    if (!this.data?.activeIntervals) return 0;
    return this.data.activeIntervals.reduce((sum, iv) =>
      sum + (new Date(iv.to).getTime() - new Date(iv.from).getTime()), 0);
  }

  get totalPauseMs(): number {
    if (!this.data) return 0;
    if (typeof this.data.downtimeMs === 'number') return this.data.downtimeMs;
    // Fallback for older daemons: union active intervals, subtract from span.
    return this.computeIdleFromIntervals();
  }

  private computeIdleFromIntervals(): number {
    const intervals = this.data?.activeIntervals;
    if (!intervals || intervals.length === 0) return 0;
    const sorted = intervals
      .map(iv => ({ from: new Date(iv.from).getTime(), to: new Date(iv.to).getTime() }))
      .sort((a, b) => a.from - b.from);
    const merged: Array<{ from: number; to: number }> = [{ ...sorted[0] }];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      const curr = sorted[i];
      if (curr.from <= last.to) last.to = Math.max(last.to, curr.to);
      else merged.push({ ...curr });
    }
    const span = merged[merged.length - 1].to - merged[0].from;
    const work = merged.reduce((sum, iv) => sum + (iv.to - iv.from), 0);
    return span - work;
  }

  /** Full weekday label (Saturday/Sunday/Monday...) — shown in the top-right header badge. */
  get dayWeekdayLabel(): string {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en', { weekday: 'long' });
  }

  /** Compact duration without seconds — used for timeline stats. */
  formatDurationHm(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
  }

  get formattedDate(): string {
    // Prefer viewedDate (navigation target). Fall back to data, then to local
    // "today" so the header + nav stay visible on the Start screen too —
    // letting the user browse past days without starting a new day.
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  private computeLocalToday(): string {
    const d = new Date();
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  get dayStartIso(): string | null {
    if (!this.data) return null;
    if (this.data.dayStartedAt) return this.data.dayStartedAt;
    const firstActivated = this.data.sessions.find(s => !!s.activatedAt)?.activatedAt;
    if (firstActivated) return firstActivated;
    return this.data.sessions[0]?.startedAt ?? null;
  }

  get dayStartLabel(): string {
    const iso = this.dayStartIso;
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  get dayStartPercent(): number | null {
    const iso = this.dayStartIso;
    return iso ? this.timeToPercent(iso) : null;
  }

  // Keep the label inside the bar's horizontal bounds.
  get dayStartLabelTransform(): string {
    const p = this.dayStartPercent;
    if (p === null) return 'translateX(-50%)';
    if (p < 10) return 'translateX(0)';
    if (p > 90) return 'translateX(-100%)';
    return 'translateX(-50%)';
  }

  // Latest activity timestamp: live `now` if any session is actively running,
  // otherwise the most recent interval `to` (frozen at pause start or session close).
  get lastActivityIso(): string | null {
    if (!this.data?.activeIntervals.length) return null;

    const hasLiveSession = this.openSessions.some(s => !s.paused && s.activatedAt !== null);
    if (hasLiveSession) return new Date(this.currentTimeMs).toISOString();

    let maxTo = 0;
    for (const iv of this.data.activeIntervals) {
      const t = new Date(iv.to).getTime();
      if (t > maxTo) maxTo = t;
    }
    return maxTo > 0 ? new Date(maxTo).toISOString() : null;
  }

  get lastActivityLabel(): string {
    const iso = this.lastActivityIso;
    if (!iso) return '';
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  get lastActivityPercent(): number | null {
    const iso = this.lastActivityIso;
    return iso ? this.timeToPercent(iso) : null;
  }

  get lastActivityLabelTransform(): string {
    const p = this.lastActivityPercent;
    if (p === null) return 'translateX(-50%)';
    if (p < 10) return 'translateX(0)';
    if (p > 90) return 'translateX(-100%)';
    return 'translateX(-50%)';
  }

  // Live "now" cursor on the timeline. Only meaningful on the today view.
  get currentTimePercent(): number | null {
    if (!this.isViewingToday || !this.data?.schedule) return null;
    const windowMs = this.scheduleWindowMs;
    if (windowMs === 0) return null;
    const offset = this.currentTimeMs - this.getScheduleStartMs();
    if (offset < 0 || offset > windowMs) return null;
    return (offset / windowMs) * 100;
  }

  sessionColor(sessionId: string): string {
    const idx = this.data?.sessions.findIndex(s => s.id === sessionId) ?? -1;
    if (idx < 0) return '#6c7086';
    const palette = AppComponent.SESSION_COLOR_PALETTE;
    return palette[idx % palette.length];
  }

  isSessionClosed(sessionId: string): boolean {
    return this.data?.sessions.find(s => s.id === sessionId)?.closedBy != null;
  }

  private getScheduleStartMs(): number {
    if (!this.data) return 0;
    const [y, m, d] = this.data.date.split('-').map(Number);
    return new Date(y, m - 1, d, this.data.schedule.start, 0, 0).getTime();
  }

  get hasSessions(): boolean {
    return (this.data?.sessions.length ?? 0) > 0;
  }

  get hasManualStart(): boolean {
    return !!this.data?.manualStart;
  }

  formatDuration(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${seconds}s`;
  }

  repoName(repoPath: string): string {
    return repoPath.split('/').pop() ?? repoPath;
  }

  staminaColor(normalizedScore: number): string {
    if (normalizedScore >= 0.6) return '#a6e3a1';
    if (normalizedScore >= 0.3) return '#f9e2af';
    return '#f38ba8';
  }

  staminaPercent(normalizedScore: number): number {
    return Math.round(Math.max(0, Math.min(1, normalizedScore)) * 100);
  }

  /** Pill key currently active for the session — Pause if paused, else its sensitivity. */
  activePill(s: SessionDetail): SensitivityPill {
    return s.paused ? 'pause' : s.sensitivity;
  }

  isAlwaysOn(s: SessionDetail): boolean {
    return !s.paused && s.sensitivity === SensitivityLevel.AlwaysOn;
  }

  statusClass(session: SessionDetail): string {
    if (session.paused) return 'paused';
    if (session.state === 'active') return 'active';
    return 'pending';
  }

  statusLabel(session: SessionDetail): string {
    if (session.paused) return `PAUSED:${session.pauseSource}`;
    return session.state.toUpperCase();
  }

  // ─── Actions ──────────────────────────────────────────────────────────

  async startDaemon(): Promise<void> {
    this.daemonStarting = true;
    try {
      await this.api.startDaemon();
      // Reload availableDates once the daemon is up — otherwise Prev/Next
      // stay disabled because the initial getDays() call (before daemon was
      // running) returned an empty list.
      setTimeout(() => { void this.refresh(); void this.refreshAvailableDates(); }, 2000);
      setTimeout(() => { void this.refresh(); void this.refreshAvailableDates(); }, 5000);
    } catch (e: unknown) {
      this.showToast(e instanceof Error ? e.message : 'Failed to start daemon');
    } finally {
      this.daemonStarting = false;
    }
  }

  /**
   * Pill click on the session scale.
   * - 'pause' → manual pause for this repo (existing /api/pause behaviour).
   * - sensitivity level → set per-repo sensitivity; the daemon side effect closes any open manual pause.
   * Clicking the already-active pill is a no-op.
   */
  async selectPill(session: SessionDetail, pill: SensitivityPill): Promise<void> {
    if (pill === this.activePill(session)) return;
    if (pill === 'pause') {
      await this.runAction(() => this.api.pause(session.repo));
    } else {
      await this.runAction(() => this.api.sensitivity(pill, session.repo));
    }
  }

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
    const ok = await this.runAction(() =>
      this.api.adjust(session.id, minutes, reasonText));
    if (ok) this.closeAdjustModal();
  }

  async submitSetStart(time: string): Promise<void> {
    const ok = await this.runAction(() => this.api.setStart(time));
    if (ok) this.setStartModalOpen = false;
  }

  async clearDayStart(): Promise<void> {
    const ok = await this.runAction(() => this.api.clearStart());
    if (ok) this.setStartModalOpen = false;
  }

  // End workday: close all sessions + stop the daemon. After this the tray
  // falls back to the Start screen since /api/today will refuse to connect.
  async confirmEndDay(): Promise<void> {
    const ok = await this.runAction(() => this.api.stop());
    if (ok) this.endDayModalOpen = false;
  }

  intervalTooltip(iv: { from: string; to: string; sessionId: string }): string {
    const from = this.formatHm(iv.from);
    const isOpen = !this.isSessionClosed(iv.sessionId);
    const toRaw = isOpen ? Date.now() : new Date(iv.to).getTime();
    const to = isOpen ? 'сейчас' : this.formatHm(iv.to);
    const mins = Math.max(1, Math.round((toRaw - new Date(iv.from).getTime()) / 60_000));
    return `${from} → ${to} · ${mins}m`;
  }

  private formatHm(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  dismissToast(): void {
    this.actionError = null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

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

  private showToast(msg: string): void {
    this.actionError = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.actionError = null, 4000);
  }
}
