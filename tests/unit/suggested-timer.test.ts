/**
 * Unit tests for the suggested timer's tray side. A live suggestion the
 * daemon offers a timer for (Suggestion.suggestedTimer) stands on the desktop
 * widget as a star row below the timers — and is a row to show by itself; the
 * eye takes the row off the desktop only; ▶ of the row and Start timer in the
 * suggestion's menu take the suggestion by a timer through the main window's
 * gate. The feed's row itself never changes: the only trace in the app is one
 * more item in its menu. Switched off — nothing of this exists. Plus the two
 * switches in Settings → Timer.
 *
 * Headless: fake clock, a fake Tauri bridge (invoke + events) on `window`, a
 * fake API; the shell runs on the real widget service.
 *
 * Run: npx tsx --tsconfig tray-app/tsconfig.json tests/unit/suggested-timer.test.ts
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

(globalThis as { window?: unknown }).window = {
  setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
  clearTimeout: (id: never): void => clearTimeout(id),
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
      if (cmd === 'load_prefs') return null;
      calls.push({ cmd, args });
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
  for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
};

await import(new URL('../../tray-app/node_modules/@angular/compiler/fesm2022/compiler.mjs', import.meta.url).href);
const { SuggestionsDayState, TimerState } = await import('../../tray-app/src/app/models/workday.models');
const { widgetLayout, widgetPayload, widgetSuggestions } = await import('../../tray-app/src/app/timer/timer-widget.util');
const { TimerWidgetComponent } = await import('../../tray-app/src/app/timer/timer-widget.component');
const { TimerWidgetService } = await import('../../tray-app/src/app/timer/timer-widget.service');
const { SuggestionRowComponent } = await import('../../tray-app/src/app/views/day-view/suggestion-row/suggestion-row.component');
const { AppComponent } = await import('../../tray-app/src/app/app.component');
const { SettingsViewComponent } = await import('../../tray-app/src/app/views/settings-view/settings-view.component');
import type {
  ApiResponse, SettingsPatch, SettingsResponse, Suggestion, SuggestionsResponse, SuggestionTimerResponse, TimerSettings,
  TimerView, TimersResponse, TodayResponse,
} from '../../tray-app/src/app/models/workday.models';
import type { WidgetLayout, WidgetPayload, WidgetSuggestion } from '../../tray-app/src/app/timer/timer-widget.util';

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

const MINUTE = 60_000;
const DAY = '2026-11-22';
const iso = (): string => new Date(nowMs).toISOString();

function timer(id: string, state: TimerView['state'], over: Partial<TimerView> = {}): TimerView {
  return {
    id, state, entryId: null, task: null, activity: null, added: false, description: '',
    totalMs: 12 * MINUTE, shareMs: 12 * MINUTE, handMinutes: 0, hidden: false, touchedAt: iso(), ...over,
  };
}

function response(timers: readonly TimerView[], desktopWidget = true): TimersResponse {
  return { date: DAY, asOf: iso(), counting: 'none', desktopWidget, timers };
}

function suggestion(uid: string, title: string, over: Partial<Suggestion> = {}): Suggestion {
  return {
    uid, date: DAY, title, start: `${DAY}T10:00:00.000Z`, end: `${DAY}T11:00:00.000Z`, plannedMinutes: 60,
    ongoing: true, suggestedTimer: true, isPrivate: false, source: 'meeting', ...over,
  };
}

const PLANNING = suggestion('ev-planning', 'Sprint planning', { resolved: { task: 'ATL-7104', activity: 'Other', level: 'series' } });
const SYNC = suggestion('ev-sync', 'Sync with the platform team');
const DAILY = suggestion('ev-daily', 'Daily standup', { resolved: { task: 'ATL-101', activity: 'Other', description: 'Daily', level: 'series' } });
const REVIEW = suggestion('ATL-9349', 'ATL-9349-colleague-retry', {
  source: 'review', resolved: { task: 'ATL-9349', activity: 'CodeReview', description: 'code review', level: 'source' },
});
const ENDED = suggestion('ev-ended', 'Backlog grooming', { ongoing: false, suggestedTimer: undefined });
// Ongoing, but its source's suggested timer is switched off.
const UNOFFERED = suggestion('ev-quiet', 'Design sync', { suggestedTimer: undefined });
const DEPLOY = timer('deploy', TimerState.Paused, { entryId: 'e1', task: 'ATL-6790', description: 'staging release' });

// ─── Star rows ────────────────────────────────────────────────────────────
console.log('Star rows');

await test('only the suggestions the daemon offers a timer for, in the feed\'s order', () => {
  const rows = widgetSuggestions([ENDED, PLANNING, UNOFFERED, SYNC]);
  assert.deepEqual(rows.map(r => r.uid), ['ev-planning', 'ev-sync']);
});

await test('a row reads as the record would: the ticket when it is known, and the description', () => {
  assert.deepEqual(widgetSuggestions([PLANNING, SYNC, DAILY, REVIEW]), [
    { uid: 'ev-planning', task: 'ATL-7104', description: 'Sprint planning' },
    { uid: 'ev-sync', task: null, description: 'Sync with the platform team' },
    { uid: 'ev-daily', task: 'ATL-101', description: 'Daily' },
    { uid: 'ATL-9349', task: 'ATL-9349', description: 'code review' },
  ] satisfies WidgetSuggestion[]);
});

await test('a row taken off the desktop is not there', () => {
  assert.deepEqual(widgetSuggestions([PLANNING, SYNC], new Set(['ev-planning'])).map(r => r.uid), ['ev-sync']);
});

await test('the widget exists for a star row alone; without one the payload is as it was', () => {
  const stars = widgetSuggestions([PLANNING]);
  const alone = widgetPayload(response([]), null, stars);
  assert.deepEqual(alone?.timers, []);
  assert.deepEqual(alone?.suggested, stars);
  assert.equal(widgetPayload(response([], false), null, stars), null, 'the desktop widget is switched off');
  assert.equal(widgetPayload(null, null, stars), null, 'no timers from the daemon');
  assert.equal(widgetPayload(response([])), null, 'no rows at all');
  const plain = widgetPayload(response([DEPLOY]));
  assert.equal('suggested' in (plain as WidgetPayload), false);
});

// ─── The plate ────────────────────────────────────────────────────────────
console.log('\nThe plate');

function plate(timers: readonly TimerView[], suggested: readonly WidgetSuggestion[]): { comp: InstanceType<typeof TimerWidgetComponent>; layouts: WidgetLayout[] } {
  const host = { nativeElement: { querySelector: (): unknown => null } };
  const comp = new TimerWidgetComponent(host as never);
  const layouts: WidgetLayout[] = [];
  comp.layoutChanged.subscribe((layout: WidgetLayout) => layouts.push(layout));
  comp.timers = timers;
  comp.suggested = suggested;
  comp.asOf = iso();
  comp.ngOnChanges();
  return { comp, layouts };
}

await test('star rows are rows of the plate: they count for its height and make it a list', () => {
  const one = plate([], widgetSuggestions([PLANNING]));
  assert.equal(one.comp.list, false);
  assert.deepEqual(one.layouts[0], widgetLayout(1, false));

  const mixed = plate([DEPLOY], widgetSuggestions([PLANNING, SYNC]));
  assert.equal(mixed.comp.list, true);
  assert.deepEqual(mixed.layouts[0], widgetLayout(3, false));
});

await test('a star row shows a zero that does not tick', () => {
  assert.equal(plate([], widgetSuggestions([PLANNING])).comp.zeroTime, '0m 00s');
});

await test('a star row that leaves fits the window again', () => {
  const h = plate([DEPLOY], widgetSuggestions([PLANNING]));
  h.comp.suggested = [];
  h.comp.ngOnChanges();
  assert.equal(h.layouts.length, 2);
  assert.deepEqual(h.layouts[1], widgetLayout(1, false));
  assert.equal(h.comp.list, false);
});

// ─── The suggestion's menu ────────────────────────────────────────────────
console.log('\nThe suggestion\'s menu');

function menuOf(row: Suggestion): { labels: string[]; started: () => number; click(label: string): void } {
  const comp = new SuggestionRowComponent({ nativeElement: {} } as never, {} as never);
  comp.suggestion = row;
  let started = 0;
  comp.timerStarted.subscribe(() => { started++; });
  const items = comp.mainMenuItems(0, 0).filter((item): item is { label: string; action: () => void } => 'label' in item);
  return {
    labels: items.map(item => item.label),
    started: () => started,
    click: (label: string): void => items.find(item => item.label === label)?.action(),
  };
}

await test('Start timer stands second, right after Log…', () => {
  assert.deepEqual(menuOf(PLANNING).labels, ['Log…', 'Start timer', 'Deny', 'Mute series…']);
});

await test('a suggestion without a ticket has it after Pick ticket…', () => {
  assert.deepEqual(menuOf(SYNC).labels, ['Pick ticket…', 'Start timer', 'Deny', 'Mute series…']);
});

await test('a review has it too', () => {
  assert.deepEqual(menuOf(REVIEW).labels, ['Log…', 'Start timer', 'Deny']);
});

await test('not offered — the menu is as it was', () => {
  assert.deepEqual(menuOf(ENDED).labels, ['Pick ticket…', 'Deny', 'Mute series…']);
  assert.deepEqual(menuOf(UNOFFERED).labels, ['Pick ticket…', 'Deny', 'Mute series…']);
  assert.deepEqual(menuOf({ ...REVIEW, suggestedTimer: undefined }).labels, ['Log…', 'Deny']);
});

await test('the item reports up; the row does nothing by itself', () => {
  const menu = menuOf(PLANNING);
  menu.click('Start timer');
  assert.equal(menu.started(), 1);
});

// ─── The shell and the widget service ─────────────────────────────────────
console.log('\nThe main window');

let dayTimers: TimerView[] = [];
let daySuggestions: Suggestion[] = [PLANNING, SYNC, ENDED];
let widgetOn = true;
const apiCalls: { readonly name: string; readonly args: readonly unknown[] }[] = [];

const suggestionsDay = (): SuggestionsResponse => ({ date: DAY, state: SuggestionsDayState.Active, suggestions: daySuggestions });
const todayAnswer = (): ApiResponse<TodayResponse> => ({
  ok: true,
  data: { date: DAY, sessions: [], monthClosed: false, timers: response(dayTimers, widgetOn) } as unknown as TodayResponse,
});

const api = new Proxy({}, {
  get: (_target, name: string) => (...args: unknown[]): Promise<unknown> => {
    apiCalls.push({ name, args });
    if (name === 'getToday') return Promise.resolve(todayAnswer());
    if (name === 'getSuggestions') return Promise.resolve({ ok: true, data: suggestionsDay() });
    if (name === 'startSuggestionTimer') {
      const taken = daySuggestions.find(s => s.uid === args[0]);
      if (!taken) return Promise.resolve({ ok: false, error: 'Suggestion not found for this uid and date' });
      daySuggestions = daySuggestions.filter(s => s !== taken);
      const started = timer(`t-${taken.uid}`, TimerState.Running, {
        task: taken.resolved?.task ?? null, entryId: taken.resolved ? `e-${taken.uid}` : null,
        description: taken.title, totalMs: 0, shareMs: 0,
      });
      dayTimers = [...dayTimers.map(t => ({ ...t, state: TimerState.Paused })), started];
      const data: SuggestionTimerResponse = { ...response(dayTimers, widgetOn), timerId: started.id, day: suggestionsDay() };
      return Promise.resolve({ ok: true, data });
    }
    return Promise.resolve({ ok: false, error: 'not in this test' });
  },
});

const zone = { run: (fn: () => void): void => fn() };
const service = new TimerWidgetService(zone as never, api as never);
const shell = new AppComponent(
  api as never,
  { start: (): void => {}, stop: (): void => {} } as never,
  { detectChanges: (): void => {} } as never,
  service,
  zone as never,
);
const hidden = shell as unknown as { onWidgetAction(action: unknown): void };
await service.start(action => hidden.onWidgetAction(action));

// What the widget window was last handed; null — it was told to go.
const lastPayload = (): WidgetPayload | null | undefined => {
  const syncs = calls.filter(c => c.cmd === 'sync_widget');
  return syncs.length === 0 ? undefined : syncs[syncs.length - 1].args['payload'] as WidgetPayload | null;
};
const stars = (): string[] => (lastPayload()?.suggested ?? []).map(s => s.uid);
const rows = (): string[] => (lastPayload()?.timers ?? []).map(t => t.id);
const takes = (): readonly unknown[][] => apiCalls.filter(c => c.name === 'startSuggestionTimer').map(c => [...c.args]);
// A poll: the day, then the suggestions that ride with it.
const poll = async (): Promise<void> => {
  nowMs += 10_000;
  await shell.refresh();
  await settle();
};

await test('no timers, a live suggestion: the widget comes for its star row', async () => {
  await poll();
  assert.deepEqual(rows(), []);
  assert.deepEqual(stars(), ['ev-planning', 'ev-sync']);
});

await test('the eye takes the row off the desktop; the suggestion stays in the feed', async () => {
  fire('widget-action', { kind: 'suggested-hide', uid: 'ev-planning' });
  await settle();
  assert.deepEqual(stars(), ['ev-sync']);
  assert.deepEqual(shell.daySuggestions.map(s => s.uid), ['ev-planning', 'ev-sync', 'ev-ended']);
  assert.equal(takes().length, 0, 'the daemon is not asked anything');
  await poll();
  assert.deepEqual(stars(), ['ev-sync'], 'the next poll does not bring it back');
});

await test('the last star row hidden: nothing to show — the widget goes', async () => {
  fire('widget-action', { kind: 'suggested-hide', uid: 'ev-sync' });
  await settle();
  assert.equal(lastPayload(), null);
});

await test('a hidden row is forgotten once its suggestion offers no timer', async () => {
  daySuggestions = [{ ...PLANNING, suggestedTimer: undefined }, SYNC, ENDED];
  await poll();
  daySuggestions = [PLANNING, SYNC, ENDED];
  await poll();
  assert.deepEqual(stars(), ['ev-planning'], 'offered anew — the row is back; the other one is still hidden');
});

await test('▶ of a star row takes the suggestion by a timer through the gate', async () => {
  fire('widget-action', { kind: 'suggested-start', uid: 'ev-planning' });
  await settle();
  assert.deepEqual(takes(), [['ev-planning', DAY, false]]);
  assert.deepEqual(rows(), ['t-ev-planning']);
  assert.deepEqual(stars(), [], 'the row became the timer');
  assert.deepEqual(shell.daySuggestions.map(s => s.uid), ['ev-sync', 'ev-ended'], 'the suggestion left the feed');
  assert.equal(shell.timers?.timers[0].state, TimerState.Running);
  assert.equal(shell.actionPending, false);
});

await test('the star row is never shown next to the timer it became', () => {
  const told = calls.filter(c => c.cmd === 'sync_widget').map(c => c.args['payload'] as WidgetPayload | null);
  const both = told.some(p => p !== null
    && p.timers.some(t => t.id === 't-ev-planning')
    && (p.suggested ?? []).some(s => s.uid === 'ev-planning'));
  assert.equal(both, false);
});

await test('Start timer in the feed\'s menu is the same action', async () => {
  apiCalls.length = 0;
  shell.submitSuggestionTimer({ uid: 'ev-sync', date: DAY });
  await settle();
  assert.deepEqual(takes(), [['ev-sync', DAY, false]]);
  assert.deepEqual(rows(), ['t-ev-planning', 't-ev-sync']);
  assert.deepEqual(shell.timers?.timers.map(t => t.state), [TimerState.Paused, TimerState.Running], 'one timer runs');
  assert.deepEqual(shell.daySuggestions.map(s => s.uid), ['ev-ended']);
});

await test('a click on a row whose suggestion offers no timer any more does nothing', async () => {
  apiCalls.length = 0;
  fire('widget-action', { kind: 'suggested-start', uid: 'ev-ended' });
  fire('widget-action', { kind: 'suggested-start', uid: 'gone' });
  await settle();
  assert.equal(takes().length, 0);
});

await test('the desktop widget switched off: no star rows, the suggestion still offers its timer', async () => {
  dayTimers = [];
  daySuggestions = [REVIEW];
  widgetOn = false;
  await poll();
  assert.equal(lastPayload(), null);
  assert.equal(shell.daySuggestions[0].suggestedTimer, true, 'Start timer stays in the row\'s menu');
  widgetOn = true;
  await poll();
  assert.deepEqual(stars(), ['ATL-9349']);
});

await test('suggestions hidden in the feed: no star rows either', async () => {
  shell.setSuggestionsMode('hidden');
  await settle();
  assert.equal(lastPayload(), null);
  shell.setSuggestionsMode('started');
  await settle();
  assert.deepEqual(stars(), ['ATL-9349']);
});

await test('nothing is offered: the widget and the feed are as they were', async () => {
  dayTimers = [DEPLOY];
  daySuggestions = [UNOFFERED, ENDED];
  await poll();
  assert.deepEqual(rows(), ['deploy']);
  assert.equal('suggested' in (lastPayload() as WidgetPayload), false);
});

// ─── Settings → Timer ─────────────────────────────────────────────────────
console.log('\nSettings');

function settingsView(timer: TimerSettings): { view: InstanceType<typeof SettingsViewComponent>; saved: SettingsPatch[]; changes: () => number } {
  let stored = timer;
  const saved: SettingsPatch[] = [];
  const answer = (): ApiResponse<SettingsResponse> => ({
    ok: true,
    data: { config: { timer: stored }, secretsMeta: { jiraConfigured: true, tempoConfigured: true } } as unknown as SettingsResponse,
  });
  const settingsApi = new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]): Promise<unknown> => {
      if (name === 'getSettings') return Promise.resolve(answer());
      if (name === 'updateSettings') {
        const patch = args[0] as SettingsPatch;
        saved.push(patch);
        stored = { ...stored, ...patch.config?.timer };
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({ ok: false, error: 'not in this test' });
    },
  });
  const view = new SettingsViewComponent(settingsApi as never, {} as never);
  view.settings = answer().data as SettingsResponse;
  let changes = 0;
  view.timerSettingsChanged.subscribe(() => { changes++; });
  return { view, saved, changes: () => changes };
}

await test('both switches are shown, off as the daemon has them', () => {
  const { view } = settingsView({ desktopWidget: true, suggested: { meeting: false, review: false } });
  assert.equal(view.suggestedTimersVisible, true);
  assert.equal(view.suggestedTimerOn('meeting'), false);
  assert.equal(view.suggestedTimerOn('review'), false);
});

await test('a switch saves at once and leaves the other settings of the block alone', async () => {
  const { view, saved, changes } = settingsView({ desktopWidget: true, suggested: { meeting: false, review: false } });
  view.toggleSuggestedTimer('meeting');
  assert.equal(view.suggestedTimerOn('meeting'), true, 'the switch moves before the daemon answers');
  await settle();
  assert.deepEqual(saved.map(patch => patch.config?.timer), [{ desktopWidget: true, suggested: { meeting: true, review: false } }]);
  assert.equal(changes(), 1, 'the shell reads the day again');

  view.toggleSuggestedTimer('review');
  view.toggleDesktopWidget();
  await settle();
  assert.deepEqual(saved[saved.length - 1].config?.timer, { desktopWidget: false, suggested: { meeting: true, review: true } });
  assert.equal(view.suggestedTimerOn('meeting'), true);
  assert.equal(view.suggestedTimerOn('review'), true);
  assert.equal(view.desktopWidgetOn, false);
});

await test('a daemon without suggested timers: the rows are hidden, the widget switch works as before', async () => {
  const { view, saved } = settingsView({ desktopWidget: true });
  assert.equal(view.suggestedTimersVisible, false);
  view.toggleSuggestedTimer('meeting');
  await settle();
  assert.equal(saved.length, 0);
  view.toggleDesktopWidget();
  await settle();
  assert.deepEqual(saved.map(patch => patch.config?.timer), [{ desktopWidget: false }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
