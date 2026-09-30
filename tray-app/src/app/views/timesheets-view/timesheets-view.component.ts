import {
  ChangeDetectorRef, Component, ElementRef, EventEmitter, Input, NgZone, OnDestroy, OnInit, Output, QueryList, ViewChild, ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkdayApiService } from '../../services/workday-api.service';
import { PushStateService } from '../../services/push-state.service';
import {
  ActivityType,
  AdoptedEntry,
  ApiResponse,
  EntryConflict,
  Favorite,
  FavoriteInput,
  ManualEntry,
  ManualEntryInput,
  ManualEntryPatch,
  MonthDayStatus,
  MonthDaySummary,
  MonthDayTask,
  MonthResponse,
  MonthSyncState,
  PushFailure,
  PushResponse,
  ResolveSide,
  ScheduleDay,
  SessionDetail,
  TempoApprovalResponse,
  TempoResolveResponse,
  TempoScheduleResponse,
} from '../../models/workday.models';
import { LoggedPanelComponent } from '../day-view/logged-panel/logged-panel.component';
import { ChipPick, LogCloudComponent } from '../day-view/log-cloud/log-cloud.component';
import { CTX_ICON } from '../day-view/ctx-icons.util';
import { CtxMenuEntry, toggleAnchoredMenu } from '../day-view/ctx-menu.util';
import { sessionRowState } from '../day-view/session-row/session-row.component';
import { staminaHeat } from '../day-view/session-row/stamina-heat.util';

// A Timesheets edit rides the app's one action gate; the tab reloads its
// month when the daemon has answered (ok or not — the card reconciles).
export interface SheetAction {
  readonly run: () => Promise<ApiResponse<unknown>>;
  readonly done: (ok: boolean) => void;
}

const NO_SUMMARIES: Readonly<Record<string, string>> = {};
const NO_REFUSALS: readonly PushFailure[] = [];
const NO_IDS: ReadonlySet<string> = new Set<string>();
const TOAST_MS = 2000;
const CLOUD_GAP = 6;
const CLOUD_EDGE = 8;
// The cloud's own inset from the view's left edge (log-cloud :host).
const CLOUD_LEFT = 10;
// The ticket the Push button leads to settles this far under the header.
const SEEK_TOP = 60;
// A live day's ▶ when nothing accrues — the lab's warm white.
const IDLE_HEAT = '243 220 200';

// The Push menu's ↗ — the header button's arrow on the menu's 12px box.
const PUSH_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="butt" stroke-linejoin="miter"><path d="M3 13L12.8 3.2"/><path d="M5.8 3H13V10.2"/></svg>';

interface DayRow {
  readonly date: string;
  readonly dayNum: number;
  readonly weekday: string;              // 'Fri' — printed uppercase
  readonly isToday: boolean;
  readonly dim: boolean;                 // an empty non-working day
  readonly holidayName: string | null;   // from Tempo schedule
  readonly state: MonthSyncState;
  readonly hasContent: boolean;          // tickets to show — hours instead of '—'
  readonly reportedSeconds: number;      // what Tempo gets for the day
  readonly heat: string;                 // the live ▶'s temperature
  readonly entries: readonly ManualEntry[];
  readonly openSessions: readonly SessionDetail[];
  readonly closedSessions: readonly SessionDetail[];
  readonly foreign: readonly MonthDayTask[];
  readonly conflicts: readonly EntryConflict[];
}

interface WeekGroup {
  readonly label: string;        // '21 — 27'
  readonly rows: readonly DayRow[];
}

interface PeriodStatus {
  readonly cls: string;          // open | in_review | approved | rejected
  readonly label: string;
}

interface Gap {
  readonly amount: string;       // '7h 00m'
  readonly word: 'behind' | 'ahead';
}

// The header's Push button: blocked, it becomes the way to what blocks it.
// count = conflicts / new rows / UNPUSHED days, by kind.
export interface PushView {
  readonly kind: 'none' | 'busy' | 'resolve' | 'review' | 'nothing' | 'push';
  readonly count: number;
}

interface SeekTarget {
  readonly date: string;
  readonly task: string;
}

/**
 * Timesheets tab (canon v2, design-preview/timesheets-lab.html). A month of
 * days against Tempo: the header names the month (status, gap, total) and
 * syncs it (the Push navigator · Fetch); an open day is one glass
 * whose lid is the day row, its tickets are the Day tab's card in sheet mode.
 * Every read of Tempo is a sync done by the daemon — the tab only asks,
 * shows what came back (new rows once, via Review) and leads to what blocks
 * a push (conflicts first).
 */
@Component({
  selector: 'app-timesheets-view',
  standalone: true,
  imports: [CommonModule, LoggedPanelComponent, LogCloudComponent],
  templateUrl: './timesheets-view.component.html',
  styleUrl: './timesheets-view.component.scss',
})
export class TimesheetsViewComponent implements OnInit, OnDestroy {
  // The app's action gate — edits and the push wait for it.
  @Input() actionPending = false;
  @Input() jiraBaseUrl: string | null = null;
  @Input() favorites: readonly Favorite[] = [];
  @Input() activityTypes: readonly ActivityType[] = [];
  @Input() activityAllowed: readonly string[] = [];
  @Output() action = new EventEmitter<SheetAction>();
  @Output() favoriteAddSubmitted = new EventEmitter<FavoriteInput>();
  @Output() favoritesRemoveSubmitted = new EventEmitter<readonly string[]>();
  @Output() settingsRequested = new EventEmitter<void>();

  @ViewChildren(LoggedPanelComponent) private panels?: QueryList<LoggedPanelComponent>;
  @ViewChild('zone') private zoneRef?: ElementRef<HTMLElement>;
  @ViewChild('head') private headRef?: ElementRef<HTMLElement>;
  @ViewChild(LogCloudComponent, { read: ElementRef }) private cloudRef?: ElementRef<HTMLElement>;

  monthData: MonthResponse | null = null;
  schedule: TempoScheduleResponse | null = null;
  approval: TempoApprovalResponse | null = null;
  approvalRefreshing = false;
  loading = true;
  error: string | null = null;

  year: number;
  month: number;

  syncing = false;
  // The last read of Tempo failed — said in red under the total.
  tempoUnreachable = false;
  // Months read this view — the read runs once per month view; a failed
  // one retries on the upkeep tick (self-heal), Fetch reads on demand.
  private readonly syncedMonths = new Set<string>();

  private readonly openDates = new Set<string>();
  // An open day's Σ as its card shows it (ms) — undo windows included.
  private readonly liveTotals = new Map<string, number>();
  // date → entries whose conflict side is taken (the card reports them).
  private readonly sidesPending = new Map<string, ReadonlySet<string>>();
  // The entry the latest ＋Log created — its card opens the draft window.
  private freshEntry: { readonly date: string; readonly id: string } | null = null;

  toastText = '';
  toastOn = false;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // ＋Log cloud, hung under (or over) the lid of its day.
  cloudOpen = false;
  cloudTop = 0;
  cloudOrigin: string | null = null;
  private cloudDate: string | null = null;
  private cloudAnchor: { readonly lid: HTMLElement; readonly btn: HTMLElement } | null = null;
  private cloudSide: 'below' | 'above' = 'below';
  private cloudResize?: ResizeObserver;

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pushWatch: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  // Guards against stale responses landing after a month switch.
  private loadSeq = 0;

  public constructor(
    private api: WorkdayApiService,
    private pushState: PushStateService,
    private host: ElementRef<HTMLElement>,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {
    const today = localToday();
    this.year = Number(today.slice(0, 4));
    this.month = Number(today.slice(5, 7));
  }

  ngOnInit(): void {
    void this.load(true);
    void this.autoSync();
    // A push started by an earlier visit is still out: reload once it lands.
    if (this.pushState.pushing()) {
      this.pushWatch = setInterval(() => {
        if (this.pushState.pushing()) return;
        if (this.pushWatch) clearInterval(this.pushWatch);
        this.pushWatch = null;
        void this.reloadMonthQuiet();
      }, 1000);
    }
    // Quiet upkeep: failed loads retry until they land (one-shot fetches must
    // self-heal), and today's row stays fresh while the current month is on
    // screen. Meta calls are cached daemon-side; the approval is asked every
    // tick — a reviewer can flip it while the tab stays open.
    this.refreshTimer = setInterval(() => {
      if (this.pushing) return;
      if (!this.monthData || this.error) { void this.load(false); return; }
      if (this.monthContainsToday) void this.reloadMonthQuiet();
      if (this.schedule === null) void this.loadSchedule(this.loadSeq);
      void this.loadApproval(this.loadSeq);
      void this.autoSync();
    }, 30_000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.pushWatch) clearInterval(this.pushWatch);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.cloudResize?.disconnect();
  }

  // ─── Loading ───────────────────────────────────────────────────────────

  private async load(showLoading: boolean): Promise<void> {
    const seq = ++this.loadSeq;
    if (showLoading) this.loading = true;
    void this.loadSchedule(seq);
    void this.loadApproval(seq);
    const res = await this.api.getMonth(this.year, this.month);
    if (seq !== this.loadSeq) return;
    if (res.ok && res.data) {
      this.monthData = res.data;
      this.error = null;
    } else {
      this.error = res.error ?? 'Unknown error';
      // A stale other-month payload must not render under this header;
      // same-month data survives so a blip doesn't blank the screen.
      if (this.monthData && (this.monthData.year !== this.year || this.monthData.month !== this.month)) {
        this.monthData = null;
      }
    }
    this.loading = false;
  }

  private async reloadMonthQuiet(): Promise<void> {
    const seq = this.loadSeq;
    const res = await this.api.getMonth(this.year, this.month);
    if (seq !== this.loadSeq || !res.ok || !res.data) return;
    this.monthData = res.data;
    this.error = null;
    this.pruneSidesPending();
  }

  private async loadSchedule(seq: number): Promise<void> {
    const res = await this.api.getTempoSchedule(this.year, this.month);
    if (seq !== this.loadSeq) return;
    this.schedule = res.ok && res.data ? res.data : null;
  }

  // A failed call keeps the last known status; a month switch clears it.
  private async loadApproval(seq: number): Promise<void> {
    const res = await this.api.getTempoApproval(this.year, this.month);
    if (seq !== this.loadSeq || !res.ok || !res.data) return;
    this.approval = res.data;
  }

  // The status tag: ask Tempo now, past the daemon's cache.
  async refreshApproval(): Promise<void> {
    if (this.approvalRefreshing) return;
    const seq = this.loadSeq;
    this.approvalRefreshing = true;
    const res = await this.api.getTempoApproval(this.year, this.month, true);
    this.approvalRefreshing = false;
    if (seq !== this.loadSeq || !res.ok || !res.data) return;
    this.approval = res.data;
  }

  // ─── Month pager (back only; a past month's title leads home) ──────────

  prevMonth(): void {
    if (this.month === 1) this.showMonth(this.year - 1, 12);
    else this.showMonth(this.year, this.month - 1);
  }

  backToCurrent(): void {
    if (this.isCurrentMonth) return;
    const today = localToday();
    this.showMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)));
  }

  get isCurrentMonth(): boolean {
    return this.monthContainsToday;
  }

  private showMonth(year: number, month: number): void {
    this.year = year;
    this.month = month;
    this.closeCloud();
    this.openDates.clear();
    this.liveTotals.clear();
    this.sidesPending.clear();
    this.schedule = null;
    this.approval = null;
    void this.load(true);
    void this.autoSync();
  }

  get monthLabel(): string {
    return new Date(this.year, this.month - 1, 1)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  private get monthKey(): string {
    return `${this.year}-${String(this.month).padStart(2, '0')}`;
  }

  private get monthContainsToday(): boolean {
    return localToday().startsWith(this.monthKey);
  }

  // ─── Header ────────────────────────────────────────────────────────────

  get periodStatus(): PeriodStatus | null {
    const key = this.approval?.available ? this.approval.statusKey : null;
    if (!key) return null;
    const cls = key.toLowerCase();
    return { cls, label: cls.replace('_', ' ') };
  }

  // IN_REVIEW / APPROVED (anything but OPEN and REJECTED): nothing in the
  // month changes — the daemon refuses every edit. Unknown status = open.
  get monthClosed(): boolean {
    const a = this.approval;
    if (!a?.available || !a.statusKey) return false;
    return a.closed ?? (a.statusKey !== 'OPEN' && a.statusKey !== 'REJECTED');
  }

  get totalLabel(): string {
    const days = this.monthData?.days ?? [];
    return fmtHm(days.reduce((sum, d) => sum + this.dayMinutes(d.date, d.reportedSeconds), 0));
  }

  // Only a gap is said, never "on schedule"; closed days only (date < today)
  // — today is still being written.
  get gap(): Gap | null {
    const m = this.monthData;
    const s = this.schedule;
    if (!m || !s?.available) return null;
    const today = localToday();
    const required = s.days.filter(d => d.date < today).reduce((sum, d) => sum + d.requiredSeconds, 0) / 60;
    const logged = m.days.filter(d => d.date < today).reduce((sum, d) => sum + this.dayMinutes(d.date, d.reportedSeconds), 0);
    const diff = Math.round(logged - required);
    if (diff === 0) return null;
    return { amount: fmtHm(Math.abs(diff)), word: diff < 0 ? 'behind' : 'ahead' };
  }

  // In-flight flag lives in a root service — see PushStateService.
  get pushing(): boolean {
    return this.pushState.pushing();
  }

  // Tempo is being read: Fetch breathes — a push reads first, too.
  get fetching(): boolean {
    return this.syncing || this.pushing;
  }

  private get busy(): boolean {
    return this.syncing || this.pushing;
  }

  get pushView(): PushView {
    if (!this.monthData || this.monthClosed) return { kind: 'none', count: 0 };
    if (this.pushing) return { kind: 'busy', count: 0 };
    const conflicts = this.openConflicts().length;
    if (conflicts > 0) return { kind: 'resolve', count: conflicts };
    const incoming = this.incoming().length;
    if (incoming > 0) return { kind: 'review', count: incoming };
    const days = this.pushableDays().length;
    if (days === 0 && !this.todayTrackingWithContent) return { kind: 'nothing', count: 0 };
    return { kind: 'push', count: days };
  }

  // Conflicts the user still has to answer, newest day first.
  private openConflicts(): SeekTarget[] {
    const out: SeekTarget[] = [];
    for (const d of [...(this.monthData?.days ?? [])].reverse()) {
      const taken = this.sidesPending.get(d.date);
      for (const c of d.conflicts ?? []) {
        if (!taken?.has(c.entryId)) out.push({ date: d.date, task: c.task });
      }
    }
    return out;
  }

  // Rows a read of Tempo adopted this month, not shown yet — newest day first.
  private incoming(): SeekTarget[] {
    const m = this.monthData;
    if (!m) return [];
    return [...this.pushState.unseen.values()]
      .filter(a => a.date >= m.from && a.date <= m.to)
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(a => ({ date: a.date, task: a.task }));
  }

  private pushableDays(): MonthDaySummary[] {
    return (this.monthData?.days ?? []).filter(d => this.stateOf(d) === MonthSyncState.Unpushed);
  }

  private get todayTracking(): boolean {
    const today = this.monthData?.days.find(d => d.date === localToday());
    return !!today && this.stateOf(today) === MonthSyncState.Tracking;
  }

  private get todayTrackingWithContent(): boolean {
    const today = this.monthData?.days.find(d => d.date === localToday());
    return !!today && this.stateOf(today) === MonthSyncState.Tracking && today.tasks.length > 0;
  }

  // ─── Fetch — every read of Tempo is a sync (the daemon's) ──────────────

  onFetch(): void {
    void this.runSync();
  }

  private autoSync(): Promise<void> {
    if (this.syncedMonths.has(this.monthKey)) return Promise.resolve();
    return this.runSync();
  }

  private async runSync(): Promise<void> {
    if (this.busy || this.actionPending) return;
    const key = this.monthKey;
    const seq = this.loadSeq;
    const [year, month] = [this.year, this.month];
    this.syncing = true;
    const res = await this.api.syncTempo(year, month);
    this.syncing = false;
    if (!res.ok || !res.data) {
      this.tempoUnreachable = true;
      return;
    }
    this.tempoUnreachable = false;
    this.syncedMonths.add(key);
    if (res.data.adopted?.length) this.adopt(res.data.adopted);
    if (this.destroyed || key !== this.monthKey) return;
    void this.reloadMonthQuiet();
    // The read asked Tempo for the approval too (a submit made on the site).
    void this.loadApproval(seq);
  }

  // What a read adopted is new until shown — unless it landed in sight
  // (its day and ticket open).
  private adopt(list: readonly AdoptedEntry[]): void {
    for (const a of list) {
      const panel = this.openDates.has(a.date) ? this.panelOf(a.date) : undefined;
      if (panel?.isTaskOpen(a.task)) continue;
      this.pushState.unseen.set(a.entryId, a);
    }
    this.pushState.version++;
  }

  private markSeen(date: string): void {
    let changed = false;
    for (const [id, a] of this.pushState.unseen) {
      if (a.date === date) { this.pushState.unseen.delete(id); changed = true; }
    }
    if (changed) this.pushState.version++;
  }

  // ─── Push — never blind: the daemon reads Tempo first ──────────────────

  onPush(ev: MouseEvent): void {
    if (this.busy || this.actionPending) return;
    const v = this.pushView;
    if (v.kind === 'resolve' || v.kind === 'review') { this.seekNext(); return; }
    if (v.kind !== 'push') return;
    if (this.todayTrackingWithContent) {
      toggleAnchoredMenu(ev.currentTarget as HTMLElement, () => this.pushMenu(v.count), 'right');
      return;
    }
    this.push(false);
  }

  // Today is tracking: its push waits for a stop — no numbers here.
  pushMenu(days: number): CtxMenuEntry[] {
    return [
      ...(days > 0 ? [{ icon: PUSH_ICON, label: 'Push without today', action: (): void => this.push(false) }] : []),
      { icon: CTX_ICON.stop, label: 'Stop tracking & push all', action: (): void => this.push(true) },
    ];
  }

  onPushDay(row: DayRow, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.busy || this.actionPending) return;
    this.push(false, row.date);
  }

  // only — one day: the daemon's conflict gate looks at that day alone.
  private push(stopTracking: boolean, only?: string): void {
    const m = this.monthData;
    if (!m || this.pushing) return;
    const today = localToday();
    const holdsToday = today >= m.from && today <= m.to;
    const from = only ?? m.from;
    let to = only ?? (holdsToday ? today : m.to);
    if (!only && holdsToday && this.todayTracking && !stopTracking) to = previousDay(today);
    if (to < from) return;
    this.pushState.pushing.set(true);
    let outcome: ApiResponse<PushResponse> | null = null;
    this.action.emit({
      run: async () => {
        outcome = await this.api.pushToTempo(from, to, false, stopTracking);
        return outcome;
      },
      done: () => {
        this.pushState.pushing.set(false);
        this.afterPush(outcome, from, to, only);
      },
    });
  }

  // Blocked (new rows adopted, conflicts) — nothing went out, the tab leads
  // to what blocks it. Out — the toast, a refusal leads to its ticket.
  private afterPush(res: ApiResponse<PushResponse> | null, from: string, to: string, only?: string): void {
    if (!res) return; // the gate was busy — nothing was sent
    if (!res.ok || !res.data) {
      // The gate toasts the reason; without a fresh read nothing went out.
      this.tempoUnreachable = true;
      return;
    }
    this.tempoUnreachable = false;
    const data = res.data;
    if (data.adopted?.length) this.adopt(data.adopted);
    if (data.blockedByAdoption || data.blockedByConflicts) {
      void this.reloadMonthQuiet().then(() => this.seekAfterBlock(only));
      return;
    }
    // A refused worklog stays red until its day goes out whole.
    this.pushState.refusals = [
      ...this.pushState.refusals.filter(r => r.date < from || r.date > to),
      ...(data.failures ?? []),
    ];
    this.pushState.version++;
    const days = new Set(data.plan
      .filter(e => e.action === 'create' || e.action === 'update' || e.action === 'delete')
      .map(e => e.date)).size;
    this.showToast(`pushed ${days} day${days === 1 ? '' : 's'}`);
    const refused = data.failures?.[0];
    void this.reloadMonthQuiet().then(() => { if (refused) this.seekTicket(refused.date, refused.task, 'cf'); });
    // The daemon dropped its approval cache.
    void this.loadApproval(this.loadSeq);
  }

  private seekAfterBlock(only?: string): void {
    const conflicts = this.openConflicts();
    const cf = conflicts.find(c => !only || c.date === only) ?? conflicts[0];
    if (cf) { this.seekTicket(cf.date, cf.task, 'cf'); return; }
    const inc = this.incoming()[0];
    if (inc) this.seekTicket(inc.date, inc.task, 'in');
  }

  private seekNext(): void {
    const cf = this.openConflicts()[0];
    if (cf) { this.seekTicket(cf.date, cf.task, 'cf'); return; }
    const inc = this.incoming()[0];
    if (inc) this.seekTicket(inc.date, inc.task, 'in');
  }

  // Take the user to a ticket: open its day and card, bring it into view, flash.
  private seekTicket(date: string, task: string, kind: 'cf' | 'in'): void {
    if (this.destroyed) return;
    this.openDates.add(date);
    if (kind === 'in') this.markSeen(date);
    this.cdr.detectChanges();
    const el = this.panelOf(date)?.seek(task, kind);
    const zone = this.zoneRef?.nativeElement;
    if (!el || !zone) return;
    const head = this.headRef?.nativeElement.offsetHeight ?? 0;
    zone.scrollTop = el.getBoundingClientRect().top - zone.getBoundingClientRect().top + zone.scrollTop - head - SEEK_TOP;
  }

  private panelOf(date: string): LoggedPanelComponent | undefined {
    return this.panels?.find(p => p.date === date);
  }

  private showToast(text: string): void {
    this.toastText = text;
    this.toastOn = true;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastOn = false, TOAST_MS);
  }

  // ─── Day list ──────────────────────────────────────────────────────────

  // Rows are rebuilt only when the data behind them changes — the open days'
  // cards take their arrays as inputs and must not see new ones every tick.
  private weeksMemo: { month: MonthResponse | null; schedule: TempoScheduleResponse | null; today: string; weeks: readonly WeekGroup[] } | null = null;

  /** Weeks newest-first, days newest-first inside; future days are dropped. */
  get weeks(): readonly WeekGroup[] {
    const today = localToday();
    const memo = this.weeksMemo;
    if (memo && memo.month === this.monthData && memo.schedule === this.schedule && memo.today === today) return memo.weeks;
    const weeks = this.buildWeeks(today);
    this.weeksMemo = { month: this.monthData, schedule: this.schedule, today, weeks };
    return weeks;
  }

  private buildWeeks(today: string): readonly WeekGroup[] {
    const m = this.monthData;
    if (!m) return [];
    const visible = m.days.filter(d => d.date <= today);
    if (visible.length === 0) return [];

    const sched = new Map<string, ScheduleDay>(
      this.schedule?.available ? this.schedule.days.map(d => [d.date, d]) : []);

    const groups: { label: string; rows: DayRow[] }[] = [];
    let currentMonday = '';
    for (const d of visible) {
      const monday = mondayOf(d.date);
      if (monday !== currentMonday) {
        currentMonday = monday;
        groups.push({ label: weekLabel(monday, m.from, m.to), rows: [] });
      }
      groups[groups.length - 1].rows.push(this.toRow(d, sched, today));
    }
    return groups.reverse().map(g => ({ label: g.label, rows: g.rows.reverse() }));
  }

  get isEmpty(): boolean {
    return !this.loading && this.monthData !== null && this.weeks.length === 0;
  }

  private toRow(d: MonthDaySummary, sched: ReadonlyMap<string, ScheduleDay>, today: string): DayRow {
    const [y, mo, dd] = d.date.split('-').map(Number);
    const js = new Date(y, mo - 1, dd);
    const dow = js.getDay();
    const s = sched.get(d.date);
    const isToday = d.date === today;
    const hasContent = d.tasks.length > 0;
    const nonWorking = s ? s.requiredSeconds === 0 : (dow === 0 || dow === 6);
    const isHoliday = s !== undefined && s.type.includes('HOLIDAY');
    const sessions = d.sessions ?? [];
    const openSessions = sessions.filter(x => !x.closedBy);
    return {
      date: d.date,
      dayNum: dd,
      weekday: js.toLocaleDateString('en', { weekday: 'short' }),
      isToday,
      dim: !hasContent && nonWorking && !isToday,
      holidayName: isHoliday ? (s?.holidayName ?? 'Holiday') : null,
      state: this.stateOf(d),
      hasContent,
      reportedSeconds: d.reportedSeconds,
      heat: liveHeat(openSessions),
      entries: d.entries ?? [],
      openSessions,
      closedSessions: sessions.filter(x => !!x.closedBy),
      foreign: d.tasks.filter(t => t.kind === 'foreign'),
      conflicts: d.conflicts ?? [],
    };
  }

  // Daemons < 0.52.0 have no day word — the flags say pushed or not.
  private stateOf(d: MonthDaySummary): MonthSyncState {
    if (d.syncState) return d.syncState;
    if (d.status === MonthDayStatus.Pushed) return MonthSyncState.Pushed;
    return d.status === MonthDayStatus.None ? MonthSyncState.None : MonthSyncState.Unpushed;
  }

  // Today is a snapshot (edits live on the Day tab); a closed month only reads.
  readOnlyDay(row: DayRow): boolean {
    return row.isToday || this.monthClosed;
  }

  // A past day opens even when empty: that is where forgotten time gets logged.
  canOpen(row: DayRow): boolean {
    return row.hasContent || !this.readOnlyDay(row);
  }

  isOpen(row: DayRow): boolean {
    return this.openDates.has(row.date) && this.canOpen(row);
  }

  toggleDay(row: DayRow): void {
    if (!this.canOpen(row)) return;
    if (this.openDates.has(row.date)) {
      this.openDates.delete(row.date);
      this.liveTotals.delete(row.date);
      if (this.cloudDate === row.date) this.closeCloud();
      return;
    }
    this.openDates.add(row.date);
    // The card is born seeing its new rows (it opens their tickets); from
    // then on they are shown.
    this.cdr.detectChanges();
    this.markSeen(row.date);
  }

  showDayPush(row: DayRow): boolean {
    return this.isOpen(row) && !this.monthClosed && row.state === MonthSyncState.Unpushed;
  }

  showLog(row: DayRow): boolean {
    return this.isOpen(row) && !this.readOnlyDay(row);
  }

  noteOf(row: DayRow): string {
    if (row.isToday && this.isOpen(row)) return 'live — edits on the Day tab';
    return row.holidayName ? `☀ ${row.holidayName}` : '';
  }

  hasHours(row: DayRow): boolean {
    return row.hasContent || (this.liveTotals.get(row.date) ?? 0) > 0;
  }

  hoursLabel(row: DayRow): string {
    return this.hasHours(row) ? fmtHm(this.dayMinutes(row.date, row.reportedSeconds)) : '—';
  }

  private dayMinutes(date: string, reportedSeconds: number): number {
    const ms = this.liveTotals.get(date);
    return ms !== undefined ? ms / 60_000 : reportedSeconds / 60;
  }

  trackByDate(_i: number, row: DayRow): string {
    return row.date;
  }

  trackByWeek(_i: number, week: WeekGroup): string {
    return week.label;
  }

  // ─── The day card (the Day tab's panel in sheet mode) ──────────────────

  get issueSummaries(): Readonly<Record<string, string>> {
    return this.monthData?.issueSummaries ?? NO_SUMMARIES;
  }

  get roundingMinutes(): number {
    return this.monthData?.roundingMinutes ?? 0;
  }

  // The cards lock while the gate or a read of Tempo is busy.
  get cardsBusy(): boolean {
    return this.actionPending || this.busy;
  }

  private memoVersion = -1;
  private refusalsByDate = new Map<string, readonly PushFailure[]>();
  private unseenByDate = new Map<string, ReadonlySet<string>>();

  private refreshMemo(): void {
    if (this.memoVersion === this.pushState.version) return;
    this.memoVersion = this.pushState.version;
    const refusals = new Map<string, PushFailure[]>();
    for (const r of this.pushState.refusals) refusals.set(r.date, [...(refusals.get(r.date) ?? []), r]);
    this.refusalsByDate = refusals;
    const unseen = new Map<string, Set<string>>();
    for (const [id, a] of this.pushState.unseen) unseen.set(a.date, new Set([...(unseen.get(a.date) ?? []), id]));
    this.unseenByDate = unseen;
  }

  refusalsFor(date: string): readonly PushFailure[] {
    this.refreshMemo();
    return this.refusalsByDate.get(date) ?? NO_REFUSALS;
  }

  unseenFor(date: string): ReadonlySet<string> {
    this.refreshMemo();
    return this.unseenByDate.get(date) ?? NO_IDS;
  }

  freshIdFor(date: string): string | null {
    return this.freshEntry?.date === date ? this.freshEntry.id : null;
  }

  onPanelPatch(date: string, e: { id: string; patch: ManualEntryPatch }): void {
    this.runSheetAction(() => this.api.updateManualEntry(e.id, e.patch, date));
  }

  onPanelDelete(date: string, id: string): void {
    this.runSheetAction(() => this.api.deleteManualEntry(id, date));
  }

  onPanelSessionDelete(date: string, id: string): void {
    this.runSheetAction(() => this.api.deleteSession(id, date));
  }

  onPanelTaskDelete(date: string, task: string): void {
    this.runSheetAction(() => this.api.deleteTask(task, date));
  }

  onPanelAdd(date: string, input: ManualEntryInput): void {
    this.runSheetAction(() => this.api.addManualEntry({ ...input, date }));
  }

  // A lost resolve gives its conflict back to the navigator; an entry that
  // moved to another ticket of the day lands in sight.
  onPanelResolve(date: string, r: { entryId: string; side: ResolveSide }): void {
    let outcome: ApiResponse<TempoResolveResponse> | null = null;
    const run = async (): Promise<ApiResponse<TempoResolveResponse>> => {
      outcome = await this.api.resolveConflict(date, r.entryId, r.side);
      return outcome;
    };
    this.runSheetAction(run, ok => {
      const moved = outcome?.data;
      if (ok && moved && moved.dateAfter === date && moved.entryIdAfter !== null) {
        this.panelOf(date)?.openTask(moved.taskAfter);
      }
      if (ok) return;
      const taken = this.sidesPending.get(date);
      if (taken?.has(r.entryId)) this.sidesPending.set(date, new Set([...taken].filter(id => id !== r.entryId)));
    });
  }

  // The card reports inside its own change detection — adopt a tick later
  // (the header and the lid are already checked by then).
  onDayTotal(date: string, ms: number): void {
    queueMicrotask(() => {
      if (this.openDates.has(date)) this.liveTotals.set(date, ms);
    });
  }

  onSidesPending(date: string, ids: readonly string[]): void {
    queueMicrotask(() => this.sidesPending.set(date, new Set(ids)));
  }

  // Taken sides whose conflict the data no longer carries are settled.
  private pruneSidesPending(): void {
    for (const d of this.monthData?.days ?? []) {
      const taken = this.sidesPending.get(d.date);
      if (!taken) continue;
      const open = new Set((d.conflicts ?? []).map(c => c.entryId));
      this.sidesPending.set(d.date, new Set([...taken].filter(id => open.has(id))));
    }
  }

  private runSheetAction(run: () => Promise<ApiResponse<unknown>>, then?: (ok: boolean) => void): void {
    this.action.emit({
      run,
      done: ok => {
        then?.(ok);
        if (!this.destroyed) void this.reloadMonthQuiet();
      },
    });
  }

  // ─── ＋Log — the Day tab's cloud, the tab adds the date ─────────────────

  openCloud(row: DayRow, ev: MouseEvent): void {
    ev.stopPropagation();
    if (this.actionPending || this.readOnlyDay(row)) return;
    const btn = ev.currentTarget as HTMLElement;
    const lid = btn.closest<HTMLElement>('.day-row');
    if (!lid) return;
    this.cloudDate = row.date;
    this.cloudAnchor = { lid, btn };
    this.cloudSide = 'below';
    const cloud = this.cloudRef?.nativeElement;
    if (cloud) this.placeCloud(cloud);
    this.cloudOpen = true;
    setTimeout(() => this.watchCloud());
  }

  // Under the lid while it fits, over it otherwise; the side sticks per open
  // (Jira results grow and shrink the cloud with every keystroke).
  private placeCloud(cloud: HTMLElement): void {
    const anchor = this.cloudAnchor;
    if (!anchor) return;
    const host = this.host.nativeElement.getBoundingClientRect();
    const lid = anchor.lid.getBoundingClientRect();
    const btn = anchor.btn.getBoundingClientRect();
    const h = cloud.offsetHeight;
    const below = lid.bottom - host.top + CLOUD_GAP;
    const above = lid.top - host.top - CLOUD_GAP - h;
    if (this.cloudSide === 'below' && below + h > host.height - CLOUD_EDGE && above >= CLOUD_EDGE) this.cloudSide = 'above';
    const originX = `${Math.round(btn.left + btn.width / 2 - host.left - CLOUD_LEFT)}px`;
    if (this.cloudSide === 'above') {
      this.cloudTop = Math.max(CLOUD_EDGE, above);
      this.cloudOrigin = `${originX} 100%`;
      return;
    }
    this.cloudTop = below + h <= host.height - CLOUD_EDGE ? below : Math.max(CLOUD_EDGE, host.height - h - CLOUD_EDGE);
    this.cloudOrigin = `${originX} 0`;
  }

  private watchCloud(): void {
    this.cloudResize?.disconnect();
    const cloud = this.cloudRef?.nativeElement;
    if (!cloud || !this.cloudOpen || typeof ResizeObserver === 'undefined') return;
    this.placeCloud(cloud);
    // The observer fires outside the Angular zone — re-enter for the binding.
    this.cloudResize = new ResizeObserver(() => this.zone.run(() => {
      const el = this.cloudRef?.nativeElement;
      if (el && this.cloudOpen) this.placeCloud(el);
    }));
    this.cloudResize.observe(cloud);
  }

  closeCloud(): void {
    this.cloudOpen = false;
    this.cloudDate = null;
    this.cloudAnchor = null;
    this.cloudResize?.disconnect();
    this.cloudResize = undefined;
  }

  // Instant log from a chip, or the Jira form — a fresh entry: its card
  // opens the draft window.
  onChipPicked(pick: ChipPick): void {
    this.logFromCloud([pick.entry], true);
  }

  onCloudForm(entry: ManualEntryInput): void {
    this.logFromCloud([entry], true);
  }

  onCloudBatch(entries: readonly ManualEntryInput[]): void {
    this.logFromCloud(entries, false);
  }

  onCloudSettings(): void {
    this.closeCloud();
    this.settingsRequested.emit();
  }

  private logFromCloud(inputs: readonly ManualEntryInput[], fresh: boolean): void {
    const date = this.cloudDate;
    this.closeCloud();
    if (!date || inputs.length === 0) return;
    // A bare Development add lands on the ticket's record and comes back
    // under the same id — drop it first so the card sees a change.
    this.freshEntry = null;
    this.runSheetAction(async () => {
      let last: ApiResponse<unknown> = { ok: false, error: 'empty batch' };
      for (const input of inputs) {
        const res = await this.api.addManualEntry({ ...input, date });
        if (!res.ok) return res;
        if (fresh && res.data) this.freshEntry = { date, id: res.data.id };
        last = res;
      }
      return last;
    });
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────

// '7h 00m', '45m', '0m' — minutes, rounded.
function fmtHm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

// The accruing session's temperature — the card's pill wears the same.
function liveHeat(open: readonly SessionDetail[]): string {
  const leader = open.find(s => sessionRowState(s) === 'tracking' && s.normalizedScore > 0);
  return leader ? staminaHeat(leader.normalizedScore) : IDLE_HEAT;
}

// ─── Local date helpers ──────────────────────────────────────────────────

function localToday(): string {
  return toIso(new Date());
}

function toIso(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function previousDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return toIso(new Date(y, m - 1, d - 1));
}

function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();                    // 0=Sun..6=Sat
  dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
  return toIso(dt);
}

// '21 — 27': the calendar week's day numbers clamped to the month bounds.
function weekLabel(mondayIso: string, monthFrom: string, monthTo: string): string {
  const [y, m, d] = mondayIso.split('-').map(Number);
  const sunday = new Date(y, m - 1, d + 6);
  const sundayIso = toIso(sunday);
  const start = mondayIso < monthFrom ? 1 : Number(mondayIso.slice(8));
  const end = sundayIso > monthTo ? Number(monthTo.slice(8)) : Number(sundayIso.slice(8));
  return `${start} — ${end}`;
}
