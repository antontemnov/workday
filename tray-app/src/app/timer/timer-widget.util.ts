import {
  DEVELOPMENT_ACTIVITY, Favorite, JiraSearchHit, TimerBindInput, TimerView, TimersResponse, TodayResponse,
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

/** What the main window hands the widget: the rows on the desktop and the moment of their numbers. */
export interface WidgetPayload {
  readonly asOf: string;
  readonly timers: readonly TimerView[];
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

/** A ticket the block offers: the key and a name to know it by. */
export interface WidgetTicket {
  readonly key: string;
  readonly name: string;
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
// text for Jira; bind — a ticket picked for a timer without one.
export type WidgetAction =
  | { readonly kind: 'toggle' | 'hide' | 'cancel' | 'born'; readonly id: string }
  | { readonly kind: 'describe'; readonly id: string; readonly description: string }
  | { readonly kind: 'tickets' }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'bind'; readonly id: string; readonly task: string };

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

/** The widget exists while the setting is on and there is a row to show. */
export function widgetPayload(response: TimersResponse | null, birthId: string | null = null): WidgetPayload | null {
  if (!response || !response.desktopWidget) return null;
  const rows = widgetRows(response.timers);
  if (rows.length === 0) return null;
  const born = birthId !== null && rows.some(t => t.id === birthId);
  return { asOf: response.asOf, timers: rows, ...(born ? { birthId } : {}) };
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

// ─── The ticket block ───────────────────────────────────────────────────

// The day's tickets, the one touched last first.
function dayTickets(today: TodayResponse | null): readonly string[] {
  if (!today) return [];
  const touched = new Map<string, string>();
  const note = (task: string | null, at: string): void => {
    if (task && at > (touched.get(task) ?? '')) touched.set(task, at);
  };
  for (const entry of today.manualEntries ?? []) note(entry.task, entry.createdAt);
  for (const session of today.sessions ?? []) note(session.task, session.lastSeenAt);
  return [...touched.keys()].sort((a, b) => (touched.get(b) as string).localeCompare(touched.get(a) as string));
}

/**
 * The tickets the app knows already, in the order the block shows them: the
 * day's, Jira in progress, favorites. No ticket twice; a group with nothing
 * left is not there. A ticket is named by its Jira summary when the app has
 * it; a favorite's ticket otherwise by the favorite.
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
    { label: TICKETS_FAVORITES, tickets: fresh(favorites.map(fav => ({ key: fav.task, name: names.get(fav.task) ?? fav.name }))) },
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

/**
 * What a search shows: the ticket the text names, then the app's own
 * matches, then what Jira found — no ticket twice.
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
    if (seen.has(ticket.key)) continue;
    seen.add(ticket.key);
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

/** A ticket picked on the widget: the record is Development with the timer's own description. */
export function widgetBindInput(task: string, timer: TimerView): TimerBindInput {
  return { task, activity: DEVELOPMENT_ACTIVITY, description: timer.description };
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
