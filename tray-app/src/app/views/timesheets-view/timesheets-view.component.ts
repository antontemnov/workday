import { Component, ElementRef, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WorkdayApiService } from '../../services/workday-api.service';
import { PushStateService } from '../../services/push-state.service';
import {
  ActivityType,
  ApiResponse,
  DEVELOPMENT_ACTIVITY,
  Favorite,
  ManualEntryPatch,
  MonthDaySummary,
  MonthDayStatus,
  MonthResponse,
  PushPlanEntry,
  PushResponse,
  ScheduleDay,
  TempoApprovalResponse,
  TempoImportRequest,
  TempoScheduleResponse,
  normalizeFavName,
} from '../../models/workday.models';
import { activityLabel, activityOptions, activityTone } from '../day-view/activity.util';
import { loadLoggedCols } from '../day-view/logged-cols.util';
import { DurationInputDirective } from '../day-view/duration-field/duration-input.directive';
import { openCtxMenu } from '../day-view/ctx-menu.util';

// Delete mirrors the Logged panel: instant with a client-side undo — the row
// stays struck-through with a burning ↩ for this long, then collapses and the
// DELETE goes out.
const UNDO_WINDOW_MS = 3000;
const REMOVE_ANIM_MS = 240;
const FAV_FEEDBACK_MS = 1200;

// One line inside a day drawer — a would-be Tempo worklog.
interface DrawerRow {
  readonly task: string;
  readonly src: string;          // session kind: '2 sessions'
  readonly activity: string;     // manual/foreign kind — raw Tempo value
  readonly description: string;  // manual kind
  readonly durLabel: string;
  readonly worklogId?: number;   // foreign kind — the import handle
  readonly entryId?: string;     // manual kind — the edit/delete handle
  readonly minutes?: number;     // manual kind — exact minutes for the edit form
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

/**
 * Timesheets tab. Logged rows in the day drawers carry the same editing
 * mechanics as the day view's Logged panel: double-click morphs the row into
 * an inline edit form, right-click opens Edit / Add to favorites / Delete,
 * delete is instant with a ~3s undo. Mutations go to the daemon with the
 * row's date (past days disk-to-disk, today via the live tracker) and the
 * month reloads — a pushed day flips to outdated, sums recount, and the next
 * push updates Tempo with the new values. Tracked (closed sessions) and
 * foreign Tempo rows stay read-only; an APPROVED Tempo period locks the
 * whole month back to view-only, consistent with the hidden push button.
 */
@Component({
  selector: 'app-timesheets-view',
  standalone: true,
  imports: [CommonModule, FormsModule, DurationInputDirective],
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

  // In-flight flag lives in a root service — see PushStateService.
  get pushing(): boolean {
    return this.pushState.pushing();
  }
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

  // ─── Logged-row editing state (keys are 'date|entryId') ────────────────
  activityTypes: readonly ActivityType[] = [];
  activityAllowed: readonly string[] = [];
  favorites: readonly Favorite[] = [];
  editingKey: string | null = null;
  editMinutes = 30;
  editActivity = '';
  editDescription = '';
  // The row's activity at morph-open — stays in the options even when the
  // allow-list has since scoped it out.
  private editPinnedActivity = '';
  savingEdit = false;
  editError: string | null = null;

  // Delete pipeline: undo window (timer) → collapse animation → DELETE sent,
  // row hidden until the reloaded month no longer carries the entry.
  private readonly deleteTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly removingKeys = new Set<string>();
  private readonly hiddenKeys = new Set<string>();
  private readonly removeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // "★ added to favorites" feedback riding the description for ~1.2s.
  favDoneKey: string | null = null;
  private favDoneTimer: ReturnType<typeof setTimeout> | null = null;

  // Column widths shared with the day view's Logged panel (read-only here —
  // resizing lives in the panel; the drawers just mirror the layout).
  readonly colName: number;
  readonly colType: number;

  private readonly openDates = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private pushNoteTimer: ReturnType<typeof setTimeout> | null = null;
  // Guards against stale responses landing after a month switch.
  private loadSeq = 0;

  constructor(private api: WorkdayApiService, private pushState: PushStateService, private host: ElementRef<HTMLElement>) {
    const today = localToday();
    this.year = Number(today.slice(0, 4));
    this.month = Number(today.slice(5, 7));
    const cols = loadLoggedCols();
    this.colName = cols.name;
    this.colType = cols.type;
  }

  ngOnInit(): void {
    void this.load(true);
    void this.autoSync();
    void this.loadEditMeta();
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
    if (this.favDoneTimer) clearTimeout(this.favDoneTimer);
    // Deletes past their undo click are the user's intent — commit them now
    // instead of silently resurrecting the rows on the next visit.
    this.flushPendingDeletes();
    this.removeTimers.forEach(t => clearTimeout(t));
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
      this.reconcileLocalEditState();
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
    this.reconcileLocalEditState();
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

  // ─── Month pager (the current month is the ceiling — no future) ────────

  prevMonth(): void { this.shiftMonth(-1); }

  nextMonth(): void {
    if (this.isCurrentMonth) return;
    this.shiftMonth(1);
  }

  /** The away-month label is the way back — one click returns to today. */
  backToCurrent(): void {
    if (this.isCurrentMonth) return;
    const today = localToday();
    this.year = Number(today.slice(0, 4));
    this.month = Number(today.slice(5, 7));
    this.resetMonthState();
  }

  get isCurrentMonth(): boolean {
    return this.monthContainsToday;
  }

  private shiftMonth(delta: number): void {
    this.month += delta;
    if (this.month < 1) { this.month = 12; this.year--; }
    if (this.month > 12) { this.month = 1; this.year++; }
    this.resetMonthState();
  }

  private resetMonthState(): void {
    this.openDates.clear();
    this.schedule = null;
    this.approval = null;
    this.pushError = null;
    this.pushNote = null;
    this.conflicts = [];
    this.importError = null;
    this.editError = null;
    this.editingKey = null;
    // Leaving the month is like leaving the tab: undo windows are over.
    this.flushPendingDeletes();
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

  /** '11h 55m behind schedule' / '3h 25m ahead of schedule' — the arrow's tooltip. */
  get deltaTip(): string | null {
    const d = this.delta;
    if (!d) return null;
    return d.ahead ? `${d.label} of schedule` : `${d.label} schedule`;
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

  // The button's badge: hours about to land in Tempo — a volume preview,
  // unlike a day count. Null (no badge) when the pending days sum to zero.
  get pushHoursLabel(): string | null {
    const days = this.monthData?.days ?? [];
    const seconds = days
      .filter(d => d.status === MonthDayStatus.Pending || d.status === MonthDayStatus.Outdated)
      .reduce((sum, d) => sum + d.reportedSeconds, 0);
    return seconds > 0 ? fmtCompact(seconds) : null;
  }

  // A submitted period is out of our hands: APPROVED is sealed, IN_REVIEW is
  // on the reviewer's desk — pushing into either is meaningless and risky.
  get pushHidden(): boolean {
    return this.approval?.available === true
      && (this.approval.statusKey === 'APPROVED' || this.approval.statusKey === 'IN_REVIEW');
  }

  async onPush(force = false): Promise<void> {
    if (this.pushing || !this.monthData || (this.pushCount === 0 && !force)) return;
    this.pushState.pushing.set(true);
    this.pushError = null;
    this.conflicts = [];
    let res: ApiResponse<PushResponse>;
    try {
      res = await this.api.pushToTempo(this.monthData.from, this.monthData.to, force);
    } finally {
      this.pushState.pushing.set(false);
    }
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

  // ─── Logged-row editing (mirrors the day view's Logged panel) ──────────

  private async loadEditMeta(): Promise<void> {
    const [types, favs] = await Promise.all([this.api.getActivityTypes(), this.api.getFavorites()]);
    if (types.ok && types.data) {
      this.activityTypes = types.data.activities;
      this.activityAllowed = types.data.allowed ?? [];
    }
    if (favs.ok && favs.data) this.favorites = favs.data.favorites;
  }

  private rowKey(row: DayRow, t: DrawerRow): string {
    return `${row.date}|${t.entryId}`;
  }

  // An APPROVED Tempo period is sealed — local edits could never land; the
  // whole month stays view-only. IN_REVIEW only pauses pushing: preparing
  // local fixes for a possible reject is legitimate.
  get editLocked(): boolean {
    return this.approval?.available === true && this.approval.statusKey === 'APPROVED';
  }

  // Rows without an entryId (older daemon) degrade to read-only.
  canEdit(t: DrawerRow): boolean {
    return t.entryId !== undefined && !this.editLocked;
  }

  isEditing(row: DayRow, t: DrawerRow): boolean {
    return this.editingKey === this.rowKey(row, t);
  }

  isRowHidden(row: DayRow, t: DrawerRow): boolean {
    return this.hiddenKeys.has(this.rowKey(row, t));
  }

  // ── Inline edit form (double-click) ──

  onRowDblClick(row: DayRow, t: DrawerRow): void {
    const key = this.rowKey(row, t);
    if (!this.canEdit(t) || this.savingEdit || this.editingKey === key || this.isDeleted(row, t)) return;
    this.editingKey = key;
    this.editMinutes = t.minutes ?? 30;
    this.editActivity = t.activity;
    this.editPinnedActivity = t.activity;
    this.editDescription = t.description;
    // Focus once the form morph renders.
    setTimeout(() => {
      const el = this.host.nativeElement.querySelector<HTMLInputElement>('.tse-min');
      el?.focus();
      el?.select();
    }, 80);
  }

  cancelEdit(): void {
    if (this.savingEdit) return;
    this.editingKey = null;
  }

  // Description is required for everything but Development (daemon rule);
  // clearing it on a Development row is a legal explicit edit.
  get editDescNeeded(): boolean {
    return this.editingKey !== null
      && this.editDescription.trim() === ''
      && this.editActivity !== DEVELOPMENT_ACTIVITY;
  }

  async saveEdit(row: DayRow, t: DrawerRow): Promise<void> {
    if (this.savingEdit || !this.isEditing(row, t) || t.entryId === undefined) return;
    if (this.editDescNeeded) {
      this.host.nativeElement.querySelector<HTMLInputElement>('.tse-desc')?.focus();
      return;
    }
    const description = this.editDescription.trim();
    const patch: ManualEntryPatch = {};
    if (this.editMinutes !== t.minutes) (patch as { minutes?: number }).minutes = this.editMinutes;
    if (this.editActivity !== t.activity) (patch as { activity?: string }).activity = this.editActivity;
    if (description !== t.description) (patch as { description?: string }).description = description;
    if (Object.keys(patch).length === 0) { this.editingKey = null; return; }

    this.savingEdit = true;
    this.editError = null;
    const res = await this.api.updateManualEntry(t.entryId, patch, row.date);
    if (res.ok) {
      // Statuses/sums changed daemon-side (pushed day → outdated) — the form
      // stays up until the fresh month renders, so the row never flickers back.
      await this.reloadMonthQuiet();
      this.editingKey = null;
    } else {
      this.editError = res.error ?? 'Update failed';
    }
    this.savingEdit = false;
  }

  // ── Context menu (right-click) ──

  onRowContextMenu(row: DayRow, t: DrawerRow, ev: MouseEvent): void {
    if (!this.canEdit(t) || this.isEditing(row, t) || this.isDeleted(row, t)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const items = [
      { icon: '✎', label: 'Edit', action: () => this.onRowDblClick(row, t) },
      // Hidden only when structurally impossible (no description to name the
      // template); an exact duplicate shows as a disabled fact instead.
      ...(t.description.trim() !== ''
        ? [this.isInFavorites(t)
          ? { icon: '★', label: 'In favorites', disabled: true,
              title: 'This exact task + description + duration is already saved', action: (): void => {} }
          : { icon: '★', label: 'Add to favorites', action: () => void this.addToFavorites(row, t) }]
        : []),
      { icon: '✕', label: 'Delete', danger: true, action: () => this.deleteRow(row, t) },
    ];
    openCtxMenu(ev.clientX, ev.clientY, items);
  }

  // Template identity mirrors the daemon: task + name (case/whitespace-
  // insensitive) + minutes. A changed duration is a new template again.
  private isInFavorites(t: DrawerRow): boolean {
    const name = normalizeFavName(t.description);
    return this.favorites.some(f =>
      f.task.toLowerCase() === t.task.toLowerCase()
      && normalizeFavName(f.name) === name
      && f.minutes === t.minutes);
  }

  private async addToFavorites(row: DayRow, t: DrawerRow): Promise<void> {
    const res = await this.api.addFavorite({
      name: t.description.trim(),
      task: t.task,
      minutes: t.minutes ?? 0,
      activity: t.activity,
    });
    if (!res.ok || !res.data) {
      this.editError = res.error ?? 'Could not add to favorites';
      return;
    }
    this.favorites = res.data.favorites;
    this.favDoneKey = this.rowKey(row, t);
    if (this.favDoneTimer) clearTimeout(this.favDoneTimer);
    this.favDoneTimer = setTimeout(() => this.favDoneKey = null, FAV_FEEDBACK_MS);
  }

  // ── Delete with undo ──

  isDeleted(row: DayRow, t: DrawerRow): boolean {
    const key = this.rowKey(row, t);
    return this.deleteTimers.has(key) || this.removingKeys.has(key);
  }

  private deleteRow(row: DayRow, t: DrawerRow): void {
    const key = this.rowKey(row, t);
    if (this.editingKey === key) this.editingKey = null;
    this.deleteTimers.set(key, setTimeout(() => this.startRemove(key), UNDO_WINDOW_MS));
  }

  undoDelete(row: DayRow, t: DrawerRow, ev: MouseEvent): void {
    ev.stopPropagation();
    const key = this.rowKey(row, t);
    const timer = this.deleteTimers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.deleteTimers.delete(key);
  }

  // Undo window over: collapse the row, then send the DELETE (with the row's
  // date). A pushed entry leaves a tombstone daemon-side — the next push
  // removes its worklog from Tempo.
  private startRemove(key: string): void {
    this.deleteTimers.delete(key);
    this.removingKeys.add(key);
    this.removeTimers.set(key, setTimeout(() => {
      this.removingKeys.delete(key);
      this.removeTimers.delete(key);
      this.hiddenKeys.add(key);
      void this.commitDelete(key);
    }, REMOVE_ANIM_MS));
  }

  private async commitDelete(key: string): Promise<void> {
    const [date, entryId] = splitKey(key);
    const res = await this.api.deleteManualEntry(entryId, date);
    if (!res.ok) {
      // Resurrect the row — the entry still exists daemon-side.
      this.hiddenKeys.delete(key);
      this.editError = res.error ?? 'Delete failed';
      return;
    }
    await this.reloadMonthQuiet();
  }

  // Commit deletes past their undo window right away (tab switch / month
  // switch) — mirrors the Logged panel's teardown contract.
  private flushPendingDeletes(): void {
    for (const [key, timer] of this.deleteTimers) {
      clearTimeout(timer);
      const [date, entryId] = splitKey(key);
      void this.api.deleteManualEntry(entryId, date);
    }
    this.deleteTimers.clear();
  }

  // Fresh month landed: drop local state for entries the data no longer
  // carries (confirmed deletes, external edits).
  private reconcileLocalEditState(): void {
    const alive = new Set<string>();
    for (const d of this.monthData?.days ?? []) {
      for (const t of d.tasks) {
        if (t.kind === 'manual' && t.entryId !== undefined) alive.add(`${d.date}|${t.entryId}`);
      }
    }
    for (const key of [...this.hiddenKeys]) {
      if (!alive.has(key)) this.hiddenKeys.delete(key);
    }
    for (const [key, timer] of [...this.deleteTimers]) {
      if (!alive.has(key)) {
        clearTimeout(timer);
        this.deleteTimers.delete(key);
      }
    }
    if (this.editingKey !== null && !alive.has(this.editingKey) && !this.savingEdit) {
      this.editingKey = null; // the edited entry is gone (external change)
    }
  }

  // ── Row display helpers ──

  activityLabel(value: string): string {
    return activityLabel(this.activityTypes, value);
  }

  activityTone(value: string): string {
    return activityTone(value);
  }

  summaryOf(task: string): string {
    return this.monthData?.issueSummaries?.[task] ?? '';
  }

  // Tracked time is always Development — that's how it pushes to Tempo.
  readonly developmentActivity = DEVELOPMENT_ACTIVITY;

  get activityOptions(): readonly ActivityType[] {
    return activityOptions(this.activityTypes, this.activityAllowed, this.editPinnedActivity);
  }

  trackByLogged(_i: number, t: DrawerRow): string {
    return t.entryId ?? `${t.task}|${t.description}|${t.durLabel}`;
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
        entryId: t.entryId,
        // Standalone manual entries ship exact minutes — seconds are ×60.
        minutes: Math.round(t.seconds / 60),
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

// 'date|entryId' → [date, entryId]; the id may itself contain '|'-free hex,
// but split on the first separator only to stay safe.
function splitKey(key: string): [string, string] {
  const i = key.indexOf('|');
  return [key.slice(0, i), key.slice(i + 1)];
}

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
