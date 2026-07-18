import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivityType, DEVELOPMENT_ACTIVITY, ManualEntryInput, Suggestion } from '../../../models/workday.models';
import { activityOptions } from '../activity.util';
import { openCtxMenu } from '../ctx-menu.util';
import { DurationInputDirective } from '../duration-field/duration-input.directive';

// Mirrors the daemon's accept default (DEFAULT_MANUAL_ACTIVITY).
const ACCEPT_ACTIVITY = 'Other';

// A ticket chosen in the log cloud's accept-picker — flows back into the row
// and opens its inline form. A fresh object per pick (reference change is the
// signal).
export interface SuggestionPick {
  readonly task: string;
  readonly activity?: string;
}

// Submitted accept + where the row sat — the created entry's row slides
// down into the feed from this spot (FLIP), since the offer becomes it.
export interface SuggestionAcceptEvent {
  readonly entry: ManualEntryInput;
  readonly sourceRect: DOMRect;
}

/**
 * Suggested row — a teal offer on the shared two-band grid, deliberately
 * muted so it clearly reads as NOT logged time (full voice on hover):
 *   band 1 — ticket chip: the learned resolution's key (teal), or a dashed
 *            "task?" when the resolver has nothing · title (live dot while
 *            ongoing) · planned minutes
 *   band 2 — when ("09:30–10:00", or "live · till 10:00" from DTSTART) ·
 *            origin spark · ✓ accept / ✕ dismiss
 * Accept mirrors the logged rows' edit: dblclick (or ✓) morphs the SAME row
 * into the inline form — activity · description · Log, with the time slot
 * swapping to a frameless duration input (minutes are editable only here).
 * Unresolved rows first open the log cloud purely to pick the ticket;
 * the pick comes back via [picked] and opens the form. ✕ dismisses through
 * the daemon (permanent per uid+date). Suggested time never joins any totals.
 */
@Component({
  selector: 'app-suggestion-row',
  standalone: true,
  imports: [CommonModule, FormsModule, DurationInputDirective],
  templateUrl: './suggestion-row.component.html',
  styleUrl: './suggestion-row.component.scss',
})
export class SuggestionRowComponent implements OnChanges {
  @Input({ required: true }) suggestion!: Suggestion;
  @Input() actionPending = false;
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() activityAllowed: readonly string[] = [];
  // Ticket picked for this row in the cloud's accept-picker.
  @Input() picked: SuggestionPick | null = null;

  // Unresolved accept: the parent opens the log cloud as a ticket picker.
  @Output() pickRequested = new EventEmitter<void>();
  // Inline form submit — the parent turns it into the daemon accept.
  @Output() acceptSubmitted = new EventEmitter<SuggestionAcceptEvent>();
  @Output() dismissed = new EventEmitter<void>();
  // Context-menu mute: days to mute the whole series for, null = forever.
  @Output() muteSubmitted = new EventEmitter<number | null>();

  editing = false;
  editTask = '';
  editMinutes = 0;
  editActivity = '';
  editDescription = '';

  public constructor(private host: ElementRef<HTMLElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    const ch = changes['suggestion'];
    if (ch) {
      const prev = ch.previousValue as Suggestion | undefined;
      const cur = ch.currentValue as Suggestion;
      // Polls replace the object every 10s — an open form must survive that;
      // only a different meeting resets the row.
      if (prev && (prev.uid !== cur.uid || prev.date !== cur.date)) this.editing = false;
    }
    const pick = changes['picked'];
    if (pick && !pick.firstChange && this.picked) {
      this.openEdit(this.picked.task, this.picked.activity);
    }
  }

  get activityOptions(): readonly ActivityType[] {
    return activityOptions(this.activityTypes, this.activityAllowed);
  }

  get durLabel(): string {
    const m = this.suggestion.plannedMinutes;
    if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    return `${m}m`;
  }

  get whenLabel(): string {
    const s = this.suggestion;
    if (s.ongoing) return `live · till ${this.formatHm(s.end)}`;
    return `${this.formatHm(s.start)}–${this.formatHm(s.end)}`;
  }

  // ✓ / dblclick: resolved rows morph into the form right away, unresolved
  // ones go pick a ticket first.
  accept(): void {
    if (this.actionPending || this.editing) return;
    const r = this.suggestion.resolved;
    if (r) this.openEdit(r.task, r.activity, r.description);
    else this.pickRequested.emit();
  }

  dismiss(): void {
    if (this.actionPending) return;
    this.dismissed.emit();
  }

  // Right-click: the full action set (logged-row parity), mute picks its
  // window in a second menu at the same spot.
  onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.editing || this.actionPending) return;
    const x = ev.clientX;
    const y = ev.clientY;
    openCtxMenu(x, y, [
      { icon: '✓', label: 'Accept', action: () => this.accept() },
      { icon: '✕', label: 'Dismiss', action: () => this.dismiss() },
      { icon: '⏸', label: 'Mute series…', action: () => this.openMuteMenu(x, y) },
    ]);
  }

  private openMuteMenu(x: number, y: number): void {
    openCtxMenu(x, y, [
      { icon: '', label: 'For a week', action: () => this.muteSubmitted.emit(7) },
      { icon: '', label: 'For a month', action: () => this.muteSubmitted.emit(30) },
      { icon: '', label: 'For 3 months', action: () => this.muteSubmitted.emit(90) },
      { icon: '∞', label: 'Forever', action: () => this.muteSubmitted.emit(null) },
    ]);
  }

  private openEdit(task: string, activity?: string, description?: string): void {
    const s = this.suggestion;
    this.editing = true;
    this.editTask = task;
    this.editMinutes = s.plannedMinutes;
    const preset = this.activityOptions.find(a => a.value === (activity ?? ACCEPT_ACTIVITY))
      ?? this.activityOptions.find(a => a.value === ACCEPT_ACTIVITY);
    this.editActivity = preset?.value ?? '';
    this.editDescription = description ?? (s.isPrivate ? '' : s.title);
    // Same focus rule as the logged edit: description, once the morph renders.
    setTimeout(() => {
      this.host.nativeElement.querySelector<HTMLInputElement>('.le-desc')?.focus();
    }, 80);
  }

  cancelEdit(): void {
    this.editing = false;
  }

  get editDescNeeded(): boolean {
    return this.editing
      && this.editDescription.trim() === ''
      && this.editActivity !== DEVELOPMENT_ACTIVITY;
  }

  submitEdit(): void {
    if (this.actionPending || !this.editing) return;
    if (!this.editActivity) {
      this.host.nativeElement.querySelector<HTMLSelectElement>('.le-act')?.focus();
      return;
    }
    if (this.editDescNeeded) {
      this.host.nativeElement.querySelector<HTMLInputElement>('.le-desc')?.focus();
      return;
    }
    this.editing = false;
    this.acceptSubmitted.emit({
      entry: {
        task: this.editTask,
        minutes: this.editMinutes,
        description: this.editDescription.trim(),
        activity: this.editActivity,
      },
      sourceRect: this.host.nativeElement.getBoundingClientRect(),
    });
  }

  private formatHm(iso: string): string {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}
