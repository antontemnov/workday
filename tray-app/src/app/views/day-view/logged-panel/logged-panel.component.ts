import { Component, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivityType, ManualEntry } from '../../../models/workday.models';
import { activityLabel, activityTone } from '../activity.util';

const FRESH_WINDOW_MS = 4000;
const STEP_MINUTES = 15;
const MIN_MINUTES = 15;
const MAX_MINUTES = 480;

/**
 * Pinned Logged panel — the manual-entries band docked to the bottom of the
 * day view. Collapses by header click (grid-rows animation); the collapsed
 * header keeps the Σ and grows a mini ＋ button (with a teal suggestions
 * badge). A just-logged entry gets a ~4s draft window with a ±15m stepper;
 * the minutes diff is committed once, when the row freezes.
 */
@Component({
  selector: 'app-logged-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './logged-panel.component.html',
  styleUrl: './logged-panel.component.scss',
})
export class LoggedPanelComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) entries: readonly ManualEntry[] = [];
  @Input() isViewingToday = true;
  @Input() actionPending = false;
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() suggestedCount = 0;
  // Id of the entry created by the latest cloud pick — opens the draft window.
  @Input() freshEntryId: string | null = null;

  @Output() logRequested = new EventEmitter<void>();
  @Output() editRequested = new EventEmitter<ManualEntry>();
  @Output() freshMinutesCommitted = new EventEmitter<{ id: string; minutes: number }>();

  collapsed = false;
  sumFlash = false;

  // Draft window state — one fresh row at a time.
  freshId: string | null = null;
  freshMinutes: number | null = null;
  private freshBase: number | null = null;
  private freezeTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private prevSumMinutes: number | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['freshEntryId'] && this.freshEntryId && this.isViewingToday) {
      this.freeze(); // a new pick supersedes any still-open draft
      this.freshId = this.freshEntryId;
      this.freshMinutes = null;
      this.armFreeze();
    }
    if (changes['entries']) {
      // The fresh entry lands with the refresh that follows the POST — pick up
      // its minutes as the stepper base once it appears.
      if (this.freshId !== null && this.freshMinutes === null) {
        const e = this.entries.find(x => x.id === this.freshId);
        if (e) { this.freshMinutes = e.minutes; this.freshBase = e.minutes; }
      }
      const sum = this.entriesSumMinutes;
      if (this.prevSumMinutes !== null && sum !== this.prevSumMinutes) this.flashSum();
      // First entry of the day lands into an empty collapsed panel → open it.
      const prev = (changes['entries'].previousValue as readonly ManualEntry[] | undefined)?.length ?? 0;
      if (this.collapsed && prev === 0 && this.entries.length > 0) this.collapsed = false;
      this.prevSumMinutes = sum;
    }
  }

  ngOnDestroy(): void {
    this.freeze(); // don't lose a pending stepper diff on teardown
    if (this.flashTimer) clearTimeout(this.flashTimer);
  }

  // ─── Header ────────────────────────────────────────────────────────────

  toggleCollapsed(ev: MouseEvent): void {
    if ((ev.target as HTMLElement).closest('.lp-mini')) return;
    this.collapsed = !this.collapsed;
  }

  onMiniClick(ev: MouseEvent): void {
    ev.stopPropagation();
    this.logRequested.emit();
  }

  private get entriesSumMinutes(): number {
    return this.entries.reduce((sum, e) => sum + e.minutes, 0);
  }

  // Σ shown in the header — live entries plus the uncommitted stepper diff.
  get sumMs(): number {
    let minutes = this.entriesSumMinutes;
    if (this.freshId !== null && this.freshMinutes !== null && this.freshBase !== null) {
      minutes += this.freshMinutes - this.freshBase;
    }
    return minutes * 60_000;
  }

  private flashSum(): void {
    this.sumFlash = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.sumFlash = false, 400);
  }

  // ─── Rows ──────────────────────────────────────────────────────────────

  isFresh(e: ManualEntry): boolean {
    // Draft only in the expanded panel — a pick into the collapsed panel
    // lands quietly (flash Σ, no draft), per the instant-log design.
    return !this.collapsed && e.id === this.freshId && this.freshMinutes !== null;
  }

  canEdit(e: ManualEntry): boolean {
    return this.isViewingToday && !e.sourceSessionId && !this.isFresh(e);
  }

  onEditClick(e: ManualEntry): void {
    if (this.actionPending) return;
    this.editRequested.emit(e);
  }

  // ─── Stepper (fresh row) ───────────────────────────────────────────────

  step(delta: number): void {
    if (this.freshMinutes === null) return;
    const next = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, this.freshMinutes + delta));
    if (next !== this.freshMinutes) {
      this.freshMinutes = next;
      this.flashSum();
    }
    this.armFreeze();
  }

  onStepWheel(ev: WheelEvent): void {
    ev.preventDefault();
    this.step(ev.deltaY < 0 ? STEP_MINUTES : -STEP_MINUTES);
  }

  stepUp(ev: MouseEvent): void { ev.stopPropagation(); this.step(STEP_MINUTES); }
  stepDown(ev: MouseEvent): void { ev.stopPropagation(); this.step(-STEP_MINUTES); }

  private armFreeze(): void {
    if (this.freezeTimer) clearTimeout(this.freezeTimer);
    this.freezeTimer = setTimeout(() => this.freeze(), FRESH_WINDOW_MS);
  }

  // Draft window over: commit the minutes diff (single PATCH) and return the
  // row to its static form.
  private freeze(): void {
    if (this.freezeTimer) { clearTimeout(this.freezeTimer); this.freezeTimer = null; }
    if (this.freshId !== null && this.freshMinutes !== null
        && this.freshBase !== null && this.freshMinutes !== this.freshBase) {
      this.freshMinutesCommitted.emit({ id: this.freshId, minutes: this.freshMinutes });
    }
    this.freshId = null;
    this.freshMinutes = null;
    this.freshBase = null;
  }

  // ─── Formatters ────────────────────────────────────────────────────────

  formatDurationHm(ms: number): string {
    const totalMinutes = Math.floor(ms / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
  }

  activityLabel(value: string): string {
    return activityLabel(this.activityTypes, value);
  }

  activityTone(value: string): string {
    return activityTone(value);
  }

  trackByEntry(_i: number, e: ManualEntry): string {
    return e.id;
  }
}
