/**
 * Unit tests for the desktop widget's tray side. Which timers are on the
 * desktop and whether the widget exists at all (the setting, a row to show);
 * the plate's size for its rows — the height is exact, the width is the
 * least one, three characters wider past the hour; the plate's mouse: a
 * press becomes a drag only past a threshold, the body moves, an edge sets
 * the width, buttons never drag; the description typed on the plate: the
 * pencil, the button that keeps the text, Enter and Esc, a row born in the
 * edit; and the main window's service: it hands the widget its rows only
 * when they change, passes the stored place along, keeps the place the
 * widget reports, routes the widget's clicks and tells it of a birth.
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

const DEPLOY = timer('deploy', TimerState.Running, { entryId: 'e1', task: 'ATL-6790', description: 'staging release', shareMs: 38 * MINUTE });
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
  assert.equal(payload?.birthId, undefined);
});

await test('a birth is told only while its row is on the desktop', () => {
  assert.equal(widgetPayload(response([CALL, DEPLOY]), 'deploy')?.birthId, 'deploy');
  assert.equal(widgetPayload(response([CALL, DEPLOY]), 'gone')?.birthId, undefined);
  assert.equal(widgetPayload(response([REVIEW, CALL]), 'review')?.birthId, undefined, 'a hidden row is not born in the edit');
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
  assert.equal(widgetLayout(1, false, true).minWidth, 262, 'a field needs room: a narrow plate is wider while it is typed in');
  assert.equal(widgetLayout(3, true, true).minWidth, 262);
  close(widgetLayout(2, false, true).height, 52.08);
  assert.equal(widgetLayout(3, true).minWidth, 187);
  assert.equal(widgetLayout(0, false).height, 0);
});

await test('past the hour: only a time that prints seconds grows', () => {
  const at = nowMs;
  const loose = timer('a', TimerState.Running, { shareMs: HOUR - SECOND });
  assert.equal(showsHours([loose], at, at), false);
  assert.equal(showsHours([loose], at, at + SECOND), true, '1h 00m 00s');
  const record = timer('b', TimerState.Paused, { entryId: 'e1', task: 'ATL-1', shareMs: 62 * MINUTE });
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
  described: { id: string; description: string }[];
  cancelled: string[];
  births: string[];
  typing: boolean[];
  carets: () => number;
}

function makePlate(timers: readonly TimerView[]): PlateHarness {
  let carets = 0;
  const host = { nativeElement: { querySelector: (): unknown => ({ focus(): void { carets++; } }) } };
  const comp = new TimerWidgetComponent(host as never);
  const described: { id: string; description: string }[] = [];
  const cancelled: string[] = [];
  const births: string[] = [];
  const typing: boolean[] = [];
  comp.described.subscribe((d: { id: string; description: string }) => described.push(d));
  comp.cancelled.subscribe((id: string) => cancelled.push(id));
  comp.birthTaken.subscribe((id: string) => births.push(id));
  comp.typing.subscribe((on: boolean) => typing.push(on));
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
  return {
    comp, layouts, grabs, drags: () => drags, releases: () => releases, opens: () => opens, rows,
    described, cancelled, births, typing, carets: () => carets,
  };
}

await test('plate: the window is fitted when the rows change, not on every poll', () => {
  const h = makePlate([DEPLOY]);
  assert.equal(h.layouts.length, 1);
  assert.equal(h.comp.list, false);
  h.rows([DEPLOY]);
  h.rows([{ ...DEPLOY, shareMs: 39 * MINUTE }]);
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
  const h = makePlate([timer('a', TimerState.Running, { shareMs: HOUR - 30 * SECOND }), CALL]);
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

// ─── The description typed on the plate ───────────────────────────────────

const ADDED = timer('added', TimerState.Running, { entryId: 'e3', task: 'ATL-6790', added: true });
const LOOSE = timer('loose', TimerState.Running, { description: 'standup notes' });
const keyOf = (name: string): { key: string; prevented: boolean; preventDefault(): void } =>
  ({ key: name, prevented: false, preventDefault(): void { this.prevented = true; } });

await test('edit: the pencil is on a timer that is switched on, not on manual added, not at rest', () => {
  const h = makePlate([DEPLOY, CALL, ADDED]);
  assert.equal(h.comp.isDescribable(DEPLOY), true);
  assert.equal(h.comp.isDescribable(timer('w', TimerState.Waiting)), true, 'waiting is switched on too');
  assert.equal(h.comp.isDescribable(CALL), false, 'a timer at rest has the eye in the slot');
  assert.equal(h.comp.isDescribable(ADDED), false, 'manual added has no text');
});

await test('edit: the pencil opens a field, the plate asks for the keyboard and for room', () => {
  const h = makePlate([DEPLOY]);
  h.comp.ngAfterViewChecked();
  assert.equal(h.carets(), 0);
  h.comp.onPencil(DEPLOY);
  assert.equal(h.comp.editingId, 'deploy');
  assert.equal(h.comp.draft, 'staging release');
  assert.deepEqual(h.typing, [true]);
  assert.equal(h.layouts.at(-1)?.minWidth, 262);
  assert.equal(h.carets(), 0, 'the field is not drawn yet');
  h.comp.ngAfterViewChecked();
  assert.equal(h.carets(), 1, 'the caret goes to the field once it is drawn');
  h.comp.ngAfterViewChecked();
  assert.equal(h.carets(), 1, 'and is not pulled back on every later check');
  h.comp.onPencil(DEPLOY);
  assert.deepEqual(h.typing, [true], 'the same pencil twice changes nothing');
});

await test('edit: Enter and the button keep what was typed and close the field', () => {
  const h = makePlate([DEPLOY]);
  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('  staging release, part 2 ');
  const enter = keyOf('Enter');
  h.comp.onEditKeydown(DEPLOY, enter as never);
  assert.deepEqual(h.described, [{ id: 'deploy', description: 'staging release, part 2' }]);
  assert.equal(enter.prevented, true);
  assert.equal(h.comp.editingId, null);
  assert.deepEqual(h.typing, [true, false]);
  assert.equal(h.layouts.at(-1)?.minWidth, 104, 'the plate is as narrow as it was');
  assert.equal(h.comp.textOf(DEPLOY), 'staging release, part 2', 'no flash of the old text');

  h.rows([{ ...DEPLOY, description: 'staging release, part 2' }]);
  const landed = { ...DEPLOY, description: 'staging release, part 2' };
  h.comp.onPencil(landed);
  h.comp.onEditInput('rollout');
  h.comp.keep(landed);
  assert.deepEqual(h.described.at(-1), { id: 'deploy', description: 'rollout' });
  assert.equal(h.comp.editingId, null);
});

await test('edit: the same text is not sent; Esc puts the text back', () => {
  const h = makePlate([DEPLOY]);
  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('staging release ');
  h.comp.keep(DEPLOY);
  assert.equal(h.described.length, 0);

  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('something else');
  h.comp.onEditKeydown(DEPLOY, keyOf('Escape') as never);
  assert.equal(h.described.length, 0);
  assert.equal(h.cancelled.length, 0, 'an old timer is never taken back by Esc');
  assert.equal(h.comp.editingId, null);
  assert.equal(h.comp.textOf(DEPLOY), 'staging release');
});

await test('edit: a click away and a poll leave the edit as it is', () => {
  const h = makePlate([DEPLOY, CALL]);
  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('staging rel');
  h.rows([{ ...DEPLOY, shareMs: 39 * MINUTE }, CALL]);
  assert.equal(h.comp.editingId, 'deploy');
  assert.equal(h.comp.draft, 'staging rel');
  h.rows([{ ...DEPLOY, state: TimerState.Paused }, CALL]);
  assert.equal(h.comp.editingId, 'deploy', 'a timer paused under the edit keeps its field');
  assert.equal(h.described.length, 0);
  assert.deepEqual(h.typing, [true]);
});

await test('edit: a record\'s description is never emptied; a no-ticket timer may lose its text', () => {
  const h = makePlate([DEPLOY, LOOSE]);
  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('   ');
  h.comp.keep(DEPLOY);
  assert.equal(h.described.length, 0);
  assert.equal(h.comp.textOf(DEPLOY), 'staging release');

  h.comp.onPencil(LOOSE);
  h.comp.onEditInput('');
  h.comp.keep(LOOSE);
  assert.deepEqual(h.described, [{ id: 'loose', description: '' }]);
});

await test('edit: the sent text holds until the rows carry it; a refusal brings the old one back', () => {
  const h = makePlate([DEPLOY]);
  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('rollout');
  h.comp.keep(DEPLOY);
  h.rows([DEPLOY]); // a poll sent before the action
  assert.equal(h.comp.textOf(DEPLOY), 'rollout');
  h.comp.forgetSent('deploy');
  assert.equal(h.comp.textOf(DEPLOY), 'staging release');
});

await test('edit: another row\'s pencil keeps the text typed in this one', () => {
  const h = makePlate([DEPLOY, LOOSE]);
  h.comp.onPencil(DEPLOY);
  h.comp.onEditInput('rollout');
  h.comp.onPencil(LOOSE);
  assert.deepEqual(h.described, [{ id: 'deploy', description: 'rollout' }]);
  assert.equal(h.comp.editingId, 'loose');
  assert.equal(h.comp.draft, 'standup notes');
  assert.deepEqual(h.typing, [true, true], 'the keyboard stays on the widget between the two rows');
  h.comp.keep(LOOSE);
  assert.deepEqual(h.typing, [true, true, false]);
});

await test('edit: a row that left the desktop takes its edit along', () => {
  const h = makePlate([DEPLOY, CALL]);
  h.comp.onPencil(DEPLOY);
  h.rows([CALL]);
  assert.equal(h.comp.editingId, null);
  assert.deepEqual(h.typing, [true, false]);
  assert.equal(h.described.length, 0);
});

await test('edit: a press on the plate leaves the caret in the field', () => {
  const h = makePlate([DEPLOY]);
  const press = (inside: 'body' | 'button'): { prevented: boolean; target: FakeTarget; preventDefault(): void } =>
    ({ prevented: false, target: target(inside), preventDefault(): void { this.prevented = true; } });
  const idle = press('body');
  h.comp.onMouseDown(idle as never);
  assert.equal(idle.prevented, false, 'nothing is typed — a press is a press');
  h.comp.onPencil(DEPLOY);
  const onButton = press('body');
  h.comp.onMouseDown(onButton as never);
  assert.equal(onButton.prevented, true, 'the button in the slot does not take the caret');
  const inField = press('button'); // closest('input') finds the field
  h.comp.onMouseDown(inField as never);
  assert.equal(inField.prevented, false, 'a press in the field moves the caret');
});

await test('birth: the row of a timer made in the tray menu is born in the edit', () => {
  const fresh = timer('fresh', TimerState.Running);
  const h = makePlate([CALL]);
  h.comp.birthId = 'fresh';
  h.rows([CALL]);
  assert.equal(h.comp.editingId, null, 'its row is not here yet');
  h.rows([CALL, fresh]);
  assert.equal(h.comp.editingId, 'fresh');
  assert.equal(h.comp.draft, '');
  assert.deepEqual(h.births, ['fresh']);
  assert.deepEqual(h.typing, [true]);
  h.rows([CALL, fresh]);
  assert.deepEqual(h.births, ['fresh'], 'told once');
});

await test('birth: Esc on the still-empty field takes the timer back', () => {
  const fresh = timer('fresh', TimerState.Running);
  const h = makePlate([fresh]);
  h.comp.birthId = 'fresh';
  h.rows([fresh]);
  h.comp.onEditKeydown(fresh, keyOf('Escape') as never);
  assert.deepEqual(h.cancelled, ['fresh']);
  assert.equal(h.comp.editingId, null);
  assert.equal(h.described.length, 0);
  h.rows([fresh]);
  assert.equal(h.comp.editingId, null, 'the same birth does not open the field again');
});

await test('birth: Esc with text typed only closes the field; Enter names the timer', () => {
  const fresh = timer('fresh', TimerState.Running);
  const h = makePlate([fresh]);
  h.comp.birthId = 'fresh';
  h.rows([fresh]);
  h.comp.onEditInput('incident');
  h.comp.onEditKeydown(fresh, keyOf('Escape') as never);
  assert.equal(h.cancelled.length, 0, 'the timer stays');
  assert.equal(h.described.length, 0);

  const other = timer('other', TimerState.Running);
  const g = makePlate([other]);
  g.comp.birthId = 'other';
  g.rows([other]);
  g.comp.onEditInput('incident call');
  g.comp.onEditKeydown(other, keyOf('Enter') as never);
  assert.deepEqual(g.described, [{ id: 'other', description: 'incident call' }]);
  assert.equal(g.cancelled.length, 0);
});

await test('birth: Esc on a field opened by the pencil never takes a timer back', () => {
  const blank = timer('blank', TimerState.Running);
  const h = makePlate([blank]);
  h.comp.onPencil(blank);
  h.comp.onEditKeydown(blank, keyOf('Escape') as never);
  assert.equal(h.cancelled.length, 0);
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

await test('service: a description typed on the widget reaches the shell; a refusal goes back', () => {
  actions.length = 0;
  calls.length = 0;
  fire('widget-action', { kind: 'describe', id: 'deploy', description: 'rollout' });
  fire('widget-action', { kind: 'cancel', id: 'fresh' });
  assert.deepEqual(actions, [{ kind: 'describe', id: 'deploy', description: 'rollout' }, { kind: 'cancel', id: 'fresh' }]);
  service.refuse('deploy');
  assert.deepEqual(calls.filter(c => c.cmd === 'widget_refused').map(c => c.args), [{ id: 'deploy' }]);
});

await test('service: a birth is told until the widget takes it', () => {
  const births = (): (string | undefined)[] => syncs().map(c => (c.args as { payload: { birthId?: string } }).payload.birthId);
  actions.length = 0;
  calls.length = 0;
  nowMs += SECOND;
  service.announceBirth('deploy');
  service.sync(response([DEPLOY, CALL]));
  nowMs += SECOND;
  service.sync(response([DEPLOY, CALL]));
  assert.deepEqual(births(), ['deploy', 'deploy'], 'the window may still be on its way');
  fire('widget-action', { kind: 'born', id: 'deploy' });
  assert.equal(actions.length, 0, 'the shell has nothing to do about it');
  nowMs += SECOND;
  service.sync(response([DEPLOY, CALL]));
  assert.deepEqual(births(), ['deploy', 'deploy', undefined]);
});

await test('service: a birth nobody took is forgotten', () => {
  const births = (): (string | undefined)[] => syncs().map(c => (c.args as { payload: { birthId?: string } }).payload.birthId);
  calls.length = 0;
  nowMs += SECOND;
  service.announceBirth('call');
  service.sync(response([DEPLOY, CALL]));
  nowMs += 16 * SECOND;
  service.sync(response([DEPLOY, CALL]));
  assert.deepEqual(births(), ['call', undefined]);
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
