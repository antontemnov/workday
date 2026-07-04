import {
  Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SessionCardComponent } from './session-card/session-card.component';
import { DurationFieldComponent } from './duration-field/duration-field.component';
import { LoggedPanelComponent } from './logged-panel/logged-panel.component';
import { ChipPick, LogCloudComponent, SuggestedLog } from './log-cloud/log-cloud.component';
import { formatDurationLabel, parseDurationToMinutes } from './duration-field/duration.util';
import { activityLabel } from './activity.util';
import {
  SessionDetail,
  SensitivityLevel,
  SensitivityPill,
  TodayResponse,
  ManualEntry,
  ManualEntryInput,
  ManualEntryPatch,
  ActivityType,
  Favorite,
} from '../../models/workday.models';

interface SensitivityPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

const DEFAULT_ACTIVITY = 'Other';

@Component({
  selector: 'app-day-view',
  standalone: true,
  imports: [CommonModule, FormsModule, SessionCardComponent, DurationFieldComponent,
            LoggedPanelComponent, LogCloudComponent],
  templateUrl: './day-view.component.html',
  styleUrl: './day-view.component.scss',
})
export class DayViewComponent implements OnChanges {
  @Input() data: TodayResponse | null = null;
  @Input() loading = false;
  @Input() error: string | null = null;
  @Input() isViewingToday = true;
  @Input() dateLabel = '';
  @Input() actionPending = false;
  @Input() daemonUserStopped = false;
  @Input() sensitivityPills: readonly SensitivityPillOption[] = [];
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() favorites: readonly Favorite[] = [];
  // Entry created by the latest log action — the panel opens its draft window.
  @Input() freshEntryId: string | null = null;

  @Output() pillSelected = new EventEmitter<{ session: SessionDetail; pill: SensitivityPill }>();
  @Output() addTimeSubmitted = new EventEmitter<{ session: SessionDetail; minutes: number }>();
  @Output() goTodayRequested = new EventEmitter<void>();
  @Output() logSubmitted = new EventEmitter<ManualEntryInput>();
  @Output() entryEditSubmitted = new EventEmitter<{ target: string; patch: ManualEntryPatch }>();

  public constructor(private host: ElementRef<HTMLElement>) {}

  @ViewChild(LoggedPanelComponent, { read: ElementRef })
  private panelRef?: ElementRef<HTMLElement>;

  // Mauve flash on the Day total when the logged share changes.
  dayFlash = false;
  private dayFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private prevLoggedMs: number | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['data']) return;
    const logged = this.loggedMs;
    if (this.prevLoggedMs !== null && logged !== this.prevLoggedMs) {
      this.dayFlash = true;
      if (this.dayFlashTimer) clearTimeout(this.dayFlashTimer);
      this.dayFlashTimer = setTimeout(() => this.dayFlash = false, 400);
    }
    this.prevLoggedMs = logged;
  }

  // ─── Sessions ─────────────────────────────────────────────────────────

  // Tracked never collapses; only history folds. Earlier (closed) starts
  // collapsed.
  earlierOpen = false;

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

  // Σ on the earlier fold — sum of closed effective durations.
  get closedTotalMs(): number {
    return this.closedSessions.reduce((sum, s) => sum + s.effectiveDurationMs, 0);
  }

  get hasSessions(): boolean {
    return (this.data?.sessions.length ?? 0) > 0;
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  // Σ on the Tracked header — live + closed effective durations.
  get trackedTotalMs(): number {
    return this.data?.sessions.reduce((sum, s) => sum + s.effectiveDurationMs, 0) ?? 0;
  }

  // Day total = Tracked Σ + Logged Σ — "what goes to Tempo today".
  get dayTotalMs(): number {
    return this.trackedTotalMs + this.loggedMs;
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

  // Reason text for the earlier (closed) rows — quiet italic, no badge.
  // Labels stay short so the row layout doesn't break at tray width.
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

  // ─── Manual entries (LOGGED band) ──────────────────────────────────────

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

  get loggedMs(): number {
    return this.manualEntries.reduce((sum, e) => sum + e.minutes, 0) * 60_000;
  }

  // Dropdown options — fall back to a single Other when types haven't loaded.
  get activityOptions(): readonly ActivityType[] {
    return this.activityTypes.length ? this.activityTypes : [{ value: DEFAULT_ACTIVITY, name: DEFAULT_ACTIVITY }];
  }

  activityLabel(value: string): string {
    return activityLabel(this.activityTypes, value);
  }

  // ─── Log cloud ─────────────────────────────────────────────────────────

  // Tracker-noticed suggestions — no daemon surface yet, so always empty;
  // the cloud's teal row and the panel badges light up once it exists.
  readonly suggestions: readonly SuggestedLog[] = [];

  cloudOpen = false;
  // Both overlays sit just above the Logged panel; measured at open time.
  overlayBottom = 0;
  composerBottom = 0;

  openCloud(): void {
    if (!this.isViewingToday || this.actionPending) return;
    this.overlayBottom = this.panelHeight() + 6;
    this.cloudOpen = true;
  }

  closeCloud(): void {
    this.cloudOpen = false;
  }

  private panelHeight(): number {
    return this.panelRef?.nativeElement.offsetHeight ?? 46;
  }

  // Instant log: chip click → cloud closes, the chip flies to the panel
  // header, the entry POSTs in parallel (lands with the next refresh).
  onChipPicked(pick: ChipPick): void {
    this.closeCloud();
    this.flyChip(pick.sourceRect, pick.label, pick.entry.minutes);
    this.logSubmitted.emit(pick.entry);
  }

  onFreshMinutesCommitted(e: { id: string; minutes: number }): void {
    this.entryEditSubmitted.emit({ target: e.id, patch: { minutes: e.minutes } });
  }

  // FLIP clone of the picked chip → flies to the panel header (Σ corner).
  // Styled inline: the element lives on document.body, outside the component's
  // scoped styles.
  private flyChip(from: DOMRect, label: string, minutes: number): void {
    const head = this.panelRef?.nativeElement.querySelector('.lp-head');
    if (!head || from.width === 0) return;
    const to = head.getBoundingClientRect();

    const g = document.createElement('span');
    Object.assign(g.style, {
      position: 'fixed', zIndex: '60', pointerEvents: 'none',
      left: `${from.left}px`, top: `${from.top}px`,
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '5px 11px', borderRadius: '999px',
      background: 'rgba(203, 166, 247, 0.16)', border: '1px solid rgba(203, 166, 247, 0.5)',
      fontSize: '10.5px', fontFamily: 'inherit',
      transition: 'transform 0.42s cubic-bezier(0.35, 0.9, 0.3, 1), opacity 0.42s ease',
    } as Partial<CSSStyleDeclaration>);

    const name = document.createElement('span');
    name.textContent = label;
    Object.assign(name.style, { color: '#cba6f7', fontWeight: '600' } as Partial<CSSStyleDeclaration>);
    const min = document.createElement('span');
    min.textContent = formatDurationLabel(minutes);
    Object.assign(min.style, { color: '#a6adc8' } as Partial<CSSStyleDeclaration>);
    g.append(name, min);

    document.body.appendChild(g);
    requestAnimationFrame(() => {
      g.style.transform =
        `translate(${to.left + 14 - from.left}px, ${to.bottom + 6 - from.top}px) scale(0.5)`;
      g.style.opacity = '0';
    });
    setTimeout(() => g.remove(), 460);
  }

  // ─── Compose popover (custom add + edit) ───────────────────────────────

  // Temporary custom path (cloud "⌨ custom…") until Jira search lands.
  openCustomComposer(): void {
    this.closeCloud();
    this.openLogPopover();
  }

  openLogPopover(): void {
    if (!this.isViewingToday) return;
    this.editingId = null;
    this.logTask = '';
    this.logTimeStr = '30m';
    this.logActivity = DEFAULT_ACTIVITY;
    this.logDescription = '';
    this.attemptedLog = false;
    this.activityListOpen = false;
    this.composerBottom = this.panelHeight() + 8;
    this.logPopoverOpen = true;
  }

  openEditPopover(entry: ManualEntry): void {
    if (!this.isViewingToday || entry.sourceSessionId) return;
    this.editingId = entry.id;
    this.logTask = entry.task;
    this.logTimeStr = formatDurationLabel(entry.minutes);
    this.logActivity = entry.activity;
    this.logDescription = entry.description;
    this.attemptedLog = false;
    this.activityListOpen = false;
    this.composerBottom = this.panelHeight() + 8;
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
