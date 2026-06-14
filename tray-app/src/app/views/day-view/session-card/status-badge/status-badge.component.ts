import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

export type BadgeAction = 'pause' | 'resume';

/**
 * Status badge with a built-in action. For Live (→ Pause) and manual-paused
 * (→ Resume) the whole pill is a button that morphs to the action label on
 * hover (● Live → ⏸ Pause); every other state renders as a plain indicator
 * pill with no action. Both faces stack in one grid cell, so the pill is sized
 * to the wider face and the morph crossfades in place — no layout shift.
 */
@Component({
  selector: 'app-status-badge',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './status-badge.component.html',
  styleUrl: './status-badge.component.scss',
})
export class StatusBadgeComponent {
  @Input({ required: true }) statusClass!: string;
  @Input({ required: true }) label!: string;
  @Input() action: BadgeAction | null = null;
  @Input() pending = false;

  @Output() act = new EventEmitter<BadgeAction>();

  public get actionWord(): string {
    return this.action === 'pause' ? 'Pause' : 'Resume';
  }

  public get actionTitle(): string {
    return this.action === 'pause' ? 'Pause this session' : 'Resume tracking';
  }

  public onClick(): void {
    if (this.pending || !this.action) return;
    this.act.emit(this.action);
  }
}
