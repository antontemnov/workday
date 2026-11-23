import {
  AfterViewChecked, Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { TimerState, TimerView } from '../models/workday.models';
import { formatTicking } from './timer-clock.util';
import { TimerTimeComponent } from './timer-time.component';
import {
  matchTickets, mergeFound, pickListEm, plateHeightPx, showsHours, WidgetBound, WidgetGrab, WidgetLayout, widgetLayout,
  WidgetSuggestion, WidgetTicket, WidgetTicketGroup,
} from './timer-widget.util';

// A press becomes a drag only past this — a click or a double click stays one.
const DRAG_THRESHOLD_PX = 3;
// A text shorter than this is not sent to Jira; the pause lets a word be finished.
const FIND_MIN_LENGTH = 2;
const FIND_PAUSE_MS = 350;
// The ticket block opens with the tickets it is handed; this long without
// them, it opens with what it had.
const KNOWN_WAIT_MS = 400;

interface Press {
  readonly grab: WidgetGrab;
  readonly x: number;
  readonly y: number;
  readonly pointerId: number;
}

interface Found {
  readonly query: string;
  // null — Jira did not answer.
  readonly tickets: readonly WidgetTicket[] | null;
}

/**
 * The desktop widget's plate: the day's timers that are on the desktop, in
 * the island's order. A row is the state glyph (under the cursor it becomes
 * ⏸ or ▶), the timer's own time, the key and the description, and one slot:
 * "hide" for a timer at rest — only such a timer can leave the desktop — and
 * a pencil for one that is switched on. The plate is as wide as its window
 * and stands at the window's anchored edge: the height follows the rows, the
 * width is dragged by the left and right edge, and what a row shows follows
 * the width. Dragging by the body moves the window; a double click opens the
 * app; a click on the text does nothing.
 *
 * The pencil turns the description into a field right on the plate. The
 * button in the slot keeps what was typed, Enter does the same, Esc puts the
 * text back; a click away changes nothing — the edit stays on. A timer with
 * a ticket has no text of its own: the field edits its record's description
 * — a record without one gets it here, so the ticket may be picked first and
 * the text typed after. A timer made by New timer of the tray
 * menu (birthId) is born in the edit, and Esc on its still-empty field takes
 * the timer back.
 *
 * A timer without a ticket has a second slot, the ticket glyph. It opens the
 * ticket block next to the row, on the side the window grows to: a search
 * line and the tickets the app knows already, scrolling inside a list of one
 * height; the favorites stand there as in the Log cloud, every one a row. A
 * click on a row binds the timer — a favorite as it says; the glyph again shuts the
 * block. The block takes the keyboard as it opens, the caret in the search
 * line: what is typed filters the known tickets at once and, after a pause,
 * goes to Jira. Enter takes the row under the highlight, the arrows move it;
 * Esc shuts the block from anywhere on the widget. One thing at
 * a time: the block ends an edit as Enter does, another row's pencil shuts
 * the block, and the slot next to the glyph of the open block is dead — a
 * missed click neither hides nor edits the row.
 *
 * Below the timers stand the live suggestions that offer a timer — star
 * rows: the feed's amber star, a zero that does not tick, the ticket when it
 * is known and the description. Under the cursor the star becomes ▶, and the
 * click takes the suggestion by a timer. The slot hides the row from the
 * desktop only — the suggestion stays in the feed.
 */
@Component({
  selector: 'app-timer-widget',
  standalone: true,
  imports: [CommonModule, TimerTimeComponent],
  templateUrl: './timer-widget.component.html',
  styleUrl: './timer-widget.component.scss',
})
export class TimerWidgetComponent implements OnChanges, AfterViewChecked, OnDestroy {
  @Input() timers: readonly TimerView[] = [];
  // Live suggestions that offer a timer — star rows below the timers.
  @Input() suggested: readonly WidgetSuggestion[] = [];
  @Input() asOf: string = '';
  // The timer New timer of the tray menu has just made — its row is born in the edit.
  @Input() birthId: string | null = null;
  // The plate grows upward from its anchor: it stands at the window's lower
  // edge, and the ticket block stands above its row.
  @Input() growsUp: boolean = true;

  @Output() toggled: EventEmitter<string> = new EventEmitter<string>();
  @Output() rowHidden: EventEmitter<string> = new EventEmitter<string>();
  @Output() opened: EventEmitter<void> = new EventEmitter<void>();
  @Output() described: EventEmitter<{ id: string; description: string }> = new EventEmitter<{ id: string; description: string }>();
  // Esc on the born timer's empty description — it was started by mistake.
  @Output() cancelled: EventEmitter<string> = new EventEmitter<string>();
  // The born row is in the edit — the birth needs no more telling.
  @Output() birthTaken: EventEmitter<string> = new EventEmitter<string>();
  // Something is being typed (the window needs the keyboard), or no more.
  @Output() typing: EventEmitter<boolean> = new EventEmitter<boolean>();
  // The ticket block is about to open: it wants the tickets the app knows.
  @Output() ticketsRequested: EventEmitter<void> = new EventEmitter<void>();
  // A text for Jira, after a pause in the typing.
  @Output() searchRequested: EventEmitter<string> = new EventEmitter<string>();
  // A row of the ticket block picked for a timer; favoriteId — the row was a favorite.
  @Output() bound: EventEmitter<WidgetBound> = new EventEmitter<WidgetBound>();
  // ▶ of a star row (the suggestion's uid), and its row taken off the desktop.
  @Output() suggestedStarted: EventEmitter<string> = new EventEmitter<string>();
  @Output() suggestedHidden: EventEmitter<string> = new EventEmitter<string>();
  // The plate's size for its rows changed — the window follows.
  @Output() layoutChanged: EventEmitter<WidgetLayout> = new EventEmitter<WidgetLayout>();
  @Output() grabbed: EventEmitter<WidgetGrab> = new EventEmitter<WidgetGrab>();
  @Output() dragged: EventEmitter<void> = new EventEmitter<void>();
  @Output() released: EventEmitter<void> = new EventEmitter<void>();

  // What a star row shows in the time column: nothing is counted yet.
  readonly zeroTime: string = formatTicking(0);
  // Some time is past the hour: the time column is three characters wider.
  hours: boolean = false;
  dragging: boolean = false;
  editingId: string | null = null;
  draft: string = '';

  // The row whose ticket block is open, and the side the block took when it opened.
  pickId: string | null = null;
  pickUp: boolean = true;
  known: readonly WidgetTicketGroup[] = [];
  // The height of the block's list, em — taken when the block opens.
  listEm: number = 0;
  query: string = '';
  // The search line has the keyboard.
  findOn: boolean = false;
  searching: boolean = false;
  // What the typed text leaves; null — nothing is typed, the groups are shown.
  rows: readonly WidgetTicket[] | null = null;
  highlight: number = 0;
  note: string = '';

  // The edit of a row born in it: Esc on the empty field takes the timer back.
  private bornId: string | null = null;
  private takenBirthId: string | null = null;
  // The field of a fresh edit is not drawn yet — the caret goes there once it is.
  private caretPending: boolean = false;
  // The keyboard is moving to another field of the plate: the window keeps it.
  private handingOver: boolean = false;
  // A description sent to the main window, shown until the rows carry it.
  private readonly sent: Map<string, string> = new Map<string, string>();
  private layout: WidgetLayout | null = null;
  private press: Press | null = null;
  // The ticket glyph was pressed; the block opens when the tickets come.
  private askedId: string | null = null;
  private knownTimer: ReturnType<typeof setTimeout> | null = null;
  private findTimer: ReturnType<typeof setTimeout> | null = null;
  private found: Found | null = null;
  // The list shows other rows — it starts from the top; the highlight moved — it stays in sight.
  private listReset: boolean = false;
  private highlightMoved: boolean = false;

  public constructor(private host: ElementRef<HTMLElement>) {}

  ngOnChanges(): void {
    this.followRows();
    this.measure();
  }

  ngAfterViewChecked(): void {
    if (this.caretPending) {
      this.caretPending = false;
      this.takeCaret();
    }
    this.settleList();
  }

  ngOnDestroy(): void {
    if (this.knownTimer !== null) clearTimeout(this.knownTimer);
    if (this.findTimer !== null) clearTimeout(this.findTimer);
  }

  // With the ticket block the plate is a list, whatever the number of rows.
  get list(): boolean {
    return this.rowCount > 1 || this.pickId !== null;
  }

  private get rowCount(): number {
    return this.timers.length + this.suggested.length;
  }

  get timeColumn(): string {
    return this.hours ? '10ch' : '7ch';
  }

  // The window may be taller than the plate: the plate has its own height.
  get plateHeight(): number {
    const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
    return this.layout ? plateHeightPx(this.layout.height, ratio) : 0;
  }

  /** Something on the plate is typed in: the window holds the keyboard for it. */
  get wantsKeyboard(): boolean {
    return this.editingId !== null || this.findOn;
  }

  trackById(_index: number, timer: TimerView): string {
    return timer.id;
  }

  trackByUid(_index: number, suggestion: WidgetSuggestion): string {
    return suggestion.uid;
  }

  isRunning(timer: TimerView): boolean { return timer.state === TimerState.Running; }
  isWaiting(timer: TimerView): boolean { return timer.state === TimerState.Waiting; }
  isPaused(timer: TimerView): boolean { return timer.state === TimerState.Paused; }

  // The pencil: any timer that is switched on.
  isDescribable(timer: TimerView): boolean { return !this.isPaused(timer); }

  // The ticket glyph: a timer that has no ticket yet.
  isPickable(timer: TimerView): boolean { return timer.entryId === null; }

  textOf(timer: TimerView): string {
    return this.sent.get(timer.id) ?? timer.description;
  }

  // A running timer crossed a minute — it may have crossed the hour.
  onMinute(): void {
    this.measure();
  }

  private measure(): void {
    this.hours = showsHours(this.timers, Date.parse(this.asOf), Date.now());
    const next = widgetLayout(this.rowCount, this.hours, this.editingId !== null, {
      pickListEm: this.pickId !== null ? this.listEm : null,
      tagged: this.timers.some(timer => this.isPickable(timer)),
    });
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
    // The row of the ticket block is gone, or has its ticket — so is the block.
    const pickedId = this.pickId ?? this.askedId;
    if (pickedId !== null && !this.timers.some(t => t.id === pickedId && this.isPickable(t))) this.closePick();
    if (!this.birthId || this.birthId === this.takenBirthId) return;
    const born = this.timers.find(t => t.id === this.birthId);
    if (!born) return;
    this.takenBirthId = born.id;
    this.yieldPick();
    this.keepCurrent();
    this.setEdit(born);
    this.bornId = born.id;
    this.birthTaken.emit(born.id);
  }

  // While a row's ticket block is open, the slot next to its glyph is dead:
  // a click meant for the glyph must not hide or edit the row.
  isBlocked(timer: TimerView): boolean { return this.pickId === timer.id; }

  onHide(timer: TimerView): void {
    if (this.isBlocked(timer)) return;
    this.rowHidden.emit(timer.id);
  }

  onPencil(timer: TimerView): void {
    if (this.editingId === timer.id || this.isBlocked(timer)) return;
    this.yieldPick();
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
    if (description === this.textOf(timer)) return;
    this.sent.set(timer.id, description);
    this.described.emit({ id: timer.id, description });
  }

  /** The main window could not keep a description: the row shows the stored text again. */
  public forgetSent(timerId: string): void {
    this.sent.delete(timerId);
  }

  /** The window has the keyboard: the caret goes to the field that is typed in. */
  public takeCaret(): void {
    const field = this.findOn ? 'input.w-fi' : this.editingId !== null ? 'input.w-in' : null;
    if (field !== null) this.host.nativeElement.querySelector<HTMLInputElement>(field)?.focus();
  }

  // While something is typed, a press anywhere on the plate leaves the caret
  // where it is — the button in the slot and a row of the list included.
  onMouseDown(ev: MouseEvent): void {
    if (this.wantsKeyboard && !(ev.target as HTMLElement).closest('input')) ev.preventDefault();
  }

  // Another row takes the edit: what was typed in this one is kept, as by Enter.
  private keepCurrent(): void {
    const current = this.timers.find(t => t.id === this.editingId);
    if (!current) return;
    this.handingOver = true;
    this.keep(current);
    this.handingOver = false;
  }

  private setEdit(timer: TimerView | null): void {
    const was = this.editingId !== null;
    this.editingId = timer ? timer.id : null;
    this.draft = timer ? this.textOf(timer) : '';
    this.bornId = null;
    this.caretPending = timer !== null;
    if (was !== (timer !== null) && !this.handingOver) this.typing.emit(timer !== null);
    this.measure();
  }

  // ─── The ticket block ──────────────────────────────────────────────────

  /** The ticket glyph: the block opens once the tickets are here; pressed again, it shuts. */
  onTag(timer: TimerView): void {
    if (this.pickId === timer.id) {
      this.closePick();
      return;
    }
    this.askedId = timer.id;
    if (this.knownTimer !== null) clearTimeout(this.knownTimer);
    this.knownTimer = setTimeout(() => this.openAsked(), KNOWN_WAIT_MS);
    this.ticketsRequested.emit();
  }

  /** The tickets the app knows: they open the block that waits for them, or renew the open one. */
  public setKnown(groups: readonly WidgetTicketGroup[]): void {
    this.known = groups;
    if (this.askedId !== null) this.openAsked();
    else this.showRows();
  }

  /** Jira's answer to a text; one for a text that is no longer in the field is dropped. */
  public setFound(query: string, tickets: readonly WidgetTicket[] | null): void {
    if (this.pickId === null || query !== this.query.trim()) return;
    this.found = { query, tickets };
    this.searching = false;
    this.showRows();
  }

  /** The search line takes the keyboard: when the block opens, and by a click if it was given away since. */
  onFind(): void {
    if (this.pickId === null || this.findOn) return;
    this.findOn = true;
    this.caretPending = true;
    this.typing.emit(true);
  }

  onFindInput(value: string): void {
    this.query = value;
    this.highlight = 0;
    this.listReset = true;
    if (this.findTimer !== null) clearTimeout(this.findTimer);
    this.findTimer = null;
    const text = value.trim();
    this.searching = text.length >= FIND_MIN_LENGTH && this.found?.query !== text;
    if (this.searching) this.findTimer = setTimeout(() => this.searchRequested.emit(text), FIND_PAUSE_MS);
    this.showRows();
  }

  onFindKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      this.closePick();
      return;
    }
    const rows = this.rows;
    if (rows === null || rows.length === 0) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      this.highlight = Math.max(0, Math.min(rows.length - 1, this.highlight + step));
      this.highlightMoved = true;
      return;
    }
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    this.onTicket(rows[this.highlight]);
  }

  /** A row of the list: the timer is bound to its ticket — as the favorite says, if it is one; the block shuts. */
  onTicket(ticket: WidgetTicket): void {
    const id = this.pickId;
    if (id === null) return;
    this.closePick();
    this.bound.emit({ id, task: ticket.key, ...(ticket.favoriteId !== undefined ? { favoriteId: ticket.favoriteId } : {}) });
  }

  onListScroll(): void {
    this.settleList();
  }

  // Esc anywhere on the widget while it has the keyboard — not only in the
  // search line — shuts the ticket block.
  @HostListener('document:keydown.escape', ['$event'])
  onEscape(ev: Event): void {
    if (ev.defaultPrevented || this.pickId === null) return;
    ev.preventDefault();
    this.closePick();
  }

  private openAsked(): void {
    if (this.knownTimer !== null) clearTimeout(this.knownTimer);
    this.knownTimer = null;
    const timer = this.timers.find(t => t.id === this.askedId);
    this.askedId = null;
    if (!timer || !this.isPickable(timer)) return;
    // Another row's block shuts; the keyboard stays for this one.
    this.yieldPick();
    // What was typed in a description is kept, as by Enter; the keyboard
    // stays on the widget for the block.
    this.keepCurrent();
    this.pickId = timer.id;
    this.pickUp = this.growsUp;
    this.listEm = pickListEm(this.known);
    this.showRows();
    this.measure();
    // The block takes the keyboard as it opens: Esc shuts it at once, and
    // what is typed goes to the search line.
    this.onFind();
  }

  private closePick(): void {
    if (this.pickId === null && this.askedId === null) return;
    if (this.knownTimer !== null) clearTimeout(this.knownTimer);
    if (this.findTimer !== null) clearTimeout(this.findTimer);
    this.knownTimer = null;
    this.findTimer = null;
    this.askedId = null;
    const hadKeyboard = this.findOn;
    this.pickId = null;
    this.query = '';
    this.found = null;
    this.searching = false;
    this.findOn = false;
    this.showRows();
    if (hadKeyboard && !this.handingOver) this.typing.emit(false);
    this.measure();
  }

  // A description takes the plate: the block shuts, the keyboard stays where it is.
  private yieldPick(): void {
    this.handingOver = true;
    this.closePick();
    this.handingOver = false;
  }

  private showRows(): void {
    const text = this.query.trim();
    if (this.pickId === null || text === '') {
      this.rows = null;
      this.note = '';
      this.highlight = 0;
      return;
    }
    const local = matchTickets(this.known.flatMap(group => group.tickets), text);
    const answer = this.found?.query === text ? this.found : null;
    const rows = mergeFound(local, answer?.tickets ?? [], text);
    this.rows = rows;
    this.highlight = Math.max(0, Math.min(rows.length - 1, this.highlight));
    if (answer === null) this.note = '';
    else if (answer.tickets === null) this.note = 'Jira unreachable';
    else this.note = rows.length === 0 ? 'No tickets' : '';
  }

  // The list fades at the edge that hides more of it.
  private settleList(): void {
    const list = this.host.nativeElement.querySelector<HTMLElement>('.w-scroll');
    if (!list || !list.classList) return;
    if (this.listReset) list.scrollTop = 0;
    if (this.highlightMoved) list.querySelector('.w-li.h')?.scrollIntoView({ block: 'nearest' });
    this.listReset = false;
    this.highlightMoved = false;
    list.classList.toggle('more-up', list.scrollTop > 1);
    list.classList.toggle('more-down', list.scrollTop + list.clientHeight < list.scrollHeight - 1);
  }

  // ─── Mouse: move by the body, width by an edge, double click opens ─────

  onPress(ev: PointerEvent, grab: WidgetGrab): void {
    if (ev.button !== 0 || this.press !== null) return;
    if (grab === 'move' && (ev.target as HTMLElement).closest('button, input, .rz, .w-pick')) return;
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
    if ((ev.target as HTMLElement).closest('button, input, .w-pick')) return;
    this.opened.emit();
  }
}
