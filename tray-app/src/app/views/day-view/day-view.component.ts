import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionDetail, SensitivityLevel, SensitivityPill, TodayResponse } from '../../models/workday.models';

interface SensitivityPillOption {
  readonly key: SensitivityPill;
  readonly label: string;
  readonly title: string;
}

// Stable palette, stepped by repo order within the day.
const SESSION_COLOR_PALETTE: readonly string[] = [
  '#89b4fa', '#f38ba8', '#a6e3a1', '#fab387', '#cba6f7',
  '#f9e2af', '#94e2d5', '#f5c2e7', '#74c7ec', '#eba0ac',
];

@Component({
  selector: 'app-day-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './day-view.component.html',
  styleUrl: './day-view.component.scss',
})
export class DayViewComponent {
  @Input() data: TodayResponse | null = null;
  @Input() loading = false;
  @Input() error: string | null = null;
  @Input() isViewingToday = true;
  @Input() dateLabel = '';
  @Input() actionPending = false;
  @Input() daemonStarting = false;
  @Input() currentTimeMs: number = Date.now();
  @Input() sensitivityPills: readonly SensitivityPillOption[] = [];

  @Output() pillSelected = new EventEmitter<{ session: SessionDetail; pill: SensitivityPill }>();
  @Output() addTimeRequested = new EventEmitter<SessionDetail>();
  @Output() setStartSubmitted = new EventEmitter<string>();
  @Output() clearStartRequested = new EventEmitter<void>();
  @Output() startDaemonRequested = new EventEmitter<void>();
  @Output() goTodayRequested = new EventEmitter<void>();

  // Anchored set-start popover (replaces the full-screen modal). Hours/minutes
  // are strings so manual typing ("4" → "04") coexists with the wheel/▲▼ spinner.
  startPopoverOpen = false;
  hoursStr = '09';
  minutesStr = '00';
  initialStart = '';
  attemptedApply = false;

  // ─── Sessions ─────────────────────────────────────────────────────────

  get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy) ?? [];
  }

  get closedSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => s.closedBy) ?? [];
  }

  get hasSessions(): boolean {
    return (this.data?.sessions.length ?? 0) > 0;
  }

  // ─── Day-start marker ─────────────────────────────────────────────────

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
    return this.formatHm(iso);
  }

  // Manual start renders mauve (like a session's manual-time tag); auto shows plain.
  get isManualStart(): boolean {
    return !!this.data?.manualStart;
  }

  // ─── Set-start popover ─────────────────────────────────────────────────

  // Click on the start time opens a small spinner anchored to it.
  toggleStartPopover(): void {
    if (this.startPopoverOpen) { this.closeStartPopover(); return; }
    if (!this.isViewingToday) return;
    const [h, m] = (this.dayStartLabel || '09:00').split(':');
    this.hoursStr = h ?? '09';
    this.minutesStr = m ?? '00';
    this.initialStart = `${this.hoursStr}:${this.minutesStr}`;
    this.attemptedApply = false;
    this.startPopoverOpen = true;
  }

  closeStartPopover(): void {
    this.startPopoverOpen = false;
  }

  // Manual typing: digits only, max two. Range validity is reported live via
  // hoursInvalid/minutesInvalid — we never silently clamp an out-of-range value.
  onHoursInput(value: string): void {
    this.hoursStr = value.replace(/\D/g, '').slice(0, 2);
    this.attemptedApply = false;
  }

  onMinutesInput(value: string): void {
    this.minutesStr = value.replace(/\D/g, '').slice(0, 2);
    this.attemptedApply = false;
  }

  // Pad a valid value to two digits on blur ("4" → "04"); leave invalid as typed.
  normalizeHours(): void {
    if (!this.hoursInvalid) this.hoursStr = this.hoursStr.padStart(2, '0');
  }

  normalizeMinutes(): void {
    if (!this.minutesInvalid) this.minutesStr = this.minutesStr.padStart(2, '0');
  }

  get hoursInvalid(): boolean {
    return !this.inRange(this.hoursStr, 23);
  }

  get minutesInvalid(): boolean {
    return !this.inRange(this.minutesStr, 59);
  }

  private inRange(value: string, max: number): boolean {
    if (!/^\d{1,2}$/.test(value.trim())) return false;
    const n = parseInt(value, 10);
    return n >= 0 && n <= max;
  }

  private toInt(value: string): number {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : 0;
  }

  // Wheel + ▲▼ steppers, wrapping 00-23 / 00-59 (always land on a valid value).
  bumpHours(delta: number): void {
    this.hoursStr = String((this.toInt(this.hoursStr) + delta + 24) % 24).padStart(2, '0');
    this.attemptedApply = false;
  }

  bumpMinutes(delta: number): void {
    this.minutesStr = String((this.toInt(this.minutesStr) + delta + 60) % 60).padStart(2, '0');
    this.attemptedApply = false;
  }

  onWheel(field: 'h' | 'm', e: WheelEvent): void {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 1 : -1;
    if (field === 'h') this.bumpHours(delta);
    else this.bumpMinutes(delta);
  }

  // Invalid → flag the bad control(s) red and keep the popover open.
  applyStart(): void {
    if (this.actionPending) return;
    if (this.hoursInvalid || this.minutesInvalid) {
      this.attemptedApply = true;
      return;
    }
    this.hoursStr = this.hoursStr.padStart(2, '0');
    this.minutesStr = this.minutesStr.padStart(2, '0');
    const value = `${this.hoursStr}:${this.minutesStr}`;
    // Unchanged from the start we opened with → no daemon write, no manual override.
    if (value === this.initialStart) {
      this.closeStartPopover();
      return;
    }
    this.setStartSubmitted.emit(value);
    this.closeStartPopover();
  }

  clearStart(): void {
    if (!this.isManualStart || this.actionPending) return;
    this.clearStartRequested.emit();
    this.closeStartPopover();
  }

  // ─── Last-activity marker ─────────────────────────────────────────────

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
    return iso ? this.formatHm(iso) : '';
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  get totalActiveMs(): number {
    if (!this.data?.activeIntervals) return 0;
    return this.data.activeIntervals.reduce((sum, iv) =>
      sum + (new Date(iv.to).getTime() - new Date(iv.from).getTime()), 0);
  }

  get totalPauseMs(): number {
    if (!this.data) return 0;
    if (typeof this.data.downtimeMs === 'number') return this.data.downtimeMs;
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

  // ─── Active|idle ratio ────────────────────────────────────────────────

  // Bar + caption render only when there is something to show.
  get hasActivity(): boolean {
    return this.totalActiveMs > 0 || this.totalPauseMs > 0;
  }

  get activePct(): number {
    const total = this.totalActiveMs + this.totalPauseMs;
    return total > 0 ? (this.totalActiveMs / total) * 100 : 0;
  }

  get idlePct(): number {
    const total = this.totalActiveMs + this.totalPauseMs;
    return total > 0 ? (this.totalPauseMs / total) * 100 : 0;
  }

  // ─── Session colour palette ───────────────────────────────────────────

  sessionColor(sessionId: string): string {
    const session = this.data?.sessions.find(s => s.id === sessionId);
    if (!session) return '#6c7086';
    const idx = this.uniqueReposSorted.indexOf(session.repo);
    if (idx < 0) return '#6c7086';
    return SESSION_COLOR_PALETTE[idx % SESSION_COLOR_PALETTE.length];
  }

  private get uniqueReposSorted(): readonly string[] {
    if (!this.data) return [];
    const set = new Set<string>();
    for (const s of this.data.sessions) set.add(s.repo);
    return [...set].sort();
  }

  // ─── Formatters ───────────────────────────────────────────────────────

  formatDurationHm(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
  }

  private formatHm(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  repoName(repoPath: string): string {
    return repoPath.split('/').pop() ?? repoPath;
  }

  sessionInterval(s: SessionDetail): string {
    return `${this.formatHm(s.startedAt)} → ${this.formatHm(s.lastSeenAt)}`;
  }

  // ─── Status / sensitivity helpers ─────────────────────────────────────

  staminaColor(normalizedScore: number): string {
    if (normalizedScore >= 0.6) return '#a6e3a1';
    if (normalizedScore >= 0.3) return '#f9e2af';
    return '#f38ba8';
  }

  staminaPercent(normalizedScore: number): number {
    return Math.round(Math.max(0, Math.min(1, normalizedScore)) * 100);
  }

  activePill(s: SessionDetail): SensitivityPill {
    return s.paused ? 'pause' : s.sensitivity;
  }

  isAlwaysOn(s: SessionDetail): boolean {
    return !s.paused && s.sensitivity === SensitivityLevel.AlwaysOn;
  }

  statusClass(s: SessionDetail): string {
    if (s.paused) {
      switch ((s.pauseSource ?? '').toLowerCase()) {
        case 'idle_timeout': return 'status-idle';
        case 'superseded':   return 'status-switched';
        case 'teams_away':   return 'status-away';
        case 'manual':       return 'status-paused';
        default:             return 'status-paused';
      }
    }
    return s.state === 'active' ? 'status-live' : 'status-pending';
  }

  statusLabel(s: SessionDetail): string {
    if (s.paused) {
      switch ((s.pauseSource ?? '').toLowerCase()) {
        case 'idle_timeout': return 'Idle';
        case 'superseded':   return 'Switched';
        case 'teams_away':   return 'Away';
        case 'manual':       return 'Paused';
        default:             return 'Paused';
      }
    }
    return s.state === 'active' ? 'Live' : 'Pending';
  }

  // Reason badge for the Closed list. Labels stay short so the row layout
  // doesn't break at the default tray window width.
  closedReasonLabel(closedBy: string | null): string {
    switch ((closedBy ?? '').toLowerCase()) {
      case 'checkout_other_task': return 'Switched';
      case 'day_boundary':        return 'Day end';
      case 'daemon_stop':
      case 'stopped':             return 'Stopped';
      case 'daemon_crash':        return 'Crashed';
      case 'manual_stop':
      case 'manual':
      case 'user':                return 'Manual';
      case 'budget_exhausted':    return 'Budget';
      case 'idle_timeout':        return 'Idle';
      case 'superseded':          return 'Switched';
      default:                    return closedBy ?? '—';
    }
  }

  closedReasonClass(closedBy: string | null): string {
    switch ((closedBy ?? '').toLowerCase()) {
      case 'checkout_other_task': return 'reason-switched';
      case 'day_boundary':        return 'reason-dayend';
      case 'daemon_stop':
      case 'stopped':
      case 'daemon_crash':        return 'reason-stopped';
      case 'manual_stop':
      case 'manual':
      case 'user':                return 'reason-manual';
      case 'budget_exhausted':    return 'reason-dayend';
      case 'idle_timeout':        return 'reason-idle';
      case 'superseded':          return 'reason-switched';
      default:                    return 'reason-other';
    }
  }

  // ─── Click handlers (forwarded to shell) ──────────────────────────────

  onPillClick(session: SessionDetail, pill: SensitivityPill): void {
    if (pill === this.activePill(session)) return;
    this.pillSelected.emit({ session, pill });
  }
}
