/**
 * Unit tests for the ICS parser: line unfolding, VEVENT extraction, Windows
 * TZID → IANA time resolution (DST-correct), VTIMEZONE fixed-offset fallback,
 * and recurrence expansion (WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT/UNTIL,
 * EXDATE, RECURRENCE-ID overrides, window overlap).
 *
 * Run: npx tsx tests/unit/ics-parser.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 */
import assert from 'node:assert/strict';
import { expandInstances, parseIcs, unfoldIcsLines } from '../../src/collectors/ics-parser.js';
import type { IcsOccurrence } from '../../src/collectors/ics-parser.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

function ics(...blocks: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', ...blocks, 'END:VCALENDAR'].join('\r\n');
}

function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

const MOSCOW_TZ = 'TZID=Russian Standard Time';

function expand(text: string, fromUtc: number, toUtc: number, tz: string = 'UTC'): IcsOccurrence[] {
  return expandInstances(parseIcs(text), fromUtc, toUtc, tz);
}

const JUL_2026 = { from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 7, 1) };

// ─── Unfolding & basic parse ─────────────────────────────────────────────

test('unfolding: continuation lines merge, leading marker char dropped', () => {
  const lines = unfoldIcsLines('SUMMARY:Hello\r\n  wor\r\n\tld\r\nUID:1');
  assert.deepEqual(lines, ['SUMMARY:Hello world', 'UID:1']);
});

test('parse: uid/summary/busyStatus/status extracted, text unescaped', () => {
  const text = ics(vevent(
    'UID:ev-1',
    'SUMMARY:Foo\\, bar\\nbaz',
    'STATUS:CONFIRMED',
    'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
    `DTSTART;${MOSCOW_TZ}:20260716T140000`,
    `DTEND;${MOSCOW_TZ}:20260716T150000`,
  ));
  const parsed = parseIcs(text);
  assert.equal(parsed.events.length, 1);
  const ev = parsed.events[0];
  assert.equal(ev.uid, 'ev-1');
  assert.equal(ev.summary, 'Foo, bar\nbaz');
  assert.equal(ev.status, 'CONFIRMED');
  assert.equal(ev.busyStatus, 'BUSY');
});

// ─── Time resolution ─────────────────────────────────────────────────────

test('Windows TZID → IANA: Moscow 14:00 = 11:00Z', () => {
  const text = ics(vevent(
    'UID:ev-1',
    `DTSTART;${MOSCOW_TZ}:20260716T140000`,
    `DTEND;${MOSCOW_TZ}:20260716T150000`,
  ));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.equal(out.length, 1);
  assert.equal(out[0].startMs, Date.UTC(2026, 6, 16, 11, 0, 0));
  assert.equal(out[0].endMs, Date.UTC(2026, 6, 16, 12, 0, 0));
  assert.equal(out[0].allDay, false);
});

test('DST-aware zone: W. Europe 10:00 is 09:00Z in winter, 08:00Z in summer', () => {
  const winter = ics(vevent('UID:w', 'DTSTART;TZID=W. Europe Standard Time:20260116T100000'));
  const summer = ics(vevent('UID:s', 'DTSTART;TZID=W. Europe Standard Time:20260716T100000'));
  const w = expand(winter, Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
  const s = expand(summer, JUL_2026.from, JUL_2026.to);
  assert.equal(w[0].startMs, Date.UTC(2026, 0, 16, 9, 0, 0));
  assert.equal(s[0].startMs, Date.UTC(2026, 6, 16, 8, 0, 0));
});

test('UTC form (trailing Z) resolves directly', () => {
  const text = ics(vevent('UID:z', 'DTSTART:20260716T120000Z', 'DTEND:20260716T123000Z'));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.equal(out[0].startMs, Date.UTC(2026, 6, 16, 12, 0, 0));
});

test('all-day VALUE=DATE: midnight in fallback zone, default one-day span', () => {
  const text = ics(vevent('UID:a', 'DTSTART;VALUE=DATE:20260716', 'DTEND;VALUE=DATE:20260717'));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.equal(out[0].startMs, Date.UTC(2026, 6, 16));
  assert.equal(out[0].endMs, Date.UTC(2026, 6, 17));
  assert.equal(out[0].allDay, true);
});

test('unknown TZID falls back to VTIMEZONE fixed offset', () => {
  const tz = [
    'BEGIN:VTIMEZONE', 'TZID:Custom Zone Time',
    'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0330', 'TZOFFSETTO:+0330', 'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\r\n');
  const text = ics(tz, vevent('UID:c', 'DTSTART;TZID=Custom Zone Time:20260716T100000'));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.equal(out[0].startMs, Date.UTC(2026, 6, 16, 6, 30, 0));
});

test('unknown TZID without VTIMEZONE falls back to the config zone', () => {
  const text = ics(vevent('UID:u', 'DTSTART;TZID=No Such Zone:20260716T100000'));
  const out = expand(text, JUL_2026.from, JUL_2026.to, 'Europe/Moscow');
  assert.equal(out[0].startMs, Date.UTC(2026, 6, 16, 7, 0, 0));
});

// ─── Recurrence expansion ────────────────────────────────────────────────

test('weekly BYDAY=MO,WE with inclusive UNTIL', () => {
  // 2026-07-06 is a Monday; UNTIL 2026-07-15T07:00Z == that Wednesday 10:00 MSK.
  const text = ics(vevent(
    'UID:wk',
    `DTSTART;${MOSCOW_TZ}:20260706T100000`,
    `DTEND;${MOSCOW_TZ}:20260706T103000`,
    'RRULE:FREQ=WEEKLY;UNTIL=20260715T070000Z;INTERVAL=1;BYDAY=MO,WE;WKST=SU',
  ));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.deepEqual(out.map(o => o.startMs), [
    Date.UTC(2026, 6, 6, 7), Date.UTC(2026, 6, 8, 7),
    Date.UTC(2026, 6, 13, 7), Date.UTC(2026, 6, 15, 7),
  ]);
  assert.ok(out.every(o => o.recurring));
});

test('biweekly INTERVAL=2 skips the in-between week', () => {
  const text = ics(vevent(
    'UID:bi',
    `DTSTART;${MOSCOW_TZ}:20260706T100000`,
    'RRULE:FREQ=WEEKLY;UNTIL=20270101T000000Z;INTERVAL=2;BYDAY=MO;WKST=SU',
  ));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.deepEqual(out.map(o => o.startMs), [Date.UTC(2026, 6, 6, 7), Date.UTC(2026, 6, 20, 7)]);
});

test('EXDATE removes its occurrence', () => {
  const text = ics(vevent(
    'UID:ex',
    `DTSTART;${MOSCOW_TZ}:20260706T100000`,
    'RRULE:FREQ=WEEKLY;UNTIL=20260721T000000Z;INTERVAL=1;BYDAY=MO;WKST=SU',
    `EXDATE;${MOSCOW_TZ}:20260713T100000`,
  ));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.deepEqual(out.map(o => o.startMs), [Date.UTC(2026, 6, 6, 7), Date.UTC(2026, 6, 20, 7)]);
});

test('COUNT bounds the series from DTSTART', () => {
  const text = ics(vevent(
    'UID:cnt',
    'DTSTART:20260706T100000Z',
    'RRULE:FREQ=DAILY;COUNT=3;INTERVAL=1',
  ));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.deepEqual(out.map(o => o.startMs), [
    Date.UTC(2026, 6, 6, 10), Date.UTC(2026, 6, 7, 10), Date.UTC(2026, 6, 8, 10),
  ]);
});

test('RECURRENCE-ID override moves an occurrence, inherits busyStatus', () => {
  const master = vevent(
    'UID:ov',
    'SUMMARY:Series',
    'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
    `DTSTART;${MOSCOW_TZ}:20260706T100000`,
    `DTEND;${MOSCOW_TZ}:20260706T103000`,
    'RRULE:FREQ=WEEKLY;UNTIL=20260721T000000Z;INTERVAL=1;BYDAY=MO;WKST=SU',
  );
  const override = vevent(
    'UID:ov',
    'SUMMARY:Series (moved)',
    `RECURRENCE-ID;${MOSCOW_TZ}:20260713T100000`,
    `DTSTART;${MOSCOW_TZ}:20260713T150000`,
    `DTEND;${MOSCOW_TZ}:20260713T153000`,
  );
  const out = expand(ics(master, override), JUL_2026.from, JUL_2026.to);
  assert.deepEqual(out.map(o => o.startMs), [
    Date.UTC(2026, 6, 6, 7), Date.UTC(2026, 6, 13, 12), Date.UTC(2026, 6, 20, 7),
  ]);
  const moved = out[1];
  assert.equal(moved.title, 'Series (moved)');
  assert.equal(moved.busyStatus, 'BUSY');
  assert.equal(moved.endMs - moved.startMs, 30 * 60_000);
});

test('monthly BYMONTHDAY hits the same day each month', () => {
  const text = ics(vevent(
    'UID:mo',
    'DTSTART:20260415T120000Z',
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=15;INTERVAL=1;UNTIL=20270101T000000Z',
  ));
  const out = expand(text, Date.UTC(2026, 5, 1), Date.UTC(2026, 7, 1));
  assert.deepEqual(out.map(o => o.startMs), [Date.UTC(2026, 5, 15, 12), Date.UTC(2026, 6, 15, 12)]);
});

test('yearly BYDAY=-1SU;BYMONTH=10 → last Sunday of October', () => {
  const text = ics(vevent(
    'UID:yr',
    'DTSTART;VALUE=DATE:20251026',
    'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  ));
  const out = expand(text, Date.UTC(2026, 9, 1), Date.UTC(2026, 10, 1));
  assert.equal(out.length, 1);
  assert.equal(out[0].startMs, Date.UTC(2026, 9, 25));
});

test('window overlap: multi-day event straddling the window start is kept', () => {
  const text = ics(vevent('UID:oof', 'DTSTART;VALUE=DATE:20260628', 'DTEND;VALUE=DATE:20260703'));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.equal(out.length, 1);
  assert.equal(out[0].startMs, Date.UTC(2026, 5, 28));
});

test('occurrence fully before the window is dropped', () => {
  const text = ics(vevent('UID:old', 'DTSTART:20260601T100000Z', 'DTEND:20260601T110000Z'));
  const out = expand(text, JUL_2026.from, JUL_2026.to);
  assert.equal(out.length, 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
