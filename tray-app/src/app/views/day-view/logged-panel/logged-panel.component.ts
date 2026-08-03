import { ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { GLOBE_ICON, JiraLinkService, canBrowseTicket } from '../jira-link.util';
import {
  ActivityType, DEVELOPMENT_ACTIVITY, Favorite, FavoriteInput, ManualEntry, ManualEntryPatch,
  SessionDetail, normalizeFavName,
} from '../../../models/workday.models';
import { activityLabel, activityOptions } from '../activity.util';
import { DurationInputDirective } from '../duration-field/duration-input.directive';
import { openCtxMenu } from '../ctx-menu.util';
import { FEED_SORT_DEFAULT, FeedSortMode } from '../feed-sort.util';

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
// Re-sorts run as a FLIP flight, never a teleport. The flight starts a beat
// AFTER the row change that caused it (its collapse/pop reads first), the
// biggest rank jumper lifts off the glass for the trip.
const REORDER_DELAY_MS = 260;
const REORDER_FLIGHT_MS = 440;

// One ticket's day — the identity printed once over the worklog rows it
// carries. Rows: observed Development (sessions + breakdown), the single
// folded "manual added" row, then each described entry. All sums are
// DISPLAY sums: a row in its undo window has already left them.
interface TicketBlock {
  readonly task: string;                        // ticket key, or '—' for taskless
  readonly at: string;                          // newest fact — feed position
  readonly sessions: readonly SessionDetail[];  // closed, oldest first
  readonly folded: readonly ManualEntry[];      // unnamed adds behind one row
  readonly named: readonly ManualEntry[];       // described entries, oldest first
  readonly rowCount: number;
  readonly totalMs: number;                     // header Σ
  readonly trkMs: number;                       // observed row share
  readonly foldedMinutes: number;               // manual added row share
}

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
 * History feed of the day view — ticket blocks newest-first: one identity
 * header (the lid) per ticket, worklog rows inside. Observed time is the top
 * row with its session breakdown; unnamed manual time folds into a single
 * "⊕ manual added" row; described entries keep their own rows with the
 * usual edit/delete/favorite mechanics. Every local change is reported to
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
  // Card order — a display preference owned by the day view (window menu).
  @Input() feedSort: FeedSortMode = FEED_SORT_DEFAULT;
  // Jira site root — null (older daemon / no secrets) hides Open in browser.
  @Input() jiraBaseUrl: string | null = null;

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

  public constructor(private host: ElementRef<HTMLElement>, private cdr: ChangeDetectorRef, private jiraLink: JiraLinkService) {}

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
  // ...and for whole ticket blocks (keyed by task): one undo per block.
  private taskDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  removingTasks = new Set<string>();
  private hiddenTasks = new Set<string>();
  private taskRemoveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Blocks mid whole-card fold: deleting the block's last content collapses
  // the card in ONE motion (the ctx-menu delete's collapse) — the row's own
  // collapse is suppressed and the commits ride the fold's timer.
  foldingTasks = new Set<string>();
  private foldPending = new Map<string, (() => void)[]>();

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

  // The card order actually shown. When the target order drifts away from it
  // (a new fact bubbles a card, a delete drops one back, the sort mode
  // changes), the cards FLY to their new spots instead of teleporting.
  private displayOrder: string[] = [];
  private reorderTimer: ReturnType<typeof setTimeout> | null = null;
  private flipCleanTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

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
    // A sort-mode switch is a direct action — fly now, no row beat to wait
    // for. A tick later: the flight measures rendered cards.
    if (changes['feedSort'] && !changes['feedSort'].firstChange) {
      setTimeout(() => this.playReorder(false));
    }
  }

  ngOnDestroy(): void {
    this.freeze(); // don't lose a pending stepper diff on teardown
    // Deletes past their undo click are the user's intent — commit them now
    // instead of silently resurrecting the rows on the next visit. Committed
    // ids go hidden so the block commits below can't re-emit them.
    for (const [id, timer] of this.deleteTimers) {
      clearTimeout(timer);
      this.hiddenIds.add(id);
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
    if (this.reorderTimer !== null) clearTimeout(this.reorderTimer);
    this.pendingTimers.forEach(t => clearTimeout(t));
    this.removeTimers.forEach(t => clearTimeout(t));
    this.sesRemoveTimers.forEach(t => clearTimeout(t));
    this.taskRemoveTimers.forEach(t => clearTimeout(t));
    this.popTimers.forEach(t => clearTimeout(t));
    // Mid-fold commits must not be lost with their timer.
    for (const commits of this.foldPending.values()) {
      for (const c of commits) c();
    }
    this.foldPending.clear();
    this.foldingTasks.clear();
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
      // Existing, draft, or foldable (merges into the manual added row).
      if (prev.has(id) || id === this.freshId || this.isFoldable(e)) continue;
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
        `.wl[data-eid="${CSS.escape(id)}"]`);
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

  // ─── Feed — ticket blocks, newest first ────────────────────────────────

  // Every fact of the day lives in its ticket's block. Cards render in
  // displayOrder, not the target order: born cards insert straight at their
  // spot, vanished cards drop out in place, but a SURVIVOR whose rank changed
  // keeps its old position here — the deferred FLIP flight moves it.
  get feedBlocks(): readonly TicketBlock[] {
    const blocks = this.buildBlocks();
    const target = this.sortTasks(blocks);
    const present = new Set(target);
    const rank = new Map(target.map((t, i) => [t, i]));
    const merged = this.displayOrder.filter(t => present.has(t));
    for (const t of target) {
      if (merged.includes(t)) continue;
      const r = rank.get(t) ?? 0;
      let idx = merged.findIndex(k => (rank.get(k) ?? Infinity) > r);
      if (idx < 0) idx = merged.length;
      merged.splice(idx, 0, t);
    }
    this.displayOrder = merged;
    if (merged.some((t, i) => t !== target[i])) this.scheduleReorder();
    const index = new Map(merged.map((t, i) => [t, i]));
    return blocks.sort((a, b) => (index.get(a.task) ?? 0) - (index.get(b.task) ?? 0));
  }

  // The target order by the active mode. Recency: the block stands on its
  // newest fact. Sum: biggest day total first, recency breaks ties.
  private sortTasks(blocks: readonly TicketBlock[]): string[] {
    return [...blocks]
      .sort((a, b) => this.feedSort === 'sum'
        ? (b.totalMs - a.totalMs || b.at.localeCompare(a.at))
        : b.at.localeCompare(a.at))
      .map(b => b.task);
  }

  // ─── FLIP re-sort — cards fly to their new spots, never teleport ───────

  private scheduleReorder(): void {
    if (this.reorderTimer !== null) return;
    this.reorderTimer = setTimeout(() => {
      this.reorderTimer = null;
      this.playReorder(true);
    }, REORDER_DELAY_MS);
  }

  // Measure standing cards → apply the target order → translate each
  // survivor from its old spot and release. The biggest rank jumper is the
  // traveler: it lifts off the glass for the flight (a mode switch moves
  // everyone — no single card to spotlight). Mid-fold cards are left alone;
  // their collapse owns the element's inline styles.
  private playReorder(withTraveler: boolean): void {
    const target = this.sortTasks(this.buildBlocks());
    if (this.displayOrder.length === target.length
        && this.displayOrder.every((t, i) => t === target[i])) return;
    const before = new Map<string, number>();
    for (const c of this.host.nativeElement.querySelectorAll<HTMLElement>('.blk')) {
      before.set(c.dataset['task'] ?? '', c.getBoundingClientRect().top);
    }
    const oldRank = new Map(this.displayOrder.map((t, i) => [t, i]));
    let traveler = '';
    let travelerJump = 0;
    if (withTraveler) {
      target.forEach((t, i) => {
        const jump = Math.abs((oldRank.get(t) ?? i) - i);
        if (jump > travelerJump) { travelerJump = jump; traveler = t; }
      });
    }
    this.displayOrder = [...target];
    this.cdr.detectChanges();
    const moved: HTMLElement[] = [];
    for (const c of this.host.nativeElement.querySelectorAll<HTMLElement>('.blk')) {
      const task = c.dataset['task'] ?? '';
      const was = before.get(task);
      if (was === undefined) continue;
      if (this.removingTasks.has(task) || this.foldingTasks.has(task)) continue;
      const delta = was - c.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      const stale = this.flipCleanTimers.get(c);
      if (stale !== undefined) clearTimeout(stale);
      c.style.transition = 'none';
      c.style.transform = `translateY(${delta}px)`;
      c.classList.toggle('traveler', task === traveler);
      moved.push(c);
    }
    if (moved.length === 0) return;
    void this.host.nativeElement.offsetHeight; // reflow pins the start positions
    for (const c of moved) {
      c.style.transition = `transform ${REORDER_FLIGHT_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
      c.style.transform = '';
      this.flipCleanTimers.set(c, setTimeout(() => {
        c.style.transition = '';
        c.classList.remove('traveler');
      }, REORDER_FLIGHT_MS + 140));
    }
  }

  private buildBlocks(): TicketBlock[] {
    const byTask = new Map<string, { sessions: SessionDetail[]; folded: ManualEntry[]; named: ManualEntry[] }>();
    const bucketOf = (task: string): { sessions: SessionDetail[]; folded: ManualEntry[]; named: ManualEntry[] } => {
      let b = byTask.get(task);
      if (!b) { b = { sessions: [], folded: [], named: [] }; byTask.set(task, b); }
      return b;
    };
    for (const s of this.closedSessions) {
      const task = s.task ?? '—';
      if (this.hiddenTasks.has(task) || this.sesHiddenIds.has(s.id)) continue;
      bucketOf(task).sessions.push(s);
    }
    for (const e of this.entries) {
      if (this.hiddenIds.has(e.id) || this.hiddenTasks.has(e.task)) continue;
      const b = bucketOf(e.task);
      if (this.isFoldable(e)) b.folded.push(e);
      else b.named.push(e);
    }
    const blocks: TicketBlock[] = [];
    for (const [task, b] of byTask) {
      b.sessions.sort((x, y) => x.startedAt.localeCompare(y.startedAt));
      b.named.sort((x, y) => x.createdAt.localeCompare(y.createdAt));
      const trkMs = b.sessions.reduce(
        (sum, s) => sum + (this.sesGone(s.id) ? 0 : s.effectiveDurationMs), 0);
      const foldedMinutes = b.folded.reduce(
        (sum, e) => sum + (this.isGoneLocally(e.id) ? 0 : this.displayMinutes(e)), 0);
      const namedMinutes = b.named.reduce(
        (sum, e) => sum + (this.isGoneLocally(e.id) ? 0 : this.displayMinutes(e)), 0);
      const at = [
        ...b.sessions.map(s => s.lastSeenAt),
        ...b.folded.map(e => e.createdAt),
        ...b.named.map(e => e.createdAt),
      ].sort().pop() ?? '';
      blocks.push({
        task,
        at,
        sessions: b.sessions,
        folded: b.folded,
        named: b.named,
        rowCount: (b.sessions.length > 0 ? 1 : 0) + (b.folded.length > 0 ? 1 : 0) + b.named.length,
        totalMs: trkMs + (foldedMinutes + namedMinutes) * 60_000,
        trkMs,
        foldedMinutes,
      });
    }
    return blocks;
  }

  // The fold: unnamed manual time is one fact per ticket regardless of how
  // many times it was poured in (＋Add time on the card, a bare Development
  // pick in LOG). The evidence — or its absence — is the row's identity, so
  // an entry with nothing to say joins the aggregate.
  private isFoldable(e: ManualEntry): boolean {
    return !!e.sourceSessionId
      || (this.displayActivity(e) === DEVELOPMENT_ACTIVITY && this.displayDescription(e).trim() === '');
  }

  trackByBlock(_i: number, b: TicketBlock): string {
    return `t:${b.task}`;
  }

  trackByEntry(_i: number, e: ManualEntry): string {
    return e.id;
  }

  trackBySession(_i: number, s: SessionDetail): string {
    return s.id;
  }

  // Σ is a sum only when there are parts: a one-row block keeps its number
  // in the header alone, the row's time slot stays empty.
  blockSum(b: TicketBlock): string {
    return b.totalMs > 0 ? this.formatDurationHm(b.totalMs) : '';
  }

  trkDur(b: TicketBlock): string {
    return b.rowCount >= 2 && b.trkMs > 0 ? this.formatDurationHm(b.trkMs) : '';
  }

  // Transient states (draft wheel, edit input, undo) always own the slot —
  // the ≥2-rows rule only mutes the static print.
  showEntryDur(b: TicketBlock, e: ManualEntry): boolean {
    return b.rowCount >= 2 || this.isFresh(e) || this.editingId === e.id;
  }

  showFoldedDur(b: TicketBlock): boolean {
    return b.rowCount >= 2 || this.foldedHasFresh(b);
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
  // opens: gone sessions' observed time, plus — for a whole-block delete —
  // every entry of the block the entry pipeline isn't already counting.
  private get goneTrackedMinutes(): number {
    let ms = 0;
    for (const s of this.closedSessions) {
      if (this.sesGone(s.id) || this.taskGone(s.task ?? '—')) ms += s.effectiveDurationMs;
    }
    let minutes = ms / 60_000;
    for (const e of this.entries) {
      if (this.taskGone(e.task) && !this.isGoneLocally(e.id)) minutes += e.minutes;
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

  canDelete(e: ManualEntry): boolean {
    return !this.isFresh(e);
  }

  // ─── Context menu (right-click) ─────────────────────────────────────────

  onRowContextMenu(e: ManualEntry, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.editingId === e.id || this.isFresh(e) || this.isDeleted(e)
        || this.taskDeleted(e.task)) return;
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
    // The block's last row: this IS the card's delete — same struck state,
    // same header undo, same whole-card collapse.
    if (!this.blockHasOtherContent(e)) {
      this.deleteTaskCard(e.task);
      return;
    }
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

  // The manual added row folds several unnamed entries behind one glyph —
  // its ⊕ IS the delete, and the whole aggregate burns on one undo window.
  foldedDeleted(b: TicketBlock): boolean {
    return b.folded.length > 0 && b.folded.every(e => this.isDeleted(e));
  }

  foldedRemoving(b: TicketBlock): boolean {
    return b.folded.length > 0 && b.folded.every(e => this.removingIds.has(e.id));
  }

  deleteFolded(b: TicketBlock, ev: MouseEvent): void {
    ev.stopPropagation();
    const alive = b.folded.filter(e => !this.isDeleted(e));
    if (alive.length === 0) return;
    // The folded row as the block's last content — the card's delete.
    if (!this.blockHasOtherContent(alive[0])) {
      this.deleteTaskCard(b.task);
      return;
    }
    for (const e of alive) this.deleteEntry(e);
  }

  undoFolded(b: TicketBlock, ev: MouseEvent): void {
    ev.stopPropagation();
    for (const e of b.folded) this.undoDelete(e, ev);
  }

  // Undo window over: collapse the row, then send the DELETE. Undo past this
  // point doesn't exist — the design keeps it purely client-side. The block's
  // LAST content doesn't collapse as a row — the whole card folds with it.
  private startRemove(id: string): void {
    this.deleteTimers.delete(id);
    this.removingIds.add(id);
    const commit = (): void => {
      this.removingIds.delete(id);
      this.removeTimers.delete(id);
      this.hiddenIds.add(id);
      this.deleteCommitted.emit(id);
    };
    const e = this.entries.find(x => x.id === id);
    if (e && !this.blockHasOtherContent(e)) {
      this.foldCardThen(e.task, commit);
      return;
    }
    this.removeTimers.set(id, setTimeout(commit, REMOVE_ANIM_MS));
  }

  // Anything else still occupying a row of the entry's block? Burning rows
  // (undo still offered) count — the card must not fold under an undo.
  // Another foldable entry shares THIS entry's row, so it doesn't hold the
  // card open on its own.
  private blockHasOtherContent(entry: ManualEntry): boolean {
    const hasOtherEntry = this.entries.some(e =>
      e.task === entry.task && e.id !== entry.id
      && !this.hiddenIds.has(e.id) && !this.removingIds.has(e.id)
      && !(this.isFoldable(e) && this.isFoldable(entry)));
    const hasSession = this.closedSessions.some(s =>
      (s.task ?? '—') === entry.task
      && !this.sesHiddenIds.has(s.id) && !this.sesRemovingIds.has(s.id));
    return hasOtherEntry || hasSession;
  }

  // One motion for the block's last content: the exact ctx-menu delete
  // collapse; every commit that emptied the block rides the same timer.
  private foldCardThen(task: string, commit: () => void): void {
    const pending = this.foldPending.get(task);
    if (pending) { pending.push(commit); return; }
    this.foldPending.set(task, [commit]);
    this.foldingTasks.add(task);
    this.collapseCardEl(task);
    this.taskRemoveTimers.set(task, setTimeout(() => {
      this.taskRemoveTimers.delete(task);
      for (const c of this.foldPending.get(task) ?? []) c();
      this.foldPending.delete(task);
      this.foldingTasks.delete(task);
      this.cardEl(task)?.removeAttribute('style'); // insurance for a reused element
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

  // Same catch-up for the session and block pipelines: a session id gone from
  // the data (our DELETE landed, or an external change) drops its local
  // state; a task with no session and no entry left is a finished block
  // delete.
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
    for (const e of this.entries) aliveTasks.add(e.task);
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

  // The manual added row carries the draft wheel when the fresh entry
  // folded into it — the aggregate's number spins, the diff is the fresh
  // entry's own minutes.
  foldedHasFresh(b: TicketBlock): boolean {
    return this.freshMinutes !== null && b.folded.some(e => e.id === this.freshId);
  }

  onFoldedWheel(b: TicketBlock, ev: WheelEvent): void {
    if (!this.foldedHasFresh(b)) return;
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
    if (!this.canEdit(e) || this.actionPending || this.editingId === e.id
        || this.isDeleted(e) || this.taskDeleted(e.task)) return;
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

  // ─── Observed row (sessions + breakdown) ────────────────────────────────

  // Task keys whose breakdown is open. Survives refreshes within the instance;
  // resets on tab switch (feed re-creation) — that matches a "peek" gesture.
  expandedTasks = new Set<string>();

  isExpandedTask(task: string): boolean {
    return this.expandedTasks.has(task);
  }

  toggleTracked(task: string): void {
    if (this.expandedTasks.has(task)) this.expandedTasks.delete(task);
    else this.expandedTasks.add(task);
  }

  // The trunk's length: one 18px line per breakdown row still standing.
  brkCount(b: TicketBlock): number {
    return b.sessions.filter(s => !this.sesRemovingIds.has(s.id)).length;
  }

  // The card's menu — answered by the block's own surfaces (lid, observed
  // row, manual added row); described entries keep their entry menu. Delete
  // takes the whole card, exactly like the old tracked card did.
  onBlockContextMenu(b: TicketBlock, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.taskDeleted(b.task) || this.foldingTasks.has(b.task)) return;
    openCtxMenu(ev.clientX, ev.clientY, [
      ...(b.sessions.length > 0
        ? [{
            icon: '⤢',
            label: this.isExpandedTask(b.task) ? 'Hide details' : 'Show details',
            action: () => this.toggleTracked(b.task),
          }]
        : []),
      ...(canBrowseTicket(this.jiraBaseUrl, b.task)
        ? [{ icon: GLOBE_ICON, label: 'Open in browser', action: (): void => this.jiraLink.openTicket(this.jiraBaseUrl, b.task) }]
        : []),
      { icon: '✕', label: 'Delete', danger: true, action: () => this.deleteTaskCard(b.task) },
    ]);
  }

  // ─── Tracked deletes (session line ✕ / whole block) — entry-row undo twin ─

  sessionDeleted(s: SessionDetail): boolean {
    return this.sesDeleteTimers.has(s.id) || this.sesRemovingIds.has(s.id);
  }

  deleteSessionRow(s: SessionDetail, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.sessionDeleted(s)) return;
    // The last line of the block's last row — the card's delete.
    if (!this.blockHasOtherSessionContent(s)) {
      this.deleteTaskCard(s.task ?? '—');
      return;
    }
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
    const commit = (): void => {
      this.sesRemovingIds.delete(id);
      this.sesRemoveTimers.delete(id);
      this.sesHiddenIds.add(id);
      this.sessionDeleteCommitted.emit(id);
    };
    const s = this.closedSessions.find(x => x.id === id);
    if (s && !this.blockHasOtherSessionContent(s)) {
      this.foldCardThen(s.task ?? '—', commit);
      return;
    }
    this.sesRemoveTimers.set(id, setTimeout(commit, REMOVE_ANIM_MS));
  }

  private blockHasOtherSessionContent(session: SessionDetail): boolean {
    const task = session.task ?? '—';
    const hasEntry = this.entries.some(e =>
      e.task === task && !this.hiddenIds.has(e.id) && !this.removingIds.has(e.id));
    const hasOtherSession = this.closedSessions.some(s =>
      s.id !== session.id && (s.task ?? '—') === task
      && !this.sesHiddenIds.has(s.id) && !this.sesRemovingIds.has(s.id));
    return hasEntry || hasOtherSession;
  }

  taskDeleted(task: string): boolean {
    return this.taskDeleteTimers.has(task) || this.removingTasks.has(task);
  }

  private deleteTaskCard(task: string): void {
    if (this.taskDeleted(task)) return;
    this.taskDeleteTimers.set(task, setTimeout(() => this.startTaskRemove(task), UNDO_WINDOW_MS));
    this.recomputeLive();
  }

  undoTaskDelete(task: string, ev: MouseEvent): void {
    ev.stopPropagation();
    const timer = this.taskDeleteTimers.get(task);
    if (!timer) return;
    clearTimeout(timer);
    this.taskDeleteTimers.delete(task);
    this.recomputeLive();
  }

  private startTaskRemove(task: string): void {
    this.taskDeleteTimers.delete(task);
    this.removingTasks.add(task);
    // Blocks have no fixed height cap — measure and fold inline.
    this.collapseCardEl(task);
    this.taskRemoveTimers.set(task, setTimeout(() => {
      this.removingTasks.delete(task);
      this.taskRemoveTimers.delete(task);
      this.hiddenTasks.add(task);
      this.cardEl(task)?.removeAttribute('style');
      this.commitTaskDelete(task);
    }, REMOVE_ANIM_MS));
  }

  // Measured inline fold: trackBy keeps the DOM element, so the collapse
  // starts from its real height (a fixed CSS cap would eat the animation).
  private collapseCardEl(task: string): void {
    const el = this.cardEl(task);
    if (!el) return;
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

  private cardEl(task: string): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(
      `.blk[data-task="${CSS.escape(task)}"]`);
  }

  // Deleting the block takes every row with it: the daemon's task-delete
  // clears sessions and session-born adds; the block's standalone entries
  // go with the card by their own DELETEs. The taskless block has no ticket
  // key to address — its delete is the sum of its sessions' deletes.
  private commitTaskDelete(task: string): void {
    if (task === '—') {
      for (const s of this.closedSessions) {
        if ((s.task ?? '—') === '—') this.sessionDeleteCommitted.emit(s.id);
      }
    } else {
      // The daemon's task-delete addresses tracked material; a block of
      // standalone entries alone has nothing there to delete.
      const hasTracked = this.closedSessions.some(s => (s.task ?? '—') === task)
        || this.entries.some(e => e.task === task && !!e.sourceSessionId);
      if (hasTracked) this.taskDeleteCommitted.emit(task);
    }
    for (const e of this.entries) {
      if (e.task !== task || e.sourceSessionId) continue;
      if (this.removingIds.has(e.id)) continue; // its own pipeline is committing
      const t = this.deleteTimers.get(e.id);
      if (t) { clearTimeout(t); this.deleteTimers.delete(e.id); }
      if (!this.hiddenIds.has(e.id)) {
        this.hiddenIds.add(e.id);
        this.deleteCommitted.emit(e.id);
      }
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

  sessionsLabel(b: TicketBlock): string {
    const n = b.sessions.length;
    return `${n} session${n === 1 ? '' : 's'}`;
  }

  // Day span of the block's tracking: first session start – last activity seen.
  trackedRange(b: TicketBlock): string {
    const first = b.sessions[0];
    const lastSeen = b.sessions.reduce(
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
