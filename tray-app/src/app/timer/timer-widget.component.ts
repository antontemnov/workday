import { Component, EventEmitter, Input, OnChanges, Output } from '@angular/core';
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
 * ⏸ or ▶), the time, the key and the description, and a slot for "hide" —
 * only a timer at rest can leave the desktop. The plate fills its window:
 * the height follows the rows, the width is dragged by the left and right
 * edge, and what a row shows follows the width. Dragging by the body moves
 * the window; a double click opens the app; a click on the text does nothing.
 */
@Component({
  selector: 'app-timer-widget',
  standalone: true,
  imports: [CommonModule, TimerTimeComponent],
  templateUrl: './timer-widget.component.html',
  styleUrl: './timer-widget.component.scss',
})
export class TimerWidgetComponent implements OnChanges {
  @Input() timers: readonly TimerView[] = [];
  @Input() asOf: string = '';

  @Output() toggled: EventEmitter<string> = new EventEmitter<string>();
  @Output() rowHidden: EventEmitter<string> = new EventEmitter<string>();
  @Output() opened: EventEmitter<void> = new EventEmitter<void>();
  // The plate's size for its rows changed — the window follows.
  @Output() layoutChanged: EventEmitter<WidgetLayout> = new EventEmitter<WidgetLayout>();
  @Output() grabbed: EventEmitter<WidgetGrab> = new EventEmitter<WidgetGrab>();
  @Output() dragged: EventEmitter<void> = new EventEmitter<void>();
  @Output() released: EventEmitter<void> = new EventEmitter<void>();

  // Some time is past the hour: the time column is three characters wider.
  hours: boolean = false;
  dragging: boolean = false;
  private layout: WidgetLayout | null = null;
  private press: Press | null = null;

  ngOnChanges(): void {
    this.measure();
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

  // A running timer crossed a minute — it may have crossed the hour.
  onMinute(): void {
    this.measure();
  }

  private measure(): void {
    this.hours = showsHours(this.timers, Date.parse(this.asOf), Date.now());
    const next = widgetLayout(this.timers.length, this.hours);
    if (this.layout && this.layout.minWidth === next.minWidth && this.layout.height === next.height) return;
    this.layout = next;
    this.layoutChanged.emit(next);
  }

  // ─── Mouse: move by the body, width by an edge, double click opens ─────

  onPress(ev: PointerEvent, grab: WidgetGrab): void {
    if (ev.button !== 0 || this.press !== null) return;
    if (grab === 'move' && (ev.target as HTMLElement).closest('button, .rz')) return;
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
    if ((ev.target as HTMLElement).closest('button')) return;
    this.opened.emit();
  }
}
