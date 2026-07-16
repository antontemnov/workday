import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

// A meeting/activity the tracker offers to log. UI model only for now — the
// daemon's suggestions surface (meeting-suggestions plan) will feed it later,
// so the day view always passes an empty list in production.
export interface SuggestedEntry {
  readonly id: string;
  readonly task: string | null;  // ticket key; null → dashed "task?" chip
  readonly title: string;
  readonly when: string;         // "15:00–15:30"
  readonly source: string;       // "series · logged 14×"
  readonly minutes: number;
}

/**
 * Suggested row — a teal offer on the shared two-band grid, deliberately
 * muted so it clearly reads as NOT logged time (full voice on hover):
 *   band 1 — teal ticket chip (dashed "task?" while unresolved) · title ·
 *            duration
 *   band 2 — when · source · ✓/✕
 * ✓ stays decorative until the daemon's suggestions engine lands; ✕ dismisses
 * locally. Suggested time never joins any totals.
 */
@Component({
  selector: 'app-suggestion-row',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './suggestion-row.component.html',
  styleUrl: './suggestion-row.component.scss',
})
export class SuggestionRowComponent {
  @Input({ required: true }) suggestion!: SuggestedEntry;
  @Output() dismissed = new EventEmitter<void>();

  get durLabel(): string {
    const m = this.suggestion.minutes;
    if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    return `${m}m`;
  }
}
