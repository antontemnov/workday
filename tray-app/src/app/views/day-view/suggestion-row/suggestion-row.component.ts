import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivityType, DEVELOPMENT_ACTIVITY, ManualEntryInput, Suggestion } from '../../../models/workday.models';
import { activityOptions } from '../activity.util';
import { openCtxMenu } from '../ctx-menu.util';
import { DurationInputDirective } from '../duration-field/duration-input.directive';

// Mirrors the daemon's accept default (DEFAULT_MANUAL_ACTIVITY).
const ACCEPT_ACTIVITY = 'Other';

// Deny collapses the row before it reports up — same gesture as a logged
// row's delete (logged-panel REMOVE_ANIM_MS). Keep the two in step.
const DENY_ANIM_MS = 240;

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
 * Suggested row — a graphite blueprint on the shared two-band grid: dashed
 * contour + faint hatch, colourless body. The only colour is the amber
 * candidate signal (star in the badge + Log…) — it clearly reads as NOT
 * logged time:
 *   band 1 — ticket badge: the learned resolution's key on unlit grey candy
 *            with a lit amber star, or a dashed "task?" with a smouldering
 *            one when the resolver has nothing · title · planned minutes
 *   band 2 — when ("09:30–10:00"; ongoing: "15:00→live" — the calendar
 *            guarantees only the start; review rows: the checkout moment)
 *            · origin (meeting / review) · Deny link / Log… candy
 * Accept mirrors the logged rows' edit: dblclick (or Log…) morphs the SAME
 * row into the inline form — activity · description · Log, with the time
 * slot swapping to a frameless duration input (minutes are editable only
 * here). Unresolved rows have no Log… — the "task?" chip is the single
 * entry: it opens the log cloud purely to pick the ticket; the pick comes
 * back via [picked] and opens the form. Deny dismisses through the daemon
 * (permanent per uid+date). Review rows (title = the colleague's branch)
 * are always resolved and carry no Mute — there is no series. Suggested
 * time never joins any totals.
 */
@Component({
  selector: 'app-suggestion-row',
  standalone: true,
  imports: [CommonModule, FormsModule, DurationInputDirective],
  templateUrl: './suggestion-row.component.html',
  styleUrl: './suggestion-row.component.scss',
})
export class SuggestionRowComponent implements OnChanges, OnDestroy {
  @Input({ required: true }) suggestion!: Suggestion;
  @Input() actionPending = false;
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() activityAllowed: readonly string[] = [];
  // Ticket picked for this row in the cloud's accept-picker.
  @Input() picked: SuggestionPick | null = null;

  // Unresolved accept: the parent opens the log cloud as a ticket picker,
  // anchored under this row (the picker opens where the ladder started).
  @Output() pickRequested = new EventEmitter<DOMRect>();
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
  // Row is collapsing after a Deny — held until the parent's refresh drops it.
  denying = false;
  private denyTimer: ReturnType<typeof setTimeout> | null = null;

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

  ngOnDestroy(): void {
    // Torn down mid-collapse (tab switch): the Deny was the user's intent, so
    // commit it now instead of dropping it — mirrors the logged delete.
    if (this.denyTimer) {
      clearTimeout(this.denyTimer);
      this.denyTimer = null;
      this.dismissed.emit();
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

  // Ongoing meetings render "start→live" in the template — the planned end
  // is not a fact yet, so it never shows while the meeting runs.
  get liveNow(): boolean {
    return this.suggestion.ongoing && this.suggestion.source !== 'review';
  }

  get startHm(): string {
    return this.formatHm(this.suggestion.start);
  }

  get whenLabel(): string {
    const s = this.suggestion;
    if (s.source === 'review') return this.formatHm(s.start);  // the checkout moment
    return `${this.formatHm(s.start)}–${this.formatHm(s.end)}`;
  }

  // Log… / dblclick: resolved rows morph into the form right away,
  // unresolved ones go pick a ticket first.
  accept(): void {
    if (this.actionPending || this.editing || this.denying) return;
    const r = this.suggestion.resolved;
    if (r) this.openEdit(r.task, r.activity, r.description);
    else this.pickRequested.emit(this.host.nativeElement.getBoundingClientRect());
  }

  // Deny: collapse the row, then report up — the offer leaves the feed the
  // same way a logged row does under delete. The daemon dismiss (and the
  // refresh that removes the row for good) fire once the collapse is done.
  dismiss(): void {
    if (this.actionPending || this.denying) return;
    this.denying = true;
    this.denyTimer = setTimeout(() => this.dismissed.emit(), DENY_ANIM_MS);
  }

  // Right-click: the full action set (logged-row parity), mute picks its
  // window in a second menu at the same spot.
  onContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.editing || this.actionPending || this.denying) return;
    this.openMainMenu(ev.clientX, ev.clientY);
  }

  private openMainMenu(x: number, y: number): void {
    openCtxMenu(x, y, [
      // The ladder speaks honestly here too: only a resolved row can promise
      // the form (Log…, = dblclick); an unresolved one offers step 1 —
      // picking the ticket.
      ...(this.suggestion.resolved
        ? [{ icon: '✓', label: 'Log…', action: (): void => this.accept() }]
        : [{ icon: '⌕', label: 'Pick ticket…', action: (): void => this.accept() }]),
      { icon: '✕', label: 'Deny', action: () => this.dismiss() },
      // Review rows have no series to mute — dismiss closes the day.
      ...(this.suggestion.source === 'review'
        ? []
        : [{ icon: '⏸', label: 'Mute series…', action: (): void => this.openMuteMenu(x, y) }]),
    ]);
  }

  private openMuteMenu(x: number, y: number): void {
    openCtxMenu(x, y, [
      { label: '← Back', action: () => this.openMainMenu(x, y) },
      { separator: true },
      { label: 'For a week', action: () => this.muteSubmitted.emit(7) },
      { label: 'For a month', action: () => this.muteSubmitted.emit(30) },
      { label: 'For 3 months', action: () => this.muteSubmitted.emit(90) },
      { label: 'Forever', action: () => this.muteSubmitted.emit(null) },
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
