import { ChangeDetectorRef, Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { TimerState } from '../models/workday.models';
import { WorkdayApiService } from '../services/workday-api.service';
import { TimerWidgetComponent } from '../timer/timer-widget.component';
import { WidgetGrab, WidgetLayout, WidgetPayload, widgetPayload } from '../timer/timer-widget.util';

const IS_TAURI: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
// Let the rows paint before the hidden window is sized and shown.
const FIRST_FIT_DELAY_MS = 50;
const PREVIEW_POLL_MS = 1000;

/**
 * Root of the desktop widget's window. It owns nothing: the main window
 * decides whether the widget exists and hands it the rows (pull on boot, then
 * 'widget-payload'); clicks go back to the main window, which acts through
 * its own gate. Rust sizes and places the window from what the plate reports.
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
                      [asOf]="p.asOf"
                      (toggled)="onToggle($event)"
                      (rowHidden)="onHide($event)"
                      (opened)="onOpen()"
                      (layoutChanged)="onLayout($event)"
                      (grabbed)="onGrab($event)"
                      (dragged)="onDrag()"
                      (released)="onRelease()" />
  `,
})
export class WidgetHostComponent implements OnInit, OnDestroy {
  payload: WidgetPayload | null = null;
  private unlistenPayload: UnlistenFn | null = null;
  private previewTimer: ReturnType<typeof setInterval> | null = null;
  private shown: boolean = false;

  public constructor(private api: WorkdayApiService, private cdr: ChangeDetectorRef) {}

  // The plate has no right-click action — and no WebView2 menu either.
  @HostListener('document:contextmenu', ['$event'])
  onContextMenu(ev: Event): void {
    ev.preventDefault();
  }

  async ngOnInit(): Promise<void> {
    if (!IS_TAURI) {
      this.startPreview();
      return;
    }
    try {
      this.unlistenPayload = await listen<WidgetPayload | null>('widget-payload', e => this.show(e.payload));
      this.show(await invoke<WidgetPayload | null>('get_pending_widget'));
    } catch {
      // The window is on its way out — nothing to render.
    }
  }

  ngOnDestroy(): void {
    if (this.unlistenPayload) this.unlistenPayload();
    if (this.previewTimer !== null) clearInterval(this.previewTimer);
  }

  private show(payload: WidgetPayload | null): void {
    this.payload = payload;
    this.cdr.detectChanges();
  }

  onLayout(layout: WidgetLayout): void {
    if (!IS_TAURI) return;
    const fit = (): void => {
      this.shown = true;
      void invoke('fit_widget', { minWidth: layout.minWidth, height: layout.height }).catch(() => { /* window closed */ });
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
    const res = await this.api.getTimers();
    if (res.ok && res.data) this.show(widgetPayload(res.data));
  }

  private async previewToggle(id: string): Promise<void> {
    const timer = this.payload?.timers.find(t => t.id === id);
    if (!timer) return;
    await (timer.state === TimerState.Paused ? this.api.startTimer(id) : this.api.pauseTimer(id));
    await this.previewPull();
  }
}
