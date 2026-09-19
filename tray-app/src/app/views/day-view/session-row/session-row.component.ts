import { Component, EventEmitter, HostBinding, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SessionDetail } from '../../../models/workday.models';
import { staminaHeat, staminaHeatLite } from './stamina-heat.util';

export type SessionRowState = 'tracking' | 'paused' | 'waiting' | 'closed';

const MANUAL_PAUSE = 'manual';

/** The one place a session's row state is derived from the daemon fields. */
export function sessionRowState(s: SessionDetail): SessionRowState {
  if (s.closedBy) return 'closed';
  if (!s.paused) return 'tracking';
  return (s.pauseSource ?? '').toLowerCase() === MANUAL_PAUSE ? 'paused' : 'waiting';
}

/**
 * One session inside its ticket block — a row of the block's shared grid
 * (the host IS the grid row): type | repo | · range | · ⊸ N | · diff | time.
 * A live session wears the pill — Tracking ▶ (the fill is the stamina, the
 * dye its temperature), Paused ⏸ (the user holds it: emptied glass, red
 * glyph), Waiting ■ (the system stopped it: frost). A closed one is a plain
 * 22px row under the type word. The left cell is the row's anchor — a click
 * asks the panel for the menu; the pill itself stays silent under the cursor.
 */
@Component({
  selector: 'app-session-row',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './session-row.component.html',
  styleUrl: './session-row.component.scss',
})
export class SessionRowComponent {
  @Input({ required: true }) session!: SessionDetail;
  // Type word of a closed row — tracked time is always Development.
  @Input() typeLabel = '';
  // A one-row block keeps its number in the header Σ alone.
  @Input() showDur = true;
  // Undo window open: the row is struck, ↩ takes the time slot.
  @Input() deleted = false;
  // The whole card burns: struck like the rest of it, the undo lives in the lid.
  @Input() struck = false;
  // The daemon is answering an action: the handle opens no menu meanwhile.
  @Input() locked = false;

  @Output() menuRequested = new EventEmitter<HTMLElement>();
  @Output() deleteRequested = new EventEmitter<void>();
  @Output() undoRequested = new EventEmitter<void>();

  @HostBinding('class.sr')
  protected readonly isRow: boolean = true;

  get state(): SessionRowState {
    return sessionRowState(this.session);
  }

  @HostBinding('class.closed')
  get isClosed(): boolean { return this.state === 'closed'; }

  @HostBinding('class.lead')
  get isTracking(): boolean { return this.state === 'tracking'; }

  @HostBinding('class.paused')
  get isPaused(): boolean { return this.state === 'paused'; }

  @HostBinding('class.frost')
  get isWaiting(): boolean { return this.state === 'waiting'; }

  @HostBinding('class.deleted')
  get isDeleted(): boolean { return this.deleted; }

  @HostBinding('class.struck')
  get isStruck(): boolean { return this.struck; }

  @HostBinding('class.locked')
  get isLocked(): boolean { return this.locked; }

  // Temperature + level of this session — the pill's dye, ▶ glow and fill.
  @HostBinding('style.--heat')
  get heat(): string { return staminaHeat(this.session.normalizedScore); }

  @HostBinding('style.--heat-lite')
  get heatLite(): string { return staminaHeatLite(this.session.normalizedScore); }

  @HostBinding('style.--stam')
  get stamina(): number { return Math.max(0, Math.min(1, this.session.normalizedScore)); }

  get repoName(): string {
    return this.session.repo.split('/').pop() ?? this.session.repo;
  }

  // A live session's range stays open: "14:40–now".
  get range(): string {
    const from = this.formatHm(this.session.startedAt);
    return `${from}–${this.isClosed ? this.formatHm(this.session.lastSeenAt) : 'now'}`;
  }

  get duration(): string {
    const totalMinutes = Math.floor(this.session.effectiveDurationMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m`;
  }

  onAnchorClick(ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.deleted || this.struck || this.locked) return;
    this.menuRequested.emit(ev.currentTarget as HTMLElement);
  }

  onDeleteClick(ev: MouseEvent): void {
    ev.stopPropagation();
    this.deleteRequested.emit();
  }

  onUndoClick(ev: MouseEvent): void {
    ev.stopPropagation();
    this.undoRequested.emit();
  }

  private formatHm(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
