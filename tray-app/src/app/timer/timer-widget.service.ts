import { Injectable, NgZone } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { ApiErrorCode, Favorite, JiraSearchHit, Suggestion, TimersResponse, TodayResponse } from '../models/workday.models';
import { loadStoredInProgress, sameHits, storeInProgress } from '../services/jira-in-progress.store';
import { readPref, writePref } from '../services/tray-prefs.store';
import { WorkdayApiService } from '../services/workday-api.service';
import {
  parseWidgetGeometry, ticketGroups, WIDGET_GEOMETRY_PREF, WidgetAction, WidgetGeometry, widgetPayload, widgetSuggestions,
  WidgetTickets,
} from './timer-widget.util';

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
 *
 * A live suggestion that offers a timer stands on the widget as a star row
 * below the timers, and is a row to show by itself. The eye on it takes the
 * row off the desktop for as long as the suggestion offers its timer — that
 * is kept here, in memory, and the suggestion stays in the feed.
 *
 * The widget's ticket block has no data of its own either: the tickets the
 * app knows are told from here (what is at hand goes at once, Jira's
 * in-progress list is read again and told when it changed), and a text typed
 * in its search goes to Jira through the daemon.
 */
@Injectable({ providedIn: 'root' })
export class TimerWidgetService {
  private sent: string | null = null;
  private unlisteners: UnlistenFn[] = [];
  private birth: { readonly id: string; readonly untilMs: number } | null = null;
  // The day as it was last synced — a star row hidden by the eye syncs again from it.
  private timers: TimersResponse | null = null;
  private suggestions: readonly Suggestion[] = [];
  // Star rows the eye took off the desktop (suggestion uids).
  private readonly hiddenSuggested: Set<string> = new Set<string>();
  // Jira in progress: the last list, kept across runs — as the Log cloud keeps it.
  private inProgress: readonly JiraSearchHit[] = loadStoredInProgress();
  private inProgressSeq: number = 0;

  public constructor(private zone: NgZone, private api: WorkdayApiService) {}

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
          if (e.payload.kind === 'search') {
            void this.search(e.payload.query);
            return;
          }
          if (e.payload.kind === 'suggested-hide') {
            this.hiddenSuggested.add(e.payload.uid);
            this.sync(this.timers, this.suggestions);
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

  /** The ticket block opened: the tickets the app knows — now, and again if Jira's in-progress list changed. */
  tellKnown(today: TodayResponse | null, favorites: readonly Favorite[]): void {
    const tell = (): void => this.tell({ kind: 'known', groups: ticketGroups(today, this.inProgress, favorites) });
    tell();
    void this.refreshInProgress().then(changed => { if (changed) tell(); });
  }

  // A failure keeps the last list.
  private async refreshInProgress(): Promise<boolean> {
    const seq = ++this.inProgressSeq;
    const res = await this.api.getJiraInProgress();
    if (seq !== this.inProgressSeq) return false;
    const unset = res.errorCode === ApiErrorCode.JiraNotConfigured;
    if (!unset && (!res.ok || !res.data)) return false;
    const hits = unset ? [] : (res.data?.hits ?? []);
    if (sameHits(hits, this.inProgress)) return false;
    this.inProgress = hits;
    storeInProgress(hits);
    return true;
  }

  private async search(query: string): Promise<void> {
    const res = await this.api.searchJira(query);
    const tickets = res.ok && res.data ? res.data.hits.map(hit => ({ key: hit.key, name: hit.summary })) : null;
    this.tell({ kind: 'found', query, tickets });
  }

  private tell(message: WidgetTickets): void {
    if (!IS_TAURI) return;
    void invoke('widget_tickets', { message }).catch(() => { /* the widget is gone */ });
  }

  /** The day's timers and suggestions as the main window knows them now — the widget follows. */
  sync(timers: TimersResponse | null, suggestions: readonly Suggestion[] = []): void {
    if (!IS_TAURI) return;
    this.timers = timers;
    this.suggestions = suggestions;
    if (this.birth && Date.now() > this.birth.untilMs) this.birth = null;
    // A row is hidden while its suggestion offers a timer; once it does not, the eye is forgotten.
    for (const uid of [...this.hiddenSuggested]) {
      if (!suggestions.some(s => s.uid === uid && s.suggestedTimer === true)) this.hiddenSuggested.delete(uid);
    }
    const payload = widgetPayload(timers, this.birth?.id ?? null, widgetSuggestions(suggestions, this.hiddenSuggested));
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
