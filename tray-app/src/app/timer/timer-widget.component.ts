import { AfterViewChecked, Component, ElementRef, EventEmitter, Input, OnChanges, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimerState, TimerView } from '../models/workday.models';
import { TimerTimeComponent } from './timer-time.component';
import { showsHours, WidgetGrab, WidgetLayout, widgetLayout } from './timer-widget.util';

// A press becomes a drag only past this — a click or a double click stays one.
const DRAG_THRESHOLD_PX = 3;

interface Press {
  readonly grab: WidgetGrab;
  readonly x: number;
  readonly y: number;
  readonly pointerId: number;
}

/**
 * The desktop widget's plate: the day's timers that are on the desktop, in
 * the island's order. A row is the state glyph (under the cursor it becomes
 * ⏸ or ▶), the timer's own time, the key and the description, and one slot:
 * "hide" for a timer at rest — only such a timer can leave the desktop — and
 * a pencil for one that is switched on. The plate fills its window: the
 * height follows the rows, the width is dragged by the left and right edge,
 * and what a row shows follows the width. Dragging by the body moves the
 * window; a double click opens the app; a click on the text does nothing.
 *
 * The pencil turns the description into a field right on the plate. The
 * button in the slot keeps what was typed, Enter does the same, Esc puts the
 * text back; a click away changes nothing — the edit stays on. A timer with
 * a ticket has no text of its own: the field edits its record's description,
 * and an emptied one is never sent. A timer made by New timer of the tray
 * menu (birthId) is born in the edit, and Esc on its still-empty field takes
 * the timer back.
 */
@Component({
  selector: 'app-timer-widget',
  standalone: true,
  imports: [CommonModule, TimerTimeComponent],
  templateUrl: './timer-widget.component.html',
  styleUrl: './timer-widget.component.scss',
})
export class TimerWidgetComponent implements OnChanges, AfterViewChecked {
  @Input() timers: readonly TimerView[] = [];
  @Input() asOf: string = '';
  // The timer New timer of the tray menu has just made — its row is born in the edit.
  @Input() birthId: string | null = null;

  @Output() toggled: EventEmitter<string> = new EventEmitter<string>();
  @Output() rowHidden: EventEmitter<string> = new EventEmitter<string>();
  @Output() opened: EventEmitter<void> = new EventEmitter<void>();
  @Output() described: EventEmitter<{ id: string; description: string }> = new EventEmitter<{ id: string; description: string }>();
  // Esc on the born timer's empty description — it was started by mistake.
  @Output() cancelled: EventEmitter<string> = new EventEmitter<string>();
  // The born row is in the edit — the birth needs no more telling.
  @Output() birthTaken: EventEmitter<string> = new EventEmitter<string>();
  // A description is being typed (the window needs the keyboard), or no more.
  @Output() typing: EventEmitter<boolean> = new EventEmitter<boolean>();
  // The plate's size for its rows changed — the window follows.
  @Output() layoutChanged: EventEmitter<WidgetLayout> = new EventEmitter<WidgetLayout>();
  @Output() grabbed: EventEmitter<WidgetGrab> = new EventEmitter<WidgetGrab>();
  @Output() dragged: EventEmitter<void> = new EventEmitter<void>();
  @Output() released: EventEmitter<void> = new EventEmitter<void>();

  // Some time is past the hour: the time column is three characters wider.
  hours: boolean = false;
  dragging: boolean = false;
  editingId: string | null = null;
  draft: string = '';
  // The edit of a row born in it: Esc on the empty field takes the timer back.
  private bornId: string | null = null;
  private takenBirthId: string | null = null;
  // The field of a fresh edit is not drawn yet — the caret goes there once it is.
  private caretPending: boolean = false;
  // A description sent to the main window, shown until the rows carry it.
  private readonly sent: Map<string, string> = new Map<string, string>();
  private layout: WidgetLayout | null = null;
  private press: Press | null = null;

  public constructor(private host: ElementRef<HTMLElement>) {}

  ngOnChanges(): void {
    this.followRows();
    this.measure();
  }

  ngAfterViewChecked(): void {
    if (!this.caretPending) return;
    this.caretPending = false;
    this.takeCaret();
  }

  get list(): boolean {
    return this.timers.length > 1;
  }

  get timeColumn(): string {
    return this.hours ? '10ch' : '7ch';
  }

  trackById(_index: number, timer: TimerView): string {
    return timer.id;
  }

  isRunning(timer: TimerView): boolean { return timer.state === TimerState.Running; }
  isWaiting(timer: TimerView): boolean { return timer.state === TimerState.Waiting; }
  isPaused(timer: TimerView): boolean { return timer.state === TimerState.Paused; }

  // The pencil: any timer that is switched on, but manual added time — it has no text.
  isDescribable(timer: TimerView): boolean { return !this.isPaused(timer) && !timer.added; }

  textOf(timer: TimerView): string {
    return this.sent.get(timer.id) ?? timer.description;
  }

  // A running timer crossed a minute — it may have crossed the hour.
  onMinute(): void {
    this.measure();
  }

  private measure(): void {
    this.hours = showsHours(this.timers, Date.parse(this.asOf), Date.now());
    const next = widgetLayout(this.timers.length, this.hours, this.editingId !== null);
    if (this.layout && this.layout.minWidth === next.minWidth && this.layout.height === next.height) return;
    this.layout = next;
    this.layoutChanged.emit(next);
  }

  // ─── Description typed on the plate ───────────────────────────────────

  private followRows(): void {
    for (const [id, text] of [...this.sent]) {
      const timer = this.timers.find(t => t.id === id);
      if (!timer || timer.description === text) this.sent.delete(id);
    }
    // The row under the edit is gone — so is the edit.
    if (this.editingId !== null && !this.timers.some(t => t.id === this.editingId)) this.setEdit(null);
    if (!this.birthId || this.birthId === this.takenBirthId) return;
    const born = this.timers.find(t => t.id === this.birthId);
    if (!born) return;
    this.takenBirthId = born.id;
    this.keepCurrent();
    this.setEdit(born);
    this.bornId = born.id;
    this.birthTaken.emit(born.id);
  }

  onPencil(timer: TimerView): void {
    if (this.editingId === timer.id) return;
    this.keepCurrent();
    this.setEdit(timer);
  }

  onEditInput(value: string): void {
    this.draft = value;
  }

  onEditKeydown(timer: TimerView, ev: KeyboardEvent): void {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      this.keep(timer);
      return;
    }
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    const mistake = this.bornId === timer.id && this.draft.trim() === '';
    this.setEdit(null);
    if (mistake) this.cancelled.emit(timer.id);
  }

  /** The button in the slot, or Enter: what was typed is the description. */
  keep(timer: TimerView): void {
    if (this.editingId !== timer.id) return;
    const description = this.draft.trim();
    this.setEdit(null);
    // A record's description is never emptied from here.
    if (description === '' && timer.entryId !== null) return;
    if (description === this.textOf(timer)) return;
    this.sent.set(timer.id, description);
    this.described.emit({ id: timer.id, description });
  }

  /** The main window could not keep a description: the row shows the stored text again. */
  public forgetSent(timerId: string): void {
    this.sent.delete(timerId);
  }

  /** The window has the keyboard: the caret goes to the field under the edit. */
  public takeCaret(): void {
    if (this.editingId === null) return;
    this.host.nativeElement.querySelector<HTMLInputElement>('input.w-in')?.focus();
  }

  // While a description is typed, a press anywhere on the plate leaves the
  // caret where it is — the button in the slot included.
  onMouseDown(ev: MouseEvent): void {
    if (this.editingId !== null && !(ev.target as HTMLElement).closest('input')) ev.preventDefault();
  }

  // Another row takes the edit: what was typed in this one is kept, as by Enter.
  private keepCurrent(): void {
    const current = this.timers.find(t => t.id === this.editingId);
    if (current) this.keep(current);
  }

  private setEdit(timer: TimerView | null): void {
    const was = this.editingId !== null;
    this.editingId = timer ? timer.id : null;
    this.draft = timer ? this.textOf(timer) : '';
    this.bornId = null;
    this.caretPending = timer !== null;
    if (was !== (timer !== null)) this.typing.emit(timer !== null);
    this.measure();
  }

  // ─── Mouse: move by the body, width by an edge, double click opens ─────

  onPress(ev: PointerEvent, grab: WidgetGrab): void {
    if (ev.button !== 0 || this.press !== null) return;
    if (grab === 'move' && (ev.target as HTMLElement).closest('button, input, .rz')) return;
    ev.stopPropagation();
    this.press = { grab, x: ev.screenX, y: ev.screenY, pointerId: ev.pointerId };
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
  }

  onPointerMove(ev: PointerEvent): void {
    const press = this.press;
    if (!press || ev.pointerId !== press.pointerId) return;
    if (!this.dragging) {
      const still = Math.abs(ev.screenX - press.x) < DRAG_THRESHOLD_PX && Math.abs(ev.screenY - press.y) < DRAG_THRESHOLD_PX;
      if (still) return;
      this.dragging = true;
      this.grabbed.emit(press.grab);
    }
    this.dragged.emit();
  }

  onPointerEnd(ev: PointerEvent): void {
    const press = this.press;
    if (!press || ev.pointerId !== press.pointerId) return;
    this.press = null;
    if (!this.dragging) return;
    this.dragging = false;
    this.released.emit();
  }

  onDoubleClick(ev: MouseEvent): void {
    if ((ev.target as HTMLElement).closest('button, input')) return;
    this.opened.emit();
  }
}
