import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkdayApiService } from './services/workday-api.service';
import { TodayResponse, SessionDetail, ApiResponse } from './models/workday.models';

interface AdjustModalState {
  sessionId: string;
  repo: string;
  task: string | null;
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

  // UI state
  activeMenuSessionId: string | null = null;
  adjustModal: AdjustModalState | null = null;
  setStartModalOpen = false;
  actionError: string | null = null;
  actionPending = false;
  hoveredSessionId: string | null = null;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: WorkdayApiService) {}

  ngOnInit(): void {
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), 10_000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  async refresh(): Promise<void> {
    const res = await this.api.getToday();
    if (res.ok && res.data) {
      this.data = res.data;
      this.error = null;
    } else {
      this.error = res.error ?? 'Unknown error';
    }
    this.loading = false;
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
    return this.data.sessions.reduce((sum, s) => sum + s.totalPauseDurationMs, 0);
  }

  get formattedDate(): string {
    if (!this.data) return '';
    const [y, m, d] = this.data.date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
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

  get allAutopauseDisabled(): boolean {
    const open = this.openSessions;
    return open.length > 0 && open.every(s => s.autoPauseDisabled);
  }

  get anyPaused(): boolean {
    return this.openSessions.some(s => s.paused);
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

  intensityColor(normalizedScore: number): string {
    if (normalizedScore >= 0.6) return '#a6e3a1';
    if (normalizedScore >= 0.3) return '#f9e2af';
    return '#f38ba8';
  }

  intensityPercent(normalizedScore: number): number {
    return Math.round(Math.max(0, Math.min(1, normalizedScore)) * 100);
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
      setTimeout(() => this.refresh(), 2000);
      setTimeout(() => this.refresh(), 5000);
    } catch (e: unknown) {
      this.showToast(e instanceof Error ? e.message : 'Failed to start daemon');
    } finally {
      this.daemonStarting = false;
    }
  }

  async pauseSession(repo: string): Promise<void> {
    await this.runAction(() => this.api.pause(repo));
  }

  async pauseAll(): Promise<void> {
    await this.runAction(() => this.api.pause());
  }

  async resumeAll(): Promise<void> {
    await this.runAction(() => this.api.resume());
  }

  async toggleAutopauseForRepo(session: SessionDetail): Promise<void> {
    // current state is `autoPauseDisabled`; toggle means "enabled = current"
    const enabled = session.autoPauseDisabled; // true → re-enable
    await this.runAction(() => this.api.autopause(enabled, session.repo));
    this.activeMenuSessionId = null;
  }

  async toggleAutopauseGlobal(): Promise<void> {
    const enabled = this.allAutopauseDisabled; // all disabled → enable
    await this.runAction(() => this.api.autopause(enabled));
  }

  openAdjustModal(session: SessionDetail): void {
    this.adjustModal = { sessionId: session.id, repo: session.repo, task: session.task };
  }

  async submitAdjust(minutes: number, reason: string): Promise<void> {
    if (!this.adjustModal) return;
    const sessionId = this.adjustModal.sessionId;
    const ok = await this.runAction(() => this.api.adjust(sessionId, minutes, reason));
    if (ok) this.adjustModal = null;
  }

  async submitSetStart(time: string): Promise<void> {
    const ok = await this.runAction(() => this.api.setStart(time));
    if (ok) this.setStartModalOpen = false;
  }

  toggleMenu(sessionId: string): void {
    this.activeMenuSessionId = this.activeMenuSessionId === sessionId ? null : sessionId;
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
