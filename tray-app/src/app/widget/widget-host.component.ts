import { ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Suggestion, TimerState } from '../models/workday.models';
import { WorkdayApiService } from '../services/workday-api.service';
import { TimerWidgetComponent } from '../timer/timer-widget.component';
import {
  ticketGroups, widgetBindInput, WidgetGrab, WidgetLayout, WidgetPayload, widgetPayload, widgetSuggestions, WidgetTickets,
} from '../timer/timer-widget.util';

const IS_TAURI: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
// Let the rows paint before the hidden window is sized and shown.
const FIRST_FIT_DELAY_MS = 50;
const PREVIEW_POLL_MS = 1000;

/**
 * Root of the desktop widget's window. It owns nothing: the main window
 * decides whether the widget exists and hands it the rows (pull on boot, then
 * 'widget-payload'); clicks and a description typed on the plate go back to
 * the main window, which acts through its own gate. Rust sizes and places the
 * window from what the plate reports, and lets it have the keyboard only
 * while something is typed on it — a description, or a search for a ticket.
 * The ticket block asks the main window for the tickets it knows and for
 * what Jira finds; Rust tells which way the window grows.
 *
 * In a browser (?widget=1, no Tauri) the same plate runs on the API service
 * directly — a preview of the look, not of the window.
 */
@Component({
  // Same selector as the main shell — main.ts picks the root by window label.
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, TimerWidgetComponent],
  template: `
    <app-timer-widget *ngIf="payload as p"
                      [timers]="p.timers"
                      [suggested]="p.suggested ?? []"
                      [asOf]="p.asOf"
                      [birthId]="p.birthId ?? null"
                      (toggled)="onToggle($event)"
                      (rowHidden)="onHide($event)"
                      (described)="onDescribe($event)"
                      (cancelled)="onCancel($event)"
                      (birthTaken)="onBirthTaken($event)"
                      (typing)="onTyping($event)"
                      (ticketsRequested)="onTickets()"
                      (searchRequested)="onSearch($event)"
                      (bound)="onBind($event)"
                      (suggestedStarted)="onSuggestedStart($event)"
                      (suggestedHidden)="onSuggestedHide($event)"
                      (opened)="onOpen()"
                      (layoutChanged)="onLayout($event)"
                      (grabbed)="onGrab($event)"
                      (dragged)="onDrag()"
                      (released)="onRelease()" />
  `,
})
export class WidgetHostComponent implements OnInit, OnDestroy {
  payload: WidgetPayload | null = null;
  @ViewChild(TimerWidgetComponent) private plate?: TimerWidgetComponent;
  private unlistenPayload: UnlistenFn | null = null;
  private unlistenRefused: UnlistenFn | null = null;
  private unlistenTickets: UnlistenFn | null = null;
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private previewSuggestions: readonly Suggestion[] = [];
  private readonly previewHidden: Set<string> = new Set<string>();
  private shown: boolean = false;

  public constructor(private api: WorkdayApiService, private cdr: ChangeDetectorRef) {}

  // The plate has no right-click action — and no WebView2 menu either.
  @HostListener('document:contextmenu', ['$event'])
  onContextMenu(ev: Event): void {
    ev.preventDefault();
  }

  // The keyboard went to another window with a field still on: that window
  // is the one to get the keyboard back when the typing ends.
  @HostListener('window:blur')
  onWindowBlur(): void {
    if (this.plate?.wantsKeyboard) this.send('widget_away');
  }

  // The window has the keyboard only while something is typed: one that came
  // with nothing to type (not by the mouse — the window ignores it then) goes
  // straight back.
  @HostListener('window:focus')
  onWindowFocus(): void {
    if (this.plate?.wantsKeyboard) this.plate.takeCaret();
    else this.send('widget_typing', { on: false });
  }

  async ngOnInit(): Promise<void> {
    if (!IS_TAURI) {
      this.startPreview();
      return;
    }
    try {
      this.unlistenPayload = await listen<WidgetPayload | null>('widget-payload', e => this.show(e.payload));
      this.unlistenRefused = await listen<string>('widget-refused', e => {
        this.plate?.forgetSent(e.payload);
        this.cdr.detectChanges();
      });
      this.unlistenTickets = await listen<WidgetTickets>('widget-tickets', e => this.onTicketsTold(e.payload));
      this.show(await invoke<WidgetPayload | null>('get_pending_widget'));
    } catch {
      // The window is on its way out — nothing to render.
    }
  }

  ngOnDestroy(): void {
    if (this.unlistenPayload) this.unlistenPayload();
    if (this.unlistenRefused) this.unlistenRefused();
    if (this.unlistenTickets) this.unlistenTickets();
    if (this.previewTimer !== null) clearInterval(this.previewTimer);
  }

  private show(payload: WidgetPayload | null): void {
    this.payload = payload;
    this.cdr.detectChanges();
  }

  onLayout(layout: WidgetLayout): void {
    if (!IS_TAURI) return;
    const first = !this.shown;
    const fit = (): void => {
      this.shown = true;
      void invoke('fit_widget', { minWidth: layout.minWidth, height: layout.height })
        // A row born in the edit asked for the keyboard while the window was still hidden.
        .then(() => { if (first && this.plate?.wantsKeyboard) this.onTyping(true); })
        .catch(() => { /* window closed */ });
    };
    if (this.shown) fit();
    else setTimeout(fit, FIRST_FIT_DELAY_MS);
  }

  onToggle(id: string): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'toggle', id } });
    else void this.previewToggle(id);
  }

  onHide(id: string): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'hide', id } });
    else void this.api.hideTimer(id).then(() => this.previewPull());
  }

  onDescribe(e: { id: string; description: string }): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'describe', id: e.id, description: e.description } });
    else void this.previewDescribe(e.id, e.description);
  }

  onCancel(id: string): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'cancel', id } });
    else void this.api.cancelTimer(id).then(() => this.previewPull());
  }

  onBirthTaken(id: string): void {
    this.send('widget_action', { action: { kind: 'born', id } });
  }

  // The ticket block is about to open: Rust tells which side of its row is
  // free, the main window — the tickets it knows.
  async onTickets(): Promise<void> {
    if (!IS_TAURI) {
      await this.previewTickets();
      return;
    }
    try {
      const growsUp = await invoke<boolean>('widget_grows_up');
      if (this.plate) this.plate.growsUp = growsUp;
    } catch {
      // The side stays as it was.
    }
    this.send('widget_action', { action: { kind: 'tickets' } });
  }

  onSearch(query: string): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'search', query } });
    else void this.previewSearch(query);
  }

  onBind(e: { id: string; task: string }): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'bind', id: e.id, task: e.task } });
    else void this.previewBind(e.id, e.task);
  }

  onSuggestedStart(uid: string): void {
    if (IS_TAURI) this.send('widget_action', { action: { kind: 'suggested-start', uid } });
    else void this.previewSuggestedStart(uid);
  }

  onSuggestedHide(uid: string): void {
    if (IS_TAURI) {
      this.send('widget_action', { action: { kind: 'suggested-hide', uid } });
      return;
    }
    this.previewHidden.add(uid);
    void this.previewPull();
  }

  private onTicketsTold(told: WidgetTickets): void {
    if (told.kind === 'known') this.plate?.setKnown(told.groups);
    else this.plate?.setFound(told.query, told.tickets);
    this.cdr.detectChanges();
  }

  // The window takes the keyboard for the time something is typed, and gives
  // it back after.
  onTyping(on: boolean): void {
    if (!IS_TAURI) return;
    void invoke('widget_typing', { on })
      .then(() => { if (on) this.plate?.takeCaret(); })
      .catch(() => { /* window closed */ });
  }

  onOpen(): void {
    this.send('open_main');
  }

  onGrab(grab: WidgetGrab): void {
    this.send('widget_grab', { grab });
  }

  onDrag(): void {
    this.send('widget_drag');
  }

  onRelease(): void {
    this.send('widget_release');
  }

  private send(command: string, args?: Record<string, unknown>): void {
    if (!IS_TAURI) return;
    void invoke(command, args).catch(() => { /* the window or the main one is gone */ });
  }

  // ─── Browser preview ────────────────────────────────────────────────────

  private startPreview(): void {
    void this.previewPull();
    this.previewTimer = setInterval(() => void this.previewPull(), PREVIEW_POLL_MS);
  }

  private async previewPull(): Promise<void> {
    const [timers, suggestions] = await Promise.all([this.api.getTimers(), this.api.getSuggestions()]);
    if (!timers.ok || !timers.data) return;
    this.previewSuggestions = suggestions.data?.suggestions ?? [];
    this.show(widgetPayload(timers.data, null, widgetSuggestions(this.previewSuggestions, this.previewHidden)));
  }

  private async previewSuggestedStart(uid: string): Promise<void> {
    const suggestion = this.previewSuggestions.find(s => s.uid === uid);
    if (suggestion) await this.api.startSuggestionTimer(uid, suggestion.date);
    await this.previewPull();
  }

  // ?grow=down — the plate as it stands at the top of the screen.
  private async previewTickets(): Promise<void> {
    if (this.plate) this.plate.growsUp = new URLSearchParams(location.search).get('grow') !== 'down';
    const [today, inProgress, favorites] = await Promise.all([
      this.api.getToday(), this.api.getJiraInProgress(), this.api.getFavorites(),
    ]);
    this.onTicketsTold({
      kind: 'known',
      groups: ticketGroups(today.data ?? null, inProgress.data?.hits ?? [], favorites.data?.favorites ?? []),
    });
  }

  private async previewSearch(query: string): Promise<void> {
    const res = await this.api.searchJira(query);
    const tickets = res.ok && res.data ? res.data.hits.map(hit => ({ key: hit.key, name: hit.summary })) : null;
    this.onTicketsTold({ kind: 'found', query, tickets });
  }

  private async previewBind(id: string, task: string): Promise<void> {
    const timer = this.payload?.timers.find(t => t.id === id);
    if (timer) await this.api.bindTimer(id, widgetBindInput(task, timer));
    await this.previewPull();
  }

  private async previewDescribe(id: string, description: string): Promise<void> {
    const res = await this.api.describeTimer(id, description);
    if (!res.ok) this.plate?.forgetSent(id);
    await this.previewPull();
  }

  private async previewToggle(id: string): Promise<void> {
    const timer = this.payload?.timers.find(t => t.id === id);
    if (!timer) return;
    await (timer.state === TimerState.Paused ? this.api.startTimer(id) : this.api.pauseTimer(id));
    await this.previewPull();
  }
}
