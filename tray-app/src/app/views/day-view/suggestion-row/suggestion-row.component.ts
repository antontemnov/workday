import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Suggestion } from '../../../models/workday.models';

// Same stepper feel as the fresh logged row (logged-panel).
const STEP_MINUTES = 15;
const MIN_MINUTES = 15;
const MAX_MINUTES = 480;

/**
 * Suggested row — a teal offer on the shared two-band grid, deliberately
 * muted so it clearly reads as NOT logged time (full voice on hover):
 *   band 1 — ticket chip: the learned resolution's key (teal), or a dashed
 *            "task?" when the resolver has nothing · title (live dot while
 *            ongoing) · minutes (wheel stepper, prefills the accept form)
 *   band 2 — when ("09:30–10:00", or "live · till 10:00" from DTSTART) ·
 *            origin spark · ✓ accept / ✕ dismiss
 * ✓ and the chip open the log cloud in accept mode; ✕ dismisses through the
 * daemon (permanent per uid+date). Suggested time never joins any totals.
 */
@Component({
  selector: 'app-suggestion-row',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './suggestion-row.component.html',
  styleUrl: './suggestion-row.component.scss',
})
export class SuggestionRowComponent implements OnChanges {
  @Input({ required: true }) suggestion!: Suggestion;
  @Input() actionPending = false;
  // Carries the stepper's current minutes — the accept form opens on them.
  @Output() acceptRequested = new EventEmitter<number>();
  @Output() dismissed = new EventEmitter<void>();

  // Stepper state. The input object is replaced by every poll, so a spun
  // value must survive reference changes — reset only on a different meeting.
  minutes = 0;

  ngOnChanges(changes: SimpleChanges): void {
    const ch = changes['suggestion'];
    if (!ch) return;
    const prev = ch.previousValue as Suggestion | undefined;
    const cur = ch.currentValue as Suggestion;
    if (!prev || prev.uid !== cur.uid || prev.date !== cur.date) {
      this.minutes = cur.plannedMinutes;
    }
  }

  get durLabel(): string {
    const m = this.minutes;
    if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    return `${m}m`;
  }

  get whenLabel(): string {
    const s = this.suggestion;
    if (s.ongoing) return `live · till ${this.formatHm(s.end)}`;
    return `${this.formatHm(s.start)}–${this.formatHm(s.end)}`;
  }

  onDurWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const next = this.minutes + (ev.deltaY < 0 ? STEP_MINUTES : -STEP_MINUTES);
    this.minutes = Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, next));
  }

  accept(): void {
    if (this.actionPending) return;
    this.acceptRequested.emit(this.minutes);
  }

  dismiss(): void {
    if (this.actionPending) return;
    this.dismissed.emit();
  }

  private formatHm(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
