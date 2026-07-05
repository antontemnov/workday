import { Directive, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { formatDurationLabel, parseDurationToMinutes } from './duration.util';

const WHEEL_STEP = 15;
const WHEEL_MIN = 15;
const WHEEL_MAX = 480;
const TYPED_MIN = 5;
const TYPED_MAX = 720;

/**
 * Smart duration text input ("1h 15m" / "90" / "45m") for the redesign's
 * compact inline forms (row edit, batch review, Jira form). Two-way binds
 * minutes: parses on blur/Enter/wheel, reformats to the canonical label,
 * reverts to the last good value on garbage. Wheel steps ±15m — inherited
 * from the fresh-row stepper, no scroll conflict since the cursor sits on
 * the control.
 */
@Directive({
  selector: 'input[wdDuration]',
  standalone: true,
})
export class DurationInputDirective implements OnChanges {
  @Input({ required: true, alias: 'wdDuration' }) minutes = 30;
  @Output('wdDurationChange') minutesChange = new EventEmitter<number>();
  // Fires after the typed value is committed — hosts submit on this instead
  // of a raw keydown.enter so they never read a stale model.
  @Output() durEnter = new EventEmitter<void>();

  public constructor(private el: ElementRef<HTMLInputElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['minutes']) return;
    // Don't fight live typing; blur/Enter re-syncs anyway.
    if (document.activeElement !== this.el.nativeElement) {
      this.el.nativeElement.value = formatDurationLabel(this.minutes);
    } else if (changes['minutes'].firstChange) {
      this.el.nativeElement.value = formatDurationLabel(this.minutes);
    }
  }

  @HostListener('blur')
  onBlur(): void {
    this.commit();
  }

  @HostListener('keydown.enter')
  onEnter(): void {
    this.commit();
    this.durEnter.emit();
  }

  @HostListener('wheel', ['$event'])
  onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const current = parseDurationToMinutes(this.el.nativeElement.value) ?? this.minutes;
    const next = Math.max(WHEEL_MIN, Math.min(WHEEL_MAX, current + (ev.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP)));
    this.setMinutes(next);
  }

  private commit(): void {
    const parsed = parseDurationToMinutes(this.el.nativeElement.value);
    if (parsed !== null) {
      this.setMinutes(Math.max(TYPED_MIN, Math.min(TYPED_MAX, parsed)));
    } else {
      this.el.nativeElement.value = formatDurationLabel(this.minutes);
    }
  }

  private setMinutes(value: number): void {
    this.el.nativeElement.value = formatDurationLabel(value);
    if (value !== this.minutes) {
      this.minutes = value;
      this.minutesChange.emit(value);
    }
  }
}
