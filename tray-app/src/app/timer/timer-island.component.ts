import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimerState, TimerView } from '../models/workday.models';
import { TimerTimeComponent } from './timer-time.component';

/**
 * The island — the header itself flowing down at the right edge: every timer
 * of the day, in the order they joined it. Every row has two floors:
 * ▶/⏸ · task? or the ticket · description · the timer's own time, and Remove
 * below. Remove takes a no-ticket timer away; one with a ticket leaves its
 * record with the time it counted — what was typed by hand stays, a record
 * grown from the timer alone goes with it. At once, no undo.
 *
 * The description is a plain field: focus it and it is being edited; Enter
 * or a click away keeps it, Esc puts it back. A timer with a ticket has no
 * text of its own — the field edits its record's description: a record
 * without one gets it here, and a text taken away goes to the daemon like
 * any other (it knows which record may go without). Polls never touch the field under the caret —
 * rows are tracked by id and the field reads its own draft. Right after New
 * timer (birthId) the caret waits in the description, and Esc on the
 * still-empty field takes the timer back.
 */
@Component({
  selector: 'app-timer-island',
  standalone: true,
  imports: [CommonModule, TimerTimeComponent],
  templateUrl: './timer-island.component.html',
  styleUrl: './timer-island.component.scss',
})
export class TimerIslandComponent implements OnChanges {
  @Input() timers: readonly TimerView[] = [];
  @Input() asOf: string = '';
  // task? was pressed on this timer: the island shrinks to its row, the
  // ticket cloud hangs under it.
  @Input() anchorId: string | null = null;
  // The timer New timer has just made — its description takes the caret.
  @Input() birthId: string | null = null;
  // The month is closed in Tempo: nothing starts, no record is edited.
  @Input() locked: boolean = false;

  @Output() toggled: EventEmitter<TimerView> = new EventEmitter<TimerView>();
  @Output() created: EventEmitter<void> = new EventEmitter<void>();
  @Output() taskRequested: EventEmitter<TimerView> = new EventEmitter<TimerView>();
  @Output() deleted: EventEmitter<TimerView> = new EventEmitter<TimerView>();
  @Output() described: EventEmitter<{ id: string; description: string }> = new EventEmitter<{ id: string; description: string }>();
  // Esc on the fresh timer's empty description — it was started by mistake.
  @Output() cancelled: EventEmitter<string> = new EventEmitter<string>();
  // The caret left the fresh timer's description: it is an ordinary timer now.
  @Output() birthSettled: EventEmitter<void> = new EventEmitter<void>();

  private editingId: string | null = null;
  private draft: string = '';
  // A description sent to the daemon, shown until its data carries it.
  private readonly sent: Map<string, string> = new Map<string, string>();

  public constructor(private host: ElementRef<HTMLElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['timers']) {
      for (const [id, text] of [...this.sent]) {
        const timer = this.timers.find(t => t.id === id);
        if (!timer || timer.description === text) this.sent.delete(id);
      }
    }
    if (changes['birthId'] && this.birthId) this.focusDescription(this.birthId);
  }

  get rows(): readonly TimerView[] {
    if (this.anchorId === null) return this.timers;
    return this.timers.filter(t => t.id === this.anchorId);
  }

  trackById(_index: number, timer: TimerView): string {
    return timer.id;
  }

  isRunning(timer: TimerView): boolean { return timer.state === TimerState.Running; }
  isWaiting(timer: TimerView): boolean { return timer.state === TimerState.Waiting; }
  isPaused(timer: TimerView): boolean { return timer.state === TimerState.Paused; }

  // A timer that is switched on (running or waiting) offers ⏸; a paused one ▶.
  isLive(timer: TimerView): boolean { return timer.state !== TimerState.Paused; }

  // A timer with a ticket acts on its record — a closed month lets nothing through.
  isFrozen(timer: TimerView): boolean { return this.locked && timer.entryId !== null; }

  // The text is a field unless the month is closed for the timer's record.
  isDescribable(timer: TimerView): boolean { return !this.isFrozen(timer); }

  /** The daemon refused a description: the field shows the stored text again. */
  public forgetSent(timerId: string): void {
    this.sent.delete(timerId);
  }

  // ─── Description field ────────────────────────────────────────────────

  descriptionOf(timer: TimerView): string {
    return this.editingId === timer.id ? this.draft : this.storedDescription(timer);
  }

  private storedDescription(timer: TimerView): string {
    return this.sent.get(timer.id) ?? timer.description;
  }

  onDescFocus(timer: TimerView): void {
    this.draft = this.storedDescription(timer);
    this.editingId = timer.id;
  }

  onDescInput(timer: TimerView, value: string): void {
    if (this.editingId !== timer.id) this.onDescFocus(timer);
    this.draft = value;
  }

  onDescKeydown(timer: TimerView, ev: KeyboardEvent): void {
    const field = ev.target as HTMLInputElement;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.keepDescription(timer, field);
      field.blur();
      return;
    }
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this.birthId === timer.id && field.value.trim() === '') {
      this.editingId = null;
      this.cancelled.emit(timer.id);
      return;
    }
    // Put the text back at once — the blur that follows keeps nothing.
    this.editingId = null;
    field.value = this.storedDescription(timer);
    if (this.birthId === timer.id) this.birthSettled.emit();
    field.blur();
  }

  onDescBlur(timer: TimerView, field?: HTMLInputElement): void {
    this.keepDescription(timer, field);
  }

  // Enter or a click away: what was typed is the description.
  private keepDescription(timer: TimerView, _field?: HTMLInputElement): void {
    if (this.editingId !== timer.id) return;
    this.editingId = null;
    if (this.birthId === timer.id) this.birthSettled.emit();
    const description = this.draft.trim();
    if (description === this.storedDescription(timer)) return;
    this.sent.set(timer.id, description);
    this.described.emit({ id: timer.id, description });
  }

  private focusDescription(timerId: string): void {
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLInputElement>(`.trow[data-id="${timerId}"] input.tfield`)?.focus();
    });
  }
}
