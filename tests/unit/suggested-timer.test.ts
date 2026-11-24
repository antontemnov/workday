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
 * A ticket given in the feed to a suggestion that came without one (task?)
 * is given once: from then on the suggestion is one with a ticket — in the
 * feed and on the widget, which only mirrors the app. The main window keeps
 * it in memory; the daemon hears of it when the suggestion is logged or taken
 * by a timer.
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
const { suggestionKey, withTickets } = await import('../../tray-app/src/app/timer/suggestion-ticket.util');
const { LogCloudComponent } = await import('../../tray-app/src/app/views/day-view/log-cloud/log-cloud.component');
const { DayViewComponent } = await import('../../tray-app/src/app/views/day-view/day-view.component');
const { TimerWidgetComponent } = await import('../../tray-app/src/app/timer/timer-widget.component');
const { TimerWidgetService } = await import('../../tray-app/src/app/timer/timer-widget.service');
const { SuggestionRowComponent } = await import('../../tray-app/src/app/views/day-view/suggestion-row/suggestion-row.component');
const { AppComponent } = await import('../../tray-app/src/app/app.component');
const { SettingsViewComponent } = await import('../../tray-app/src/app/views/settings-view/settings-view.component');
import type {
  ApiResponse, Favorite, SettingsPatch, SettingsResponse, Suggestion, SuggestionsResponse, SuggestionTicket,
  SuggestionTimerResponse, TimerSettings, TimerView, TimersResponse, TodayResponse,
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

// ─── A ticket given in the feed ───────────────────────────────────────────
console.log('\nA ticket given in the feed');

const PRIVATE = suggestion('ev-private', 'Private appointment', { isPrivate: true });
const ticketsOf = (...pairs: readonly (readonly [Suggestion, SuggestionTicket])[]): ReadonlyMap<string, SuggestionTicket> =>
  new Map(pairs.map(([row, ticket]) => [suggestionKey(row), ticket]));

await test('a suggestion that got its ticket is a suggestion with a ticket — Other, as nothing is known of it', () => {
  const [planning, sync] = withTickets([PLANNING, SYNC], ticketsOf([SYNC, { task: 'ATL-555' }]));
  assert.equal(planning, PLANNING, 'the others are as they came');
  assert.deepEqual(sync.resolved, { task: 'ATL-555', activity: 'Other', level: 'picked' });
  assert.deepEqual({ ...sync, resolved: undefined }, { ...SYNC, resolved: undefined }, 'nothing else changes');
});

await test('an activity the pick brings — a candidate\'s, a favorite\'s — is kept', () => {
  const [sync] = withTickets([SYNC], ticketsOf([SYNC, { task: 'ATL-101', activity: 'Meeting' }]));
  assert.equal(sync.resolved?.activity, 'Meeting');
});

await test('a ticket the daemon knows stands', () => {
  assert.deepEqual(withTickets([PLANNING], ticketsOf([PLANNING, { task: 'ATL-1' }])), [PLANNING]);
});

await test('a ticket is given for the day: the same meeting tomorrow has none', () => {
  const tomorrow = { ...SYNC, date: '2026-11-23' };
  assert.deepEqual(withTickets([tomorrow], ticketsOf([SYNC, { task: 'ATL-555' }])), [tomorrow]);
});

await test('the widget mirrors the app: the star row reads the given ticket — a private meeting like any other', () => {
  const shown = withTickets([SYNC, PRIVATE], ticketsOf([SYNC, { task: 'ATL-555' }], [PRIVATE, { task: 'ATL-556' }]));
  assert.deepEqual(widgetSuggestions(shown), [
    { uid: 'ev-sync', task: 'ATL-555', description: 'Sync with the platform team' },
    { uid: 'ev-private', task: 'ATL-556', description: 'Private appointment' },
  ] satisfies WidgetSuggestion[]);
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

// ─── The feed's row: the pick as it was, then a row with a ticket ─────────
console.log('\nThe feed\'s row and a ticket given to it');

const ACTIVITIES = [{ value: 'Development', name: 'Development' }, { value: 'Other', name: 'Other' }, { value: 'Meeting', name: 'Meeting' }];
const labelsOf = (comp: InstanceType<typeof SuggestionRowComponent>): string[] =>
  comp.mainMenuItems(0, 0).filter((item): item is { label: string; action: () => void } => 'label' in item).map(item => item.label);

function feedRow(row: Suggestion): { comp: InstanceType<typeof SuggestionRowComponent>; asked: () => number; pick(next: SuggestionTicket): void } {
  const host = { nativeElement: { querySelector: (): unknown => null, getBoundingClientRect: (): unknown => ({}) } };
  const comp = new SuggestionRowComponent(host as never, {} as never);
  comp.suggestion = row;
  comp.activityTypes = ACTIVITIES;
  let asked = 0;
  comp.pickRequested.subscribe(() => { asked++; });
  return {
    comp,
    asked: () => asked,
    pick: (next: SuggestionTicket): void => {
      const previous = comp.picked;
      comp.picked = next;
      comp.ngOnChanges({ picked: { previousValue: previous, currentValue: next, firstChange: false, isFirstChange: () => false } });
    },
  };
}

await test('a pick opens the form as it always did: Other when nothing is known, the candidate\'s activity otherwise', () => {
  const plain = feedRow(SYNC);
  plain.pick({ task: 'ATL-555' });
  assert.equal(plain.comp.editing, true);
  assert.equal(plain.comp.editTask, 'ATL-555');
  assert.equal(plain.comp.editActivity, 'Other');
  assert.equal(plain.comp.editDescription, 'Sync with the platform team');
  const candidate = feedRow(SYNC);
  candidate.pick({ task: 'ATL-101', activity: 'Meeting' });
  assert.equal(candidate.comp.editActivity, 'Meeting');
});

await test('the form shut, the row is a suggestion with a ticket: Log…, the form again — no second pick', () => {
  const [bound] = withTickets([SYNC], ticketsOf([SYNC, { task: 'ATL-555' }]));
  const row = feedRow(bound);
  assert.deepEqual(labelsOf(row.comp), ['Log…', 'Start timer', 'Deny', 'Mute series…']);
  row.comp.accept();
  assert.equal(row.asked(), 0, 'the ticket is not asked for again');
  assert.equal(row.comp.editing, true);
  assert.equal(row.comp.editTask, 'ATL-555');
  assert.equal(row.comp.editActivity, 'Other');
});

await test('the Day view opens the form as before and reports the ticket up — once', () => {
  const view = new DayViewComponent({ nativeElement: {} } as never, { run: (fn: () => void): void => fn() } as never);
  const reported: { uid: string; date: string; ticket: SuggestionTicket }[] = [];
  view.suggestionTicketPicked.subscribe((e: { uid: string; date: string; ticket: SuggestionTicket }) => reported.push(e));
  view.openCloudForAccept(SYNC);
  const pick: SuggestionTicket = { task: 'ATL-555' };
  view.onAcceptPicked(pick);
  assert.deepEqual(reported, [{ uid: 'ev-sync', date: DAY, ticket: pick }]);
  assert.equal(view.cloudOpen, false);
  assert.equal(view.pickFor(SYNC), pick, 'the row gets its pick and opens the form');
  assert.equal(view.pickFor(PLANNING), null);
});

await test('a favorite picked for a suggestion says its activity; a Jira ticket says only the key', () => {
  const cloud = new LogCloudComponent({ getJiraInProgress: async (): Promise<{ ok: false }> => ({ ok: false }) } as never);
  cloud.open = true;
  cloud.acceptTarget = SYNC;
  const picked: SuggestionTicket[] = [];
  cloud.acceptPicked.subscribe((ticket: SuggestionTicket) => picked.push(ticket));
  const review: Favorite = { id: 'f1', name: 'PR review', task: 'ATL-205', minutes: 30, activity: 'CodeReview', createdAt: iso() };
  cloud.pickFavorite(review, {} as never);
  cloud.pickJira({ key: 'ATL-10', summary: 'Payment retry' }, {} as never);
  assert.deepEqual(picked, [{ task: 'ATL-205', activity: 'CodeReview' }, { task: 'ATL-10' }]);
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
      const task = (args[3] as SuggestionTicket | undefined)?.task ?? taken.resolved?.task ?? null;
      const started = timer(`t-${taken.uid}`, TimerState.Running, {
        task, entryId: task ? `e-${taken.uid}` : null,
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

// Every state the shell hands the widget — also one that never leaves the service.
const handed: (WidgetPayload | null)[] = [];
const handOver = service.sync.bind(service);
service.sync = (timers, suggestions = []): void => {
  handed.push(widgetPayload(timers, null, widgetSuggestions(suggestions)));
  handOver(timers, suggestions);
};

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
  const from = handed.length;
  fire('widget-action', { kind: 'suggested-start', uid: 'ev-planning' });
  await settle();
  assert.deepEqual(takes(), [['ev-planning', DAY, false, undefined]]);
  assert.deepEqual(rows(), ['t-ev-planning']);
  assert.deepEqual(stars(), [], 'the row became the timer');
  // Found on the real widget: told of the star row gone before the timer, it
  // was cut to the rows that were left — here it would have been told to go.
  assert.ok(handed.length > from);
  assert.ok(handed.slice(from).every(p => p !== null && p.timers.some(t => t.id === 't-ev-planning')), 'no moment without the row');
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
  assert.deepEqual(takes(), [['ev-sync', DAY, false, undefined]]);
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

// ─── The main window: a ticket given in the feed ──────────────────────────
console.log('\nThe main window and a ticket given in the feed');

const starKeys = (): (string | null)[] => (lastPayload()?.suggested ?? []).map(s => s.task);
const shown = (uid: string): Suggestion | undefined => shell.daySuggestions.find(s => s.uid === uid);
const CANDIDATES = suggestion('ev-retro', 'Retrospective', {
  candidates: [{ task: 'ATL-101', activity: 'Meeting', lastUsedAt: iso() }, { task: 'ATL-205', activity: 'Other', lastUsedAt: iso() }],
});

await test('the ticket is on the row and on the star row at once; the daemon is told nothing', async () => {
  dayTimers = [];
  daySuggestions = [SYNC, CANDIDATES, PRIVATE, ENDED];
  await poll();
  assert.deepEqual(starKeys(), [null, null, null]);
  apiCalls.length = 0;
  shell.onSuggestionTicket({ uid: 'ev-sync', date: DAY, ticket: { task: 'ATL-555' } });
  await settle();
  assert.deepEqual(shown('ev-sync')?.resolved, { task: 'ATL-555', activity: 'Other', level: 'picked' });
  assert.deepEqual(starKeys(), ['ATL-555', null, null]);
  assert.equal(apiCalls.length, 0);
});

await test('it stays through the polls and the Day tab', async () => {
  daySuggestions = [{ ...SYNC }, CANDIDATES, PRIVATE, ENDED];
  await poll();
  shell.setView('set');
  shell.setView('day');
  await poll();
  assert.equal(shown('ev-sync')?.resolved?.task, 'ATL-555');
  assert.deepEqual(starKeys(), ['ATL-555', null, null]);
});

await test('a private meeting is a meeting: the key on its star row, the ticket in its timer', async () => {
  shell.onSuggestionTicket({ uid: 'ev-private', date: DAY, ticket: { task: 'ATL-777' } });
  await settle();
  assert.deepEqual(starKeys(), ['ATL-555', null, 'ATL-777']);
  apiCalls.length = 0;
  fire('widget-action', { kind: 'suggested-start', uid: 'ev-private' });
  await settle();
  assert.deepEqual(takes(), [['ev-private', DAY, false, { task: 'ATL-777' }]]);
  assert.equal(shell.timers?.timers.find(t => t.id === 't-ev-private')?.task, 'ATL-777');
});

await test('▶ of the star row starts the timer on the given ticket', async () => {
  apiCalls.length = 0;
  fire('widget-action', { kind: 'suggested-start', uid: 'ev-sync' });
  await settle();
  assert.deepEqual(takes(), [['ev-sync', DAY, false, { task: 'ATL-555' }]]);
  const started = shell.timers?.timers.find(t => t.id === 't-ev-sync');
  assert.equal(started?.task, 'ATL-555');
  assert.equal(started?.state, TimerState.Running);
  assert.deepEqual(stars(), ['ev-retro']);
});

await test('Start timer in the menu sends a picked candidate with its activity', async () => {
  shell.onSuggestionTicket({ uid: 'ev-retro', date: DAY, ticket: { task: 'ATL-101', activity: 'Meeting' } });
  await settle();
  assert.deepEqual(starKeys(), ['ATL-101']);
  apiCalls.length = 0;
  shell.submitSuggestionTimer({ uid: 'ev-retro', date: DAY });
  await settle();
  assert.deepEqual(takes(), [['ev-retro', DAY, false, { task: 'ATL-101', activity: 'Meeting' }]]);
});

await test('a suggestion that offers no timer gets its ticket in the feed all the same', async () => {
  shell.onSuggestionTicket({ uid: 'ev-ended', date: DAY, ticket: { task: 'ATL-9' } });
  await settle();
  assert.equal(shown('ev-ended')?.resolved?.task, 'ATL-9');
  assert.deepEqual(stars(), [], 'it has no star row');
});

await test('a suggestion that left the feed takes its ticket along', async () => {
  daySuggestions = [];
  await poll();
  daySuggestions = [ENDED];
  await poll();
  assert.equal(shown('ev-ended')?.resolved, undefined, 'back in the feed, it asks again');
});

await test('a ticket for a suggestion that is not in the feed is dropped', async () => {
  shell.onSuggestionTicket({ uid: 'gone', date: DAY, ticket: { task: 'ATL-9' } });
  daySuggestions = [ENDED, suggestion('gone', 'Late arrival')];
  await poll();
  assert.equal(shown('gone')?.resolved, undefined);
});

await test('the daemon knows the series meanwhile: its ticket stands, the request carries none', async () => {
  daySuggestions = [SYNC];
  await poll();
  shell.onSuggestionTicket({ uid: 'ev-sync', date: DAY, ticket: { task: 'ATL-555' } });
  daySuggestions = [{ ...SYNC, resolved: { task: 'ATL-7104', activity: 'Meeting', level: 'series' } }];
  await poll();
  assert.equal(shown('ev-sync')?.resolved?.task, 'ATL-7104');
  apiCalls.length = 0;
  shell.submitSuggestionTimer({ uid: 'ev-sync', date: DAY });
  await settle();
  assert.deepEqual(takes(), [['ev-sync', DAY, false, undefined]]);
});

await test('suggestions hidden in the feed: the tickets go with them', async () => {
  daySuggestions = [SYNC];
  await poll();
  shell.onSuggestionTicket({ uid: 'ev-sync', date: DAY, ticket: { task: 'ATL-555' } });
  shell.setSuggestionsMode('hidden');
  shell.setSuggestionsMode('started');
  await settle();
  assert.deepEqual(starKeys(), [null]);
});

// ─── Settings → Timer ─────────────────────────────────────────────────────
console.log('\nSettings');

interface SettingsRig {
  readonly view: InstanceType<typeof SettingsViewComponent>;
  readonly saved: SettingsPatch[];
  readonly stored: () => TimerSettings;
  readonly changes: () => number;
  // Saves wait here until they are let through — a slow daemon.
  hold(): void;
  release(): Promise<void>;
}

function settingsView(timer: TimerSettings): SettingsRig {
  let stored = timer;
  const saved: SettingsPatch[] = [];
  let held = false;
  let waiting: (() => void)[] = [];
  const answer = (): ApiResponse<SettingsResponse> => ({
    ok: true,
    data: { config: { timer: stored }, secretsMeta: { jiraConfigured: true, tempoConfigured: true } } as unknown as SettingsResponse,
  });
  // The daemon lays a patch over what it has, field by field.
  const apply = (patch: SettingsPatch): void => {
    const next = patch.config?.timer;
    if (!next) return;
    stored = {
      desktopWidget: next.desktopWidget ?? stored.desktopWidget,
      ...(stored.suggested ? { suggested: { ...stored.suggested, ...next.suggested } } : {}),
    };
  };
  const settingsApi = new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]): Promise<unknown> => {
      if (name === 'getSettings') return Promise.resolve(answer());
      if (name === 'updateSettings') {
        const patch = args[0] as SettingsPatch;
        saved.push(patch);
        const done = (): { ok: boolean } => { apply(patch); return { ok: true }; };
        if (!held) return Promise.resolve(done());
        return new Promise(resolve => { waiting.push(() => resolve(done())); });
      }
      return Promise.resolve({ ok: false, error: 'not in this test' });
    },
  });
  const view = new SettingsViewComponent(settingsApi as never, {} as never);
  view.settings = answer().data as SettingsResponse;
  let changes = 0;
  view.timerSettingsChanged.subscribe(() => { changes++; });
  return {
    view, saved, stored: () => stored, changes: () => changes,
    hold: (): void => { held = true; },
    release: async (): Promise<void> => {
      const due = waiting;
      waiting = [];
      due.forEach(resume => resume());
      await settle();
    },
  };
}

const timerPatches = (rig: SettingsRig): unknown[] => rig.saved.map(patch => patch.config?.timer);

await test('both switches are shown, off as the daemon has them', () => {
  const { view } = settingsView({ desktopWidget: true, suggested: { meeting: false, review: false } });
  assert.equal(view.suggestedTimersVisible, true);
  assert.equal(view.suggestedTimerOn('meeting'), false);
  assert.equal(view.suggestedTimerOn('review'), false);
});

await test('a switch saves at once and sends only itself', async () => {
  const rig = settingsView({ desktopWidget: true, suggested: { meeting: false, review: false } });
  rig.view.toggleSuggestedTimer('meeting');
  assert.equal(rig.view.suggestedTimerOn('meeting'), true, 'the switch moves before the daemon answers');
  await settle();
  assert.deepEqual(timerPatches(rig), [{ suggested: { meeting: true } }]);
  assert.equal(rig.changes(), 1, 'the shell reads the day again');

  rig.view.toggleDesktopWidget();
  await settle();
  assert.deepEqual(timerPatches(rig)[1], { desktopWidget: false });
  assert.deepEqual(rig.stored(), { desktopWidget: false, suggested: { meeting: true, review: false } });
  assert.equal(rig.view.suggestedTimerOn('meeting'), true);
  assert.equal(rig.view.desktopWidgetOn, false);
});

await test('two switches moved while a save is on its way go out together', async () => {
  const rig = settingsView({ desktopWidget: true, suggested: { meeting: false, review: false } });
  rig.hold();
  rig.view.toggleDesktopWidget();
  rig.view.toggleSuggestedTimer('meeting');
  rig.view.toggleSuggestedTimer('review');
  await rig.release();
  await rig.release();
  assert.deepEqual(timerPatches(rig), [{ desktopWidget: false }, { suggested: { meeting: true, review: true } }]);
  assert.deepEqual(rig.stored(), { desktopWidget: false, suggested: { meeting: true, review: true } });
});

await test('a switch never puts its neighbour back, however slow the daemon is', async () => {
  // Found on the real app: meetings off, on again, then Desktop widget off —
  // and the daemon ended with meetings off.
  const rig = settingsView({ desktopWidget: true, suggested: { meeting: true, review: true } });
  rig.hold();
  rig.view.toggleSuggestedTimer('meeting');   // off — the save is on its way
  rig.view.toggleSuggestedTimer('meeting');   // on again — waits for that save
  await rig.release();                        // the first save lands, the second one goes out
  rig.view.toggleDesktopWidget();             // moved while the daemon still has "off"
  await rig.release();
  await rig.release();
  assert.deepEqual(timerPatches(rig), [{ suggested: { meeting: false } }, { suggested: { meeting: true } }, { desktopWidget: false }]);
  assert.deepEqual(rig.stored(), { desktopWidget: false, suggested: { meeting: true, review: true } });
  assert.equal(rig.view.suggestedTimerOn('meeting'), true);
  assert.equal(rig.view.desktopWidgetOn, false);
});

await test('a save that lands does not undo on screen what was switched after it', async () => {
  // Found on the real app as well: the view read the settings back after
  // every save, the switch jumped back for a moment, and the next click
  // landed on the wrong state.
  const rig = settingsView({ desktopWidget: true, suggested: { meeting: false, review: false } });
  rig.hold();
  rig.view.toggleSuggestedTimer('meeting');   // on
  rig.view.toggleSuggestedTimer('meeting');   // off
  await rig.release();                        // "on" lands at the daemon
  assert.equal(rig.view.suggestedTimerOn('meeting'), false, 'the switch stays where the last click put it');
  rig.view.toggleSuggestedTimer('meeting');   // on — the third click means what it shows
  assert.equal(rig.view.suggestedTimerOn('meeting'), true);
  await rig.release();
  await rig.release();
  assert.deepEqual(rig.stored(), { desktopWidget: true, suggested: { meeting: true, review: false } });
  assert.equal(rig.view.suggestedTimerOn('meeting'), true, 'the last save of the run reads the settings back');
  assert.equal(rig.changes(), 3);
});

await test('a daemon without suggested timers: the rows are hidden, the widget switch works as before', async () => {
  const rig = settingsView({ desktopWidget: true });
  assert.equal(rig.view.suggestedTimersVisible, false);
  rig.view.toggleSuggestedTimer('meeting');
  await settle();
  assert.equal(rig.saved.length, 0);
  rig.view.toggleDesktopWidget();
  await settle();
  assert.deepEqual(timerPatches(rig), [{ desktopWidget: false }]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
