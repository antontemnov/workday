import {
  ChangeDetectionStrategy, ChangeDetectorRef, Component, EventEmitter, HostBinding, Input, NgZone, OnChanges, OnDestroy, Output,
} from '@angular/core';
import { TimerState, TimerView } from '../models/workday.models';
import { formatTimerTime, liveMinutes } from './timer-clock.util';

const TICK_MS = 250;

/**
 * A timer's time as text. A running timer ticks by itself: the interval
 * lives outside the Angular zone and repaints this one node, so a second of
 * a timer never re-checks the whole app. Crossing a whole minute is the one
 * thing the rest of the screen cares about (sums move) — minuteChanged.
 */
@Component({
  selector: 'app-timer-time',
  standalone: true,
  template: '{{ text }}',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TimerTimeComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) timer!: TimerView;
  // The daemon's moment the timer's numbers were taken at.
  @Input({ required: true }) asOf: string = '';
  // Fix the box to the text's character count — digits swapping must not
  // tremble what stands next to it.
  @Input() pinWidth: boolean = false;
  @Output() minuteChanged: EventEmitter<void> = new EventEmitter<void>();

  text: string = '';
  private minutes: number = 0;
  private handle: ReturnType<typeof setInterval> | null = null;

  public constructor(private zone: NgZone, private cdr: ChangeDetectorRef) {}

  @HostBinding('style.width.ch')
  get pinnedWidth(): number | null {
    return this.pinWidth ? this.text.length : null;
  }

  ngOnChanges(): void {
    const now = Date.now();
    this.text = formatTimerTime(this.timer, Date.parse(this.asOf), now);
    this.minutes = liveMinutes(this.timer, Date.parse(this.asOf), now);
    if (this.timer.state === TimerState.Running) this.start();
    else this.stop();
  }

  ngOnDestroy(): void {
    this.stop();
  }

  private start(): void {
    if (this.handle !== null) return;
    this.zone.runOutsideAngular(() => {
      this.handle = setInterval(() => this.tick(), TICK_MS);
    });
  }

  private stop(): void {
    if (this.handle === null) return;
    clearInterval(this.handle);
    this.handle = null;
  }

  private tick(): void {
    const now = Date.now();
    const asOfMs = Date.parse(this.asOf);
    const text = formatTimerTime(this.timer, asOfMs, now);
    if (text !== this.text) {
      this.text = text;
      this.cdr.detectChanges();
    }
    const minutes = liveMinutes(this.timer, asOfMs, now);
    if (minutes !== this.minutes) {
      this.minutes = minutes;
      this.zone.run(() => this.minuteChanged.emit());
    }
  }
}
