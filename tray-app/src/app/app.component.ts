import { ChangeDetectorRef, Component, ElementRef, HostListener, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WorkdayApiService } from './services/workday-api.service';
import { NotificationDeliveryService } from './services/notification-delivery.service';
import {
  TodayResponse,
  SessionDetail,
  ApiResponse,
  SensitivityLevel,
  SensitivityPill,
  ActivityType,
  ManualEntryInput,
  ManualEntryPatch,
  Favorite,
  FavoriteInput,
  FavoriteRemoveResponse,
  Suggestion,
  SuggestionsResponse,
  SuggestionAcceptRequest,
  TimerActionResponse,
  TimerBindInput,
  TimerState,
  TimerView,
  TimersResponse,
} from './models/workday.models';
import { TimerChipComponent } from './timer/timer-chip.component';
import { TimerIslandComponent } from './timer/timer-island.component';
import { currentTimer } from './timer/timer-clock.util';
import { currentCtxMenu } from './views/day-view/ctx-menu.util';
import { DayViewComponent } from './views/day-view/day-view.component';
import { loadSuggestionsMode, persistSuggestionsMode, type SuggestionsMode } from './views/day-view/suggestions-mode.util';
import { TimesheetsViewComponent, type SheetAction } from './views/timesheets-view/timesheets-view.component';
import { SettingsViewComponent } from './views/settings-view/settings-view.component';
import { SetupViewComponent } from './views/setup-view/setup-view.component';

// An all-day suggestions read longer than this is a calendar re-fetch.
const ALL_DAY_SLOW_READ_MS = 200;

// While a timer is switched on the daemon may hand the count over on any of
// its ticks — the island is asked more often than the day.
const TIMER_POLL_MS = 3_000;

// Who counts and what state each timer is in — a change means the day's
// sessions and entries moved too.
function timersSignature(timers: TimersResponse): string {
  return `${timers.counting}|${timers.timers.map(t => `${t.id}:${t.state}:${t.entryId ?? ''}`).join(',')}`;
}

type TrayKind = 'live' | 'pending' | 'idle' | 'paused' | 'none';
type ActiveView = 'day' | 'sheet' | 'set' | 'setup';

interface SensitivityPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly hint: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule, DayViewComponent, TimesheetsViewComponent, SettingsViewComponent, SetupViewComponent,
    TimerChipComponent, TimerIslandComponent,
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  // ─── View routing (signal-style state via plain field for now) ─────────
  activeView: ActiveView = 'day';
  // Refused Day-tab edits roll back through it.
  @ViewChild(DayViewComponent) private dayView?: DayViewComponent;

  // Custom titlebar: the header's close glyph exists only inside the Tauri
  // webview — browser dev mode has no window to close.
  readonly isTauri: boolean = '__TAURI_INTERNALS__' in window;

  // ─── Data / lifecycle state ────────────────────────────────────────────
  data: TodayResponse | null = null;
  error: string | null = null;
  loading = true;
  daemonStarting = false;

  // Supervisor state (package E): reachability comes from the watchdog's
  // health checks; userStopped mirrors the daemon's manual-stop marker —
  // a deliberately stopped daemon is never respawned by the watchdog.
  daemonReachable = true;
  daemonUserStopped = false;
  // Jira site root from the status poll — kept on failure (self-heals on the
  // next tick), absent on older daemons → browse links stay hidden.
  jiraBaseUrl: string | null = null;
  private watchdogFailures = 0;
  private lastDaemonSpawnAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  // First-run: the daemon is an npm package the tray installs itself when
  // the offline screen discovers it missing. One attempt per launch —
  // failures park in daemonInstallError with a manual retry.
  daemonInstalling = false;
  daemonInstallError: string | null = null;
  nodeMissing = false;
  private daemonInstallAttempted = false;

  // Setup wizard auto-show: checked once per launch after the daemon comes
  // up. In-memory only — an unfinished setup re-offers on the next launch.
  private setupOffered = false;

  // Sensitivity = idle-patience scale: at full stamina a session tolerates
  // this much idle before auto-pausing (each change tops it up). Labels are
  // display-only; the backing enum values (low/normal/patient) are unchanged.
  // The hint rides the session's Mode menu.
  readonly sensitivityPills: readonly SensitivityPillOption[] = [
    { key: SensitivityLevel.Low,     label: 'Sharp',   hint: '15m idle' },
    { key: SensitivityLevel.Normal,  label: 'Normal',  hint: '45m idle' },
    { key: SensitivityLevel.Patient, label: 'Relaxed', hint: '90m idle' },
  ];

  // Modal state (cross-cutting, triggered by DayView events)
  endDayModalOpen = false;

  // Tempo _Activity_ options for the manual-entry composer; prefetched once.
  // activityTypes = full catalog (labels), activityAllowed = picker allow-list.
  activityTypes: readonly ActivityType[] = [];
  activityAllowed: readonly string[] = [];

  // Log-cloud chip templates. loaded distinguishes "fetch never landed" from
  // a legitimately empty list — the poll retries only the former; the cache
  // is never cleared on failure (one-shot fetches must self-heal).
  favorites: readonly Favorite[] = [];
  private favoritesLoaded = false;

  // Entry id from the latest add — the Logged panel opens its draft window.
  freshEntryId: string | null = null;

  // Today's meeting suggestions (daemon-derived, polled with the day). Kept
  // on failure — an old daemon without the endpoint simply never fills it,
  // a transient miss self-heals on the next poll.
  private suggestionsDay: SuggestionsResponse | null = null;
  // What the feed offers (tray-side preference): 'hidden' requests nothing,
  // 'all' makes reads and mutations carry includeFuture. Reads are ticketed at send time; a mutation answer or a
  // mode flip raises the floor, and a read sent below it is dropped — a slow
  // all-day read never repaints the feed with an older picture. Reads never
  // drop each other: whichever answers first in the current mode is applied.
  suggestionsMode: SuggestionsMode = loadSuggestionsMode();
  // An all-day answer is on screen — until then any all-day read is awaited.
  private allDayShown: boolean = false;
  // Any all-day read may be held by the daemon for a fresh calendar feed: the
  // launch one, the half-hourly one, a Show click. A read that outlives the
  // threshold counts as slow — that is what the menu reports as "fetching";
  // ordinary millisecond polls never reach it.
  private allDayReadsInFlight: number = 0;
  private allDaySlowReads: number = 0;
  private suggestionsTicket: number = 0;
  private suggestionsFloor: number = 0;

  // Manual timers (daemon >= 0.56.0 — null on an older one: no chip at all).
  // The state lives in the daemon; the tray shows it and sends actions.
  timers: TimersResponse | null = null;
  islandOpen: boolean = false;
  // task? was pressed on this timer: the island shrinks to its row and the
  // Day view's ticket cloud hangs under it.
  timerPick: TimerView | null = null;
  // The timer New timer has just made — its description takes the caret.
  timerBirthId: string | null = null;
  // Timer actions go out one after another: a description committed by a
  // blur and the click that caused the blur must both reach the daemon.
  private timerChain: Promise<unknown> = Promise.resolve();
  private timerPollTimer: ReturnType<typeof setInterval> | null = null;
  @ViewChild(TimerIslandComponent, { read: ElementRef }) private islandRef?: ElementRef<HTMLElement>;

  // Toast + action gate
  actionError: string | null = null;
  actionPending = false;

  // App self-update: version announced by the Rust background check.
  // Non-null → banner with a restart button; install is click-only.
  appUpdateVersion: string | null = null;
  appUpdateInstalling = false;
  private unlistenAppUpdate: UnlistenFn | null = null;

  // Toast actions land here: the toast window asks Rust to show main on a view.
  private unlistenNavigate: UnlistenFn | null = null;

  // Tracks daemon reachability across polls. Flips false on any failed call
  // (daemon down, mid-life self-update, apiVersion mismatch) so the next
  // success is recognized as a reconnect → re-pull activity types.
  private daemonWasReachable = true;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private api: WorkdayApiService,
    private notifications: NotificationDeliveryService,
    private cdr: ChangeDetectorRef,
  ) {}

  // Kill the WebView2 default context menu app-wide (Back/Refresh/Print…).
  // Right-click is a first-class action here (design iter.12); text inputs
  // keep the native menu for copy/paste.
  @HostListener('document:contextmenu', ['$event'])
  onGlobalContextMenu(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    if (target?.closest('input, textarea, [contenteditable]')) return;
    ev.preventDefault();
  }

  ngOnInit(): void {
    void this.watchAppUpdates();
    void this.watchNavigateEvents();
    this.notifications.start();
    void this.refreshActivityTypes();
    void this.refreshFavorites();
    this.refresh();
    this.pollTimer = setInterval(() => {
      this.refresh();
      // Activity types load once on startup; if that first fetch failed
      // (daemon not ready at launch / transient version mismatch) the
      // composer is stuck on "Other" until app restart. Retry until loaded.
      if (this.activityTypes.length === 0) void this.refreshActivityTypes();
      if (!this.favoritesLoaded) void this.refreshFavorites();
    }, 10_000);
    void this.watchdogTick();
    this.watchdogTimer = setInterval(() => void this.watchdogTick(), 15_000);
    this.timerPollTimer = setInterval(() => void this.pollTimers(), TIMER_POLL_MS);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.timerPollTimer) clearInterval(this.timerPollTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.unlistenAppUpdate) this.unlistenAppUpdate();
    if (this.unlistenNavigate) this.unlistenNavigate();
    this.notifications.stop();
  }

  // Toast "open" action → Rust shows this window and emits the target view.
  private async watchNavigateEvents(): Promise<void> {
    try {
      this.unlistenNavigate = await listen<string>('navigate-view', e => {
        const v = e.payload;
        if (v === 'day' || v === 'sheet' || v === 'set') this.setView(v);
      });
    } catch {
      // Outside Tauri webview (browser dev mode) — no window events.
    }
  }

  // ─── Daemon watchdog ─────────────────────────────────────────────────────

  // The tray is the daemon's supervisor: health-check every 15s, respawn
  // after 2 consecutive failures — unless the stop marker says the user
  // stopped it on purpose. The spawn cooldown rides out the daemon's own
  // self-update restart window; a spurious spawn is a no-op anyway
  // (single-instance guard daemon-side).
  private async watchdogTick(): Promise<void> {
    const res = await this.api.getStatus();
    if (res.ok) {
      this.daemonReachable = true;
      this.daemonUserStopped = false;
      this.watchdogFailures = 0;
      this.nodeMissing = false;
      this.daemonInstallError = null;
      const jiraUrl = res.data?.jiraBaseUrl;
      if (jiraUrl) this.jiraBaseUrl = jiraUrl;
      if (!this.setupOffered) {
        this.setupOffered = true;
        void this.maybeOfferSetup();
      }
      return;
    }

    this.daemonReachable = false;
    this.daemonUserStopped = await this.api.isDaemonManuallyStopped();
    if (this.daemonUserStopped) {
      this.watchdogFailures = 0;
      return;
    }

    // First run: no point respawning a CLI that isn't there — install it.
    if (!this.daemonInstallAttempted && !this.daemonInstalling) {
      const installed = await this.api.isDaemonInstalled();
      if (!installed) {
        await this.installDaemonFlow();
        return;
      }
    }

    this.watchdogFailures++;
    if (this.watchdogFailures < 2) return;
    if (Date.now() - this.lastDaemonSpawnAt < 60_000) return;
    this.lastDaemonSpawnAt = Date.now();
    try {
      await this.api.startDaemon();
    } catch {
      // Outside Tauri (browser dev) — nothing to spawn.
    }
  }

  // npm install -g workday-daemon via Rust, with the Node precondition
  // surfaced as its own screen — the one thing the app cannot self-heal.
  private async installDaemonFlow(): Promise<void> {
    this.daemonInstallAttempted = true;
    const node = await this.api.getNodeVersion();
    if (!node) {
      this.nodeMissing = true;
      return;
    }
    this.nodeMissing = false;
    this.daemonInstalling = true;
    this.daemonInstallError = null;
    try {
      await this.api.installDaemon();
      // Install command already spawned "workday start" — give it a moment.
      this.lastDaemonSpawnAt = Date.now();
      setTimeout(() => { void this.watchdogTick(); void this.refresh(); }, 3000);
      setTimeout(() => { void this.refresh(); }, 7000);
    } catch (e: unknown) {
      this.daemonInstallError = e instanceof Error ? e.message : 'Daemon install failed';
    } finally {
      this.daemonInstalling = false;
    }
  }

  // Offline-screen retry (failed install / Node installed since).
  async retryDaemonInstall(): Promise<void> {
    this.daemonInstallAttempted = false;
    this.daemonInstallError = null;
    await this.watchdogTick();
  }

  // Fresh daemon without the essentials configured → open the wizard. An
  // older daemon 404s the endpoint — no wizard, nothing lost.
  private async maybeOfferSetup(): Promise<void> {
    const res = await this.api.getSetup();
    if (!res.ok || !res.data) return;
    const c = res.data.configured;
    if (!c.jira || !c.repos) this.setView('setup');
  }

  // ─── App self-update ─────────────────────────────────────────────────────

  // Rust checks for tray updates (launch + every 6h) and announces a found
  // version. The launch check can finish before this listener attaches, so
  // also pull the stored pending version once.
  private async watchAppUpdates(): Promise<void> {
    try {
      this.unlistenAppUpdate = await listen<string>('app-update-available', e => {
        this.appUpdateVersion = e.payload;
      });
      const pending = await invoke<string | null>('get_pending_app_update');
      if (pending) this.appUpdateVersion = pending;
    } catch {
      // Outside Tauri webview (browser dev mode) — no updater.
    }
  }

  async installAppUpdate(): Promise<void> {
    if (this.appUpdateInstalling) return;
    this.appUpdateInstalling = true;
    try {
      // On success this process is replaced by the new version — no return.
      await invoke('install_app_update');
    } catch (e: unknown) {
      this.appUpdateInstalling = false;
      this.showToast(`App update failed: ${String(e)}`);
    }
  }

  // Activity options rarely change — fetch once on load (cached daemon-side).
  private async refreshActivityTypes(): Promise<void> {
    const res = await this.api.getActivityTypes();
    if (res.ok && res.data) {
      this.activityTypes = res.data.activities;
      this.activityAllowed = res.data.allowed ?? [];
    }
  }

  private async refreshFavorites(): Promise<void> {
    const res = await this.api.getFavorites();
    if (res.ok && res.data) {
      this.favorites = res.data.favorites;
      this.favoritesLoaded = true;
    }
  }

  get daySuggestions(): readonly Suggestion[] {
    return this.suggestionsDay?.suggestions ?? [];
  }

  private get allDaySuggestions(): boolean {
    return this.suggestionsMode === 'all';
  }

  get suggestionSummaries(): Readonly<Record<string, string>> {
    return this.suggestionsDay?.issueSummaries ?? {};
  }

  get allDayFetching(): boolean {
    return this.allDaySuggestions && this.allDaySlowReads > 0;
  }

  // The menu row waits out a slow read, and any read while nothing all-day is
  // on screen yet (launch, a Show click).
  get allDayBusy(): boolean {
    return this.allDaySuggestions && this.allDayReadsInFlight > 0
      && (this.allDaySlowReads > 0 || !this.allDayShown);
  }

  private async refreshSuggestions(): Promise<void> {
    if (this.suggestionsMode === 'hidden') return;
    const ticket = ++this.suggestionsTicket;
    const allDay = this.allDaySuggestions;
    const endRead = allDay ? this.beginAllDayRead() : null;
    try {
      const res = await this.api.getSuggestions(undefined, allDay);
      if (ticket <= this.suggestionsFloor) return;
      if (res.ok && res.data) this.applySuggestionsDay(res.data, false);
    } finally {
      endRead?.();
    }
  }

  private beginAllDayRead(): () => void {
    this.allDayReadsInFlight++;
    let slow = false;
    const slowTimer = setTimeout(() => { slow = true; this.allDaySlowReads++; }, ALL_DAY_SLOW_READ_MS);
    return (): void => {
      clearTimeout(slowTimer);
      this.allDayReadsInFlight--;
      if (slow) this.allDaySlowReads--;
    };
  }

  // raiseFloor: a mutation answer outdates every read sent before it.
  private applySuggestionsDay(day: SuggestionsResponse, raiseFloor: boolean = true): void {
    if (raiseFloor) this.suggestionsFloor = this.suggestionsTicket;
    this.suggestionsDay = day;
    if (this.allDaySuggestions) this.allDayShown = true;
  }

  // Every switch outdates the reads sent before it. Hidden drops the rows and
  // stops asking; leaving All day drops the upcoming rows at once; the rest
  // is one read — into All day the daemon may hold it for a fresh feed.
  // Picking All day again after a read that never answered just reads again.
  setSuggestionsMode(mode: SuggestionsMode): void {
    const previous = this.suggestionsMode;
    if (mode === previous && !(mode === 'all' && !this.allDayShown)) return;
    this.suggestionsMode = mode;
    this.allDayShown = false;
    persistSuggestionsMode(mode);
    this.suggestionsFloor = this.suggestionsTicket;
    if (mode === 'hidden') {
      this.suggestionsDay = null;
      return;
    }
    if (mode === 'started' && previous === 'all' && this.suggestionsDay) {
      this.suggestionsDay = {
        ...this.suggestionsDay,
        suggestions: this.suggestionsDay.suggestions.filter(s => !s.upcoming),
      };
      return;
    }
    void this.refreshSuggestions();
  }

  async refresh(): Promise<void> {
    const res = await this.api.getToday();
    if (res.ok && res.data) {
      this.data = res.data;
      this.timers = res.data.timers ?? null;
      this.error = null;
      void this.refreshSuggestions();
      // Daemon reachable again after a failure window — e.g. it finished a
      // self-update mid-session, possibly with a new apiVersion. Re-pull
      // activity types: they're never cleared on failure (so they can't fall
      // off), but a restarted daemon may serve an updated list, and this also
      // recovers a first load that never landed while the daemon was down.
      if (!this.daemonWasReachable) {
        this.daemonWasReachable = true;
        void this.refreshActivityTypes();
        void this.refreshFavorites();
      }
    } else {
      this.error = res.error ?? 'Unknown error';
      this.daemonWasReachable = false;
    }
    this.loading = false;
    this.syncTrayStatus();
  }

  // Header close glyph → CloseRequested → Rust hides to tray, never exits.
  async winClose(): Promise<void> {
    try {
      await getCurrentWindow().close();
    } catch {
      // Outside Tauri webview — nothing to close.
    }
  }

  // Minimize = straight to tray: direct hide() skips the native minimize
  // round-trip (no taskbar flicker) and matches what the Resized handler
  // would do anyway.
  async winMinimize(): Promise<void> {
    try {
      await getCurrentWindow().hide();
    } catch {
      // Outside Tauri webview — nothing to hide.
    }
  }

  // ─── View switching ─────────────────────────────────────────────────────

  setView(v: ActiveView): void {
    // The just-logged draft belongs to the mounted Day view; leaving it strands
    // the fresh id, and returning would replay the draft stepper on the last
    // row. Drop it so the one-shot never outlives the view it targets.
    if (v !== 'day') this.freshEntryId = null;
    // Returning to the Day view re-pulls the activity scope and suggestions —
    // the user may have just changed the scope or calendar settings there
    // (cheap: served from the daemon cache / derived).
    if (v === 'day' && this.activeView !== 'day') {
      void this.refreshActivityTypes();
      void this.refreshSuggestions();
    }
    this.activeView = v;
  }

  // Wizard finished or skipped → back to the day view with fresh data.
  onSetupDone(): void {
    this.setView('day');
    void this.refresh();
  }

  // DayView mode pill click → existing pause / sensitivity action.
  async onPillSelected(e: { session: SessionDetail; pill: SensitivityPill; keepPause?: boolean }): Promise<void> {
    if (e.pill === 'pause') {
      await this.runAction(() => this.api.pause(e.session.repo));
    } else if (e.pill === 'resume') {
      await this.runAction(() => this.api.resume(e.session.repo));
    } else {
      await this.runAction(() => this.api.sensitivity(e.pill as SensitivityLevel, e.session.repo, e.keepPause));
    }
  }

  // ─── Header: date display ──────────────────────────────────────────────

  get formattedDate(): string {
    return this.headerDate().toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  get formattedWeekday(): string {
    return this.headerDate().toLocaleDateString('en-GB', { weekday: 'long' });
  }

  private headerDate(): Date {
    const date = this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  private computeLocalToday(): string {
    return this.toIso(new Date());
  }

  private toIso(dt: Date): string {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  // ─── Tray icon sync ────────────────────────────────────────────────────

  private syncTrayStatus(): void {
    const open = this.openSessions;
    let kind: TrayKind = 'none';
    let label = 'Workday';

    if (open.length > 0) {
      const live    = open.find(s => !s.paused && s.state === 'active');
      const pending = open.find(s => !s.paused && s.state !== 'active');
      const idle    = open.find(s => s.paused && s.pauseSource === 'idle_timeout');
      const paused  = open.find(s => s.paused);

      if (live) {
        kind = 'live';
        label = `Workday — ${this.repoName(live.repo)}${live.task ? ' · ' + live.task : ''}`;
      } else if (pending) {
        kind = 'pending';
        label = `Workday — ${this.repoName(pending.repo)} (pending)`;
      } else if (idle) {
        kind = 'idle';
        label = `Workday — idle (${this.repoName(idle.repo)})`;
      } else if (paused) {
        kind = 'paused';
        label = `Workday — paused (${this.repoName(paused.repo)})`;
      }
    }

    void invoke('set_tray_status', { kind, tooltip: label }).catch(() => {});
  }

  private get openSessions(): SessionDetail[] {
    return this.data?.sessions.filter(s => !s.closedBy) ?? [];
  }

  private repoName(repoPath: string): string {
    return repoPath.split('/').pop() ?? repoPath;
  }

  // ─── Manual timers ─────────────────────────────────────────────────────

  // The chip's timer: the running one, else the waiting one, else the last
  // touched by hand; null = the island is empty and the chip reads "Timer".
  get chipTimer(): TimerView | null {
    return this.timers ? currentTimer(this.timers.timers) : null;
  }

  // The chip opens and closes the island. With a ticket cloud hanging from
  // it, the click only lets the cloud go.
  toggleIsland(): void {
    const wasOpen = this.islandOpen && this.timerPick === null;
    this.closeTimerPick();
    this.islandOpen = !wasOpen;
  }

  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(ev: PointerEvent): void {
    if (!this.islandOpen || this.timerPick !== null) return;
    const target = ev.target as HTMLElement | null;
    if (target?.closest('app-timer-island, app-timer-chip')) return;
    this.islandOpen = false;
  }

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    if (this.islandOpen && this.timerPick === null && currentCtxMenu() === null) this.islandOpen = false;
  }

  onTimerToggle(timer: TimerView): void {
    void this.runTimerAction(() => timer.state === TimerState.Paused
      ? this.api.startTimer(timer.id)
      : this.api.pauseTimer(timer.id));
  }

  onTimerPause(timerId: string): void {
    void this.runTimerAction(() => this.api.pauseTimer(timerId));
  }

  // New timer in the island: it runs at once, the caret waits in its description.
  onTimerNew(): void {
    void this.runTimerAction(() => this.api.newTimer(), data => {
      this.timerBirthId = data.timerId;
      this.islandOpen = true;
    });
  }

  // Start timer «text» in the Log cloud: the description is there already,
  // the chip lights up — the island stays shut.
  onTimerStartText(text: string): void {
    void this.runTimerAction(() => this.api.newTimer(text));
  }

  onTimerDescribe(e: { id: string; description: string }): void {
    void this.runTimerAction(() => this.api.describeTimer(e.id, e.description));
  }

  onTimerDelete(timer: TimerView): void {
    if (this.timerPick?.id === timer.id) this.closeTimerPick();
    void this.runTimerAction(() => this.api.deleteTimer(timer.id));
  }

  // Esc on the fresh timer's empty description — it was started by mistake.
  onTimerCancel(timerId: string): void {
    this.timerBirthId = null;
    void this.runTimerAction(() => this.api.cancelTimer(timerId));
  }

  // task?: the island shrinks to the timer's row, the ticket cloud opens
  // under it — on the Day tab, where the cloud lives.
  onTimerTask(timer: TimerView): void {
    if (this.timerPick?.id === timer.id) {
      this.closeTimerPick();
      return;
    }
    this.setView('day');
    this.timerPick = timer;
    this.islandOpen = true;
    // Render now: the Day view mounts and the island takes its one-row
    // height — the cloud is measured against that, not the list it was.
    this.cdr.detectChanges();
    const island = this.islandRef?.nativeElement;
    if (!island || !this.dayView) {
      this.timerPick = null;
      return;
    }
    this.dayView.openCloudForTimer(timer, this.timers?.asOf ?? '', island.getBoundingClientRect());
  }

  onTimerBind(e: { timerId: string; input: TimerBindInput }): void {
    void this.runTimerAction(() => this.api.bindTimer(e.timerId, e.input));
  }

  onEntryTimerStart(entryId: string): void {
    void this.runTimerAction(() => this.api.startEntryTimer(entryId));
  }

  onEntryTimerRemove(entryId: string): void {
    void this.runTimerAction(() => this.api.removeEntryTimer(entryId));
  }

  private closeTimerPick(): void {
    if (this.timerPick === null) return;
    this.timerPick = null;
    this.dayView?.closeCloud();
  }

  // One at a time, in the order they were asked for; the answer carries the
  // day's timers, shown before the refresh brings the rest of the day.
  private runTimerAction(
    call: () => Promise<ApiResponse<TimerActionResponse>>,
    done?: (data: TimerActionResponse) => void,
  ): Promise<boolean> {
    const result = this.timerChain.then(() => this.runAction(async () => {
      const res = await call();
      if (res.ok && res.data) {
        this.timers = res.data;
        done?.(res.data);
      }
      return res;
    }));
    this.timerChain = result.catch(() => false);
    return result;
  }

  // A switched-on timer can change hands on a daemon tick; when it does, the
  // sessions and entries of the day changed with it.
  private async pollTimers(): Promise<void> {
    const before = this.timers;
    if (!before || this.actionPending || !before.timers.some(t => t.state !== TimerState.Paused)) return;
    const res = await this.api.getTimers();
    if (!res.ok || !res.data || this.actionPending || this.timers !== before) return;
    this.timers = res.data;
    if (timersSignature(res.data) !== timersSignature(before)) void this.refresh();
  }

  // ─── Add time ──────────────────────────────────────────────────────────

  // ─── Manual entries ────────────────────────────────────────────────────

  async submitLog(input: ManualEntryInput): Promise<void> {
    // A bare Development add lands on the ticket's existing record and comes
    // back under the same id — drop it first so the panel sees a change.
    this.freshEntryId = null;
    await this.runAction(async () => {
      const res = await this.api.addManualEntry(input);
      // Captured before the refresh inside runAction, so the panel sees the
      // fresh id and the entry land together.
      if (res.ok && res.data) this.freshEntryId = res.data.id;
      return res;
    });
  }

  // Batch review → sequential POSTs in one gated action; a failure stops the
  // run (entries before it stay logged) and surfaces as the usual toast. No
  // freshEntryId: batch entries land as static rows, no draft window.
  async submitLogBatch(inputs: readonly ManualEntryInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.runAction(async () => {
      let last: ApiResponse<unknown> = { ok: false, error: 'empty batch' };
      for (const input of inputs) {
        last = await this.api.addManualEntry(input);
        if (!last.ok) return last;
      }
      return last;
    });
  }

  async submitEntryEdit(e: { target: string; patch: ManualEntryPatch }): Promise<void> {
    if (!await this.runAction(() => this.api.updateManualEntry(e.target, e.patch))) this.dayView?.rollback(e.target);
  }

  // ─── Meeting suggestions ───────────────────────────────────────────────

  // Accept = a standalone ManualEntry with the meeting's sourceRef. The
  // response carries both the entry (→ draft window, like submitLog) and the
  // recalculated day — applied immediately, not left to the next poll.
  async submitSuggestionAccept(req: SuggestionAcceptRequest): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.acceptSuggestion({ ...req, includeFuture: this.allDaySuggestions });
      if (res.ok && res.data) {
        this.freshEntryId = res.data.entry.id;
        this.applySuggestionsDay(res.data.day);
      }
      return res;
    });
  }

  async submitSuggestionDismiss(e: { uid: string; date: string }): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.dismissSuggestion(e.uid, e.date, this.allDaySuggestions);
      if (res.ok && res.data) this.applySuggestionsDay(res.data);
      return res;
    });
  }

  async submitSuggestionMute(e: { uid: string; date: string; days: number | null }): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.muteSuggestion(e.uid, e.date, e.days ?? undefined, this.allDaySuggestions);
      if (res.ok && res.data) this.applySuggestionsDay(res.data);
      return res;
    });
  }

  // Deferred DELETE — the panel already played the undo window; a failure
  // surfaces as the usual toast and the row comes back at once.
  submitEntryDelete(target: string): void {
    this.runCommit(() => this.api.deleteManualEntry(target), this.rollbackOnRefusal(target));
  }

  async submitSessionStop(target: string): Promise<void> {
    if (!await this.runAction(() => this.api.stopSession(target))) this.dayView?.rollback(target);
  }

  submitSessionDelete(target: string): void {
    this.runCommit(() => this.api.deleteSession(target), this.rollbackOnRefusal(target));
  }

  submitTaskDelete(task: string, includeOpen = false): void {
    this.runCommit(() => this.api.deleteTask(task, undefined, includeOpen), this.rollbackOnRefusal(task));
  }

  private rollbackOnRefusal(id: string): (ok: boolean) => void {
    return ok => { if (!ok) this.dayView?.rollback(id); };
  }

  // Timesheets edits share the gate; the tab reloads its month afterwards.
  submitSheetAction(a: SheetAction): void {
    this.runCommit(a.run, a.done);
  }

  // A card's delete commits in one breath — its tracked part, then each
  // entry (and a view torn down commits every pending one at once). Calls
  // made within one tick go out as ONE action, one after another: the gate
  // would drop all but the first. The first failure is the toast.
  private commitCalls: (() => Promise<ApiResponse<unknown>>)[] = [];
  private commitDone: ((ok: boolean) => void)[] = [];

  private runCommit(call: () => Promise<ApiResponse<unknown>>, done?: (ok: boolean) => void): void {
    this.commitCalls.push(call);
    if (done) this.commitDone.push(done);
    if (this.commitCalls.length === 1) queueMicrotask(() => void this.flushCommits());
  }

  private async flushCommits(): Promise<void> {
    const calls = this.commitCalls;
    const done = this.commitDone;
    this.commitCalls = [];
    this.commitDone = [];
    const ok = await this.runAction(async () => {
      let failed: ApiResponse<unknown> | null = null;
      for (const call of calls) {
        const res = await call();
        if (!res.ok && !failed) failed = res;
      }
      return failed ?? { ok: true };
    });
    for (const d of done) d(ok);
  }

  // ─── Favorites (context-menu management) ───────────────────────────────

  async submitFavoriteAdd(input: FavoriteInput): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.addFavorite(input);
      if (res.ok && res.data) this.favorites = res.data.favorites;
      return res;
    });
  }

  async submitFavoritesRemove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.runAction(async () => {
      let last: ApiResponse<FavoriteRemoveResponse> = { ok: false, error: 'empty removal' };
      for (const id of ids) {
        last = await this.api.removeFavorite(id);
        if (!last.ok) return last;
        if (last.data) this.favorites = last.data.favorites;
      }
      return last;
    });
  }

  async confirmEndDay(): Promise<void> {
    const ok = await this.runAction(() => this.api.stop());
    if (ok) {
      this.endDayModalOpen = false;
      // The daemon writes its manual-stop marker; reflect it immediately so
      // the watchdog stands down and the Settings toggle flips to Start.
      this.daemonReachable = false;
      this.daemonUserStopped = true;
      this.watchdogFailures = 0;
    }
  }

  // ─── Daemon lifecycle ──────────────────────────────────────────────────

  async startDaemon(): Promise<void> {
    this.daemonStarting = true;
    this.daemonUserStopped = false;
    // The spawn counts as the watchdog's attempt — no double start.
    this.lastDaemonSpawnAt = Date.now();
    this.watchdogFailures = 0;
    try {
      await this.api.startDaemon();
      // Spinner holds until the first post-spawn health check answers.
      setTimeout(() => {
        void this.watchdogTick().finally(() => { this.daemonStarting = false; });
        void this.refresh();
      }, 2000);
      setTimeout(() => { void this.refresh(); }, 5000);
    } catch (e: unknown) {
      this.showToast(e instanceof Error ? e.message : 'Failed to start daemon');
      this.daemonStarting = false;
    }
  }

  // ─── Action gate ───────────────────────────────────────────────────────

  private async runAction<T>(fn: () => Promise<ApiResponse<T>>): Promise<boolean> {
    if (this.actionPending) return false;
    this.actionPending = true;
    this.actionError = null;
    try {
      const res = await fn();
      if (!res.ok) {
        this.showToast(res.error ?? 'Action failed');
        return false;
      }
      await this.refresh();
      return true;
    } finally {
      this.actionPending = false;
    }
  }

  dismissToast(): void {
    this.actionError = null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  private showToast(msg: string): void {
    this.actionError = msg;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.actionError = null, 4000);
  }
}
