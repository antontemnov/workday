import { Injectable, NgZone } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { TimersResponse } from '../models/workday.models';
import { readPref, writePref } from '../services/tray-prefs.store';
import { parseWidgetGeometry, WIDGET_GEOMETRY_PREF, WidgetAction, WidgetGeometry, widgetPayload } from './timer-widget.util';

const IS_TAURI: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
// How long a birth is told to a widget that has not taken it.
const BIRTH_TTL_MS = 15_000;

/**
 * The main window's side of the desktop widget. The main window lives the
 * whole session, so it is the one that decides: the widget exists while the
 * setting is on and some timer is on the desktop, and it shows exactly the
 * rows it is handed. The widget's clicks come back here as actions, and its
 * place on the screen comes back to be kept in prefs.json — only the main
 * window writes that file. A timer made by New timer of the tray menu is
 * told to the widget until it takes the row into the edit.
 */
@Injectable({ providedIn: 'root' })
export class TimerWidgetService {
  private sent: string | null = null;
  private unlisteners: UnlistenFn[] = [];
  private birth: { readonly id: string; readonly untilMs: number } | null = null;

  public constructor(private zone: NgZone) {}

  /** Start hearing the widget; `onAction` gets its clicks. */
  async start(onAction: (action: WidgetAction) => void): Promise<void> {
    if (!IS_TAURI) return;
    try {
      this.unlisteners = [
        await listen<WidgetAction>('widget-action', e => {
          if (e.payload.kind === 'born') {
            if (this.birth?.id === e.payload.id) this.birth = null;
            return;
          }
          this.zone.run(() => onAction(e.payload));
        }),
        await listen<WidgetGeometry>('widget-geometry', e => writePref(WIDGET_GEOMETRY_PREF, JSON.stringify(e.payload))),
      ];
    } catch {
      // No event bridge — the widget stays display-only.
    }
  }

  stop(): void {
    this.unlisteners.forEach(unlisten => unlisten());
    this.unlisteners = [];
  }

  /** New timer of the tray menu made this timer: its row on the widget is born in the edit. */
  announceBirth(timerId: string): void {
    this.birth = { id: timerId, untilMs: Date.now() + BIRTH_TTL_MS };
  }

  /** The daemon refused a description typed on the widget: its row shows the stored text again. */
  refuse(timerId: string): void {
    if (!IS_TAURI) return;
    void invoke('widget_refused', { id: timerId }).catch(() => { /* the widget is gone */ });
  }

  /** The day's timers as the main window knows them now — the widget follows. */
  sync(timers: TimersResponse | null): void {
    if (!IS_TAURI) return;
    if (this.birth && Date.now() > this.birth.untilMs) this.birth = null;
    const payload = widgetPayload(timers, this.birth?.id ?? null);
    const key = JSON.stringify(payload);
    if (key === this.sent) return;
    this.sent = key;
    const geometry = payload ? parseWidgetGeometry(readPref(WIDGET_GEOMETRY_PREF)) : null;
    void invoke('sync_widget', { payload, geometry }).catch(() => {
      // Not delivered — the next change of the timers tries again.
      this.sent = null;
    });
  }
}
