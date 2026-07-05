import {
  Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionCardComponent } from './session-card/session-card.component';
import { LoggedPanelComponent } from './logged-panel/logged-panel.component';
import { ChipPick, LogCloudComponent, SuggestedLog } from './log-cloud/log-cloud.component';
import { formatDurationLabel } from './duration-field/duration.util';
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

@Component({
  selector: 'app-day-view',
  standalone: true,
  imports: [CommonModule, SessionCardComponent, LoggedPanelComponent, LogCloudComponent],
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
  @Output() batchSubmitted = new EventEmitter<readonly ManualEntryInput[]>();
  @Output() entryEditSubmitted = new EventEmitter<{ target: string; patch: ManualEntryPatch }>();
  @Output() settingsRequested = new EventEmitter<void>();

  @ViewChild(LoggedPanelComponent, { read: ElementRef })
  private panelRef?: ElementRef<HTMLElement>;

  // Mauve flash on the Day total when the logged share changes — server data
  // and local live diffs (draft stepper ticks) both count.
  dayFlash = false;
  private dayFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private prevDisplayedLoggedMs: number | null = null;

  // Uncommitted/unconfirmed panel minutes — keeps the Day total moving in the
  // same instant as the panel Σ while a draft stepper spins.
  liveDiffMinutes = 0;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['data']) this.checkDayFlash();
  }

  onLiveDiff(minutes: number): void {
    this.liveDiffMinutes = minutes;
    this.checkDayFlash();
  }

  private checkDayFlash(): void {
    const displayed = this.displayedLoggedMs;
    if (this.prevDisplayedLoggedMs !== null && displayed !== this.prevDisplayedLoggedMs) {
      this.dayFlash = true;
      if (this.dayFlashTimer) clearTimeout(this.dayFlashTimer);
      this.dayFlashTimer = setTimeout(() => this.dayFlash = false, 400);
    }
    this.prevDisplayedLoggedMs = displayed;
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

  // Day total = Tracked Σ + Logged Σ — "what goes to Tempo today". Includes
  // the panel's live diff so a spinning draft stepper moves it immediately.
  get dayTotalMs(): number {
    return this.trackedTotalMs + this.displayedLoggedMs;
  }

  private get displayedLoggedMs(): number {
    return this.loggedMs + this.liveDiffMinutes * 60_000;
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

  get manualEntries(): readonly ManualEntry[] {
    return this.data?.manualEntries ?? [];
  }

  get loggedMs(): number {
    return this.manualEntries.reduce((sum, e) => sum + e.minutes, 0) * 60_000;
  }

  onPanelPatch(e: { id: string; patch: ManualEntryPatch }): void {
    this.entryEditSubmitted.emit({ target: e.id, patch: e.patch });
  }

  // ─── Log cloud ─────────────────────────────────────────────────────────

  // Tracker-noticed suggestions — no daemon surface yet, so always empty;
  // the cloud's teal row and the panel badges light up once it exists.
  readonly suggestions: readonly SuggestedLog[] = [];

  cloudOpen = false;
  // The cloud sits just above the Logged panel; measured at open time.
  overlayBottom = 0;

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

  // Jira-result form → a single entry; lands with the usual draft window.
  onFormSubmitted(entry: ManualEntryInput): void {
    this.closeCloud();
    this.logSubmitted.emit(entry);
  }

  // Batch review → several entries at once; they land as static rows.
  onBatchSubmitted(entries: readonly ManualEntryInput[]): void {
    this.closeCloud();
    this.batchSubmitted.emit(entries);
  }

  onSettingsRequested(): void {
    this.closeCloud();
    this.settingsRequested.emit();
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
}
