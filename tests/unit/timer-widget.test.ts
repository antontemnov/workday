/**
 * Unit tests for the desktop widget's tray side. Which timers are on the
 * desktop and whether the widget exists at all (the setting, a row to show);
 * the plate's size for its rows — the height is exact, the width is the
 * least one, three characters wider past the hour; the plate's mouse: a
 * press becomes a drag only past a threshold, the body moves, an edge sets
 * the width, buttons never drag; and the main window's service: it hands the
 * widget its rows only when they change, passes the stored place along,
 * keeps the place the widget reports, and routes the widget's clicks.
 *
 * Headless: fake clock, a fake Tauri bridge (invoke + events) on `window`.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/timer-widget.test.ts
 */
import assert from 'node:assert/strict';

// ─── Fake clock ───────────────────────────────────────────────────────────
let nowMs = 1_700_000_000_000;
Date.now = () => nowMs;

// ─── Fake Tauri bridge (installed before the modules load) ────────────────
interface Call { readonly cmd: string; readonly args: Record<string, unknown> }
type Listener = (event: { event: string; id: number; payload: unknown }) => void;
const calls: Call[] = [];
const callbacks = new Map<number, Listener>();
const listeners = new Map<string, Listener>();
let callbackSeq = 0;
let prefsFile: string | null = null;
let failNextSync = false;

(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (callback: Listener): number => {
      callbacks.set(++callbackSeq, callback);
      return callbackSeq;
    },
    invoke: async (cmd: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      if (cmd === 'plugin:event|listen') {
        listeners.set(args['event'] as string, callbacks.get(args['handler'] as number) as Listener);
        return callbackSeq;
      }
      if (cmd === 'load_prefs') return prefsFile;
      if (cmd === 'save_prefs') {
        prefsFile = args['json'] as string;
        return undefined;
      }
      calls.push({ cmd, args });
      if (cmd === 'sync_widget' && failNextSync) {
        failNextSync = false;
        throw new Error('window is busy');
      }
      return undefined;
    },
  },
};

const fire = (event: string, payload: unknown): void => {
  const listener = listeners.get(event);
  assert.ok(listener, `a listener for ${event}`);
  listener({ event, id: 1, payload });
};
const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { TimerState } = await import('../../tray-app/src/app/models/workday.models');
const {
  parseWidgetGeometry, showsHours, WIDGET_GEOMETRY_PREF, widgetLayout, widgetPayload, widgetRows,
} = await import('../../tray-app/src/app/timer/timer-widget.util');
const { TimerWidgetComponent } = await import('../../tray-app/src/app/timer/timer-widget.component');
const { TimerWidgetService } = await import('../../tray-app/src/app/timer/timer-widget.service');
const { loadTrayPrefs, readPref } = await import('../../tray-app/src/app/services/tray-prefs.store');
import type { TimerView, TimersResponse } from '../../tray-app/src/app/models/workday.models';
import type { WidgetAction, WidgetGeometry, WidgetGrab, WidgetLayout } from '../../tray-app/src/app/timer/timer-widget.util';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err as Error).message}`);
  }
}

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (): string => new Date(nowMs).toISOString();

function timer(id: string, state: TimerView['state'], over: Partial<TimerView> = {}): TimerView {
  return {
    id, state, entryId: null, task: null, activity: null, added: false, description: '',
    totalMs: 12 * MINUTE, shareMs: 12 * MINUTE, handMinutes: 0, hidden: false, touchedAt: iso(), ...over,
  };
}

function response(timers: readonly TimerView[], desktopWidget = true): TimersResponse {
  return { date: '2026-11-16', asOf: iso(), counting: 'none', desktopWidget, timers };
}

const DEPLOY = timer('deploy', TimerState.Running, { entryId: 'e1', task: 'ATL-6790', description: 'staging release', totalMs: 38 * MINUTE });
const CALL = timer('call', TimerState.Paused, { description: 'reports call' });
const REVIEW = timer('review', TimerState.Paused, { entryId: 'e2', task: 'ATL-6712', description: 'PR review', hidden: true });

// ─── What is on the desktop ───────────────────────────────────────────────

await test('rows: every timer not taken off the desktop, in the island\'s order', () => {
  assert.deepEqual(widgetRows([REVIEW, CALL, DEPLOY]).map(t => t.id), ['call', 'deploy']);
});

await test('the widget exists while the setting is on and there is a row', () => {
  assert.equal(widgetPayload(null), null, 'no timers from the daemon');
  assert.equal(widgetPayload(response([CALL, DEPLOY], false)), null, 'switched off in Settings');
  assert.equal(widgetPayload(response([])), null, 'no timers today');
  assert.equal(widgetPayload(response([REVIEW])), null, 'every row hidden');
  const payload = widgetPayload(response([REVIEW, CALL, DEPLOY]));
  assert.deepEqual(payload?.timers.map(t => t.id), ['call', 'deploy']);
  assert.equal(payload?.asOf, iso());
});

// ─── The plate's size ─────────────────────────────────────────────────────

await test('layout: the height is the rows, the width is the least one', () => {
  const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  assert.equal(widgetLayout(1, false).minWidth, 104);
  close(widgetLayout(1, false).height, 26.04);
  assert.equal(widgetLayout(2, false).minWidth, 168, 'a list keeps the key in sight');
  close(widgetLayout(2, false).height, 52.08);
  close(widgetLayout(3, false).height, 76.02);
  assert.equal(widgetLayout(1, true).minWidth, 123, 'an hour\'s digits need room');
  assert.equal(widgetLayout(3, true).minWidth, 187);
  assert.equal(widgetLayout(0, false).height, 0);
});

await test('past the hour: only a time that prints seconds grows', () => {
  const at = nowMs;
  const loose = timer('a', TimerState.Running, { totalMs: HOUR - SECOND });
  assert.equal(showsHours([loose], at, at), false);
  assert.equal(showsHours([loose], at, at + SECOND), true, '1h 00m 00s');
  const record = timer('b', TimerState.Paused, { entryId: 'e1', task: 'ATL-1', totalMs: 62 * MINUTE });
  assert.equal(showsHours([record], at, at), false, 'a record at rest reads 1h 02m — it fits');
  assert.equal(showsHours([{ ...record, state: TimerState.Waiting }], at, at), true);
});

await test('stored place: read back only when it is whole', () => {
  const stored: WidgetGeometry = { anchorX: 1905, anchorY: 1017, fromRight: true, fromBottom: true, width: 262 };
  assert.deepEqual(parseWidgetGeometry(JSON.stringify(stored)), stored);
  assert.equal(parseWidgetGeometry(null), null);
  assert.equal(parseWidgetGeometry('not json'), null);
  assert.equal(parseWidgetGeometry('null'), null);
  assert.equal(parseWidgetGeometry(JSON.stringify({ ...stored, width: 0 })), null);
  assert.equal(parseWidgetGeometry(JSON.stringify({ ...stored, anchorX: 12.5 })), null);
  assert.equal(parseWidgetGeometry(JSON.stringify({ anchorX: 1, anchorY: 2, width: 262 })), null);
});

// ─── The plate ────────────────────────────────────────────────────────────

interface PlateHarness {
  comp: InstanceType<typeof TimerWidgetComponent>;
  layouts: WidgetLayout[];
  grabs: WidgetGrab[];
  drags: () => number;
  releases: () => number;
  opens: () => number;
  /** A poll: the same or other rows with a fresh moment. */
  rows: (timers: readonly TimerView[]) => void;
}

function makePlate(timers: readonly TimerView[]): PlateHarness {
  const comp = new TimerWidgetComponent();
  const layouts: WidgetLayout[] = [];
  const grabs: WidgetGrab[] = [];
  let drags = 0;
  let releases = 0;
  let opens = 0;
  comp.layoutChanged.subscribe((l: WidgetLayout) => layouts.push(l));
  comp.grabbed.subscribe((g: WidgetGrab) => grabs.push(g));
  comp.dragged.subscribe(() => { drags++; });
  comp.released.subscribe(() => { releases++; });
  comp.opened.subscribe(() => { opens++; });
  const rows = (next: readonly TimerView[]): void => {
    comp.timers = next;
    comp.asOf = iso();
    comp.ngOnChanges();
  };
  rows(timers);
  return { comp, layouts, grabs, drags: () => drags, releases: () => releases, opens: () => opens, rows };
}

await test('plate: the window is fitted when the rows change, not on every poll', () => {
  const h = makePlate([DEPLOY]);
  assert.equal(h.layouts.length, 1);
  assert.equal(h.comp.list, false);
  h.rows([DEPLOY]);
  h.rows([{ ...DEPLOY, totalMs: 39 * MINUTE }]);
  assert.equal(h.layouts.length, 1, 'the same rows — the window stays as it is');
  h.rows([DEPLOY, CALL]);
  assert.equal(h.layouts.length, 2);
  assert.equal(h.layouts[1].minWidth, 168);
  assert.equal(h.comp.list, true);
  h.rows([DEPLOY]);
  assert.equal(h.layouts.length, 3, 'back to one row');
  assert.equal(h.layouts[2].minWidth, 104);
});

await test('plate: a running timer crossing the hour widens the time column', () => {
  const h = makePlate([timer('a', TimerState.Running, { totalMs: HOUR - 30 * SECOND }), CALL]);
  assert.equal(h.comp.timeColumn, '7ch');
  nowMs += 30 * SECOND;
  h.comp.onMinute(); // the time node tells of the minute
  assert.equal(h.comp.hours, true);
  assert.equal(h.comp.timeColumn, '10ch');
  assert.equal(h.layouts.at(-1)?.minWidth, 187);
});

interface FakeTarget { closest(selector: string): unknown; captured: number[]; setPointerCapture(id: number): void }
const target = (inside: 'body' | 'button' | 'edge'): FakeTarget => ({
  captured: [],
  closest: (): unknown => (inside === 'body' ? null : {}),
  setPointerCapture(id: number): void { this.captured.push(id); },
});
const pointer = (el: FakeTarget, x: number, y: number, over: { button?: number; pointerId?: number } = {}): never =>
  ({ button: 0, pointerId: 1, screenX: x, screenY: y, target: el, currentTarget: el, stopPropagation(): void {}, ...over }) as never;

await test('mouse: a press on the body becomes a move only past the threshold', () => {
  const h = makePlate([DEPLOY]);
  const body = target('body');
  h.comp.onPress(pointer(body, 500, 500), 'move');
  assert.deepEqual(body.captured, [1], 'the pointer is held — the cursor may outrun the window');
  h.comp.onPointerMove(pointer(body, 501, 502));
  assert.deepEqual(h.grabs, [], 'a hand that trembles is not a drag');
  h.comp.onPointerMove(pointer(body, 504, 500));
  assert.deepEqual(h.grabs, ['move']);
  assert.equal(h.comp.dragging, true);
  h.comp.onPointerMove(pointer(body, 520, 480));
  assert.deepEqual(h.grabs, ['move'], 'grabbed once');
  assert.equal(h.drags(), 2);
  h.comp.onPointerEnd(pointer(body, 520, 480));
  assert.equal(h.releases(), 1);
  assert.equal(h.comp.dragging, false);
});

await test('mouse: a click is not a drag', () => {
  const h = makePlate([DEPLOY]);
  const body = target('body');
  h.comp.onPress(pointer(body, 500, 500), 'move');
  h.comp.onPointerEnd(pointer(body, 500, 500));
  assert.deepEqual(h.grabs, []);
  assert.equal(h.releases(), 0);
  h.comp.onPointerMove(pointer(body, 600, 600));
  assert.deepEqual(h.grabs, [], 'nothing is held after the button is up');
});

await test('mouse: an edge drags the width; a button never drags', () => {
  const h = makePlate([DEPLOY]);
  const edge = target('edge');
  h.comp.onPress(pointer(edge, 500, 500), 'left');
  h.comp.onPointerMove(pointer(edge, 490, 500));
  assert.deepEqual(h.grabs, ['left']);
  h.comp.onPointerEnd(pointer(edge, 490, 500));

  const button = target('button');
  h.comp.onPress(pointer(button, 500, 500), 'move');
  h.comp.onPointerMove(pointer(button, 560, 500));
  assert.deepEqual(h.grabs, ['left'], '⏸ / ▶ and hide are clicks');
  assert.deepEqual(button.captured, []);
});

await test('mouse: only the left button, only the pointer that pressed', () => {
  const h = makePlate([DEPLOY]);
  const body = target('body');
  h.comp.onPress(pointer(body, 500, 500, { button: 2 }), 'move');
  h.comp.onPointerMove(pointer(body, 560, 500));
  assert.deepEqual(h.grabs, []);

  h.comp.onPress(pointer(body, 500, 500), 'move');
  h.comp.onPress(pointer(body, 100, 100, { pointerId: 2 }), 'right');
  h.comp.onPointerMove(pointer(body, 560, 500, { pointerId: 2 }));
  assert.deepEqual(h.grabs, [], 'another pointer does not drag');
  h.comp.onPointerMove(pointer(body, 560, 500));
  assert.deepEqual(h.grabs, ['move']);
});

await test('mouse: a double click on the body opens the app, on a button it does not', () => {
  const h = makePlate([DEPLOY]);
  h.comp.onDoubleClick({ target: target('button') } as never);
  assert.equal(h.opens(), 0);
  h.comp.onDoubleClick({ target: target('body') } as never);
  assert.equal(h.opens(), 1);
});

// ─── The main window's service ────────────────────────────────────────────

const STORED: WidgetGeometry = { anchorX: 1905, anchorY: 1017, fromRight: true, fromBottom: true, width: 262 };
prefsFile = JSON.stringify({ [WIDGET_GEOMETRY_PREF]: JSON.stringify(STORED) });
await loadTrayPrefs();

const actions: WidgetAction[] = [];
let zoneRuns = 0;
const service = new TimerWidgetService({ run: (fn: () => void): void => { zoneRuns++; fn(); } } as never);
await service.start(action => actions.push(action));
const syncs = (): Call[] => calls.filter(c => c.cmd === 'sync_widget');

await test('service: the widget gets its rows and the stored place', () => {
  calls.length = 0;
  service.sync(response([REVIEW, CALL, DEPLOY]));
  assert.equal(syncs().length, 1);
  const args = syncs()[0].args as { payload: { timers: TimerView[] }; geometry: WidgetGeometry };
  assert.deepEqual(args.payload.timers.map(t => t.id), ['call', 'deploy']);
  assert.deepEqual(args.geometry, STORED);
});

await test('service: nothing new — nothing sent; a fresh moment goes out', () => {
  calls.length = 0;
  service.sync(response([REVIEW, CALL, DEPLOY]));
  assert.equal(syncs().length, 0, 'the same poll twice');
  nowMs += 3 * SECOND;
  service.sync(response([REVIEW, CALL, DEPLOY]));
  assert.equal(syncs().length, 1, 'a running row ticks on from the new moment');
});

await test('service: switched off, or no rows — the widget goes', () => {
  calls.length = 0;
  service.sync(response([CALL, DEPLOY], false));
  assert.equal(syncs().length, 1);
  assert.deepEqual(syncs()[0].args, { payload: null, geometry: null });
  service.sync(response([REVIEW]));
  service.sync(null);
  assert.equal(syncs().length, 1, 'it is gone already');
  service.sync(response([DEPLOY]));
  assert.equal(syncs().length, 2, 'the next start brings it back');
});

await test('service: the place the widget reports is kept — and used next time', async () => {
  const moved: WidgetGeometry = { anchorX: 40, anchorY: 60, fromRight: false, fromBottom: false, width: 190 };
  fire('widget-geometry', moved);
  await settle();
  assert.deepEqual(parseWidgetGeometry(readPref(WIDGET_GEOMETRY_PREF)), moved);
  assert.ok((prefsFile ?? '').includes('anchorX'), 'written to prefs.json by the main window');
  calls.length = 0;
  nowMs += SECOND;
  service.sync(response([DEPLOY]));
  assert.deepEqual((syncs()[0].args as { geometry: WidgetGeometry }).geometry, moved);
});

await test('service: the widget\'s clicks reach the shell inside the zone', () => {
  const before = zoneRuns;
  fire('widget-action', { kind: 'toggle', id: 'call' });
  fire('widget-action', { kind: 'hide', id: 'call' });
  assert.deepEqual(actions, [{ kind: 'toggle', id: 'call' }, { kind: 'hide', id: 'call' }]);
  assert.equal(zoneRuns - before, 2);
});

await test('service: rows that did not reach the window are sent again', async () => {
  calls.length = 0;
  nowMs += SECOND;
  const rows = response([DEPLOY, CALL]);
  failNextSync = true;
  service.sync(rows);
  await settle();
  service.sync(rows);
  assert.equal(syncs().length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
