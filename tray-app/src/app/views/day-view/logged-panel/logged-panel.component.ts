import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ActivityType, DEVELOPMENT_ACTIVITY, Favorite, FavoriteInput, ManualEntry, ManualEntryPatch,
} from '../../../models/workday.models';
import { activityLabel, activityTone } from '../activity.util';
import { DurationInputDirective } from '../duration-field/duration-input.directive';
import { openCtxMenu } from '../ctx-menu.util';

const FRESH_WINDOW_MS = 4000;
const STEP_MINUTES = 15;
const MIN_MINUTES = 15;
const MAX_MINUTES = 480;
// Safety net: a pending patch the data never confirms (failed PATCH) reverts
// the optimistic row after this long.
const PENDING_TTL_MS = 10_000;
// Delete is instant with a client-side undo: the row stays struck-through
// with a burning ↩ for this long, then collapses and the DELETE goes out.
const UNDO_WINDOW_MS = 3000;
const REMOVE_ANIM_MS = 240;
const FAV_FEEDBACK_MS = 1200;

/**
 * Pinned Logged panel — the manual-entries band docked to the bottom of the
 * day view. Collapses by header click (grid-rows animation); the collapsed
 * header keeps the Σ and grows a mini ＋ button (with a teal suggestions
 * badge). A just-logged entry gets a ~4s draft window with a ±15m stepper;
 * double-click morphs a row into an inline edit form. Every local change
 * (stepper ticks included) reflects in the Σ immediately and is reported to
 * the parent as a live diff so the Day total moves in the same instant;
 * committed patches stay as optimistic overrides until the daemon's data
 * confirms them — no flicker between PATCH and refresh.
 */
@Component({
  selector: 'app-logged-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DurationInputDirective],
  templateUrl: './logged-panel.component.html',
  styleUrl: './logged-panel.component.scss',
})
export class LoggedPanelComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) entries: readonly ManualEntry[] = [];
  @Input() isViewingToday = true;
  @Input() actionPending = false;
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() favorites: readonly Favorite[] = [];
  @Input() suggestedCount = 0;
  // Id of the entry created by the latest cloud pick — opens the draft window.
  @Input() freshEntryId: string | null = null;

  @Output() logRequested = new EventEmitter<void>();
  @Output() patchCommitted = new EventEmitter<{ id: string; patch: ManualEntryPatch }>();
  // Fired when the undo window closes — the entry is gone for the user; the
  // parent sends the actual DELETE (undo never re-creates server-side).
  @Output() deleteCommitted = new EventEmitter<string>();
  @Output() favoriteAdded = new EventEmitter<FavoriteInput>();
  // Uncommitted + unconfirmed local minutes vs the server data — the parent
  // adds it to the Day total so it moves together with the panel Σ.
  @Output() liveDiffChanged = new EventEmitter<number>();

  public constructor(private host: ElementRef<HTMLElement>) {}

  collapsed = false;
  sumFlash = false;

  // Draft window state — one fresh row at a time.
  freshId: string | null = null;
  freshMinutes: number | null = null;
  private freshBase: number | null = null;
  private freezeTimer: ReturnType<typeof setTimeout> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  // Inline row edit (double-click).
  editingId: string | null = null;
  editMinutes = 30;
  editActivity = '';
  editDescription = '';

  // Optimistic overrides: patch sent, refresh not yet confirming it.
  private pending = new Map<string, ManualEntryPatch>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Delete pipeline: undo window (timer) → collapse animation → hidden until
  // the server data drops the row. Σ excludes an entry from the first stage.
  private deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  removingIds = new Set<string>();
  private hiddenIds = new Set<string>();
  private removeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // "★ added to favorites" feedback riding the description for ~1.2s.
  favDoneId: string | null = null;
  private favDoneTimer: ReturnType<typeof setTimeout> | null = null;

  private prevDisplayedSum: number | null = null;
  private lastEmittedDiff = 0;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['freshEntryId'] && this.freshEntryId && this.isViewingToday) {
      this.freeze(); // a new pick supersedes any still-open draft
      // Draft window (mauve stepper) is an expanded-panel affordance only. A
      // pick into a collapsed panel fixes the time immediately and lands as a
      // static row — mirrors the mockup's addStaticRow path; the panel stays
      // collapsed (quiet landing: chip fly + Σ flash).
      if (!this.collapsed) {
        this.freshId = this.freshEntryId;
        this.freshMinutes = null;
        this.armFreeze();
      }
    }
    if (changes['entries']) {
      // The fresh entry lands with the refresh that follows the POST — pick up
      // its minutes as the stepper base once it appears.
      if (this.freshId !== null && this.freshMinutes === null) {
        const e = this.entries.find(x => x.id === this.freshId);
        if (e) { this.freshMinutes = e.minutes; this.freshBase = e.minutes; }
      }
      this.reconcilePending();
      this.reconcileDeletes();
      if (this.editingId !== null && !this.entries.some(e => e.id === this.editingId)) {
        this.editingId = null; // the edited entry is gone (external change)
      }
      this.recomputeLive();
    }
  }

  ngOnDestroy(): void {
    this.freeze(); // don't lose a pending stepper diff on teardown
    // Deletes past their undo click are the user's intent — commit them now
    // instead of silently resurrecting the rows on the next visit.
    for (const [id, timer] of this.deleteTimers) {
      clearTimeout(timer);
      this.deleteCommitted.emit(id);
    }
    this.deleteTimers.clear();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.favDoneTimer) clearTimeout(this.favDoneTimer);
    this.pendingTimers.forEach(t => clearTimeout(t));
    this.removeTimers.forEach(t => clearTimeout(t));
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

  // Newest first — a fresh log lands at the top, right under the ghost row.
  // Rows whose DELETE is already sent stay hidden until the data confirms.
  get displayEntries(): readonly ManualEntry[] {
    return [...this.entries].filter(e => !this.hiddenIds.has(e.id)).reverse();
  }

  // Σ shown in the header — server data plus every local override.
  get sumMs(): number {
    return this.displayedSumMinutes * 60_000;
  }

  // A deleted row leaves the Σ the moment the undo window opens.
  private get displayedSumMinutes(): number {
    return this.entries.reduce(
      (sum, e) => sum + (this.isGoneLocally(e.id) ? 0 : this.displayMinutes(e)), 0);
  }

  private isGoneLocally(id: string): boolean {
    return this.deleteTimers.has(id) || this.removingIds.has(id) || this.hiddenIds.has(id);
  }

  private get rawSumMinutes(): number {
    return this.entries.reduce((sum, e) => sum + e.minutes, 0);
  }

  private flashSum(): void {
    this.sumFlash = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.sumFlash = false, 400);
  }

  // Flash on any visible Σ change and keep the parent's live diff current.
  // Confirming refreshes swap an override for real data without changing the
  // displayed value — no flash, diff settles back to 0.
  private recomputeLive(): void {
    const displayed = this.displayedSumMinutes;
    if (this.prevDisplayedSum !== null && displayed !== this.prevDisplayedSum) this.flashSum();
    this.prevDisplayedSum = displayed;
    const diff = displayed - this.rawSumMinutes;
    if (diff !== this.lastEmittedDiff) {
      this.lastEmittedDiff = diff;
      this.liveDiffChanged.emit(diff);
    }
  }

  // ─── Row display (with optimistic overrides) ───────────────────────────

  displayMinutes(e: ManualEntry): number {
    if (this.isFresh(e)) return this.freshMinutes ?? e.minutes;
    return this.pending.get(e.id)?.minutes ?? e.minutes;
  }

  displayActivity(e: ManualEntry): string {
    return this.pending.get(e.id)?.activity ?? e.activity;
  }

  displayDescription(e: ManualEntry): string {
    return this.pending.get(e.id)?.description ?? e.description;
  }

  isFresh(e: ManualEntry): boolean {
    // Draft only in the expanded panel — a pick into the collapsed panel
    // lands quietly (flash Σ, no draft), per the instant-log design.
    return !this.collapsed && e.id === this.freshId && this.freshMinutes !== null;
  }

  canEdit(e: ManualEntry): boolean {
    return this.isViewingToday && !e.sourceSessionId && !this.isFresh(e);
  }

  // Session-born entries can't be edited, but deleting them is legal.
  canDelete(e: ManualEntry): boolean {
    return this.isViewingToday && !this.isFresh(e);
  }

  rowTitle(e: ManualEntry): string {
    if (this.editingId === e.id || this.isDeleted(e)) return '';
    if (this.canEdit(e)) return 'right-click — actions · double-click — edit';
    if (this.canDelete(e)) return 'right-click — actions';
    return '';
  }

  // ─── Context menu (right-click) ─────────────────────────────────────────

  onRowContextMenu(e: ManualEntry, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.editingId === e.id || this.isFresh(e) || this.isDeleted(e)) return;
    const items = [
      ...(this.canEdit(e) ? [{ icon: '✎', label: 'Edit', action: () => this.onRowDblClick(e) }] : []),
      // Hidden (not disabled) when the row already has this template.
      ...(this.canAddToFavorites(e)
        ? [{ icon: '★', label: 'Add to favorites', action: () => this.addToFavorites(e) }] : []),
      ...(this.canDelete(e)
        ? [{ icon: '✕', label: 'Delete', danger: true, action: () => this.deleteEntry(e) }] : []),
    ];
    openCtxMenu(ev.clientX, ev.clientY, items);
  }

  // A favorite is task + name (description) — no description, nothing to save.
  private canAddToFavorites(e: ManualEntry): boolean {
    if (!this.canEdit(e)) return false;
    const name = this.displayDescription(e).trim();
    if (!name) return false;
    return !this.favorites.some(f => f.task === e.task && f.name === name);
  }

  private addToFavorites(e: ManualEntry): void {
    this.favoriteAdded.emit({
      name: this.displayDescription(e).trim(),
      task: e.task,
      minutes: this.displayMinutes(e),
      activity: this.displayActivity(e),
    });
    this.favDoneId = e.id;
    if (this.favDoneTimer) clearTimeout(this.favDoneTimer);
    this.favDoneTimer = setTimeout(() => this.favDoneId = null, FAV_FEEDBACK_MS);
  }

  // ─── Delete with undo ────────────────────────────────────────────────────

  isDeleted(e: ManualEntry): boolean {
    return this.deleteTimers.has(e.id) || this.removingIds.has(e.id);
  }

  private deleteEntry(e: ManualEntry): void {
    if (this.editingId === e.id) this.editingId = null;
    this.deleteTimers.set(e.id, setTimeout(() => this.startRemove(e.id), UNDO_WINDOW_MS));
    this.recomputeLive();
  }

  undoDelete(e: ManualEntry, ev: MouseEvent): void {
    ev.stopPropagation();
    const timer = this.deleteTimers.get(e.id);
    if (!timer) return;
    clearTimeout(timer);
    this.deleteTimers.delete(e.id);
    this.recomputeLive();
  }

  // Undo window over: collapse the row, then send the DELETE. Undo past this
  // point doesn't exist — the design keeps it purely client-side.
  private startRemove(id: string): void {
    this.deleteTimers.delete(id);
    this.removingIds.add(id);
    this.removeTimers.set(id, setTimeout(() => {
      this.removingIds.delete(id);
      this.removeTimers.delete(id);
      this.hiddenIds.add(id);
      this.deleteCommitted.emit(id);
    }, REMOVE_ANIM_MS));
  }

  // Server data caught up (or the entry vanished externally) — drop the
  // local delete state for ids the data no longer carries.
  private reconcileDeletes(): void {
    const alive = new Set(this.entries.map(e => e.id));
    for (const id of [...this.hiddenIds]) {
      if (!alive.has(id)) this.hiddenIds.delete(id);
    }
    for (const [id, timer] of [...this.deleteTimers]) {
      if (!alive.has(id)) {
        clearTimeout(timer);
        this.deleteTimers.delete(id);
      }
    }
  }

  // ─── Pending patches ────────────────────────────────────────────────────

  private commitPatch(id: string, patch: ManualEntryPatch): void {
    this.pending.set(id, { ...this.pending.get(id), ...patch });
    const old = this.pendingTimers.get(id);
    if (old) clearTimeout(old);
    this.pendingTimers.set(id, setTimeout(() => {
      this.pending.delete(id);
      this.pendingTimers.delete(id);
      this.recomputeLive();
    }, PENDING_TTL_MS));
    this.patchCommitted.emit({ id, patch });
  }

  // Drop overrides the server data now reflects (or whose entry is gone).
  private reconcilePending(): void {
    for (const [id, patch] of [...this.pending]) {
      const e = this.entries.find(x => x.id === id);
      const confirmed = !e
        || ((patch.minutes === undefined || e.minutes === patch.minutes)
          && (patch.activity === undefined || e.activity === patch.activity)
          && (patch.description === undefined || e.description === patch.description));
      if (confirmed) {
        this.pending.delete(id);
        const t = this.pendingTimers.get(id);
        if (t) clearTimeout(t);
        this.pendingTimers.delete(id);
      }
    }
  }

  // ─── Stepper (fresh row) ───────────────────────────────────────────────

  step(delta: number): void {
    if (this.freshMinutes === null) return;
    const next = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, this.freshMinutes + delta));
    if (next !== this.freshMinutes) {
      this.freshMinutes = next;
      this.recomputeLive();
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

  // Draft window over: commit the minutes diff (single PATCH, held as an
  // optimistic override) and return the row to its static form.
  private freeze(): void {
    if (this.freezeTimer) { clearTimeout(this.freezeTimer); this.freezeTimer = null; }
    if (this.freshId !== null && this.freshMinutes !== null
        && this.freshBase !== null && this.freshMinutes !== this.freshBase) {
      this.commitPatch(this.freshId, { minutes: this.freshMinutes });
    }
    this.freshId = null;
    this.freshMinutes = null;
    this.freshBase = null;
    this.recomputeLive();
  }

  // ─── Inline row edit (double-click) ────────────────────────────────────

  onRowDblClick(e: ManualEntry): void {
    if (!this.canEdit(e) || this.actionPending || this.editingId === e.id || this.isDeleted(e)) return;
    this.editingId = e.id;
    this.editMinutes = this.displayMinutes(e);
    this.editActivity = this.displayActivity(e);
    this.editDescription = this.displayDescription(e);
    // Focus once the form morph renders.
    setTimeout(() => {
      const el = this.host.nativeElement.querySelector<HTMLInputElement>('.le-min');
      el?.focus();
      el?.select();
    }, 80);
  }

  cancelEdit(): void {
    this.editingId = null;
  }

  // Description is required for everything but Development (daemon rule);
  // clearing it on a Development row is a legal explicit edit.
  get editDescNeeded(): boolean {
    return this.editingId !== null
      && this.editDescription.trim() === ''
      && this.editActivity !== DEVELOPMENT_ACTIVITY;
  }

  saveEdit(e: ManualEntry): void {
    if (this.actionPending || this.editingId !== e.id) return;
    if (this.editDescNeeded) {
      this.host.nativeElement.querySelector<HTMLInputElement>('.le-desc')?.focus();
      return;
    }
    const description = this.editDescription.trim();
    const patch: ManualEntryPatch = {};
    if (this.editMinutes !== this.displayMinutes(e)) (patch as { minutes?: number }).minutes = this.editMinutes;
    if (this.editActivity !== this.displayActivity(e)) (patch as { activity?: string }).activity = this.editActivity;
    if (description !== this.displayDescription(e)) (patch as { description?: string }).description = description;
    this.editingId = null;
    if (Object.keys(patch).length === 0) return;
    this.commitPatch(e.id, patch);
    this.recomputeLive();
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

  get activityOptions(): readonly ActivityType[] {
    return this.activityTypes.length ? this.activityTypes : [{ value: 'Other', name: 'Other' }];
  }

  trackByEntry(_i: number, e: ManualEntry): string {
    return e.id;
  }
}
