import { TimerView, TimersResponse } from '../models/workday.models';
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

// toggle — ⏸ / ▶ of a row; hide — the row off the desktop; describe — the
// text typed on the plate; cancel — Esc on a born timer's empty description;
// born — the born row is in the edit (the main window stops telling of it).
export type WidgetAction =
  | { readonly kind: 'toggle' | 'hide' | 'cancel' | 'born'; readonly id: string }
  | { readonly kind: 'describe'; readonly id: string; readonly description: string };

export interface WidgetLayout {
  readonly minWidth: number;
  readonly height: number;
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
 * the least one. While a description is typed the field needs room — a
 * narrow plate is wider for that time.
 */
export function widgetLayout(rowCount: number, hours: boolean, editing: boolean = false): WidgetLayout {
  const list = rowCount > 1;
  const heightEm = list ? rowCount * LIST_ROW_EM + 2 * LIST_PAD_EM : ROW_EM;
  const least = (list ? LIST_MIN_WIDTH : ONE_MIN_WIDTH) + (hours ? HOURS_EXTRA_WIDTH : 0);
  return {
    minWidth: editing ? Math.max(least, EDIT_MIN_WIDTH) : least,
    height: rowCount > 0 ? heightEm * WIDGET_FONT_PX : 0,
  };
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
