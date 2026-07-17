// Zero-dependency ICS (RFC 5545) parser + recurrence expansion, scoped to
// what Outlook published-calendar feeds actually emit: VEVENT with
// DTSTART/DTEND (TZID = Windows zone name, or VALUE=DATE for all-day),
// RRULE FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL/COUNT/UNTIL/BYDAY/
// BYMONTHDAY/BYMONTH/WKST, EXDATE, RECURRENCE-ID overrides.
//
// Time conversion: TZID → IANA via the CLDR map, then Intl does the DST
// math. Outlook's own VTIMEZONE blocks are degenerate (STANDARD == DAYLIGHT,
// no transition rules) and only serve as a fixed-offset fallback for TZIDs
// the map does not know.
import { RRULE_MAX_ITERATIONS } from '../core/constants.js';
import { windowsTzidToIana } from './windows-timezones.js';

// ─── Parsed structures ──────────────────────────────────────────────────

export interface IcsDateTime {
  readonly value: string;       // 20260717T100000 | 20260717T100000Z | 20260717
  readonly tzid: string | null;
  readonly isDate: boolean;     // VALUE=DATE — all-day
}

export interface IcsEvent {
  readonly uid: string;
  readonly summary: string;
  readonly dtStart: IcsDateTime;
  readonly dtEnd: IcsDateTime | null;
  readonly status: string;       // CONFIRMED | CANCELLED | …
  readonly busyStatus: string;   // X-MICROSOFT-CDO-BUSYSTATUS value
  readonly rrule: string;        // raw RRULE value, '' when non-recurring
  readonly exdates: readonly IcsDateTime[];
  readonly recurrenceId: IcsDateTime | null;
}

export interface ParsedIcs {
  readonly events: readonly IcsEvent[];
  // TZID → fixed offset minutes (STANDARD TZOFFSETTO) — fallback only.
  readonly tzOffsets: ReadonlyMap<string, number>;
}

/** One materialized event instance (series expanded, overrides applied). */
export interface IcsOccurrence {
  readonly uid: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly title: string;
  readonly busyStatus: string;
  readonly allDay: boolean;
  readonly cancelled: boolean;
  readonly recurring: boolean;
}

// ─── Line unfolding + property split ────────────────────────────────────

/** RFC 5545 unfolding: a line starting with space/tab continues the previous one. */
export function unfoldIcsLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r\n|\n|\r/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out.filter(l => l.length > 0);
}

interface IcsProperty {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
}

/** Split NAME;PARAM=V;PARAM="quoted":value — quotes may protect ':' and ';'. */
function parseProperty(line: string): IcsProperty | null {
  let inQuotes = false;
  let colonAt = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) { colonAt = i; break; }
  }
  if (colonAt < 0) return null;

  const head = line.slice(0, colonAt);
  const value = line.slice(colonAt + 1);
  const segments: string[] = [];
  let seg = '';
  inQuotes = false;
  for (const ch of head) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ';' && !inQuotes) { segments.push(seg); seg = ''; continue; }
    seg += ch;
  }
  segments.push(seg);

  const name = segments[0].toUpperCase();
  const params: Record<string, string> = {};
  for (const p of segments.slice(1)) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

/** Unescape RFC 5545 text values: \n \, \; \\ */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch);
}

function toIcsDateTime(prop: IcsProperty): IcsDateTime {
  return {
    value: prop.value.trim(),
    tzid: prop.params['TZID'] ?? null,
    isDate: prop.params['VALUE'] === 'DATE' || /^\d{8}$/.test(prop.value.trim()),
  };
}

// ─── Calendar parse ─────────────────────────────────────────────────────

export function parseIcs(text: string): ParsedIcs {
  const lines = unfoldIcsLines(text);
  const events: IcsEvent[] = [];
  const tzOffsets = new Map<string, number>();

  let inEvent = false;
  let ev: {
    uid: string; summary: string; status: string; busyStatus: string; rrule: string;
    dtStart: IcsDateTime | null; dtEnd: IcsDateTime | null;
    exdates: IcsDateTime[]; recurrenceId: IcsDateTime | null;
  } | null = null;

  let tzId: string | null = null;
  let tzInStandard = false;
  let inTimezone = false;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      ev = { uid: '', summary: '', status: '', busyStatus: '', rrule: '', dtStart: null, dtEnd: null, exdates: [], recurrenceId: null };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (ev?.uid && ev.dtStart) {
        events.push({
          uid: ev.uid, summary: ev.summary, dtStart: ev.dtStart, dtEnd: ev.dtEnd,
          status: ev.status, busyStatus: ev.busyStatus, rrule: ev.rrule,
          exdates: ev.exdates, recurrenceId: ev.recurrenceId,
        });
      }
      inEvent = false;
      ev = null;
      continue;
    }
    if (line === 'BEGIN:VTIMEZONE') { inTimezone = true; tzId = null; continue; }
    if (line === 'END:VTIMEZONE') { inTimezone = false; continue; }
    if (inTimezone) {
      if (line === 'BEGIN:STANDARD') { tzInStandard = true; continue; }
      if (line === 'END:STANDARD') { tzInStandard = false; continue; }
      const prop = parseProperty(line);
      if (!prop) continue;
      if (prop.name === 'TZID') tzId = prop.value.trim();
      if (prop.name === 'TZOFFSETTO' && tzInStandard && tzId && !tzOffsets.has(tzId)) {
        const m = prop.value.trim().match(/^([+-])(\d{2})(\d{2})$/);
        if (m) tzOffsets.set(tzId, (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])));
      }
      continue;
    }
    if (!inEvent || !ev) continue;

    const prop = parseProperty(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID': ev.uid = prop.value.trim(); break;
      case 'SUMMARY': ev.summary = unescapeText(prop.value).trim(); break;
      case 'STATUS': ev.status = prop.value.trim().toUpperCase(); break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS': ev.busyStatus = prop.value.trim().toUpperCase(); break;
      case 'RRULE': ev.rrule = prop.value.trim(); break;
      case 'DTSTART': ev.dtStart = toIcsDateTime(prop); break;
      case 'DTEND': ev.dtEnd = toIcsDateTime(prop); break;
      case 'RECURRENCE-ID': ev.recurrenceId = toIcsDateTime(prop); break;
      case 'EXDATE':
        // May carry several comma-separated values on one line.
        for (const v of prop.value.split(',')) {
          const single: IcsProperty = { name: prop.name, params: prop.params, value: v };
          ev.exdates.push(toIcsDateTime(single));
        }
        break;
    }
  }

  return { events, tzOffsets };
}

// ─── Wall time → UTC ────────────────────────────────────────────────────

interface LocalTime { y: number; mo: number; d: number; h: number; mi: number; s: number }

function parseIcsValue(value: string): LocalTime | null {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/);
  if (!m) return null;
  return {
    y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]),
    h: Number(m[4] ?? 0), mi: Number(m[5] ?? 0), s: Number(m[6] ?? 0),
  };
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getDtf(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = getDtf(timeZone).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find(p => p.type === t)?.value ?? 0);
  let hour = get('hour');
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asUtc - utcMs;
}

/** UTC ms of a wall-clock time in an IANA zone (two-pass DST refinement). */
export function zonedTimeToUtc(t: LocalTime, timeZone: string): number {
  const guess = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  const utc1 = guess - tzOffsetMs(guess, timeZone);
  return guess - tzOffsetMs(utc1, timeZone);
}

function isValidIanaZone(tz: string): boolean {
  if (dtfCache.has(tz)) return true;
  try { getDtf(tz); return true; } catch { return false; }
}

/**
 * Resolve an ICS date/datetime to UTC ms. Resolution order for TZID:
 * IANA-as-is → CLDR Windows map → VTIMEZONE fixed offset → fallback zone.
 * VALUE=DATE resolves as midnight in the fallback (config) zone.
 */
export function resolveIcsTime(
  dt: IcsDateTime,
  tzOffsets: ReadonlyMap<string, number>,
  fallbackTimezone: string,
): number | null {
  const t = parseIcsValue(dt.value);
  if (!t) return null;

  if (dt.isDate) return zonedTimeToUtc(t, fallbackTimezone);
  if (dt.value.endsWith('Z')) return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);

  if (dt.tzid) {
    if (isValidIanaZone(dt.tzid)) return zonedTimeToUtc(t, dt.tzid);
    const iana = windowsTzidToIana(dt.tzid);
    if (iana && isValidIanaZone(iana)) return zonedTimeToUtc(t, iana);
    const fixed = tzOffsets.get(dt.tzid);
    if (fixed !== undefined) return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - fixed * 60_000;
  }
  return zonedTimeToUtc(t, fallbackTimezone);
}

// ─── RRULE ──────────────────────────────────────────────────────────────

interface ByDay { readonly ord: number; readonly weekday: number } // weekday 0=MO..6=SU, ord 0 = every

interface Rrule {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  readonly interval: number;
  readonly count: number | null;
  readonly until: IcsDateTime | null;
  readonly byDay: readonly ByDay[];
  readonly byMonthDay: readonly number[];
  readonly byMonth: readonly number[];
  readonly wkst: number;
}

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

function parseRrule(raw: string): Rrule | null {
  const parts: Record<string, string> = {};
  for (const p of raw.split(';')) {
    const eq = p.indexOf('=');
    if (eq > 0) parts[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  const freq = parts['FREQ'];
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const byDay: ByDay[] = [];
  if (parts['BYDAY']) {
    for (const token of parts['BYDAY'].split(',')) {
      const m = token.trim().match(/^([+-]?\d+)?([A-Z]{2})$/);
      if (!m) continue;
      const weekday = WEEKDAYS.indexOf(m[2]);
      if (weekday < 0) continue;
      byDay.push({ ord: m[1] ? Number(m[1]) : 0, weekday });
    }
  }

  return {
    freq,
    interval: Math.max(1, Number(parts['INTERVAL'] ?? 1) || 1),
    count: parts['COUNT'] ? Number(parts['COUNT']) : null,
    until: parts['UNTIL']
      ? { value: parts['UNTIL'], tzid: null, isDate: /^\d{8}$/.test(parts['UNTIL']) }
      : null,
    byDay,
    byMonthDay: (parts['BYMONTHDAY'] ?? '').split(',').map(Number).filter(n => Number.isInteger(n) && n !== 0),
    byMonth: (parts['BYMONTH'] ?? '').split(',').map(Number).filter(n => n >= 1 && n <= 12),
    wkst: Math.max(0, WEEKDAYS.indexOf(parts['WKST'] ?? 'MO')),
  };
}

// Calendar-day arithmetic in UTC space (dates only, no wall-clock meaning).
const DAY_MS = 86_400_000;

function dayNumber(y: number, mo: number, d: number): number {
  return Date.UTC(y, mo - 1, d) / DAY_MS;
}

function fromDayNumber(day: number): { y: number; mo: number; d: number } {
  const dt = new Date(day * DAY_MS);
  return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 0=MO..6=SU */
function weekdayOfDay(day: number): number {
  return (new Date(day * DAY_MS).getUTCDay() + 6) % 7;
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/** Day-of-month of the ord-th weekday (1st/2nd/…/-1=last), or null. */
function nthWeekdayOfMonth(y: number, mo: number, ord: number, weekday: number): number | null {
  const total = daysInMonth(y, mo);
  if (ord > 0) {
    const firstDow = weekdayOfDay(dayNumber(y, mo, 1));
    const day = 1 + ((weekday - firstDow + 7) % 7) + (ord - 1) * 7;
    return day <= total ? day : null;
  }
  const lastDow = weekdayOfDay(dayNumber(y, mo, total));
  const day = total - ((lastDow - weekday + 7) % 7) + (ord + 1) * 7;
  return day >= 1 ? day : null;
}

/**
 * Candidate occurrence days (day numbers) of a series, in order, starting at
 * DTSTART's day. Pure calendar pattern — COUNT/UNTIL/window bounds are
 * enforced by the caller, which stops pulling.
 */
function* candidateDays(rule: Rrule, start: { y: number; mo: number; d: number }): Generator<number> {
  const startDay = dayNumber(start.y, start.mo, start.d);

  if (rule.freq === 'DAILY') {
    for (let k = 0; ; k++) yield startDay + k * rule.interval;
  }

  if (rule.freq === 'WEEKLY') {
    if (rule.byDay.length === 0) {
      for (let k = 0; ; k++) yield startDay + k * 7 * rule.interval;
    }
    const weekdays = new Set(rule.byDay.map(b => b.weekday));
    const weekStartOf = (day: number): number => day - ((weekdayOfDay(day) - rule.wkst + 7) % 7);
    const anchorWeek = weekStartOf(startDay);
    for (let day = startDay; ; day++) {
      if (!weekdays.has(weekdayOfDay(day))) continue;
      const weekIndex = (weekStartOf(day) - anchorWeek) / 7;
      if (weekIndex % rule.interval === 0) yield day;
    }
  }

  if (rule.freq === 'MONTHLY') {
    for (let k = 0; ; k++) {
      const total = (start.mo - 1) + k * rule.interval;
      const y = start.y + Math.floor(total / 12);
      const mo = (total % 12) + 1;
      yield* daysWithinMonth(rule, y, mo, start.d);
    }
  }

  if (rule.freq === 'YEARLY') {
    for (let k = 0; ; k++) {
      const y = start.y + k * rule.interval;
      const months = rule.byMonth.length > 0 ? rule.byMonth : [start.mo];
      for (const mo of months) yield* daysWithinMonth(rule, y, mo, start.d);
    }
  }
}

function* daysWithinMonth(rule: Rrule, y: number, mo: number, fallbackDom: number): Generator<number> {
  if (rule.byMonthDay.length > 0) {
    const total = daysInMonth(y, mo);
    for (const dom of [...rule.byMonthDay].sort((a, b) => a - b)) {
      const day = dom > 0 ? dom : total + dom + 1;
      if (day >= 1 && day <= total) yield dayNumber(y, mo, day);
    }
    return;
  }
  if (rule.byDay.length > 0) {
    const days: number[] = [];
    for (const b of rule.byDay) {
      if (b.ord !== 0) {
        const dom = nthWeekdayOfMonth(y, mo, b.ord, b.weekday);
        if (dom !== null) days.push(dayNumber(y, mo, dom));
      } else {
        // Every matching weekday of the month (rare in Outlook feeds).
        for (let dom = 1; dom <= daysInMonth(y, mo); dom++) {
          const day = dayNumber(y, mo, dom);
          if (weekdayOfDay(day) === b.weekday) days.push(day);
        }
      }
    }
    yield* days.sort((a, b) => a - b);
    return;
  }
  if (fallbackDom <= daysInMonth(y, mo)) yield dayNumber(y, mo, fallbackDom);
}

// ─── Expansion ──────────────────────────────────────────────────────────

interface SeriesContext {
  readonly tzOffsets: ReadonlyMap<string, number>;
  readonly fallbackTimezone: string;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

/** Occurrence start times (UTC ms) of a recurring master within the window. */
function expandSeriesStarts(event: IcsEvent, ctx: SeriesContext): number[] {
  const rule = parseRrule(event.rrule);
  const start = parseIcsValue(event.dtStart.value);
  if (!rule || !start) return [];

  const untilMs = rule.until
    ? resolveIcsTime(rule.until.isDate
        ? { ...rule.until, isDate: true }
        : rule.until, ctx.tzOffsets, ctx.fallbackTimezone)
    : null;
  // Date-only UNTIL bounds the whole last day.
  const untilBoundMs = untilMs !== null && rule.until?.isDate ? untilMs + DAY_MS - 1 : untilMs;

  const exdateMs = new Set<number>();
  for (const ex of event.exdates) {
    const ms = resolveIcsTime(ex, ctx.tzOffsets, ctx.fallbackTimezone);
    if (ms !== null) exdateMs.add(ms);
  }

  const starts: number[] = [];
  const seriesStartDay = dayNumber(start.y, start.mo, start.d);
  let generated = 0;
  let iterations = 0;
  for (const day of candidateDays(rule, start)) {
    if (++iterations > RRULE_MAX_ITERATIONS) break;
    // Pattern days before DTSTART (first month/year of the series) are not
    // occurrences and must not consume COUNT.
    if (day < seriesStartDay) continue;
    const { y, mo, d } = fromDayNumber(day);
    const occMs = event.dtStart.isDate
      ? resolveIcsTime({ value: formatIcsDate(y, mo, d), tzid: null, isDate: true }, ctx.tzOffsets, ctx.fallbackTimezone)
      : resolveIcsTime(
          { value: `${formatIcsDate(y, mo, d)}T${pad2(start.h)}${pad2(start.mi)}${pad2(start.s)}`, tzid: event.dtStart.tzid, isDate: false },
          ctx.tzOffsets, ctx.fallbackTimezone);
    if (occMs === null) continue;

    generated++;
    if (rule.count !== null && generated > rule.count) break;
    if (untilBoundMs !== null && occMs > untilBoundMs) break;
    if (occMs > ctx.windowEndMs) break;
    if (exdateMs.has(occMs)) continue;
    starts.push(occMs);
  }
  return starts;
}

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function formatIcsDate(y: number, mo: number, d: number): string { return `${y}${pad2(mo)}${pad2(d)}`; }

/** DTEND−DTSTART in ms; all-day defaults to one day, timed to zero. */
function eventDurationMs(event: IcsEvent, ctx: SeriesContext): number {
  const startMs = resolveIcsTime(event.dtStart, ctx.tzOffsets, ctx.fallbackTimezone);
  const endMs = event.dtEnd ? resolveIcsTime(event.dtEnd, ctx.tzOffsets, ctx.fallbackTimezone) : null;
  if (startMs !== null && endMs !== null && endMs >= startMs) return endMs - startMs;
  return event.dtStart.isDate ? DAY_MS : 0;
}

/**
 * Expand a parsed calendar into concrete instances overlapping the window
 * (endMs ≥ windowStart AND startMs ≤ windowEnd — a multi-day OOF that began
 * before the window still shows). RECURRENCE-ID overrides replace the
 * generated occurrence they point at; an override inherits master's
 * title/busyStatus when it carries none of its own.
 */
export function expandInstances(
  parsed: ParsedIcs,
  windowStartMs: number,
  windowEndMs: number,
  fallbackTimezone: string,
): IcsOccurrence[] {
  const ctx: SeriesContext = { tzOffsets: parsed.tzOffsets, fallbackTimezone, windowStartMs, windowEndMs };

  const masters = new Map<string, IcsEvent>();
  const overrides = new Map<string, IcsEvent[]>();
  for (const ev of parsed.events) {
    if (ev.recurrenceId) {
      const list = overrides.get(ev.uid) ?? [];
      list.push(ev);
      overrides.set(ev.uid, list);
    } else {
      masters.set(ev.uid, ev);
    }
  }

  const out: IcsOccurrence[] = [];
  const inWindow = (startMs: number, endMs: number): boolean =>
    endMs >= windowStartMs && startMs <= windowEndMs;

  const pushInstance = (ev: IcsEvent, startMs: number, endMs: number, recurring: boolean, master?: IcsEvent): void => {
    if (!inWindow(startMs, endMs)) return;
    out.push({
      uid: ev.uid,
      startMs,
      endMs,
      title: ev.summary || master?.summary || '',
      busyStatus: ev.busyStatus || master?.busyStatus || '',
      allDay: ev.dtStart.isDate,
      cancelled: ev.status === 'CANCELLED',
      recurring,
    });
  };

  for (const [uid, master] of masters) {
    const duration = eventDurationMs(master, ctx);

    if (!master.rrule) {
      const startMs = resolveIcsTime(master.dtStart, ctx.tzOffsets, fallbackTimezone);
      if (startMs !== null) pushInstance(master, startMs, startMs + duration, false);
      continue;
    }

    const replacedStarts = new Set<number>();
    for (const ov of overrides.get(uid) ?? []) {
      const rid = resolveIcsTime(ov.recurrenceId!, ctx.tzOffsets, fallbackTimezone);
      if (rid !== null) replacedStarts.add(rid);
    }
    for (const startMs of expandSeriesStarts(master, ctx)) {
      if (replacedStarts.has(startMs)) continue;
      pushInstance(master, startMs, startMs + duration, true);
    }
  }

  // Overrides are instances in their own right (moved/edited occurrences) —
  // also covers orphan overrides whose master fell outside the feed.
  for (const [uid, list] of overrides) {
    const master = masters.get(uid);
    for (const ov of list) {
      const startMs = resolveIcsTime(ov.dtStart, ctx.tzOffsets, fallbackTimezone);
      if (startMs === null) continue;
      const duration = eventDurationMs(ov.dtEnd ? ov : (master ?? ov), ctx);
      pushInstance(ov, startMs, startMs + duration, true, master);
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.uid.localeCompare(b.uid));
  return out;
}
