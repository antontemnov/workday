import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkdayApiService } from '../../services/workday-api.service';
import {
  MonthDaySummary,
  MonthDayStatus,
  MonthResponse,
  PushPlanEntry,
  ScheduleDay,
  TempoApprovalResponse,
  TempoImportRequest,
  TempoScheduleResponse,
} from '../../models/workday.models';

// One line inside a day drawer — a would-be Tempo worklog.
interface DrawerRow {
  readonly task: string;
  readonly src: string;          // session kind: '2 sessions'
  readonly activity: string;     // manual kind
  readonly description: string;  // manual kind
  readonly durLabel: string;
  readonly worklogId?: number;   // foreign kind — the import handle
}

interface DayRow {
  readonly date: string;
  readonly dayNum: number;
  readonly weekday: string;              // 'Fri'
  readonly isToday: boolean;
  readonly dim: boolean;                 // non-working day with no data
  readonly hasData: boolean;             // clickable → drawer
  readonly holidayName: string | null;   // from Tempo schedule
  readonly hoursLabel: string;
  readonly under: boolean;               // closed day short of its required hours
  readonly status: MonthDayStatus;
  readonly driftLines: readonly string[];  // what diverges from Tempo (snapshot-verified)
  readonly driftTitle: string;             // driftLines joined for the status tooltip
  readonly trackedRows: readonly DrawerRow[];
  readonly loggedRows: readonly DrawerRow[];
  readonly tempoRows: readonly DrawerRow[];   // foreign worklogs — read-only mirror
  readonly trackedSumLabel: string;
  readonly loggedSumLabel: string;
  readonly tempoSumLabel: string;
}

interface WeekGroup {
  readonly label: string;        // '13 – 19'
  readonly rows: readonly DayRow[];
}

interface PeriodStatus {
  readonly cls: string;          // open | in_review | approved | rejected
  readonly label: string;
}

interface TotalsDelta {
  readonly ahead: boolean;
  readonly label: string;        // '2h behind'
}

@Component({
  selector: 'app-timesheets-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timesheets-view.component.html',
  styleUrl: './timesheets-view.component.scss',
})
export class TimesheetsViewComponent implements OnInit, OnDestroy {
  monthData: MonthResponse | null = null;
  schedule: TempoScheduleResponse | null = null;
  approval: TempoApprovalResponse | null = null;
  loading = true;
  error: string | null = null;

  year: number;
  month: number;

  pushing = false;
  pushError: string | null = null;
  pushNote: string | null = null;
  // Push refused by the conflict gate — these worklogs were edited in Tempo
  // after our push. The user chooses: force-push (ours) or leave Tempo as is.
  conflicts: readonly PushPlanEntry[] = [];

  syncing = false;
  // Months already snapshot-synced this session — auto-sync fires once per
  // month view; failures retry on the upkeep tick (self-heal), the button
  // re-syncs on demand.
  private readonly syncedMonths = new Set<string>();

  // Import in flight: the day date, or 'date|worklogId' for a single row.
  importingKey: string | null = null;
  importError: string | null = null;

  private readonly openDates = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pushNoteTimer: ReturnType<typeof setTimeout> | null = null;
  // Guards against stale responses landing after a month switch.
  private loadSeq = 0;

  constructor(private api: WorkdayApiService) {
    const today = localToday();
    this.year = Number(today.slice(0, 4));
    this.month = Number(today.slice(5, 7));
  }

  ngOnInit(): void {
    void this.load(true);
    void this.autoSync();
    // Quiet upkeep: failed loads retry until they land (one-shot fetches must
    // self-heal), and today's row stays fresh while the current month is on
    // screen. Meta calls are cached daemon-side.
    this.refreshTimer = setInterval(() => {
      if (this.pushing) return;
      if (!this.monthData || this.error) { void this.load(false); return; }
      if (this.monthContainsToday) void this.reloadMonthQuiet();
      if (this.schedule === null) void this.loadSchedule(this.loadSeq);
      if (this.approval === null) void this.loadApproval(this.loadSeq);
      void this.autoSync();
    }, 30_000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.pushNoteTimer) clearTimeout(this.pushNoteTimer);
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
  }

  private async loadSchedule(seq: number): Promise<void> {
    const res = await this.api.getTempoSchedule(this.year, this.month);
    if (seq !== this.loadSeq) return;
    this.schedule = res.ok && res.data ? res.data : null;
  }

  private async loadApproval(seq: number): Promise<void> {
    const res = await this.api.getTempoApproval(this.year, this.month);
    if (seq !== this.loadSeq) return;
    this.approval = res.ok && res.data ? res.data : null;
  }

  // ─── Tempo snapshot sync ───────────────────────────────────────────────

  private get monthKey(): string {
    return `${this.year}-${String(this.month).padStart(2, '0')}`;
  }

  /** Once-per-month-view pull; failed attempts retry via the upkeep tick. */
  private autoSync(): Promise<void> {
    if (this.syncedMonths.has(this.monthKey)) return Promise.resolve();
    return this.runSync();
  }

  onSync(): void {
    if (this.syncing) return;
    void this.runSync();
  }

  private async runSync(): Promise<void> {
    if (this.syncing) return;
    const key = this.monthKey;
    this.syncing = true;
    const res = await this.api.syncTempo(this.year, this.month);
    this.syncing = false;
    if (!res.ok) return; // offline / no tokens — statuses stay flag-based, retried by upkeep
    this.syncedMonths.add(key);
    // Fresh snapshot changes day statuses only through the month payload.
    if (key === this.monthKey) void this.reloadMonthQuiet();
  }

  get syncedLabel(): string | null {
    const iso = this.monthData?.syncedAt;
    if (!iso) return null;
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${day}, ${time}`;
  }

  // ─── Month pager ───────────────────────────────────────────────────────

  prevMonth(): void { this.shiftMonth(-1); }
  nextMonth(): void { this.shiftMonth(1); }

  private shiftMonth(delta: number): void {
    this.month += delta;
    if (this.month < 1) { this.month = 12; this.year--; }
    if (this.month > 12) { this.month = 1; this.year++; }
    this.openDates.clear();
    this.schedule = null;
    this.approval = null;
    this.pushError = null;
    this.pushNote = null;
    this.conflicts = [];
    this.importError = null;
    void this.load(true);
    void this.autoSync();
  }

  get monthLabel(): string {
    return new Date(this.year, this.month - 1, 1)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  private get monthContainsToday(): boolean {
    return localToday().startsWith(`${this.year}-${String(this.month).padStart(2, '0')}`);
  }

  // ─── Header totals ─────────────────────────────────────────────────────

  get totalLabel(): string {
    return fmtCompact(this.monthData?.totals.reportedSeconds ?? 0);
  }

  get requiredLabel(): string | null {
    if (!this.schedule?.available) return null;
    return fmtCompact(this.schedule.requiredSecondsTotal);
  }

  // Behind/ahead over strictly closed days: required(≤yesterday) vs
  // logged(≤yesterday). Today is still being written and never counts.
  get delta(): TotalsDelta | null {
    const m = this.monthData;
    const s = this.schedule;
    if (!m || !s?.available) return null;
    const today = localToday();
    const required = s.days.filter(d => d.date < today)
      .reduce((sum, d) => sum + d.requiredSeconds, 0);
    const logged = m.days.filter(d => d.date < today)
      .reduce((sum, d) => sum + d.reportedSeconds, 0);
    const diff = required - logged;
    if (diff === 0) return null;
    return diff > 0
      ? { ahead: false, label: `${fmtCompact(diff)} behind` }
      : { ahead: true, label: `${fmtCompact(-diff)} ahead` };
  }

  // ─── Tempo strip: period status · last push · push button ─────────────

  get periodStatus(): PeriodStatus | null {
    const key = this.approval?.available ? this.approval.statusKey : null;
    if (!key) return null;
    const cls = key.toLowerCase();
    return { cls, label: cls.replace('_', ' ') };
  }

  get lastPushLabel(): string | null {
    const iso = this.monthData?.lastPushAt;
    if (!iso) return null;
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${day}, ${time}`;
  }

  get pushCount(): number {
    const t = this.monthData?.totals;
    return t ? t.pendingDays + t.outdatedDays : 0;
  }

  // Approved period is sealed Tempo-side — nothing to push into it.
  get pushHidden(): boolean {
    return this.approval?.available === true && this.approval.statusKey === 'APPROVED';
  }

  async onPush(force = false): Promise<void> {
    if (this.pushing || !this.monthData || (this.pushCount === 0 && !force)) return;
    this.pushing = true;
    this.pushError = null;
    this.conflicts = [];
    const res = await this.api.pushToTempo(this.monthData.from, this.monthData.to, force);
    this.pushing = false;
    if (res.ok && res.data) {
      if (res.data.blockedByConflicts) {
        // Nothing was executed — surface the choice, no reload needed.
        this.conflicts = res.data.plan.filter(e => e.conflict);
        return;
      }
      const r = res.data.result;
      if (r) {
        if (r.failed > 0) this.pushError = `push finished with ${r.failed} failed worklog(s)`;
        const deleted = r.deleted > 0 ? ` · ${r.deleted} deleted` : '';
        this.setPushNote(`pushed · ${r.posted} created · ${r.updated} updated${deleted}`);
      }
    } else {
      this.pushError = res.error ?? 'Push failed';
    }
    // Statuses changed on disk and the daemon dropped its approval cache.
    await this.load(false);
  }

  onPushForce(): void {
    void this.onPush(true);
  }

  // "Keep Tempo": no mutation — the day stays outdated with its drift
  // visible; aligning local data (or a later force) resolves it.
  dismissConflicts(): void {
    this.conflicts = [];
  }

  // ─── Tempo import (adopt foreign worklogs) ─────────────────────────────

  onImportRow(row: DayRow, t: DrawerRow): void {
    if (t.worklogId === undefined) return;
    void this.runImport(`${row.date}|${t.worklogId}`,
      { year: this.year, month: this.month, worklogIds: [t.worklogId] });
  }

  onImportDay(row: DayRow): void {
    void this.runImport(row.date, { year: this.year, month: this.month, date: row.date });
  }

  isImporting(key: string): boolean {
    return this.importingKey === key;
  }

  private async runImport(key: string, request: TempoImportRequest): Promise<void> {
    if (this.importingKey) return;
    this.importingKey = key;
    this.importError = null;
    const res = await this.api.importTempo(request);
    this.importingKey = null;
    if (res.ok && res.data) {
      if (res.data.failed > 0) {
        const first = res.data.items.find(i => i.error);
        this.importError = `${res.data.failed} worklog(s) not imported — ${first?.error ?? 'unknown error'}`;
      }
      // Adopted rows move from the tempo section into logged; the daemon
      // already refetched the snapshot, so statuses and syncedAt are fresh.
      await this.reloadMonthQuiet();
    } else {
      this.importError = res.error ?? 'Import failed';
    }
  }

  private setPushNote(note: string): void {
    this.pushNote = note;
    if (this.pushNoteTimer) clearTimeout(this.pushNoteTimer);
    this.pushNoteTimer = setTimeout(() => this.pushNote = null, 6000);
  }

  // ─── Day list ──────────────────────────────────────────────────────────

  /** Weeks newest-first, days newest-first inside; future days are dropped. */
  get weeks(): readonly WeekGroup[] {
    const m = this.monthData;
    if (!m) return [];
    const today = localToday();
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
    // Foreign-only days carry no local log (status none) but still open.
    const hasData = d.status !== MonthDayStatus.None || d.tasks.length > 0;
    const isToday = d.date === today;
    const nonWorking = s ? s.requiredSeconds === 0 : (dow === 0 || dow === 6);
    const isHoliday = s !== undefined && s.type.includes('HOLIDAY');
    const tracked = d.tasks.filter(t => t.kind === 'session');
    const logged = d.tasks.filter(t => t.kind === 'manual');
    const foreign = d.tasks.filter(t => t.kind === 'foreign');
    const driftLines = d.drift ?? [];

    return {
      date: d.date,
      dayNum: dd,
      weekday: js.toLocaleDateString('en', { weekday: 'short' }),
      isToday,
      dim: !hasData && nonWorking && !isToday,
      hasData,
      holidayName: isHoliday ? (s?.holidayName ?? 'Holiday') : null,
      hoursLabel: fmtSum(d.reportedSeconds),
      under: hasData && !isToday
        && s !== undefined && s.requiredSeconds > 0
        && d.reportedSeconds < s.requiredSeconds,
      status: d.status,
      driftLines,
      driftTitle: driftLines.join('\n'),
      trackedRows: tracked.map(t => ({
        task: t.task,
        src: t.sessionCount === 1 ? '1 session' : `${t.sessionCount} sessions`,
        activity: '', description: '',
        durLabel: fmtDur(t.seconds),
      })),
      loggedRows: logged.map(t => ({
        task: t.task,
        src: '',
        activity: t.activity ?? '',
        description: t.description ?? '',
        durLabel: fmtDur(t.seconds),
      })),
      tempoRows: foreign.map(t => ({
        task: t.task,
        src: '',
        activity: t.activity ?? '',
        description: t.description ?? '',
        durLabel: fmtDur(t.seconds),
        worklogId: t.tempoWorklogId,
      })),
      trackedSumLabel: fmtSum(tracked.reduce((sum, t) => sum + t.seconds, 0)),
      loggedSumLabel: fmtSum(logged.reduce((sum, t) => sum + t.seconds, 0)),
      tempoSumLabel: fmtSum(foreign.reduce((sum, t) => sum + t.seconds, 0)),
    };
  }

  isOpen(date: string): boolean {
    return this.openDates.has(date);
  }

  toggleDay(row: DayRow): void {
    if (!row.hasData) return;
    if (this.openDates.has(row.date)) this.openDates.delete(row.date);
    else this.openDates.add(row.date);
  }

  trackByDate(_i: number, row: DayRow): string {
    return row.date;
  }

  trackByWeek(_i: number, week: WeekGroup): string {
    return week.label;
  }
}

// ─── Formatting (Xh Ym everywhere — no decimal hours on this tab) ────────

// Day rows & section sums: '8h 00m', '0h 25m', zero → '0h'.
function fmtSum(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  if (totalMin === 0) return '0h';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Entry rows: '45m', '1h 00m'.
function fmtDur(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

// Header totals & deltas: '89h 12m', '176h', '45m', zero → '0h'.
function fmtCompact(seconds: number): string {
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return m > 0 ? `${m}m` : '0h';
}

// ─── Local date helpers ──────────────────────────────────────────────────

function localToday(): string {
  return toIso(new Date());
}

function toIso(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function mondayOf(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay();                    // 0=Sun..6=Sat
  dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
  return toIso(dt);
}

// '13 – 19': the calendar week's day numbers clamped to the month bounds.
function weekLabel(mondayIso: string, monthFrom: string, monthTo: string): string {
  const [y, m, d] = mondayIso.split('-').map(Number);
  const sunday = new Date(y, m - 1, d + 6);
  const sundayIso = toIso(sunday);
  const start = mondayIso < monthFrom ? 1 : Number(mondayIso.slice(8));
  const end = sundayIso > monthTo ? Number(monthTo.slice(8)) : Number(sundayIso.slice(8));
  return `${start} – ${end}`;
}
