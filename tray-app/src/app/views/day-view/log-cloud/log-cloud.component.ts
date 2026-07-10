import {
  Component, ElementRef, EventEmitter, HostBinding, HostListener, Input, OnChanges, OnDestroy,
  Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  ActivityType, ApiErrorCode, DEVELOPMENT_ACTIVITY, Favorite, FavoriteInput, JiraSearchHit,
  ManualEntryInput, normalizeFavName,
} from '../../../models/workday.models';
import { WorkdayApiService } from '../../../services/workday-api.service';
import { activityOptions } from '../activity.util';
import { DurationInputDirective } from '../duration-field/duration-input.directive';
import { openCtxMenu } from '../ctx-menu.util';

// Tracker-noticed log suggestion (e.g. a review of someone else's branch).
// UI-side only for now — the daemon has no suggestions surface yet, so the
// parent always passes []; the teal row and badges light up once it does.
export interface SuggestedLog {
  readonly task: string;
  readonly name: string;
  readonly minutes: number;
  readonly activity: string;
}

// What a picked chip turns into, plus where it flew from (for the FLIP clone).
export interface ChipPick {
  readonly entry: ManualEntryInput;
  readonly label: string;
  readonly sourceRect: DOMRect;
}

// One collected chip in batch mode. label keeps the chip identity for the
// review row; description/minutes/activity are the editable log payload.
interface BasketItem {
  readonly id: string;
  readonly task: string;
  readonly label: string;
  readonly src: 'fav' | 'sugg' | 'jira';
  description: string;
  minutes: number;
  activity: string;             // '' → must be picked before Log all
}

type CloudMode = 'chips' | 'form' | 'review';

// State of the Jira zone under the favorites — shown only when the local
// filter has no matches. 'idle' = zone hidden.
type JiraZone = 'idle' | 'short' | 'loading' | 'results' | 'empty' | 'error' | 'notConfigured';

const SPAWN_MS = 450;
const JIRA_DEBOUNCE_MS = 350;
const JIRA_MIN_QUERY = 2;
const JIRA_MAX_HITS = 5;
const DEFAULT_FORM_MINUTES = 30;
const FAV_NAME_MAX = 26;
const FAV_FEEDBACK_MS = 1200;
// Removed favorite chips shrink away (staggered in batch) before the emit.
const SHRINK_STAGGER_MS = 40;
const SHRINK_ANIM_MS = 180;

/**
 * Log cloud — the chip overlay that opens from the Logged panel's ghost row /
 * mini button. Three-stage search (local favorites filter → debounced live
 * Jira search → chip results), instant log on chip click, form morph for Jira
 * results (ticket is a label — it must exist in Jira), batch mode with a
 * review screen, suggested (teal) row.
 */
@Component({
  selector: 'app-log-cloud',
  standalone: true,
  imports: [CommonModule, FormsModule, DurationInputDirective],
  templateUrl: './log-cloud.component.html',
  styleUrl: './log-cloud.component.scss',
})
export class LogCloudComponent implements OnChanges, OnDestroy {
  @Input() open = false;
  @Input() favorites: readonly Favorite[] = [];
  @Input() suggestions: readonly SuggestedLog[] = [];
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() activityAllowed: readonly string[] = [];
  @Input() actionPending = false;

  @Output() chipPicked = new EventEmitter<ChipPick>();
  @Output() formSubmitted = new EventEmitter<ManualEntryInput>();
  @Output() batchSubmitted = new EventEmitter<readonly ManualEntryInput[]>();
  // Favorites management: right-click a Jira result → save a template;
  // ✎ edit-mode batch → remove (ids).
  @Output() favoriteSaved = new EventEmitter<FavoriteInput>();
  @Output() favoritesRemoved = new EventEmitter<readonly string[]>();
  @Output() settingsRequested = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>;
  @ViewChild('formMin') formMin?: ElementRef<HTMLInputElement>;
  @ViewChild('formAct') formAct?: ElementRef<HTMLSelectElement>;
  @ViewChild('formDesc') formDesc?: ElementRef<HTMLInputElement>;

  @HostBinding('class.open') get isOpen(): boolean { return this.open; }
  // Chip pop wave — only while opening; filter re-renders stay animation-free.
  @HostBinding('class.spawn') spawn = false;
  @HostBinding('class.form-mode') get isFormMode(): boolean { return this.mode === 'form'; }
  @HostBinding('class.review-mode') get isReviewMode(): boolean { return this.mode === 'review'; }
  @HostBinding('class.batch-mode') get isBatchMode(): boolean { return this.batch && this.mode === 'chips'; }
  @HostBinding('class.edit-mode') get isEditMode(): boolean { return this.editMode && this.mode === 'chips'; }

  filter = '';
  mode: CloudMode = 'chips';
  batch = false;
  basket: BasketItem[] = [];

  // ✎ edit mode — mark superfluous favorites, remove them in one batch.
  editMode = false;
  marked = new Set<string>();

  // "★ saved to favorites" feedback on a Jira chip (its key), ~1.2s.
  savedJiraKey: string | null = null;
  private savedTimer: ReturnType<typeof setTimeout> | null = null;

  // Favorites shrinking away before their removal reaches the daemon.
  shrinkingIds = new Set<string>();
  private shrinkTimers: ReturnType<typeof setTimeout>[] = [];

  jiraZone: JiraZone = 'idle';
  jiraHits: readonly JiraSearchHit[] = [];
  private jiraTimer: ReturnType<typeof setTimeout> | null = null;
  private jiraSeq = 0;

  // Form morph (Jira result only) — the ticket is a fixed label.
  formTask = '';
  formMinutes = DEFAULT_FORM_MINUTES;
  formDescription = '';
  formActivity = '';
  formActivityNeeded = false;

  private spawnTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private api: WorkdayApiService) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['open']) return;
    if (this.open) {
      this.resetState();
      this.spawn = true;
      if (this.spawnTimer) clearTimeout(this.spawnTimer);
      this.spawnTimer = setTimeout(() => this.spawn = false, SPAWN_MS);
      this.focusFilter(70);
    }
  }

  ngOnDestroy(): void {
    if (this.spawnTimer) clearTimeout(this.spawnTimer);
    if (this.jiraTimer) clearTimeout(this.jiraTimer);
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.shrinkTimers.forEach(t => clearTimeout(t));
  }

  private resetState(): void {
    this.filter = '';
    this.mode = 'chips';
    this.batch = false;
    this.basket = [];
    this.editMode = false;
    this.marked.clear();
    this.cancelJira();
  }

  private focusFilter(delay = 60): void {
    setTimeout(() => this.filterInput?.nativeElement.focus(), delay);
  }

  // ─── Filtering + Jira live search ──────────────────────────────────────

  private get query(): string {
    return this.filter.trim().toLowerCase();
  }

  get queryLabel(): string {
    return this.filter.trim();
  }

  get filteredFavorites(): readonly Favorite[] {
    const q = this.query;
    if (!q) return this.favorites;
    return this.favorites.filter(f =>
      f.name.toLowerCase().includes(q) || f.task.toLowerCase().includes(q));
  }

  // Suggested row shows only on the unfiltered cloud — typing means the user
  // is hunting a favorite, not browsing offers. Edit mode is favorites-only.
  get showSuggestions(): boolean {
    return this.suggestions.length > 0 && this.query === '' && !this.editMode;
  }

  onFilterInput(value: string): void {
    this.filter = value;
    const q = this.query;
    this.cancelJira();
    if (this.editMode) return; // edit mode: local favorites filter only
    if (!q || this.filteredFavorites.length > 0) return; // stage 1 covers it
    if (q.length < JIRA_MIN_QUERY) {
      this.jiraZone = 'short';
      return;
    }
    // Stage 2: no local match → debounced live Jira search via the daemon.
    this.jiraZone = 'loading';
    const seq = this.jiraSeq;
    this.jiraTimer = setTimeout(() => void this.searchJira(q, seq), JIRA_DEBOUNCE_MS);
  }

  private cancelJira(): void {
    this.jiraSeq++;
    if (this.jiraTimer) { clearTimeout(this.jiraTimer); this.jiraTimer = null; }
    this.jiraZone = 'idle';
    this.jiraHits = [];
  }

  private async searchJira(query: string, seq: number): Promise<void> {
    const res = await this.api.searchJira(query);
    if (seq !== this.jiraSeq || !this.open) return; // superseded by newer input
    if (res.ok && res.data) {
      this.jiraHits = res.data.hits.slice(0, JIRA_MAX_HITS);
      this.jiraZone = this.jiraHits.length ? 'results' : 'empty';
    } else if (res.errorCode === ApiErrorCode.JiraNotConfigured) {
      this.jiraZone = 'notConfigured';
    } else {
      this.jiraZone = 'error'; // network fail → quiet status, per design
    }
  }

  // ─── Picks (instant / batch collect) ───────────────────────────────────

  pickFavorite(f: Favorite, ev: MouseEvent): void {
    if (this.editMode) {
      this.toggleMarked(f);
      return;
    }
    if (this.collectOnPick(ev)) {
      this.toggleBasket(this.favBasketItem(f));
      return;
    }
    if (this.actionPending) return;
    this.emitPick({ task: f.task, minutes: f.minutes, description: f.name, activity: f.activity }, f.name,
      (ev.currentTarget as HTMLElement).getBoundingClientRect());
  }

  pickSuggestion(s: SuggestedLog, ev: MouseEvent): void {
    if (this.collectOnPick(ev)) {
      this.toggleBasket(this.suggBasketItem(s));
      return;
    }
    if (this.actionPending) return;
    this.emitPick({ task: s.task, minutes: s.minutes, description: s.name, activity: s.activity }, s.name,
      (ev.currentTarget as HTMLElement).getBoundingClientRect());
  }

  pickJira(h: JiraSearchHit, ev: MouseEvent): void {
    if (this.collectOnPick(ev)) {
      this.toggleBasket(this.jiraBasketItem(h));
      return;
    }
    this.enterForm(h);
  }

  // Ctrl+click collects even outside batch mode (and switches it on).
  private collectOnPick(ev: MouseEvent): boolean {
    if (this.batch) return true;
    if (ev.ctrlKey || ev.metaKey) {
      this.batch = true;
      return true;
    }
    return false;
  }

  private emitPick(entry: ManualEntryInput, label: string, sourceRect: DOMRect): void {
    this.chipPicked.emit({ entry, label, sourceRect });
  }

  // Enter in the filter (Tempo-style): favorite match → instant log; only
  // Jira results → first one into the form. Batch: collect the first chip,
  // clear the filter for the next pick; empty filter + basket → review.
  onFilterEnter(): void {
    if (this.editMode) return; // edit mode: clicks mark chips, Enter is idle
    const q = this.query;
    if (this.batch) {
      if (!q && this.basket.length) {
        this.openReview();
        return;
      }
      const item = this.firstEnterBasketItem();
      if (item) {
        this.toggleBasket(item);
        if (q) this.onFilterInput('');
      }
      return;
    }
    if (this.actionPending) return;
    const sugg = !q ? this.suggestions[0] : undefined;
    if (sugg) {
      this.emitPickFromKeyboard({ task: sugg.task, minutes: sugg.minutes, description: sugg.name, activity: sugg.activity }, sugg.name);
      return;
    }
    const fav = this.filteredFavorites[0];
    if (fav) {
      this.emitPickFromKeyboard({ task: fav.task, minutes: fav.minutes, description: fav.name, activity: fav.activity }, fav.name);
      return;
    }
    if (this.jiraZone === 'results' && this.jiraHits.length > 0) {
      this.enterForm(this.jiraHits[0]);
    }
  }

  private firstEnterBasketItem(): BasketItem | null {
    if (this.showSuggestions && this.suggestions.length > 0) return this.suggBasketItem(this.suggestions[0]);
    const fav = this.filteredFavorites[0];
    if (fav) return this.favBasketItem(fav);
    if (this.jiraZone === 'results' && this.jiraHits.length > 0) return this.jiraBasketItem(this.jiraHits[0]);
    return null;
  }

  private emitPickFromKeyboard(entry: ManualEntryInput, label: string): void {
    // No chip element under the keyboard — fly from the filter row instead.
    const rect = this.filterInput?.nativeElement.getBoundingClientRect()
      ?? new DOMRect(0, 0, 0, 0);
    this.emitPick(entry, label, rect);
  }

  // Esc unwinds one layer at a time: review → form → filter text → edit →
  // batch → close. A typed query is a layer of its own — the first Esc only
  // clears it.
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (!this.open) return;
    if (this.mode === 'review') { this.exitReview(); return; }
    if (this.mode === 'form') { this.exitForm(); return; }
    if (this.filter !== '') { this.onFilterInput(''); this.focusFilter(0); return; }
    if (this.editMode) { this.setEditMode(false); this.focusFilter(0); return; }
    if (this.batch) { this.setBatch(false); this.focusFilter(0); return; }
    this.closed.emit();
  }

  // ─── Favorites management (✎ edit mode + Jira save context menu) ────────

  toggleEditMode(): void {
    this.setEditMode(!this.editMode);
    this.focusFilter(0);
  }

  private setEditMode(v: boolean): void {
    this.editMode = v;
    if (v) {
      this.setBatch(false);
      this.cancelJira(); // favorites-only surface: suggested & Jira go dark
    } else {
      this.marked.clear();
    }
  }

  private toggleMarked(f: Favorite): void {
    if (this.marked.has(f.id)) this.marked.delete(f.id);
    else this.marked.add(f.id);
  }

  isMarked(f: Favorite): boolean {
    return this.marked.has(f.id);
  }

  removeMarked(): void {
    if (this.marked.size === 0) return;
    const all = [...this.marked];
    // Shrink the visible marked chips in order, staggered; then emit + exit.
    const visible = this.filteredFavorites.filter(f => this.marked.has(f.id));
    visible.forEach((f, i) => {
      this.shrinkTimers.push(setTimeout(() => this.shrinkingIds.add(f.id), i * SHRINK_STAGGER_MS));
    });
    const total = Math.max(0, visible.length - 1) * SHRINK_STAGGER_MS + SHRINK_ANIM_MS;
    this.shrinkTimers.push(setTimeout(() => {
      this.favoritesRemoved.emit(all);
      this.setEditMode(false);
      this.shrinkingIds.clear();
      this.focusFilter(0);
    }, total));
  }

  onJiraContextMenu(h: JiraSearchHit, ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    // Duplicate = the exact template this save would create (task + name +
    // default minutes), same identity as the daemon; other templates on the
    // same task don't block saving another one.
    const name = normalizeFavName(this.jiraFavName(h));
    const dup = this.favorites.some(f =>
      f.task.toLowerCase() === h.key.toLowerCase()
      && normalizeFavName(f.name) === name
      && f.minutes === DEFAULT_FORM_MINUTES);
    openCtxMenu(ev.clientX, ev.clientY, [
      dup
        ? { icon: '★', label: 'In favorites', disabled: true,
            title: 'This task + summary + default duration is already saved', action: (): void => {} }
        : { icon: '★', label: 'Save as favorite', action: () => this.saveJiraAsFavorite(h) },
    ]);
  }

  private jiraFavName(h: JiraSearchHit): string {
    return h.summary.length > FAV_NAME_MAX
      ? `${h.summary.slice(0, FAV_NAME_MAX - 1)}…`
      : h.summary;
  }

  // Template without logging: name from the summary, defaults for the rest.
  private saveJiraAsFavorite(h: JiraSearchHit): void {
    const name = this.jiraFavName(h);
    this.favoriteSaved.emit({
      name, task: h.key, minutes: DEFAULT_FORM_MINUTES, activity: 'Other',
    });
    this.savedJiraKey = h.key;
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.savedTimer = setTimeout(() => this.savedJiraKey = null, FAV_FEEDBACK_MS);
  }

  // ─── Batch basket ──────────────────────────────────────────────────────

  toggleBatch(): void {
    this.setBatch(!this.batch);
    this.focusFilter(0);
  }

  private setBatch(v: boolean): void {
    this.batch = v;
    if (!v) this.basket = [];
  }

  private favBasketItem(f: Favorite): BasketItem {
    // Key by the favorite's stable id — task+name collide when two templates
    // share a ticket + summary but differ in minutes (30m vs 45m).
    return { id: `fav:${f.id}`, task: f.task, label: f.name, src: 'fav',
             description: f.name, minutes: f.minutes, activity: f.activity };
  }

  private suggBasketItem(s: SuggestedLog): BasketItem {
    return { id: `sugg:${s.task}:${s.name}`, task: s.task, label: s.name, src: 'sugg',
             description: s.name, minutes: s.minutes, activity: s.activity };
  }

  private jiraBasketItem(h: JiraSearchHit): BasketItem {
    return { id: `jira:${h.key}`, task: h.key, label: h.summary, src: 'jira',
             description: '', minutes: DEFAULT_FORM_MINUTES, activity: '' };
  }

  private toggleBasket(item: BasketItem): void {
    const i = this.basket.findIndex(b => b.id === item.id);
    if (i >= 0) this.basket.splice(i, 1);
    else this.basket.push(item);
  }

  isFavPicked(f: Favorite): boolean {
    return this.inBasket(`fav:${f.id}`);
  }

  isSuggPicked(s: SuggestedLog): boolean {
    return this.inBasket(`sugg:${s.task}:${s.name}`);
  }

  isJiraPicked(h: JiraSearchHit): boolean {
    return this.inBasket(`jira:${h.key}`);
  }

  private inBasket(id: string): boolean {
    return this.basket.some(b => b.id === id);
  }

  clearBasket(): void {
    this.basket = [];
    this.focusFilter(0);
  }

  get basketTotalMinutes(): number {
    return this.basket.reduce((sum, b) => sum + b.minutes, 0);
  }

  // ─── Review screen (scope-edit of the collected batch) ─────────────────

  openReview(): void {
    if (this.basket.length === 0) return;
    this.mode = 'review';
  }

  exitReview(): void {
    this.mode = 'chips';
    this.focusFilter();
  }

  removeFromBasket(item: BasketItem): void {
    this.basket = this.basket.filter(b => b !== item);
    if (this.basket.length === 0) this.exitReview();
  }

  // Jira rows join the basket without an activity — Tempo requires one.
  get reviewMissingActivity(): boolean {
    return this.basket.some(b => !b.activity);
  }

  // Description is user data (never auto-filled from the ticket summary);
  // only Development rows may leave it empty.
  rvDescNeeded(b: BasketItem): boolean {
    return this.needsDescription(b.activity, b.description);
  }

  get reviewMissingDescription(): boolean {
    return this.basket.some(b => this.rvDescNeeded(b));
  }

  get reviewInvalid(): boolean {
    return this.reviewMissingActivity || this.reviewMissingDescription;
  }

  get reviewHint(): string {
    if (this.reviewMissingActivity) return '← activity for Jira rows';
    if (this.reviewMissingDescription) return '← description (Development may skip it)';
    return '';
  }

  logAllIfReady(): void {
    if (!this.reviewInvalid) this.logAll();
  }

  logAll(): void {
    if (this.actionPending || this.basket.length === 0 || this.reviewInvalid) return;
    const entries = this.basket.map(b => ({
      task: b.task,
      minutes: b.minutes,
      description: b.description.trim(),
      activity: b.activity,
    }));
    this.setBatch(false);
    this.mode = 'chips';
    this.batchSubmitted.emit(entries);
  }

  // ─── Form morph (Jira result → single entry) ───────────────────────────

  enterForm(h: JiraSearchHit): void {
    this.formTask = h.key;
    // The ticket summary is a label, not a description — the user writes
    // what was actually done (may stay empty for Development).
    this.formDescription = '';
    this.formMinutes = DEFAULT_FORM_MINUTES;
    this.formActivity = '';
    this.formActivityNeeded = true;
    this.mode = 'form';
    // Focus lands in the duration once the morph settles (mockup: 140ms).
    setTimeout(() => {
      const el = this.formMin?.nativeElement;
      el?.focus();
      el?.select();
    }, 140);
  }

  exitForm(): void {
    this.mode = 'chips';
    this.focusFilter(80);
  }

  get formDescNeeded(): boolean {
    return this.needsDescription(this.formActivity, this.formDescription);
  }

  submitForm(): void {
    if (this.mode !== 'form') return;
    if (!this.formActivity) {
      this.formActivityNeeded = true;
      this.formAct?.nativeElement.focus();
      return;
    }
    if (this.formDescNeeded) {
      this.formDesc?.nativeElement.focus();
      return;
    }
    if (this.actionPending) return;
    this.formSubmitted.emit({
      task: this.formTask,
      minutes: this.formMinutes,
      description: this.formDescription.trim(),
      activity: this.formActivity,
    });
  }

  // Empty description is allowed only for Development (mirrors the daemon
  // rule); an unpicked activity counts as "will require one".
  private needsDescription(activity: string, description: string): boolean {
    return description.trim() === '' && activity !== DEVELOPMENT_ACTIVITY;
  }

  // ─── Misc ──────────────────────────────────────────────────────────────

  get activityOptions(): readonly ActivityType[] {
    return activityOptions(this.activityTypes, this.activityAllowed);
  }

  chipDelay(i: number): string {
    return `${30 + i * 12}ms`;
  }

  formatMinutes(minutes: number): string {
    if (minutes >= 60) {
      return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
    }
    return `${minutes}m`;
  }

  trackByFavorite(_i: number, f: Favorite): string {
    return f.id;
  }

  trackByJira(_i: number, h: JiraSearchHit): string {
    return h.key;
  }

  trackByBasket(_i: number, b: BasketItem): string {
    return b.id;
  }
}
