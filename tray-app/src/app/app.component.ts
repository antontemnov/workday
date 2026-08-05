import { Component, HostListener, OnInit, OnDestroy } from '@angular/core';
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
} from './models/workday.models';
import { DayViewComponent } from './views/day-view/day-view.component';
import { TimesheetsViewComponent } from './views/timesheets-view/timesheets-view.component';
import { SettingsViewComponent } from './views/settings-view/settings-view.component';
import { SetupViewComponent } from './views/setup-view/setup-view.component';

type TrayKind = 'live' | 'pending' | 'idle' | 'paused' | 'none';
type ActiveView = 'day' | 'sheet' | 'set' | 'setup';

interface SensitivityPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DayViewComponent, TimesheetsViewComponent, SettingsViewComponent, SetupViewComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  // ─── View routing (signal-style state via plain field for now) ─────────
  activeView: ActiveView = 'day';

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

  // Sensitivity = idle-patience scale. Pause/Resume is a separate per-card
  // button now, so it's no longer a pill here. Labels are display-only; the
  // backing enum values (low/normal/patient) are unchanged.
  readonly sensitivityPills: readonly SensitivityPillOption[] = [
    { key: SensitivityLevel.Low,      label: 'Sharp',   description: 'full stamina → 15 min idle', title: 'Short leash — at full stamina tolerates up to 15 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.Normal,   label: 'Normal',  description: '→ 45 min',                  title: 'Default — at full stamina tolerates up to 45 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.Patient,  label: 'Relaxed', description: '→ 90 min',                  title: 'Tolerant — at full stamina tolerates up to 90 min idle before pausing; each change tops it up' },
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
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
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

  get suggestionSummaries(): Readonly<Record<string, string>> {
    return this.suggestionsDay?.issueSummaries ?? {};
  }

  private async refreshSuggestions(): Promise<void> {
    const res = await this.api.getSuggestions();
    if (res.ok && res.data) this.suggestionsDay = res.data;
  }

  async refresh(): Promise<void> {
    const res = await this.api.getToday();
    if (res.ok && res.data) {
      this.data = res.data;
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
  async onPillSelected(e: { session: SessionDetail; pill: SensitivityPill }): Promise<void> {
    if (e.pill === 'pause') {
      await this.runAction(() => this.api.pause(e.session.repo));
    } else {
      await this.runAction(() => this.api.sensitivity(e.pill as SensitivityLevel, e.session.repo));
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

  // ─── Add time ──────────────────────────────────────────────────────────

  // Session-born manual entry: the daemon takes the task from the session,
  // activity is Development, no description by design. Shows up in Logged
  // and folds into the session aggregate at push time.
  async onAddTime(e: { session: SessionDetail; minutes: number }): Promise<void> {
    await this.runAction(() => this.api.addSessionTime(e.session.id, e.minutes));
  }

  // ─── Manual entries ────────────────────────────────────────────────────

  async submitLog(input: ManualEntryInput): Promise<void> {
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
    await this.runAction(() => this.api.updateManualEntry(e.target, e.patch));
  }

  // ─── Meeting suggestions ───────────────────────────────────────────────

  // Accept = a standalone ManualEntry with the meeting's sourceRef. The
  // response carries both the entry (→ draft window, like submitLog) and the
  // recalculated day — applied immediately, not left to the next poll.
  async submitSuggestionAccept(req: SuggestionAcceptRequest): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.acceptSuggestion(req);
      if (res.ok && res.data) {
        this.freshEntryId = res.data.entry.id;
        this.suggestionsDay = res.data.day;
      }
      return res;
    });
  }

  async submitSuggestionDismiss(e: { uid: string; date: string }): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.dismissSuggestion(e.uid, e.date);
      if (res.ok && res.data) this.suggestionsDay = res.data;
      return res;
    });
  }

  async submitSuggestionMute(e: { uid: string; date: string; days: number | null }): Promise<void> {
    await this.runAction(async () => {
      const res = await this.api.muteSuggestion(e.uid, e.date, e.days ?? undefined);
      if (res.ok && res.data) this.suggestionsDay = res.data;
      return res;
    });
  }

  // Deferred DELETE — the panel already played the undo window; a failure
  // surfaces as the usual toast and the row comes back with the refresh.
  async submitEntryDelete(target: string): Promise<void> {
    await this.runAction(() => this.api.deleteManualEntry(target));
  }

  async submitSessionDelete(target: string): Promise<void> {
    await this.runAction(() => this.api.deleteSession(target));
  }

  async submitTaskDelete(task: string): Promise<void> {
    await this.runAction(() => this.api.deleteTask(task));
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
