import {
  Component, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionCardComponent } from './session-card/session-card.component';
import { LoggedPanelComponent, type ArriveFrom } from './logged-panel/logged-panel.component';
import { ChipPick, LogCloudComponent } from './log-cloud/log-cloud.component';
import { SuggestionRowComponent, type SuggestionAcceptEvent, type SuggestionPick } from './suggestion-row/suggestion-row.component';
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
  FavoriteInput,
  Suggestion,
  SuggestionAcceptRequest,
  suggestionSourceRef,
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
  imports: [CommonModule, SessionCardComponent, LoggedPanelComponent, LogCloudComponent, SuggestionRowComponent],
  templateUrl: './day-view.component.html',
  styleUrl: './day-view.component.scss',
})
export class DayViewComponent implements OnChanges, OnDestroy {
  @Input() data: TodayResponse | null = null;
  @Input() loading = false;
  @Input() error: string | null = null;
  @Input() dateLabel = '';
  @Input() weekdayLabel = '';
  @Input() actionPending = false;
  @Input() daemonUserStopped = false;
  @Input() sensitivityPills: readonly SensitivityPillOption[] = [];
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() activityAllowed: readonly string[] = [];
  @Input() favorites: readonly Favorite[] = [];
  // Entry created by the latest log action — the panel opens its draft window.
  @Input() freshEntryId: string | null = null;
  // Today's pending meeting offers (daemon-derived, polled with the day).
  @Input() suggestions: readonly Suggestion[] = [];
  // Jira summaries for resolved/candidate tasks (daemon name cache).
  @Input() suggestionSummaries: Readonly<Record<string, string>> = {};

  @Output() pillSelected = new EventEmitter<{ session: SessionDetail; pill: SensitivityPill }>();
  @Output() addTimeSubmitted = new EventEmitter<{ session: SessionDetail; minutes: number }>();
  @Output() logSubmitted = new EventEmitter<ManualEntryInput>();
  @Output() batchSubmitted = new EventEmitter<readonly ManualEntryInput[]>();
  @Output() entryEditSubmitted = new EventEmitter<{ target: string; patch: ManualEntryPatch }>();
  @Output() entryDeleteSubmitted = new EventEmitter<string>();
  @Output() favoriteAddSubmitted = new EventEmitter<FavoriteInput>();
  @Output() favoritesRemoveSubmitted = new EventEmitter<readonly string[]>();
  @Output() settingsRequested = new EventEmitter<void>();
  @Output() suggestionAcceptSubmitted = new EventEmitter<SuggestionAcceptRequest>();
  @Output() suggestionDismissSubmitted = new EventEmitter<{ uid: string; date: string }>();
  @Output() suggestionMuteSubmitted = new EventEmitter<{ uid: string; date: string; days: number | null }>();

  @ViewChild('dayHead')
  private dayHeadRef?: ElementRef<HTMLElement>;

  // The history feed — the fly-chip's landing pad: a fresh entry materializes
  // as the feed's newest row, so the chip flies there, not to the Day total.
  @ViewChild(LoggedPanelComponent, { read: ElementRef })
  private historyRef?: ElementRef<HTMLElement>;

  @ViewChild(LogCloudComponent, { read: ElementRef })
  private cloudRef?: ElementRef<HTMLElement>;

  // Mauve flash on the Day total when the logged share changes — server data
  // and local live diffs (draft stepper ticks) both count.
  dayFlash = false;
  private dayFlashTimer: ReturnType<typeof setTimeout> | null = null;
  private prevDisplayedLoggedMs: number | null = null;

  // Uncommitted/unconfirmed panel minutes — keeps the Day total moving in the
  // same instant as the panel Σ while a draft stepper spins.
  liveDiffMinutes = 0;

  public constructor(private hostEl: ElementRef<HTMLElement>, private zone: NgZone) {}

  ngOnDestroy(): void {
    this.cloudResize?.disconnect();
  }

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

  // Only sessions with real activity: pending candidates and watching cards
  // (activatedAt == null) stay hidden — the radar placeholder covers them.
  get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy && s.activatedAt !== null) ?? [];
  }

  // Closed sessions render as read-only rows in the history feed.
  get closedSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => s.closedBy) ?? [];
  }

  // Radar only when the day is a blank page — any session, suggestion, entry
  // or closed group means the feed has something better to say.
  get dayEmpty(): boolean {
    return this.openSessions.length === 0
      && this.closedSessions.length === 0
      && this.manualEntries.length === 0
      && this.suggestions.length === 0;
  }

  get closedTotalMs(): number {
    return this.closedSessions.reduce((sum, s) => sum + s.effectiveDurationMs, 0);
  }

  // ─── Stats ────────────────────────────────────────────────────────────

  // Σ on the Tracked header — live sessions only; closed time counts as Logged.
  get trackedTotalMs(): number {
    return this.openSessions.reduce((sum, s) => sum + s.effectiveDurationMs, 0);
  }

  // Day total = Tracked Σ + Logged Σ — "what goes to Tempo today". Includes
  // the panel's live diff so a spinning draft stepper moves it immediately.
  get dayTotalMs(): number {
    return this.trackedTotalMs + this.displayedLoggedMs + this.closedTotalMs;
  }

  private get displayedLoggedMs(): number {
    return this.loggedMs + this.liveDiffMinutes * 60_000;
  }

  // Empty until the day's first minutes — the header shows no zero.
  get dayTotalLabel(): string {
    return this.dayTotalMs > 0 ? this.formatDurationHm(this.dayTotalMs) : '';
  }

  // ─── Formatters ───────────────────────────────────────────────────────

  formatDurationHm(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
  }

  // ─── Manual entries (LOGGED band) ──────────────────────────────────────

  get manualEntries(): readonly ManualEntry[] {
    return this.data?.manualEntries ?? [];
  }

  // Task key → ticket summary, for the Logged rows. Empty until the daemon
  // caches the names (older daemon omits the field entirely).
  get issueSummaries(): Readonly<Record<string, string>> {
    return this.data?.issueSummaries ?? {};
  }

  get loggedMs(): number {
    return this.manualEntries.reduce((sum, e) => sum + e.minutes, 0) * 60_000;
  }

  onPanelPatch(e: { id: string; patch: ManualEntryPatch }): void {
    this.entryEditSubmitted.emit({ target: e.id, patch: e.patch });
  }

  // ─── Suggestions (graphite blueprint rows between the live cards and the history) ─────

  onSuggestionDismiss(s: Suggestion): void {
    this.suggestionDismissSubmitted.emit({ uid: s.uid, date: s.date });
  }

  onSuggestionMute(s: Suggestion, days: number | null): void {
    this.suggestionMuteSubmitted.emit({ uid: s.uid, date: s.date, days });
  }

  trackBySuggestion(_i: number, s: Suggestion): string {
    return `${s.uid}:${s.date}`;
  }

  // ─── Log cloud ─────────────────────────────────────────────────────────

  cloudOpen = false;
  // The cloud hangs just below the sticky day header (＋Log), or under the
  // asking suggestion row (accept picker); measured at open time.
  overlayTop = 0;
  // Accept picker morphs out of its row's left edge, not the ＋Log corner.
  cloudOrigin: string | null = null;

  // Non-null → the cloud is a pure ticket picker for an unresolved meeting
  // suggestion: a pick closes the cloud and flows back into the row, which
  // opens its inline accept form (the logged-edit twin).
  acceptTarget: Suggestion | null = null;
  // The pick, addressed to its row (`uid:date`); a fresh object per pick.
  private suggestionPick: { key: string; pick: SuggestionPick } | null = null;
  // Latest accept's departure point — the feed slides the created entry's row
  // down from the offer's old spot when it lands.
  suggestionArrive: ArriveFrom | null = null;

  openCloud(): void {
    if (this.actionPending) return;
    this.acceptTarget = null;
    this.cloudOrigin = null;
    this.overlayTop = this.headHeight() + 6;
    this.cloudOpen = true;
  }

  // The picker opens where the ladder started: right under the asking row.
  // The panel is ALIVE in height (candidates render, the Jira zone appears
  // as the filter is typed), so placement can't be a one-shot measure — a
  // ResizeObserver re-runs it on every panel growth while the picker is open.
  openCloudForAccept(s: Suggestion, from?: DOMRect): void {
    if (this.actionPending) return;
    this.acceptTarget = s;
    if (from) {
      this.acceptAnchor = from;
      this.cloudSide = 'below';
      const host = this.hostEl.nativeElement.getBoundingClientRect();
      this.overlayTop = from.bottom - host.top + 2;
      this.cloudOrigin = '24px 0';
      setTimeout(() => this.watchCloudSize());
    } else {
      this.acceptAnchor = null;
      this.overlayTop = this.headHeight() + 6;
      this.cloudOrigin = null;
    }
    this.cloudOpen = true;
  }

  private acceptAnchor: DOMRect | null = null;
  private cloudSide: 'below' | 'above' = 'below';
  private cloudResize?: ResizeObserver;

  private watchCloudSize(): void {
    this.cloudResize?.disconnect();
    const cloud = this.cloudRef?.nativeElement;
    if (!cloud || !this.cloudOpen || !this.acceptAnchor) return;
    this.placeCloud(cloud);
    // The observer fires outside the Angular zone — re-enter for the binding.
    this.cloudResize = new ResizeObserver(() => this.zone.run(() => {
      const el = this.cloudRef?.nativeElement;
      if (el && this.cloudOpen && this.acceptAnchor) this.placeCloud(el);
    }));
    this.cloudResize.observe(cloud);
  }

  // Under the row while it fits; flips ABOVE the row otherwise (menu at a
  // screen edge — the sharp anchor row stays visible below, and further
  // growth pushes the top edge up, not the bottom onto the row); when
  // neither side fits, just clamp inside the view below the sticky header.
  // The side is STICKY per open: Jira result sets shrink and grow with
  // every filter keystroke, and a stateless choice would bounce the panel
  // across the row — once above, it stays above until the picker closes.
  private placeCloud(cloud: HTMLElement): void {
    const from = this.acceptAnchor!;
    const host = this.hostEl.nativeElement.getBoundingClientRect();
    const headTop = this.headHeight() + 6;
    const h = cloud.offsetHeight;
    const anchor = from.bottom - host.top + 2;

    if (this.cloudSide === 'below'
        && anchor + h > host.height - 8
        && from.top - host.top - h - 2 >= headTop) {
      this.cloudSide = 'above';
    }

    if (this.cloudSide === 'above') {
      // Bottom pinned to the row; a panel too tall for the slot spills past
      // it — the only honest option left.
      this.overlayTop = Math.max(headTop, from.top - host.top - h - 2);
      this.cloudOrigin = '24px 100%';
      return;
    }
    this.overlayTop = anchor + h <= host.height - 8
      ? anchor
      : Math.max(headTop, host.height - h - 8); // tiny-window fallback
    this.cloudOrigin = '24px 0';
  }

  closeCloud(): void {
    this.cloudOpen = false;
    this.acceptTarget = null;
    this.acceptAnchor = null;
    this.cloudResize?.disconnect();
    this.cloudResize = undefined;
  }

  pickFor(s: Suggestion): SuggestionPick | null {
    return this.suggestionPick?.key === `${s.uid}:${s.date}` ? this.suggestionPick.pick : null;
  }

  // The row the picker opened for stays sharp above the cloud backdrop —
  // its offer IS the context of the choice. Keyed (not by reference): polls
  // swap the objects while the cloud is open.
  isCloudAnchor(s: Suggestion): boolean {
    return this.cloudOpen
      && this.acceptTarget !== null
      && this.acceptTarget.uid === s.uid
      && this.acceptTarget.date === s.date;
  }

  onAcceptPicked(pick: SuggestionPick): void {
    const target = this.acceptTarget;
    this.closeCloud();
    if (target) this.suggestionPick = { key: `${target.uid}:${target.date}`, pick };
  }

  onSuggestionAccept(s: Suggestion, ev: SuggestionAcceptEvent): void {
    this.suggestionPick = null;
    const entry = ev.entry;
    // Not a new entity — the offer row BECOMES the logged row, so no fly-chip
    // here: the feed slides the landed row down from the offer's old spot.
    this.suggestionArrive = { sourceRef: suggestionSourceRef(s), top: ev.sourceRect.top };
    this.suggestionAcceptSubmitted.emit({
      uid: s.uid,
      date: s.date,
      task: entry.task,
      minutes: entry.minutes,
      description: entry.description,
      activity: entry.activity,
    });
  }

  private headHeight(): number {
    return this.dayHeadRef?.nativeElement.offsetHeight ?? 42;
  }

  // Instant log: chip click → cloud closes, the chip flies to the panel
  // header, the entry POSTs in parallel (lands with the next refresh).
  onChipPicked(pick: ChipPick): void {
    this.closeCloud();
    this.flyChip(pick.sourceRect, pick.label, pick.entry.minutes);
    this.logSubmitted.emit(pick.entry);
  }

  // Jira-result form → a single entry; lands with the usual draft window.
  // (Accept mode never reaches this form — picks flow back into the row.)
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

  // FLIP clone of the picked chip → flies into the history feed, where the
  // entry is about to land as the newest row. Styled inline: the element
  // lives on document.body, outside the component's scoped styles.
  private flyChip(from: DOMRect, label: string, minutes: number): void {
    const target = this.historyRef?.nativeElement ?? this.dayHeadRef?.nativeElement;
    if (!target || from.width === 0) return;
    const to = target.getBoundingClientRect();

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
    // Settles at the feed's top-left — the spot the new row's ticket chip
    // takes; scale stays near 1 so it reads as "becoming the row".
    requestAnimationFrame(() => {
      g.style.transform =
        `translate(${to.left + 9 - from.left}px, ${to.top + 4 - from.top}px) scale(0.85)`;
      g.style.opacity = '0';
    });
    setTimeout(() => g.remove(), 460);
  }
}
