import {
  DEFAULT_MANUAL_ACTIVITY, DEVELOPMENT_ACTIVITY, Favorite, JiraSearchHit, Suggestion, TimerBindInput, TimerView,
  TimersResponse, TodayResponse,
} from '../models/workday.models';
import { formatTimerTime } from './timer-clock.util';

// The widget's own type scale: every size below is in its em.
export const WIDGET_FONT_PX = 10.5;
const ROW_EM = 2.48;        // the only row
const LIST_ROW_EM = 2.28;   // a row of a list
const LIST_PAD_EM = 0.2;    // above and below a list
// Least widths, px: the time and the hide slot · plus the key · plus an hour's digits.
const ONE_MIN_WIDTH = 104;
const LIST_MIN_WIDTH = 168;
const HOURS_EXTRA_WIDTH = 19;
// Least width while a description is typed on the plate — the width a widget is born with.
const EDIT_MIN_WIDTH = 262;
// "38m 12s" — the longest time without hours.
const MINUTES_TIME_LENGTH = 7;
// A lone row without a ticket has a second slot — the ticket glyph.
const TAG_EXTRA_WIDTH = 18;
// The ticket block, in the widget's em (the stylesheet holds the same numbers):
// the search line, a row of the list, a group's label, the list's own padding.
const PICK_FIND_EM = 2.28;
const PICK_ROW_EM = 2.1;
const PICK_LABEL_EM = 1.9;
const PICK_PAD_EM = 0.4;
// The list shows about seven rows — the rest scrolls inside; a short one
// keeps room for what a search finds.
const PICK_LIST_MAX_EM = 15.75;
const PICK_LIST_MIN_EM = 4 * PICK_ROW_EM + PICK_PAD_EM;

export const TICKETS_TODAY = 'today';
export const TICKETS_IN_PROGRESS = 'jira · in progress';
export const TICKETS_FAVORITES = 'favorites';

export const WIDGET_GEOMETRY_PREF = 'workday.timerWidget.geometry';

/**
 * A live suggestion on the widget — a star row below the timers: not a timer
 * yet, a click on it takes the suggestion by one.
 */
export interface WidgetSuggestion {
  readonly uid: string;
  readonly task: string | null;
  readonly description: string;
}

/** What the main window hands the widget: the rows on the desktop and the moment of their numbers. */
export interface WidgetPayload {
  readonly asOf: string;
  readonly timers: readonly TimerView[];
  // Live suggestions that offer a timer; absent when there is none.
  readonly suggested?: readonly WidgetSuggestion[];
  // The timer New timer of the tray menu has just made: its row is born in the edit.
  readonly birthId?: string;
}

/**
 * Where the widget stands. The anchor is the corner that stays put while the
 * window grows — physical px; the width is the user's — logical px.
 */
export interface WidgetGeometry {
  readonly anchorX: number;
  readonly anchorY: number;
  readonly fromRight: boolean;
  readonly fromBottom: boolean;
  readonly width: number;
}

export type WidgetGrab = 'move' | 'left' | 'right';

/**
 * A row the block offers: a ticket — the key and a name to know it by — or a
 * favorite: its ticket's key, its own name and its id. A favorite is a row of
 * its own, as its chip in the Log cloud is.
 */
export interface WidgetTicket {
  readonly key: string;
  readonly name: string;
  readonly favoriteId?: string;
}

/** A row of the block picked for a timer; favoriteId — the row was a favorite. */
export interface WidgetBound {
  readonly id: string;
  readonly task: string;
  readonly favoriteId?: string;
}

export interface WidgetTicketGroup {
  readonly label: string;
  readonly tickets: readonly WidgetTicket[];
}

/**
 * The main window's answer to the ticket block: the tickets the app knows,
 * or what Jira found for a text (null — Jira did not answer).
 */
export type WidgetTickets =
  | { readonly kind: 'known'; readonly groups: readonly WidgetTicketGroup[] }
  | { readonly kind: 'found'; readonly query: string; readonly tickets: readonly WidgetTicket[] | null };

// toggle — ⏸ / ▶ of a row; hide — the row off the desktop; describe — the
// text typed on the plate; cancel — Esc on a born timer's empty description;
// born — the born row is in the edit (the main window stops telling of it);
// tickets — the ticket block opens and asks what the app knows; search — a
// text for Jira; bind — a ticket picked for a timer without one (favoriteId
// — the row was a favorite);
// suggested-start — ▶ of a star row: its suggestion is taken by a timer;
// suggested-hide — the star row off the desktop.
export type WidgetAction =
  | { readonly kind: 'toggle' | 'hide' | 'cancel' | 'born'; readonly id: string }
  | { readonly kind: 'suggested-start'; readonly uid: string }
  | { readonly kind: 'suggested-hide'; readonly uid: string }
  | { readonly kind: 'describe'; readonly id: string; readonly description: string }
  | { readonly kind: 'tickets' }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'bind'; readonly id: string; readonly task: string; readonly favoriteId?: string };

export interface WidgetLayout {
  readonly minWidth: number;
  readonly height: number;
}

export interface WidgetLayoutExtra {
  // The ticket block is open: the height of its list, em.
  readonly pickListEm?: number | null;
  // Some row has the ticket glyph.
  readonly tagged?: boolean;
}

/** Rows on the desktop, in the island's order: every timer not taken off it. */
export function widgetRows(timers: readonly TimerView[]): readonly TimerView[] {
  return timers.filter(t => !t.hidden);
}

/**
 * The suggestions that stand on the widget as star rows, in the feed's order
 * (by start): the ones the daemon offers a timer for, minus those taken off
 * the desktop. A row reads as the record would: the ticket when it is known,
 * and the description the record gets — the meeting's title by default.
 */
export function widgetSuggestions(
  suggestions: readonly Suggestion[],
  hidden: ReadonlySet<string> = new Set<string>(),
): readonly WidgetSuggestion[] {
  return suggestions
    .filter(s => s.suggestedTimer === true && !hidden.has(s.uid))
    .map(s => ({ uid: s.uid, task: s.resolved?.task ?? null, description: s.resolved?.description ?? s.title }));
}

/** The widget exists while the setting is on and there is a row to show — a timer's or a suggestion's. */
export function widgetPayload(
  response: TimersResponse | null,
  birthId: string | null = null,
  suggested: readonly WidgetSuggestion[] = [],
): WidgetPayload | null {
  if (!response || !response.desktopWidget) return null;
  const rows = widgetRows(response.timers);
  if (rows.length === 0 && suggested.length === 0) return null;
  const born = birthId !== null && rows.some(t => t.id === birthId);
  return { asOf: response.asOf, timers: rows, ...(suggested.length > 0 ? { suggested } : {}), ...(born ? { birthId } : {}) };
}

/** A time past the hour is three characters longer: the column and the least width follow. */
export function showsHours(rows: readonly TimerView[], asOfMs: number, nowMs: number): boolean {
  return rows.some(t => formatTimerTime(t, asOfMs, nowMs).length > MINUTES_TIME_LENGTH);
}

/**
 * The plate's logical size for its rows: the height is exact, the width is
 * the least one. While a description is typed, or a ticket is picked, the
 * plate needs room — a narrow one is wider for that time. The ticket block
 * is a part of the plate: with it the plate is a list, taller by the search
 * line and the block's list.
 */
export function widgetLayout(
  rowCount: number,
  hours: boolean,
  editing: boolean = false,
  extra: WidgetLayoutExtra = {},
): WidgetLayout {
  const listEm = extra.pickListEm ?? null;
  const list = rowCount > 1 || listEm !== null;
  const rowsEm = list ? rowCount * LIST_ROW_EM + 2 * LIST_PAD_EM : ROW_EM;
  const heightEm = rowsEm + (listEm !== null ? PICK_FIND_EM + listEm : 0);
  const one = ONE_MIN_WIDTH + (extra.tagged ? TAG_EXTRA_WIDTH : 0);
  const least = (list ? LIST_MIN_WIDTH : one) + (hours ? HOURS_EXTRA_WIDTH : 0);
  return {
    minWidth: editing || listEm !== null ? Math.max(least, EDIT_MIN_WIDTH) : least,
    height: rowCount > 0 ? heightEm * WIDGET_FONT_PX : 0,
  };
}

/**
 * States told to Rust one at a time, the latest one last. Every command is
 * a request of its own, and of two sent together the older may be taken
 * last — the window would stay with a state that is gone. While one is on
 * its way the next waits, and only the latest waits: what came between is
 * outdated already.
 */
export class LatestLast<T> {
  private busy: boolean = false;
  private waiting: { readonly state: T } | null = null;

  /** `send` settles when Rust has taken the state; a failure is its own to handle. */
  public constructor(private readonly send: (state: T) => Promise<unknown>) {}

  public tell(state: T): void {
    if (this.busy) {
      this.waiting = { state };
      return;
    }
    this.busy = true;
    const next = (): void => {
      this.busy = false;
      const waiting = this.waiting;
      this.waiting = null;
      if (waiting) this.tell(waiting.state);
    };
    void this.send(state).then(next, next);
  }
}

/**
 * The plate's height on the screen: whole device pixels, never fewer than
 * the rows need — the number Rust cuts the window to. The plate does not fill
 * its window: on Windows the window is taller, so that rows and the ticket
 * block come and go without a resize.
 */
export function plateHeightPx(height: number, devicePixelRatio: number): number {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.ceil(height * ratio - 1e-6) / ratio;
}

// ─── The ticket block ───────────────────────────────────────────────────

// The tickets that have a card in the day, the one touched last first. A
// session that never came alive (a candidate the Day tab does not show) is
// not one of them.
function dayTickets(today: TodayResponse | null): readonly string[] {
  if (!today) return [];
  const touched = new Map<string, string>();
  const note = (task: string | null, at: string): void => {
    if (task && at > (touched.get(task) ?? '')) touched.set(task, at);
  };
  for (const entry of today.manualEntries ?? []) note(entry.task, entry.createdAt);
  for (const session of today.sessions ?? []) {
    if (session.activatedAt !== null) note(session.task, session.lastSeenAt);
  }
  return [...touched.keys()].sort((a, b) => (touched.get(b) as string).localeCompare(touched.get(a) as string));
}

/**
 * What the app knows already, in the order the block shows it: the day's
 * tickets, Jira in progress, favorites. A ticket stands once in the first
 * two, named by its Jira summary when the app has it. The favorites are what
 * the Log cloud shows: every favorite is a row, under its own name — two of
 * one ticket are two rows, and a ticket listed above does not take its
 * favorites away. A group with nothing in it is not there.
 */
export function ticketGroups(
  today: TodayResponse | null,
  inProgress: readonly JiraSearchHit[],
  favorites: readonly Favorite[],
): readonly WidgetTicketGroup[] {
  const names = new Map<string, string>(Object.entries(today?.issueSummaries ?? {}));
  for (const hit of inProgress) names.set(hit.key, hit.summary);
  const seen = new Set<string>();
  const fresh = (tickets: readonly WidgetTicket[]): readonly WidgetTicket[] => tickets.filter(ticket => {
    if (seen.has(ticket.key)) return false;
    seen.add(ticket.key);
    return true;
  });
  const groups: WidgetTicketGroup[] = [
    { label: TICKETS_TODAY, tickets: fresh(dayTickets(today).map(key => ({ key, name: names.get(key) ?? '' }))) },
    { label: TICKETS_IN_PROGRESS, tickets: fresh(inProgress.map(hit => ({ key: hit.key, name: hit.summary }))) },
    { label: TICKETS_FAVORITES, tickets: favorites.map(fav => ({ key: fav.task, name: fav.name, favoriteId: fav.id })) },
  ];
  return groups.filter(group => group.tickets.length > 0);
}

/** The tickets a typed text leaves: it is in the key or in the name. */
export function matchTickets(tickets: readonly WidgetTicket[], text: string): readonly WidgetTicket[] {
  const query = text.trim().toLowerCase();
  if (query === '') return tickets;
  return tickets.filter(ticket => ticket.key.toLowerCase().includes(query) || ticket.name.toLowerCase().includes(query));
}

// "7104" and "atl-7104" name one ticket.
function namesTicket(key: string, query: string): boolean {
  const lower = key.toLowerCase();
  return lower === query || lower.slice(lower.lastIndexOf('-') + 1) === query;
}

// A favorite is a row of its own: it merges neither with its ticket nor with
// another favorite of the same ticket.
function rowIdentity(ticket: WidgetTicket): string {
  return ticket.favoriteId === undefined ? ticket.key : `favorite:${ticket.favoriteId}`;
}

/**
 * What a search shows: the rows of the ticket the text names, then the app's
 * own matches, then what Jira found — no ticket twice, every favorite kept.
 */
export function mergeFound(
  local: readonly WidgetTicket[],
  found: readonly WidgetTicket[],
  text: string,
): readonly WidgetTicket[] {
  const query = text.trim().toLowerCase();
  const all = [...local, ...found];
  const seen = new Set<string>();
  const rows: WidgetTicket[] = [];
  for (const ticket of [...all.filter(t => namesTicket(t.key, query)), ...all]) {
    const identity = rowIdentity(ticket);
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push(ticket);
  }
  return rows;
}

/** The height of the block's list for the known tickets, em: what they need, between the least and the most. */
export function pickListEm(groups: readonly WidgetTicketGroup[]): number {
  const rows = groups.reduce((sum, group) => sum + group.tickets.length, 0);
  const content = groups.length * PICK_LABEL_EM + rows * PICK_ROW_EM + PICK_PAD_EM;
  return Math.min(PICK_LIST_MAX_EM, Math.max(PICK_LIST_MIN_EM, content));
}

/** A timer grown from a suggestion: its ticket brings the suggestion's record, not a Development one. */
export function ticketActivity(timer: TimerView): string {
  return timer.sourceRef === undefined ? DEVELOPMENT_ACTIVITY : DEFAULT_MANUAL_ACTIVITY;
}

/**
 * A row picked on the widget — there is no form there. A ticket: the record
 * is Development (a suggestion's timer — Other) with the timer's own
 * description. A favorite binds as the island's form fills it: its activity,
 * and its name for a timer that has no description.
 */
export function widgetBindInput(task: string, timer: TimerView, favorite: Favorite | null = null): TimerBindInput {
  if (favorite) return { task: favorite.task, activity: favorite.activity, description: timer.description || favorite.name };
  return { task, activity: ticketActivity(timer), description: timer.description };
}

export function parseWidgetGeometry(text: string | null): WidgetGeometry | null {
  if (!text) return null;
  try {
    const raw = JSON.parse(text) as Partial<WidgetGeometry> | null;
    if (!raw || typeof raw !== 'object') return null;
    const { anchorX, anchorY, fromRight, fromBottom, width } = raw;
    if (!Number.isInteger(anchorX) || !Number.isInteger(anchorY)) return null;
    if (typeof fromRight !== 'boolean' || typeof fromBottom !== 'boolean') return null;
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null;
    return { anchorX: anchorX as number, anchorY: anchorY as number, fromRight, fromBottom, width };
  } catch {
    return null;
  }
}
