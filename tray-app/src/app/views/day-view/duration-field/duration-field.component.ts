import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DurationQuickPick, MINUTE_QUICK_PICKS, formatDurationLabel, parseDurationToMinutes } from './duration.util';

/**
 * Tempo-style duration input: free-text ("1h 30m"), quick-pick chips, and
 * mouse-wheel stepping (±5 min). Shared by the LOG TIME composer and the
 * Add Manual Time popover. Text is two-way bound via [(value)]; the host owns
 * parsing for validation (parseDurationToMinutes from the same util).
 */
@Component({
  selector: 'app-duration-field',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './duration-field.component.html',
  styleUrl: './duration-field.component.scss',
})
export class DurationFieldComponent {
  @Input() value = '';
  @Output() valueChange = new EventEmitter<string>();
  @Input() invalid = false;
  @Input() disabled = false;
  @Input() quickPicks: readonly DurationQuickPick[] = MINUTE_QUICK_PICKS;
  @Output() enter = new EventEmitter<void>();

  // Live typing: push the raw text up so the host can clear its error flag.
  public onInput(value: string): void {
    this.setValue(value);
  }

  // Reformat to the canonical label on blur ("1.5" → "1h 30m"); leave invalid
  // text as typed so the host's red flag still points at it.
  public normalize(): void {
    const minutes = parseDurationToMinutes(this.value);
    if (minutes !== null) this.setValue(formatDurationLabel(minutes));
  }

  public pick(minutes: number): void {
    this.setValue(formatDurationLabel(minutes));
  }

  // Mouse wheel steps the duration by 5 min (wheel-only, no spinner buttons).
  public onWheel(e: WheelEvent): void {
    if (this.disabled) return;
    e.preventDefault();
    const current = parseDurationToMinutes(this.value) ?? 0;
    const next = Math.max(5, current + (e.deltaY < 0 ? 5 : -5));
    this.setValue(formatDurationLabel(next));
  }

  private setValue(value: string): void {
    this.value = value;
    this.valueChange.emit(value);
  }
}
