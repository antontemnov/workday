import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { WorkdayApiService } from './services/workday-api.service';
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

// One weekday cell resolved to a concrete date in the currently-viewed week.
interface WeekdayNavCell {
  readonly letter: string;
  readonly full: string;
  readonly weekend: boolean;
  readonly date: string;       // YYYY-MM-DD for this weekday in the viewed week
  readonly isToday: boolean;
  readonly active: boolean;    // the currently-viewed date
  readonly navigable: boolean; // has saved data (or is today) → clickable
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
  activityTypes: readonly ActivityType[] = [];

  // Log-cloud chip templates. loaded distinguishes "fetch never landed" from
  // a legitimately empty list — the poll retries only the former; the cache
  // is never cleared on failure (one-shot fetches must self-heal).
  favorites: readonly Favorite[] = [];
  private favoritesLoaded = false;

  // Entry id from the latest add — the Logged panel opens its draft window.
  freshEntryId: string | null = null;

  // Toast + action gate
  actionError: string | null = null;
  actionPending = false;

  // App self-update: version announced by the Rust background check.
  // Non-null → banner with a restart button; install is click-only.
  appUpdateVersion: string | null = null;
  appUpdateInstalling = false;
  private unlistenAppUpdate: UnlistenFn | null = null;

  // Day navigation: null = viewing today, otherwise a YYYY-MM-DD past date.
  viewedDate: string | null = null;
  private todayDate: string | null = null;
  private availableDates: string[] = [];
  private navLoaded = false;

  // Tracks daemon reachability across polls. Flips false on any failed call
  // (daemon down, mid-life self-update, apiVersion mismatch) so the next
  // success is recognized as a reconnect → re-pull activity types.
  private daemonWasReachable = true;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private api: WorkdayApiService) {}

  ngOnInit(): void {
    void this.watchAppUpdates();
    void this.refreshAvailableDates();
    void this.refreshActivityTypes();
    void this.refreshFavorites();
    this.refresh();
    this.pollTimer = setInterval(() => {
      if (this.isViewingToday) this.refresh();
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
    }
  }

  private async refreshFavorites(): Promise<void> {
    const res = await this.api.getFavorites();
    if (res.ok && res.data) {
      this.favorites = res.data.favorites;
      this.favoritesLoaded = true;
    }
  }

  async refresh(): Promise<void> {
    const date = this.viewedDate;
    const res = date
      ? await this.api.getDay(date)
      : await this.api.getToday();
    if (res.ok && res.data) {
      this.data = res.data;
      this.error = null;
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
      if (!date) this.todayDate = res.data.date;
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
    if (this.isViewingToday) this.syncTrayStatus();
  }

  // ─── View switching ─────────────────────────────────────────────────────

  setView(v: ActiveView): void {
    this.activeView = v;
  }

  // Timesheets click on a day row → switch to Day view for that date.
  onDaySelected(date: string): void {
    this.viewedDate = date;
    this.activeView = 'day';
    this.data = null;
    this.error = null;
    this.loading = true;
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

  // ─── Header: weekday grid + date display ───────────────────────────────

  /** Full weekday label — shown as the tooltip on the day-grid cell. */
  get dayWeekdayLabel(): string {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en', { weekday: 'long' });
  }

  /** Week-day grid (Mon..Sun). Highlights the active cell for the currently viewed date. */
  readonly weekdayCells: ReadonlyArray<{ letter: string; full: string; idx: number; weekend: boolean }> = [
    { letter: 'M', full: 'Monday',    idx: 1, weekend: false },
    { letter: 'T', full: 'Tuesday',   idx: 2, weekend: false },
    { letter: 'W', full: 'Wednesday', idx: 3, weekend: false },
    { letter: 'T', full: 'Thursday',  idx: 4, weekend: false },
    { letter: 'F', full: 'Friday',    idx: 5, weekend: false },
    { letter: 'S', full: 'Saturday',  idx: 6, weekend: true  },
    { letter: 'S', full: 'Sunday',    idx: 0, weekend: true  },
  ];

  get activeWeekdayCell(): number {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    const dow = new Date(y, m - 1, d).getDay();
    return this.weekdayCells.findIndex(c => c.idx === dow);
  }

  /** Mon..Sun of the viewed week, each cell resolved to a date + navigability.
   *  A cell is navigable when it has saved data (or is today) → click jumps to it. */
  get weekdayNav(): readonly WeekdayNavCell[] {
    const ref = this.viewedDate ?? this.todayDate ?? this.computeLocalToday();
    const monday = this.mondayOf(ref);
    const today = this.todayDate ?? this.computeLocalToday();
    const activeIdx = this.activeWeekdayCell;
    return this.weekdayCells.map((c, i) => {
      const date = this.addDays(monday, i);
      const isToday = date === today;
      return {
        letter: c.letter,
        full: c.full,
        weekend: c.weekend,
        date,
        isToday,
        active: i === activeIdx,
        navigable: isToday || this.availableDates.includes(date),
      };
    });
  }

  trackByWeekday(_i: number, c: WeekdayNavCell): string {
    return c.date;
  }

  /** Per-cell tooltip — full weekday, plus the date (and "today") when navigable. */
  weekdayTitle(c: WeekdayNavCell): string {
    if (!c.navigable || c.active) return c.full;
    const [y, m, d] = c.date.split('-').map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    return `${c.full} · ${label}${c.isToday ? ' (today)' : ''}`;
  }

  /** Weekday cell click → switch to Day view for that date. No-op without data. */
  selectWeekday(c: WeekdayNavCell): void {
    if (!c.navigable) return;
    this.activeView = 'day';
    if (c.active) return;           // already this day — just surfaced the Day view
    if (c.isToday) this.goToday();
    else this.navigateTo(c.date);
  }

  get formattedDate(): string {
    const date = this.viewedDate ?? this.data?.date ?? this.computeLocalToday();
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
  }

  get isViewingToday(): boolean {
    return this.viewedDate === null;
  }

  goToday(): void {
    if (this.isViewingToday) return;
    this.navigateTo(null);
    void this.refreshAvailableDates();
  }

  private navigateTo(date: string | null): void {
    this.viewedDate = date;
    this.data = null;
    this.error = null;
    this.loading = true;
    void this.refresh();
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
