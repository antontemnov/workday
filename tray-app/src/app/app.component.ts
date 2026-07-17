import { Component, HostListener, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
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

type TrayKind = 'live' | 'pending' | 'idle' | 'paused' | 'none';
type ActiveView = 'day' | 'sheet' | 'set';

interface SensitivityPillOption {
  readonly key: SensitivityLevel;
  readonly label: string;
  readonly description: string;
  readonly title: string;
}

// One weekday cell resolved to a concrete date in the current week.
interface WeekdayNavCell {
  readonly letter: string;
  readonly full: string;
  readonly weekend: boolean;
  readonly date: string;       // YYYY-MM-DD for this weekday in the current week
  readonly isToday: boolean;
  readonly worked: boolean;    // has saved data → highlighted (display-only)
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DayViewComponent, TimesheetsViewComponent, SettingsViewComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  // ─── View routing (signal-style state via plain field for now) ─────────
  activeView: ActiveView = 'day';

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
  private watchdogFailures = 0;
  private lastDaemonSpawnAt = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  // Sensitivity = idle-patience scale. Pause/Resume is a separate per-card
  // button now, so it's no longer a pill here. Labels are display-only; the
  // backing enum values (low/normal/patient/always_on) are unchanged.
  readonly sensitivityPills: readonly SensitivityPillOption[] = [
    { key: SensitivityLevel.Low,      label: 'Sharp',   description: 'full stamina → 15 min idle', title: 'Short leash — at full stamina tolerates up to 15 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.Normal,   label: 'Normal',  description: '→ 45 min',                  title: 'Default — at full stamina tolerates up to 45 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.Patient,  label: 'Relaxed', description: '→ 90 min',                  title: 'Tolerant — at full stamina tolerates up to 90 min idle before pausing; each change tops it up' },
    { key: SensitivityLevel.AlwaysOn, label: 'Nonstop', description: 'never auto-pauses',          title: 'Never idle-pauses, but prioritizes your active repository. Resumes when you return.' },
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

  // Worked-day dots on the week strip (display-only, no navigation).
  private todayDate: string | null = null;
  private availableDates: string[] = [];
  private navLoaded = false;

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
    void this.refreshAvailableDates();
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
      return;
    }

    this.daemonReachable = false;
    this.daemonUserStopped = await this.api.isDaemonManuallyStopped();
    if (this.daemonUserStopped) {
      this.watchdogFailures = 0;
      return;
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

  private async refreshAvailableDates(): Promise<void> {
    const res = await this.api.getDays();
    if (res.ok && res.data) {
      this.availableDates = [...res.data.dates];
      this.navLoaded = true;
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
      this.todayDate = res.data.date;
      if (res.data.sessions.length > 0 && !this.availableDates.includes(res.data.date)) {
        this.availableDates = [res.data.date, ...this.availableDates].sort().reverse();
      }
      if (!this.navLoaded) {
        void this.refreshAvailableDates();
      }
    } else {
      this.error = res.error ?? 'Unknown error';
      this.daemonWasReachable = false;
    }
    this.loading = false;
    this.syncTrayStatus();
  }

  // ─── View switching ─────────────────────────────────────────────────────

  setView(v: ActiveView): void {
    // The just-logged draft belongs to the mounted Day view; leaving it strands
    // the fresh id, and returning would replay the draft stepper on the last
    // row. Drop it so the one-shot never outlives the view it targets.
    if (v !== 'day') this.freshEntryId = null;
    // Returning to the Day view re-pulls the activity scope — the user may
    // have just changed it in Settings (cheap: served from the daemon cache).
    if (v === 'day' && this.activeView !== 'day') void this.refreshActivityTypes();
    this.activeView = v;
  }

  // DayView mode pill click → existing pause / sensitivity action.
  async onPillSelected(e: { session: SessionDetail; pill: SensitivityPill }): Promise<void> {
    if (e.pill === 'pause') {
      await this.runAction(() => this.api.pause(e.session.repo));
    } else {
      await this.runAction(() => this.api.sensitivity(e.pill as SensitivityLevel, e.session.repo));
    }
  }

  // ─── Header: weekday strip + date display ──────────────────────────────

  /** Full weekday label — shown as the tooltip on the day-grid cell. */
  get dayWeekdayLabel(): string {
    const date = this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en', { weekday: 'long' });
  }

  /** Week-day grid (Mon..Sun). */
  readonly weekdayCells: ReadonlyArray<{ letter: string; full: string; idx: number; weekend: boolean }> = [
    { letter: 'M', full: 'Monday',    idx: 1, weekend: false },
    { letter: 'T', full: 'Tuesday',   idx: 2, weekend: false },
    { letter: 'W', full: 'Wednesday', idx: 3, weekend: false },
    { letter: 'T', full: 'Thursday',  idx: 4, weekend: false },
    { letter: 'F', full: 'Friday',    idx: 5, weekend: false },
    { letter: 'S', full: 'Saturday',  idx: 6, weekend: true  },
    { letter: 'S', full: 'Sunday',    idx: 0, weekend: true  },
  ];

  /** Mon..Sun of the current week — worked days highlighted, display-only. */
  get weekdayNav(): readonly WeekdayNavCell[] {
    const today = this.todayDate ?? this.computeLocalToday();
    const monday = this.mondayOf(today);
    return this.weekdayCells.map((c, i) => {
      const date = this.addDays(monday, i);
      return {
        letter: c.letter,
        full: c.full,
        weekend: c.weekend,
        date,
        isToday: date === today,
        worked: this.availableDates.includes(date),
      };
    });
  }

  trackByWeekday(_i: number, c: WeekdayNavCell): string {
    return c.date;
  }

  get formattedDate(): string {
    const date = this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  private computeLocalToday(): string {
    return this.toIso(new Date());
  }

  // Monday of the week containing dateStr (week runs Mon..Sun to match the grid).
  private mondayOf(dateStr: string): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    const dow = dt.getDay();                    // 0=Sun..6=Sat
    dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
    return this.toIso(dt);
  }

  private addDays(dateStr: string, n: number): string {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + n);
    return this.toIso(dt);
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

  // Deferred DELETE — the panel already played the undo window; a failure
  // surfaces as the usual toast and the row comes back with the refresh.
  async submitEntryDelete(target: string): Promise<void> {
    await this.runAction(() => this.api.deleteManualEntry(target));
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
        void this.refreshAvailableDates();
      }, 2000);
      setTimeout(() => { void this.refresh(); void this.refreshAvailableDates(); }, 5000);
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
