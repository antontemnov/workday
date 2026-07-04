import { Component, ElementRef, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionCardComponent } from './session-card/session-card.component';
import { DurationFieldComponent } from './duration-field/duration-field.component';
import { formatDurationLabel, parseDurationToMinutes } from './duration-field/duration.util';
import {
  SessionDetail,
  SensitivityLevel,
  SensitivityPill,
  TodayResponse,
  ManualEntry,
  ManualEntryInput,
  ManualEntryPatch,
  ActivityType,
} from '../../models/workday.models';

interface SensitivityPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

// Manual entries are their own species — one accent (mauve) regardless of task.
const MANUAL_ACCENT = '#cba6f7';
const DEFAULT_ACTIVITY = 'Other';

@Component({
  selector: 'app-day-view',
  standalone: true,
  imports: [CommonModule, FormsModule, SessionCardComponent, DurationFieldComponent],
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
  @Input() daemonUserStopped = false;
  @Input() currentTimeMs: number = Date.now();
  @Input() sensitivityPills: readonly SensitivityPillOption[] = [];
  @Input() activityTypes: readonly ActivityType[] = [];

  @Output() pillSelected = new EventEmitter<{ session: SessionDetail; pill: SensitivityPill }>();
  @Output() addTimeSubmitted = new EventEmitter<{ session: SessionDetail; minutes: number }>();
  @Output() goTodayRequested = new EventEmitter<void>();
  @Output() logSubmitted = new EventEmitter<ManualEntryInput>();
  @Output() entryEditSubmitted = new EventEmitter<{ target: string; patch: ManualEntryPatch }>();

  public constructor(private host: ElementRef<HTMLElement>) {}

  // ─── Sessions ─────────────────────────────────────────────────────────

  // Section collapse — "live open, history collapsed". Active starts open;
  // Closed always starts collapsed; Logged too (the dock owns adding, the list
  // is review-only).
  activeOpen = true;
  closedOpen = false;
  loggedOpen = false;

  get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy) ?? [];
  }

  get closedSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => s.closedBy) ?? [];
  }

  // Green dot on the Active header — at least one session is tracking right now.
  get hasLiveSession(): boolean {
    return this.openSessions.some(s => !s.paused && s.state === 'active');
  }

  // Σ on the Closed header — sum of effective durations.
  get closedTotalMs(): number {
    return this.closedSessions.reduce((sum, s) => sum + s.effectiveDurationMs, 0);
  }

  get hasSessions(): boolean {
    return (this.data?.sessions.length ?? 0) > 0;
  }

  // ─── Day-start marker ─────────────────────────────────────────────────

  // Server-resolved label (earliest activatedAt); the disk-fallback path may
  // leave it null, so mirror the same earliest-activatedAt logic locally.
  get dayStartIso(): string | null {
    if (!this.data) return null;
    if (this.data.dayStart) return this.data.dayStart;
    let earliest: string | null = null;
    for (const s of this.data.sessions) {
      if (!s.activatedAt) continue;
      if (earliest === null || new Date(s.activatedAt).getTime() < new Date(earliest).getTime()) {
        earliest = s.activatedAt;
      }
    }
    return earliest;
  }

  get dayStartLabel(): string {
    const iso = this.dayStartIso;
    if (!iso) return '';
    return this.formatHm(iso);
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
    return this.totalActiveMs > 0 || this.totalPauseMs > 0 || this.loggedMs > 0;
  }

  // Bar total = active + idle (git presence) + logged (manual). Three segments
  // mirror the three caption numbers; logged is additive, not carved from idle.
  private get ratioTotalMs(): number {
    return this.totalActiveMs + this.totalPauseMs + this.loggedMs;
  }

  get activePct(): number {
    const total = this.ratioTotalMs;
    return total > 0 ? (this.totalActiveMs / total) * 100 : 0;
  }

  get idlePct(): number {
    const total = this.ratioTotalMs;
    return total > 0 ? (this.totalPauseMs / total) * 100 : 0;
  }

  get loggedPct(): number {
    const total = this.ratioTotalMs;
    return total > 0 ? (this.loggedMs / total) * 100 : 0;
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

  // ─── Manual entries (LOGGED band) ──────────────────────────────────────

  readonly manualAccent = MANUAL_ACCENT;

  // Compose popover state. editingId = null → adding; otherwise editing that id.
  logPopoverOpen = false;
  editingId: string | null = null;
  logTask = '';
  logTimeStr = '30m';
  logActivity = DEFAULT_ACTIVITY;
  logDescription = '';
  attemptedLog = false;
  activityListOpen = false;
  activitySearch = '';

  get manualEntries(): readonly ManualEntry[] {
    return this.data?.manualEntries ?? [];
  }

  // The Logged section renders only with real entries; the dock owns adding, so
  // there is no empty-state band any more.
  get showLoggedSection(): boolean {
    return this.manualEntries.length > 0;
  }

  get loggedMs(): number {
    return this.manualEntries.reduce((sum, e) => sum + e.minutes, 0) * 60_000;
  }

  // Dropdown options — fall back to a single Other when types haven't loaded.
  get activityOptions(): readonly ActivityType[] {
    return this.activityTypes.length ? this.activityTypes : [{ value: DEFAULT_ACTIVITY, name: DEFAULT_ACTIVITY }];
  }

  activityLabel(value: string): string {
    return this.activityTypes.find(a => a.value === value)?.name ?? value;
  }

  // CSS modifier so a few common activities get a distinct badge tint.
  activityTone(value: string): string {
    switch (value) {
      case 'CodeReview':
      case 'CodeReviewFixes':
      case 'TestReview':   return 'rev';
      case 'Development':
      case 'Bugfixing':    return 'dev';
      default:             return 'other';
    }
  }

  // ─── Compose popover ───────────────────────────────────────────────────

  openLogPopover(): void {
    if (!this.isViewingToday) return;
    this.editingId = null;
    this.logTask = '';
    this.logTimeStr = '30m';
    this.logActivity = DEFAULT_ACTIVITY;
    this.logDescription = '';
    this.attemptedLog = false;
    this.activityListOpen = false;
    this.logPopoverOpen = true;
  }

  openEditPopover(entry: ManualEntry): void {
    if (!this.isViewingToday) return;
    this.editingId = entry.id;
    this.logTask = entry.task;
    this.logTimeStr = formatDurationLabel(entry.minutes);
    this.logActivity = entry.activity;
    this.logDescription = entry.description;
    this.attemptedLog = false;
    this.activityListOpen = false;
    this.logPopoverOpen = true;
  }

  closeLogPopover(): void {
    this.logPopoverOpen = false;
    this.activityListOpen = false;
  }

  // ─── Activity dropdown (custom — native <select> can't cap height/scroll) ──

  openActivityList(): void {
    this.activityListOpen = true;
    this.activitySearch = ''; // start unfiltered; the input filters as you type
    // *ngIf renders the input on the next tick — query the live DOM and focus.
    setTimeout(() => this.host.nativeElement
      .querySelector<HTMLInputElement>('.lp-activity-search')?.focus());
  }

  closeActivityList(): void {
    this.activityListOpen = false;
  }

  selectActivity(value: string): void {
    this.logActivity = value;
    this.activityListOpen = false;
  }

  // Enter in the filter picks the top match (Tempo-style).
  selectFirstActivity(): void {
    const first = this.filteredActivities[0];
    if (first) this.selectActivity(first.value);
  }

  get filteredActivities(): readonly ActivityType[] {
    const q = this.activitySearch.trim().toLowerCase();
    if (!q) return this.activityOptions;
    return this.activityOptions.filter(a => a.name.toLowerCase().includes(q));
  }

  // Duration text edited via the shared DurationFieldComponent; parse here for
  // validation + submit (the field handles input/chips/wheel/normalize).
  get parsedMinutes(): number | null {
    return parseDurationToMinutes(this.logTimeStr);
  }

  get logTaskInvalid(): boolean {
    return this.logTask.trim().length === 0;
  }

  get logMinutesInvalid(): boolean {
    return this.parsedMinutes === null;
  }

  get logDescriptionInvalid(): boolean {
    return this.logDescription.trim().length === 0;
  }

  get logInvalid(): boolean {
    return this.logTaskInvalid || this.logMinutesInvalid || this.logDescriptionInvalid;
  }

  applyLog(): void {
    if (this.actionPending) return;
    if (this.logInvalid) {
      this.attemptedLog = true;
      return;
    }
    const task = this.logTask.trim();
    const minutes = this.parsedMinutes ?? 0;
    const description = this.logDescription.trim();
    const activity = this.logActivity || DEFAULT_ACTIVITY;

    if (this.editingId) {
      this.entryEditSubmitted.emit({ target: this.editingId, patch: { minutes, description, activity } });
    } else {
      this.logSubmitted.emit({ task, minutes, description, activity });
    }
    this.closeLogPopover();
  }

}
