import {
  Component, ElementRef, EventEmitter, HostBinding, Input, OnChanges, OnDestroy,
  Output, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Favorite, ManualEntryInput } from '../../../models/workday.models';

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

const SPAWN_MS = 450;

/**
 * Log cloud — the favorites chip overlay that opens from the Logged panel's
 * ghost row / mini button. This stage: spawn wave, local filter, instant log
 * on chip click, suggested (teal) row. Jira search and batch mode come next;
 * the ⌨ custom chip is a temporary bridge until Jira search lands.
 */
@Component({
  selector: 'app-log-cloud',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './log-cloud.component.html',
  styleUrl: './log-cloud.component.scss',
})
export class LogCloudComponent implements OnChanges, OnDestroy {
  @Input() open = false;
  @Input() favorites: readonly Favorite[] = [];
  @Input() suggestions: readonly SuggestedLog[] = [];
  @Input() actionPending = false;

  @Output() chipPicked = new EventEmitter<ChipPick>();
  @Output() customRequested = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  @ViewChild('filterInput') filterInput?: ElementRef<HTMLInputElement>;

  @HostBinding('class.open') get isOpen(): boolean { return this.open; }
  // Chip pop wave — only while opening; filter re-renders stay animation-free.
  @HostBinding('class.spawn') spawn = false;

  filter = '';
  private spawnTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['open']) return;
    if (this.open) {
      this.filter = '';
      this.spawn = true;
      if (this.spawnTimer) clearTimeout(this.spawnTimer);
      this.spawnTimer = setTimeout(() => this.spawn = false, SPAWN_MS);
      setTimeout(() => this.filterInput?.nativeElement.focus(), 70);
    }
  }

  ngOnDestroy(): void {
    if (this.spawnTimer) clearTimeout(this.spawnTimer);
  }

  // ─── Filtering ─────────────────────────────────────────────────────────

  private get query(): string {
    return this.filter.trim().toLowerCase();
  }

  get filteredFavorites(): readonly Favorite[] {
    const q = this.query;
    if (!q) return this.favorites;
    return this.favorites.filter(f =>
      f.name.toLowerCase().includes(q) || f.task.toLowerCase().includes(q));
  }

  // Suggested row shows only on the unfiltered cloud — typing means the user
  // is hunting a favorite, not browsing offers.
  get showSuggestions(): boolean {
    return this.suggestions.length > 0 && this.query === '';
  }

  get noMatches(): boolean {
    return this.query !== '' && this.filteredFavorites.length === 0;
  }

  // ─── Picks ─────────────────────────────────────────────────────────────

  pickFavorite(f: Favorite, ev: MouseEvent): void {
    if (this.actionPending) return;
    this.emitPick({ task: f.task, minutes: f.minutes, description: f.name, activity: f.activity }, f.name, ev);
  }

  pickSuggestion(s: SuggestedLog, ev: MouseEvent): void {
    if (this.actionPending) return;
    this.emitPick({ task: s.task, minutes: s.minutes, description: s.name, activity: s.activity }, s.name, ev);
  }

  private emitPick(entry: ManualEntryInput, label: string, ev: MouseEvent): void {
    const chip = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.chipPicked.emit({ entry, label, sourceRect: chip });
  }

  // Enter picks the first visible favorite (Tempo-style).
  onEnter(): void {
    const first = this.showSuggestions && this.filteredFavorites.length === 0
      ? null : this.filteredFavorites[0];
    if (!first) return;
    if (this.actionPending) return;
    this.emitPickFromKeyboard(first);
  }

  private emitPickFromKeyboard(f: Favorite): void {
    // No chip element under the keyboard — fly from the filter row instead.
    const rect = this.filterInput?.nativeElement.getBoundingClientRect()
      ?? new DOMRect(0, 0, 0, 0);
    this.chipPicked.emit({
      entry: { task: f.task, minutes: f.minutes, description: f.name, activity: f.activity },
      label: f.name,
      sourceRect: rect,
    });
  }

  onEscape(): void {
    this.closed.emit();
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
}
