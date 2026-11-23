/**
 * Unit tests for "New timer" in the tray icon's menu — the main window's
 * side. Rust owns the menu and only passes the click on; the main window
 * starts the timer through its own gate and leaves the window as it is. The
 * item is live only while a click can work: the daemon answered the last
 * poll and the month is open. Also the shell's part in the widget's ticket
 * block: it tells what it knows and binds the picked ticket through the gate.
 *
 * Headless: a fake Tauri bridge (invoke + events) on `window`, a fake API.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/tray-menu-timer.test.ts
 */
import assert from 'node:assert/strict';

// ─── Fake Tauri bridge (installed before the modules load) ────────────────
interface Call { readonly cmd: string; readonly args: Record<string, unknown> }
type Listener = (event: { event: string; id: number; payload: unknown }) => void;
const calls: Call[] = [];
const callbacks = new Map<number, Listener>();
const listeners = new Map<string, Listener>();
let callbackSeq = 0;
let failNextMenuCall = false;

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
      calls.push({ cmd, args });
      if (cmd === 'set_tray_new_timer' && failNextMenuCall) {
        failNextMenuCall = false;
        throw new Error('tray is busy');
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
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
};

await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { TimerState } = await import('../../tray-app/src/app/models/workday.models');
const { AppComponent } = await import('../../tray-app/src/app/app.component');
import type { ApiResponse, Favorite, TimerView, TimersResponse, TodayResponse } from '../../tray-app/src/app/models/workday.models';

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

const AS_OF = '2026-11-16T10:00:00.000Z';

function timers(...list: TimerView[]): TimersResponse {
  return { date: '2026-11-16', asOf: AS_OF, counting: 'none', desktopWidget: true, timers: list };
}

function day(over: { monthClosed?: boolean; timers?: TimersResponse | null } = {}): ApiResponse<TodayResponse> {
  const data = { date: '2026-11-16', sessions: [], monthClosed: over.monthClosed ?? false, timers: over.timers === null ? undefined : over.timers ?? timers() };
  return { ok: true, data: data as unknown as TodayResponse };
}

const FRESH: TimerView = {
  id: 'fresh', state: TimerState.Running, entryId: null, task: null, activity: null, added: false, description: '',
  totalMs: 0, shareMs: 0, handMinutes: 0, hidden: false, touchedAt: AS_OF,
};

// ─── The shell on a fake API ──────────────────────────────────────────────
let today: ApiResponse<TodayResponse> = day();
const apiCalls: { readonly name: string; readonly args: readonly unknown[] }[] = [];
const api = new Proxy({}, {
  get: (_target, name: string) => (...args: unknown[]): Promise<unknown> => {
    apiCalls.push({ name, args });
    if (name === 'getToday') return Promise.resolve(today);
    if (name === 'newTimer') {
      today = day({ timers: timers(FRESH) });
      return Promise.resolve({ ok: true, data: { ...timers(FRESH), timerId: FRESH.id } });
    }
    return Promise.resolve({ ok: false, error: 'not in this test' });
  },
});

let zoneRuns = 0;
// What the shell tells the desktop widget: a birth, then the rows that carry it.
const widgetTold: string[] = [];
const widget = {
  start: async (): Promise<void> => {},
  stop: (): void => {},
  sync: (rows: TimersResponse | null): void => { widgetTold.push(`rows:${rows?.timers.map(t => t.id).join(',') ?? ''}`); },
  announceBirth: (id: string): void => { widgetTold.push(`birth:${id}`); },
  tellKnown: (day: TodayResponse | null, favorites: readonly unknown[]): void => {
    widgetTold.push(`known:${day?.date ?? ''}:${favorites.length}`);
  },
};
const shell = new AppComponent(
  api as never,
  { start: (): void => {}, stop: (): void => {} } as never,
  { detectChanges: (): void => {} } as never,
  widget as never,
  { run: (fn: () => void): void => { zoneRuns++; fn(); } } as never,
);
const hidden = shell as unknown as { watchTrayMenu(): Promise<void>; onWidgetAction(action: unknown): void };
const menuCalls = (): boolean[] => calls.filter(c => c.cmd === 'set_tray_new_timer').map(c => c.args['enabled'] as boolean);

// ─── When the item is live ────────────────────────────────────────────────

await test('the item is live while the daemon answers and the month is open', async () => {
  await shell.refresh();
  assert.deepEqual(menuCalls(), [true]);
  await shell.refresh();
  assert.deepEqual(menuCalls(), [true], 'nothing changed — Rust is not told again');
});

await test('a closed month greys it out, an open one brings it back', async () => {
  calls.length = 0;
  today = day({ monthClosed: true });
  await shell.refresh();
  today = day();
  await shell.refresh();
  assert.deepEqual(menuCalls(), [false, true]);
});

await test('a daemon that does not answer greys it out', async () => {
  calls.length = 0;
  today = { ok: false, error: 'daemon is down' };
  await shell.refresh();
  assert.deepEqual(menuCalls(), [false]);
  today = day();
  await shell.refresh();
  assert.deepEqual(menuCalls(), [false, true], 'back with the daemon');
});

await test('a daemon without timers leaves it grey', async () => {
  calls.length = 0;
  today = day({ timers: null });
  await shell.refresh();
  assert.deepEqual(menuCalls(), [false]);
  today = day();
  await shell.refresh();
});

await test('a telling that failed is repeated on the next poll', async () => {
  calls.length = 0;
  failNextMenuCall = true;
  today = day({ monthClosed: true });
  await shell.refresh();
  await settle();
  await shell.refresh();
  assert.deepEqual(menuCalls(), [false, false]);
  today = day();
  await shell.refresh();
});

// ─── The click ────────────────────────────────────────────────────────────

await test('a click starts a timer through the gate, inside the zone', async () => {
  await hidden.watchTrayMenu();
  apiCalls.length = 0;
  const before = zoneRuns;
  fire('tray-new-timer', null);
  await settle();
  const started = apiCalls.filter(c => c.name === 'newTimer');
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].args, [], 'no description — it is typed on the widget');
  assert.equal(zoneRuns, before + 1);
  assert.ok(apiCalls.some(c => c.name === 'getToday'), 'the day is read again after the action');
  assert.equal(shell.actionPending, false);
});

await test('the widget is told of the birth before the rows that carry it', async () => {
  const birth = widgetTold.indexOf('birth:fresh');
  assert.ok(birth >= 0, 'the row is born in the edit on the widget');
  assert.equal(widgetTold[birth + 1], 'rows:fresh');
});

await test('the window stays as it is: the island is not opened, no caret waits', async () => {
  assert.equal(shell.islandOpen, false);
  assert.equal(shell.timerBirthId, null);
  assert.deepEqual(shell.timers?.timers.map(t => t.id), ['fresh'], 'the chip and the widget have the timer');
});

// ─── The widget's ticket block ────────────────────────────────────────────

await test('the ticket block is told what the shell knows', () => {
  widgetTold.length = 0;
  hidden.onWidgetAction({ kind: 'tickets' });
  assert.deepEqual(widgetTold, ['known:2026-11-16:0']);
});

await test('a ticket picked on the widget binds the timer through the gate', async () => {
  apiCalls.length = 0;
  hidden.onWidgetAction({ kind: 'bind', id: 'fresh', task: 'ATL-6790' });
  await settle();
  const bound = apiCalls.filter(c => c.name === 'bindTimer');
  assert.equal(bound.length, 1);
  assert.deepEqual(bound[0].args, ['fresh', { task: 'ATL-6790', activity: 'Development', description: '' }]);
  assert.equal(shell.actionPending, false);
});

await test('a ticket for a timer that is not there is not sent', async () => {
  apiCalls.length = 0;
  hidden.onWidgetAction({ kind: 'bind', id: 'gone', task: 'ATL-6790' });
  hidden.onWidgetAction({ kind: 'search', query: 'dep' });
  await settle();
  assert.deepEqual(apiCalls.filter(c => c.name === 'bindTimer' || c.name === 'searchJira'), []);
});

// ─── A favorite, and a timer grown from a meeting ─────────────────────────

const fav = (id: string, name: string, task: string, activity: string): Favorite =>
  ({ id, name, task, minutes: 30, activity, createdAt: AS_OF });
const lastBind = (): readonly unknown[] | undefined => apiCalls.filter(c => c.name === 'bindTimer').at(-1)?.args;
const pick = async (action: Record<string, unknown>): Promise<void> => {
  apiCalls.length = 0;
  hidden.onWidgetAction({ kind: 'bind', ...action });
  await settle();
};

await test('a favorite picked on the widget binds as the favorite says: its activity, its name', async () => {
  shell.favorites = [
    fav('f1', 'PR review', 'ATL-205', 'CodeReview'),
    fav('f2', 'sprint planning', 'ATL-14', 'Meeting'),
    fav('f3', 'Iteration Planning', 'ATL-14', 'Other'),
  ];
  await pick({ id: 'fresh', task: 'ATL-205', favoriteId: 'f1' });
  assert.deepEqual(lastBind(), ['fresh', { task: 'ATL-205', activity: 'CodeReview', description: 'PR review' }]);
});

await test('two favorites of one ticket are told apart', async () => {
  await pick({ id: 'fresh', task: 'ATL-14', favoriteId: 'f2' });
  assert.deepEqual(lastBind(), ['fresh', { task: 'ATL-14', activity: 'Meeting', description: 'sprint planning' }]);
  await pick({ id: 'fresh', task: 'ATL-14', favoriteId: 'f3' });
  assert.deepEqual(lastBind(), ['fresh', { task: 'ATL-14', activity: 'Other', description: 'Iteration Planning' }]);
});

await test('the ticket of a favorite picked as a ticket is Development, as before', async () => {
  await pick({ id: 'fresh', task: 'ATL-14' });
  assert.deepEqual(lastBind(), ['fresh', { task: 'ATL-14', activity: 'Development', description: '' }]);
});

await test('a favorite that is gone since the block was told binds as its ticket', async () => {
  await pick({ id: 'fresh', task: 'ATL-14', favoriteId: 'removed' });
  assert.deepEqual(lastBind(), ['fresh', { task: 'ATL-14', activity: 'Development', description: '' }]);
});

await test('a timer grown from a meeting: a ticket picked on the widget is Other, not Development', async () => {
  const meeting: TimerView = { ...FRESH, id: 'meeting', description: 'Sync with the platform team', sourceRef: 'meeting:ev-sync:2026-11-16' };
  today = day({ timers: timers(FRESH, meeting) });
  await shell.refresh();
  await pick({ id: 'meeting', task: 'ATL-6790' });
  assert.deepEqual(lastBind(), ['meeting', { task: 'ATL-6790', activity: 'Other', description: 'Sync with the platform team' }]);
  await pick({ id: 'fresh', task: 'ATL-6790' });
  assert.deepEqual(lastBind(), ['fresh', { task: 'ATL-6790', activity: 'Development', description: '' }], 'a New timer is as it was');
});

await test('a favorite picked for the meeting\'s timer keeps the favorite\'s activity and the meeting\'s name', async () => {
  await pick({ id: 'meeting', task: 'ATL-14', favoriteId: 'f2' });
  assert.deepEqual(lastBind(), ['meeting', { task: 'ATL-14', activity: 'Meeting', description: 'Sync with the platform team' }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
