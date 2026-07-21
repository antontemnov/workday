import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ActivityType, DEVELOPMENT_ACTIVITY, Favorite, FavoriteInput, ManualEntry, ManualEntryPatch,
  SessionDetail, normalizeFavName,
} from '../../../models/workday.models';
import { activityLabel, activityOptions } from '../activity.util';
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
// Batch / instant static rows fly in once with a staggered pop.
const POP_ANIM_MS = 500;
const POP_STAGGER_MS = 80;

// One breakdown line of a merged card: a closed session at its close point,
// or a session-born manual add at its createdAt.
type GroupItem =
  | { readonly kind: 'session'; readonly session: SessionDetail; readonly at: string }
  | { readonly kind: 'manual'; readonly entry: ManualEntry; readonly at: string };

// One ticket's session history — closed sessions plus session-born manual
// adds folded into a single card, mirroring how the daemon folds both into
// one Tempo worklog at push time. Read-only header; the chronological
// breakdown (sessions and adds interleaved) expands inside the row.
interface TrackedGroup {
  readonly task: string;                      // ticket key, or '—' for taskless
  readonly totalMs: number;                   // sessions + manual adds
  readonly manualMs: number;                  // manual adds alone (band-2 note)
  readonly sessions: readonly SessionDetail[];
  readonly items: readonly GroupItem[];       // breakdown, oldest first
}

// The feed interleaves manual entries and session-born groups newest-first;
// `at` is the item's place in the day's chronology.
type FeedItem =
  | { readonly kind: 'entry'; readonly entry: ManualEntry; readonly at: string }
  | { readonly kind: 'group'; readonly group: TrackedGroup; readonly at: string };

// A suggestion accept in flight: the entry it creates (matched by the
// meeting sourceRef) is not a NEW thing — the offer row became it. So on
// first sight it slides from the offer's old spot into its place in the
// feed instead of popping in; a same-spot landing (the bottom suggestion)
// plays nothing at all.
export interface ArriveFrom {
  readonly sourceRef: string;
  readonly top: number;
}

/**
 * History feed of the day view — manual entries and session-born groups
 * interleaved newest-first, two-band rows on one shared grid. A just-logged
 * entry gets a ~4s draft window with a ±15m wheel on its time; double-click
 * swaps a row's second band for the inline edit controls. Every local change
 * (wheel ticks included) is reported to the parent as a live diff so the Day
 * total moves in the same instant; committed patches stay as optimistic
 * overrides until the daemon's data confirms them — no flicker between PATCH
 * and refresh.
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
  // Closed tracked sessions — rendered as read-only rows in the feed.
  @Input() closedSessions: readonly SessionDetail[] = [];
  // Task key → ticket summary, for the name column. Absent key → placeholder.
  @Input() issueSummaries: Readonly<Record<string, string>> = {};
  @Input() actionPending = false;
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() activityAllowed: readonly string[] = [];
  @Input() favorites: readonly Favorite[] = [];
  // Id of the entry created by the latest cloud pick — opens the draft window.
  @Input() freshEntryId: string | null = null;
  // Latest suggestion accept — its entry arrives with a slide, not a pop.
  @Input() arriveFrom: ArriveFrom | null = null;

  @Output() patchCommitted = new EventEmitter<{ id: string; patch: ManualEntryPatch }>();
  // Fired when the undo window closes — the entry is gone for the user; the
  // parent sends the actual DELETE (undo never re-creates server-side).
  @Output() deleteCommitted = new EventEmitter<string>();
  // Same contract for a closed session (id) and a whole ticket block (task).
  @Output() sessionDeleteCommitted = new EventEmitter<string>();
  @Output() taskDeleteCommitted = new EventEmitter<string>();
  @Output() favoriteAdded = new EventEmitter<FavoriteInput>();
  // Uncommitted + unconfirmed local minutes vs the server data — the parent
  // adds it to the Day total so it moves together with the feed.
  @Output() liveDiffChanged = new EventEmitter<number>();

  public constructor(private host: ElementRef<HTMLElement>) {}

  // Draft window state — one fresh row at a time.
  freshId: string | null = null;
  freshMinutes: number | null = null;
  private freshBase: number | null = null;
  private freezeTimer: ReturnType<typeof setTimeout> | null = null;

  // Inline row edit (double-click).
  editingId: string | null = null;
  editMinutes = 30;
  editActivity = '';
  editDescription = '';
  // The entry's activity at morph-open — kept in the options even when the
  // allow-list has since scoped it out, so the select can show it.
  private editPinnedActivity = '';

  // Optimistic overrides: patch sent, refresh not yet confirming it.
  private pending = new Map<string, ManualEntryPatch>();
  private pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Delete pipeline: undo window (timer) → collapse animation → hidden until
  // the server data drops the row. The live diff excludes an entry from the
  // first stage.
  private deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  removingIds = new Set<string>();
  private hiddenIds = new Set<string>();
  private removeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Same three-stage pipeline for closed sessions (keyed by session id)...
  private sesDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  sesRemovingIds = new Set<string>();
  private sesHiddenIds = new Set<string>();
  private sesRemoveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // ...and for whole ticket blocks (keyed by task): one undo per card.
  private taskDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  removingTasks = new Set<string>();
  private hiddenTasks = new Set<string>();
  private taskRemoveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // A card emptied by deleting its last breakdown line: the husk keeps the
  // feed slot while it folds shut (its rows are already committed deletes).
  private foldingCards = new Map<string, { group: TrackedGroup; at: string }>();

  // Pop pipeline: new static rows (batch / instant) fly in once, staggered.
  // The fresh draft has its own row-in and is skipped.
  private seenIds = new Set<string>();
  private firstEntriesChange = true;
  poppingIds = new Set<string>();
  popDelayMs = new Map<string, number>();
  private popTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Accepted-suggestion row mid-slide — suppresses the fresh/pop entry
  // animation (the class outlives the slide: re-enabling `animation` would
  // replay row-in from scratch).
  arrivingId: string | null = null;

  // "★ added to favorites" feedback riding the description for ~1.2s.
  favDoneId: string | null = null;
  private favDoneTimer: ReturnType<typeof setTimeout> | null = null;

  private lastEmittedDiff = 0;

  ngOnChanges(changes: SimpleChanges): void {
    // A real pick fires this while the feed is alive (firstChange false). On
    // re-creation — switching tabs back to Day — Angular replays the still-set
    // freshEntryId as a firstChange; ignore it, or the last row re-opens its
    // draft stepper every time the user returns to the Day view.
    if (changes['freshEntryId'] && !changes['freshEntryId'].firstChange
        && this.freshEntryId) {
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
      this.reconcilePending();
      this.reconcileDeletes();
      this.detectPops();
      if (this.editingId !== null && !this.entries.some(e => e.id === this.editingId)) {
        this.editingId = null; // the edited entry is gone (external change)
      }
    }
    if (changes['entries'] || changes['closedSessions']) {
      this.reconcileTrackedDeletes();
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
    for (const [id, timer] of this.sesDeleteTimers) {
      clearTimeout(timer);
      this.sessionDeleteCommitted.emit(id);
    }
    this.sesDeleteTimers.clear();
    for (const [task, timer] of this.taskDeleteTimers) {
      clearTimeout(timer);
      this.commitTaskDelete(task);
    }
    this.taskDeleteTimers.clear();
    if (this.favDoneTimer) clearTimeout(this.favDoneTimer);
    this.pendingTimers.forEach(t => clearTimeout(t));
    this.removeTimers.forEach(t => clearTimeout(t));
    this.sesRemoveTimers.forEach(t => clearTimeout(t));
    this.taskRemoveTimers.forEach(t => clearTimeout(t));
    this.popTimers.forEach(t => clearTimeout(t));
  }

  // ─── Pop-in for new static rows (batch / instant) ──────────────────────

  // Fly in genuinely-new rows once, staggered. Silently adopt on the first
  // sight and on a wholesale set swap — only incremental additions to
  // today's log pop.
  private detectPops(): void {
    const ids = this.entries.map(e => e.id);
    const curSet = new Set(ids);
    const prev = this.seenIds;
    const anyVanished = [...prev].some(id => !curSet.has(id));
    const anyNew = ids.some(id => !prev.has(id));
    const swap = this.firstEntriesChange
      || (anyVanished && anyNew && prev.size > 0);
    this.firstEntriesChange = false;
    this.seenIds = curSet;
    if (swap) { this.clearPops(); return; }

    let stagger = 0;
    for (const e of this.entries) {
      const id = e.id;
      // An accepted suggestion's entry slides from the offer's old spot —
      // checked before the fresh skip: accepts open the draft window too.
      if (!prev.has(id) && this.arriveFrom && e.sourceRef === this.arriveFrom.sourceRef) {
        this.playArrive(id, this.arriveFrom.top);
        continue;
      }
      // Existing, draft, or session-born (renders inside a group, not as a row).
      if (prev.has(id) || id === this.freshId || e.sourceSessionId) continue;
      this.poppingIds.add(id);
      this.popDelayMs.set(id, stagger);
      const total = stagger + POP_ANIM_MS;
      stagger += POP_STAGGER_MS;
      const t = setTimeout(() => {
        this.poppingIds.delete(id);
        this.popDelayMs.delete(id);
        this.popTimers.delete(id);
      }, total);
      this.popTimers.set(id, t);
    }
  }

  private clearPops(): void {
    this.popTimers.forEach(t => clearTimeout(t));
    this.popTimers.clear();
    this.poppingIds.clear();
    this.popDelayMs.clear();
    this.arrivingId = null;
  }

  // FLIP: start the row at the offer's old Y, settle into its natural spot.
  // Runs a tick later — the row isn't in the DOM until this change renders.
  private playArrive(id: string, fromTop: number): void {
    this.arrivingId = id;
    setTimeout(() => {
      const row = this.host.nativeElement.querySelector<HTMLElement>(
        `.log-row2[data-eid="${CSS.escape(id)}"]`);
      if (!row) return;
      const delta = fromTop - row.getBoundingClientRect().top;
      if (Math.abs(delta) < 8) return; // bottom suggestion: same spot, no motion
      row.style.transition = 'none';
      row.style.transform = `translateY(${delta}px)`;
      void row.offsetHeight;
      row.style.transition = 'transform 0.32s cubic-bezier(0.25, 0.9, 0.3, 1)';
      row.style.transform = '';
      setTimeout(() => { row.style.transition = ''; }, 360);
    });
  }

  // ─── Feed ──────────────────────────────────────────────────────────────

  // Standalone manual entries and per-ticket session groups in one
  // chronology, newest first: entries sit at their createdAt, a group at its
  // newest breakdown item. Session-born adds live inside their ticket's
  // group, not as rows of their own.
  get feedItems(): readonly FeedItem[] {
    const items: FeedItem[] = this.entries
      .filter(e => !this.hiddenIds.has(e.id) && !e.sourceSessionId)
      .map(e => ({ kind: 'entry' as const, entry: e, at: e.createdAt }));
    for (const group of this.trackedGroups) {
      items.push({ kind: 'group', group, at: this.groupAt(group) });
    }
    // Folding husks hold their old slot until the collapse finishes.
    for (const [task, f] of this.foldingCards) {
      if (!items.some(it => it.kind === 'group' && it.group.task === task)) {
        items.push({ kind: 'group', group: f.group, at: f.at });
      }
    }
    return items.sort((a, b) => b.at.localeCompare(a.at));
  }

  trackByFeed(_i: number, it: FeedItem): string {
    return it.kind === 'entry' ? `e:${it.entry.id}` : `g:${it.group.task}`;
  }

  private get rawSumMinutes(): number {
    return this.entries.reduce((sum, e) => sum + e.minutes, 0);
  }

  // A deleted row leaves the totals the moment the undo window opens.
  private get displayedSumMinutes(): number {
    return this.entries.reduce(
      (sum, e) => sum + (this.isGoneLocally(e.id) ? 0 : this.displayMinutes(e)), 0);
  }

  private isGoneLocally(id: string): boolean {
    return this.deleteTimers.has(id) || this.removingIds.has(id) || this.hiddenIds.has(id);
  }

  private sesGone(id: string): boolean {
    return this.sesDeleteTimers.has(id) || this.sesRemovingIds.has(id) || this.sesHiddenIds.has(id);
  }

  private taskGone(task: string): boolean {
    return this.taskDeleteTimers.has(task) || this.removingTasks.has(task) || this.hiddenTasks.has(task);
  }

  // Pending tracked deletes leave the Day total the moment their undo window
  // opens: gone sessions' observed time, plus — for a whole-card delete —
  // the card's session-born adds the entry pipeline isn't already counting.
  private get goneTrackedMinutes(): number {
    let ms = 0;
    for (const s of this.closedSessions) {
      if (this.sesGone(s.id) || this.taskGone(s.task ?? '—')) ms += s.effectiveDurationMs;
    }
    let minutes = ms / 60_000;
    for (const e of this.entries) {
      if (e.sourceSessionId && this.taskGone(e.task) && !this.isGoneLocally(e.id)) minutes += e.minutes;
    }
    return minutes;
  }

  // Keep the parent's live diff current: local overrides move the Day total
  // in the same instant; confirming refreshes settle the diff back to 0.
  private recomputeLive(): void {
    const diff = this.displayedSumMinutes - this.rawSumMinutes - this.goneTrackedMinutes;
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
    return e.id === this.freshId && this.freshMinutes !== null;
  }

  canEdit(e: ManualEntry): boolean {
    return !e.sourceSessionId && !this.isFresh(e);
  }

  // Session-born entries can't be edited, but deleting them is legal.
  canDelete(e: ManualEntry): boolean {
    return !this.isFresh(e);
  }

  // ─── Context menu (right-click) ─────────────────────────────────────────

  onRowContextMenu(e: ManualEntry, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.editingId === e.id || this.isFresh(e) || this.isDeleted(e)) return;
    const items = [
      ...(this.canEdit(e) ? [{ icon: '✎', label: 'Edit', action: () => this.onRowDblClick(e) }] : []),
      // Hidden only when structurally impossible (no description to name the
      // template); an exact duplicate shows as a disabled fact instead.
      ...(this.canFavorite(e)
        ? [this.isInFavorites(e)
          ? { icon: '★', label: 'In favorites', disabled: true,
              title: 'This exact task + description + duration is already saved', action: (): void => {} }
          : { icon: '★', label: 'Add to favorites', action: () => this.addToFavorites(e) }]
        : []),
      ...(this.canDelete(e)
        ? [{ icon: '✕', label: 'Delete', danger: true, action: () => this.deleteEntry(e) }] : []),
    ];
    openCtxMenu(ev.clientX, ev.clientY, items);
  }

  // A favorite is task + name (description) — no description, nothing to save.
  private canFavorite(e: ManualEntry): boolean {
    return this.canEdit(e) && this.displayDescription(e).trim() !== '';
  }

  // Template identity mirrors the daemon: task + name (case/whitespace-
  // insensitive) + minutes. A changed duration is a new template again.
  private isInFavorites(e: ManualEntry): boolean {
    const name = normalizeFavName(this.displayDescription(e));
    const minutes = this.displayMinutes(e);
    return this.favorites.some(f =>
      f.task.toLowerCase() === e.task.toLowerCase()
      && normalizeFavName(f.name) === name
      && f.minutes === minutes);
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

  // Delete of a session-born add lives in its breakdown line's ⊕ node —
  // same undo pipeline as the standalone rows.
  deleteManualEntry(e: ManualEntry, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.isDeleted(e)) return;
    this.deleteEntry(e);
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
      const e = this.entries.find(x => x.id === id);
      if (e?.sourceSessionId) this.maybeFoldEmptiedCard(e.task);
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

  // Same catch-up for the session and card pipelines: a session id gone from
  // the data (our DELETE landed, or an external change) drops its local
  // state; a task with no closed session and no session-born add left is a
  // finished card delete.
  private reconcileTrackedDeletes(): void {
    const aliveSes = new Set(this.closedSessions.map(s => s.id));
    for (const id of [...this.sesHiddenIds]) {
      if (!aliveSes.has(id)) this.sesHiddenIds.delete(id);
    }
    for (const [id, timer] of [...this.sesDeleteTimers]) {
      if (!aliveSes.has(id)) {
        clearTimeout(timer);
        this.sesDeleteTimers.delete(id);
      }
    }

    const aliveTasks = new Set<string>();
    for (const s of this.closedSessions) aliveTasks.add(s.task ?? '—');
    for (const e of this.entries) {
      if (e.sourceSessionId) aliveTasks.add(e.task);
    }
    for (const task of [...this.hiddenTasks]) {
      if (!aliveTasks.has(task)) this.hiddenTasks.delete(task);
    }
    for (const [task, timer] of [...this.taskDeleteTimers]) {
      if (!aliveTasks.has(task)) {
        clearTimeout(timer);
        this.taskDeleteTimers.delete(task);
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

  // Wheel on the fresh row's time — the only rows whose time spins outside
  // edit. Non-fresh rows keep the wheel for the feed's scroll.
  onFreshWheel(e: ManualEntry, ev: WheelEvent): void {
    if (!this.isFresh(e)) return;
    ev.preventDefault();
    this.step(ev.deltaY < 0 ? STEP_MINUTES : -STEP_MINUTES);
  }

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
    this.editPinnedActivity = this.editActivity;
    this.editDescription = this.displayDescription(e);
    // Focus the description once the form morph renders — no select() on the
    // frameless time (the highlight box reads as a glitch there); the time
    // edits by wheel or an explicit click into it.
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLInputElement>('.le-desc')?.focus();
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

  // ─── Ticket name ────────────────────────────────────────────────────────

  summaryOf(e: ManualEntry): string {
    return this.issueSummaries[e.task] ?? '';
  }

  // ─── Session groups (closed sessions + session-born adds) ───────────────
  // One card per ticket, summed — mirrors how the daemon folds sessions and
  // their "+ Add time" entries into a single Tempo worklog. A ticket with
  // only a manual add still gets its card; closed sessions join it later.
  // Header is read-only; dblclick / context menu toggles the breakdown, where
  // a manual add's ⊕ node morphs into its delete on hover.

  // Task keys whose breakdown is open. Survives refreshes within the instance;
  // resets on tab switch (feed re-creation) — that matches a "peek" gesture.
  expandedTasks = new Set<string>();

  get trackedGroups(): readonly TrackedGroup[] {
    const byTask = new Map<string, { sessions: SessionDetail[]; manual: ManualEntry[] }>();
    const bucketOf = (task: string): { sessions: SessionDetail[]; manual: ManualEntry[] } => {
      let b = byTask.get(task);
      if (!b) { b = { sessions: [], manual: [] }; byTask.set(task, b); }
      return b;
    };
    for (const s of this.closedSessions) {
      const task = s.task ?? '—';
      if (this.hiddenTasks.has(task) || this.sesHiddenIds.has(s.id)) continue;
      bucketOf(task).sessions.push(s);
    }
    for (const e of this.entries) {
      if (!e.sourceSessionId || this.hiddenIds.has(e.id) || this.hiddenTasks.has(e.task)) continue;
      bucketOf(e.task).manual.push(e);
    }
    const groups: TrackedGroup[] = [];
    for (const [task, b] of byTask) {
      // Breakdown chronology: a session sits at its close point (last
      // activity), a manual add at the moment it was added.
      const items: GroupItem[] = [
        ...b.sessions.map(s => ({ kind: 'session' as const, session: s, at: s.lastSeenAt })),
        ...b.manual.map(e => ({ kind: 'manual' as const, entry: e, at: e.createdAt })),
      ].sort((x, y) => x.at.localeCompare(y.at));
      const manualMs = b.manual.reduce(
        (sum, e) => sum + (this.isGoneLocally(e.id) ? 0 : e.minutes), 0) * 60_000;
      b.sessions.sort((x, y) => x.startedAt.localeCompare(y.startedAt));
      groups.push({
        task,
        totalMs: b.sessions.reduce(
          (sum, s) => sum + (this.sesGone(s.id) ? 0 : s.effectiveDurationMs), 0) + manualMs,
        manualMs,
        sessions: b.sessions,
        items,
      });
    }
    return groups;
  }

  // The group's place in the feed chronology: its newest breakdown item.
  private groupAt(g: TrackedGroup): string {
    return g.items[g.items.length - 1].at;
  }

  trackByGroupItem(_i: number, bi: GroupItem): string {
    return bi.kind === 'session' ? `s:${bi.session.id}` : `m:${bi.entry.id}`;
  }

  isExpanded(g: TrackedGroup): boolean {
    return this.expandedTasks.has(g.task);
  }

  toggleTracked(g: TrackedGroup): void {
    if (this.expandedTasks.has(g.task)) this.expandedTasks.delete(g.task);
    else this.expandedTasks.add(g.task);
  }

  onTrackedContextMenu(g: TrackedGroup, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.taskDeleted(g) || this.foldingCards.has(g.task)) return;
    openCtxMenu(ev.clientX, ev.clientY, [
      {
        icon: '⤢',
        label: this.isExpanded(g) ? 'Hide details' : 'Show details',
        action: () => this.toggleTracked(g),
      },
      { icon: '✕', label: 'Delete', danger: true, action: () => this.deleteTaskCard(g) },
    ]);
  }

  // ─── Tracked deletes (session row ✕ / whole card) — entry-row undo twin ──

  sessionDeleted(s: SessionDetail): boolean {
    return this.sesDeleteTimers.has(s.id) || this.sesRemovingIds.has(s.id);
  }

  deleteSessionRow(s: SessionDetail, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.sessionDeleted(s)) return;
    this.sesDeleteTimers.set(s.id, setTimeout(() => this.startSessionRemove(s.id), UNDO_WINDOW_MS));
    this.recomputeLive();
  }

  undoSessionDelete(s: SessionDetail, ev: MouseEvent): void {
    ev.stopPropagation();
    const timer = this.sesDeleteTimers.get(s.id);
    if (!timer) return;
    clearTimeout(timer);
    this.sesDeleteTimers.delete(s.id);
    this.recomputeLive();
  }

  private startSessionRemove(id: string): void {
    this.sesDeleteTimers.delete(id);
    this.sesRemovingIds.add(id);
    this.sesRemoveTimers.set(id, setTimeout(() => {
      this.sesRemovingIds.delete(id);
      this.sesRemoveTimers.delete(id);
      this.sesHiddenIds.add(id);
      this.sessionDeleteCommitted.emit(id);
      const s = this.closedSessions.find(x => x.id === id);
      if (s) this.maybeFoldEmptiedCard(s.task ?? '—');
    }, REMOVE_ANIM_MS));
  }

  taskDeleted(g: TrackedGroup): boolean {
    return this.taskDeleteTimers.has(g.task) || this.removingTasks.has(g.task);
  }

  private deleteTaskCard(g: TrackedGroup): void {
    if (this.taskDeleted(g)) return;
    this.taskDeleteTimers.set(g.task, setTimeout(() => this.startTaskRemove(g.task), UNDO_WINDOW_MS));
    this.recomputeLive();
  }

  undoTaskDelete(g: TrackedGroup, ev: MouseEvent): void {
    ev.stopPropagation();
    const timer = this.taskDeleteTimers.get(g.task);
    if (!timer) return;
    clearTimeout(timer);
    this.taskDeleteTimers.delete(g.task);
    this.recomputeLive();
  }

  private startTaskRemove(task: string): void {
    this.taskDeleteTimers.delete(task);
    this.removingTasks.add(task);
    this.taskRemoveTimers.set(task, setTimeout(() => {
      this.removingTasks.delete(task);
      this.taskRemoveTimers.delete(task);
      this.hiddenTasks.add(task);
      this.commitTaskDelete(task);
    }, REMOVE_ANIM_MS));
  }

  // Deleting the last breakdown line leaves an empty card: it follows its
  // content out — after the row's own collapse the husk folds shut, exactly
  // like a ctx-menu card delete (the rows' deletes are already committed,
  // so the fold is purely visual).
  private maybeFoldEmptiedCard(task: string): void {
    if (this.foldingCards.has(task) || this.taskGone(task)) return;
    const hasSession = this.closedSessions.some(s => (s.task ?? '—') === task && !this.sesHiddenIds.has(s.id));
    const hasAdd = this.entries.some(e => !!e.sourceSessionId && e.task === task && !this.hiddenIds.has(e.id));
    if (hasSession || hasAdd) return;

    // The husk keeps the group's old feed slot (newest raw row of the task —
    // hidden rows included, they ARE the slot).
    const ats = [
      ...this.closedSessions.filter(s => (s.task ?? '—') === task).map(s => s.lastSeenAt),
      ...this.entries.filter(e => !!e.sourceSessionId && e.task === task).map(e => e.createdAt),
    ].sort();
    this.foldingCards.set(task, {
      group: { task, totalMs: 0, manualMs: 0, sessions: [], items: [] },
      at: ats[ats.length - 1] ?? '',
    });

    // Measured inline fold: trackBy keeps the DOM element, so the collapse
    // starts from its real height (a fixed CSS cap would eat the animation).
    const el = this.cardEl(task);
    if (el) {
      el.style.overflow = 'hidden';
      el.style.maxHeight = `${el.offsetHeight}px`;
      void el.offsetHeight;
      el.style.transition = 'max-height 0.22s ease, opacity 0.18s ease, padding 0.22s ease, margin 0.22s ease';
      el.style.maxHeight = '0';
      el.style.opacity = '0';
      el.style.paddingTop = '0';
      el.style.paddingBottom = '0';
      el.style.marginBottom = '0';
    }
    this.taskRemoveTimers.set(task, setTimeout(() => {
      this.taskRemoveTimers.delete(task);
      this.foldingCards.delete(task);
      this.cardEl(task)?.removeAttribute('style'); // insurance for a reused element
    }, REMOVE_ANIM_MS));
  }

  private cardEl(task: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(
      `.log-row2.ses[data-task="${CSS.escape(task)}"]`);
  }

  // The taskless card has no ticket key to address on the daemon — its
  // delete is the sum of its sessions' deletes (it can't carry manual adds:
  // "+ Add time" requires a task).
  private commitTaskDelete(task: string): void {
    if (task !== '—') {
      this.taskDeleteCommitted.emit(task);
      return;
    }
    for (const s of this.closedSessions) {
      if ((s.task ?? '—') === '—') this.sessionDeleteCommitted.emit(s.id);
    }
  }

  sessionInterval(s: SessionDetail): string {
    return `${this.formatHm(s.startedAt)}–${this.formatHm(s.lastSeenAt)}`;
  }

  formatHm(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  summaryOfTask(task: string): string {
    return this.issueSummaries[task] ?? '';
  }

  sessionsLabel(g: TrackedGroup): string {
    const n = g.sessions.length;
    return `${n} session${n === 1 ? '' : 's'}`;
  }

  // Day span of the group's tracking: first session start – last activity seen.
  trackedRange(g: TrackedGroup): string {
    const first = g.sessions[0];
    const lastSeen = g.sessions.reduce(
      (max, s) => s.lastSeenAt > max ? s.lastSeenAt : max, first.lastSeenAt);
    return `${this.formatHm(first.startedAt)}–${this.formatHm(lastSeen)}`;
  }

  // Tracked time is always Development — that's how it pushes to Tempo.
  readonly developmentActivity = DEVELOPMENT_ACTIVITY;

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

  get activityOptions(): readonly ActivityType[] {
    return activityOptions(this.activityTypes, this.activityAllowed, this.editPinnedActivity);
  }
}
