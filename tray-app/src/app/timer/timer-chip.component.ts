import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimerState, TimerView } from '../models/workday.models';
import { TimerTimeComponent } from './timer-time.component';

/**
 * The timer in the app header — one flat element left of the window buttons.
 * At rest it is the outline of the chip to come (icon + "Timer"); with timers
 * it shows the current one: running, waiting (a session counts), or the last
 * one touched, in grey. A click only opens and closes the island.
 */
@Component({
  selector: 'app-timer-chip',
  standalone: true,
  imports: [CommonModule, TimerTimeComponent],
  templateUrl: './timer-chip.component.html',
  styleUrl: './timer-chip.component.scss',
})
export class TimerChipComponent {
  @Input() timer: TimerView | null = null;
  @Input() asOf: string = '';
  @Input() open: boolean = false;
  @Output() toggled: EventEmitter<void> = new EventEmitter<void>();

  get running(): boolean { return this.timer?.state === TimerState.Running; }
  get waiting(): boolean { return this.timer?.state === TimerState.Waiting; }
  get paused(): boolean { return this.timer?.state === TimerState.Paused; }
}
