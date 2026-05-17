import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { WorkdayApiService } from '../../services/workday-api.service';
import { DayStatus, MonthDay, MonthResponse } from '../../models/workday.models';

const HOUR_MS = 3_600_000;

interface TaskChip {
  readonly key: string;
  readonly tone: string;          // CSS modifier: blue/green/peach/mauve/teal/etc.
}

interface DayRow {
  readonly date: string;
  readonly dayNum: number;        // 1-31
  readonly weekday: string;       // Mon/Tue/...
  readonly weekdayIdx: number;    // 0=Mon, 6=Sun
  readonly isToday: boolean;
  readonly isWeekend: boolean;
  readonly hours: number;
  readonly tasks: readonly TaskChip[];
  readonly status: DayStatus;
}

@Component({
  selector: 'app-timesheets-view',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './timesheets-view.component.html',
  styleUrl: './timesheets-view.component.scss',
})
export class TimesheetsViewComponent implements OnInit {
  @Output() daySelected = new EventEmitter<string>();

  monthData: MonthResponse | null = null;
  loading = true;
  saving = false;

  // Default to current calendar month — mock backend ignores these anyway.
  year: number = new Date().getFullYear();
  month: number = new Date().getMonth() + 1;

  constructor(private api: WorkdayApiService) {}

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    const res = await this.api.getMonth(this.year, this.month);
    if (res.ok && res.data) {
      this.monthData = res.data;
    }
    this.loading = false;
  }

  async prevMonth(): Promise<void> {
    this.month--;
    if (this.month < 1) { this.month = 12; this.year--; }
    await this.load();
  }

  async nextMonth(): Promise<void> {
    this.month++;
    if (this.month > 12) { this.month = 1; this.year++; }
    await this.load();
  }

  get monthLabel(): string {
    if (!this.monthData) return '';
    const d = new Date(this.monthData.year, this.monthData.month - 1, 1);
    return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  // Past + today only — future days are dropped from the visible list.
  private get visibleDays(): readonly MonthDay[] {
    if (!this.monthData) return [];
    const today = todayIso();
    return this.monthData.days.filter(d => d.date <= today);
  }

  get trackedTotal(): number {
    return this.visibleDays.reduce((s, d) => s + d.claimedMs, 0) / HOUR_MS;
  }

  get readyToPushHours(): number {
    return this.visibleDays
      .filter(d => d.status === DayStatus.Confirmed)
      .reduce((s, d) => s + d.claimedMs, 0) / HOUR_MS;
  }

  get pushDisabled(): boolean {
    return this.saving || this.readyToPushHours <= 0;
  }

  /**
   * Rows grouped by week — outer array is weeks in reverse chronological order
   * (newest week first), inner array is days within a week also reversed
   * (Sun → Mon), so today sits at the very top.
   */
  get weeks(): readonly (readonly DayRow[])[] {
    const rows = this.visibleDays.map(d => this.toRow(d));
    if (rows.length === 0) return [];

    // Walk chronological list and split at each Mon boundary.
    const groups: DayRow[][] = [];
    let bucket: DayRow[] = [];
    for (const row of rows) {
      if (row.weekdayIdx === 0 && bucket.length) {
        groups.push(bucket);
        bucket = [];
      }
      bucket.push(row);
    }
    if (bucket.length) groups.push(bucket);

    // Reverse weeks AND reverse days within each week.
    return groups.slice().reverse().map(g => g.slice().reverse());
  }

  private toRow(d: MonthDay): DayRow {
    const [y, m, dd] = d.date.split('-').map(Number);
    const jsDate = new Date(y, m - 1, dd);
    const jsDow = jsDate.getDay();         // 0=Sun..6=Sat
    const weekdayIdx = jsDow === 0 ? 6 : jsDow - 1;
    return {
      date: d.date,
      dayNum: dd,
      weekday: jsDate.toLocaleDateString('en', { weekday: 'short' }),
      weekdayIdx,
      isToday: d.date === todayIso(),
      isWeekend: jsDow === 0 || jsDow === 6,
      hours: d.claimedMs / HOUR_MS,
      tasks: d.tasks.map(t => ({ key: t.key, tone: this.toneFor(t.key) })),
      status: d.status,
    };
  }

  // Per-tag colour tone, stable across days. Deterministic hash of the task key.
  private toneFor(key: string): string {
    const tones = ['blue', 'green', 'peach', 'mauve', 'teal'];
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return tones[Math.abs(h) % tones.length];
  }

  statusLabel(s: DayStatus): string {
    switch (s) {
      case DayStatus.Pushed:    return 'Pushed';
      case DayStatus.Confirmed: return 'Ready';
      case DayStatus.Draft:     return 'Draft';
    }
  }

  // ─── Row click → drill into Day view for that date ────────────────────

  onRowClick(row: DayRow): void {
    this.daySelected.emit(row.date);
  }

  // ─── Actions (stubs — wired to mocks for now) ─────────────────────────

  async onExport(): Promise<void> {
    // TODO: real CSV export endpoint
    console.log('TODO: export', { year: this.year, month: this.month });
  }

  async onPush(): Promise<void> {
    if (this.pushDisabled || !this.monthData) return;
    this.saving = true;
    const monthStr = String(this.monthData.month).padStart(2, '0');
    const from = `${this.monthData.year}-${monthStr}-01`;
    const to   = `${this.monthData.year}-${monthStr}-${String(daysInMonth(this.monthData.year, this.monthData.month)).padStart(2, '0')}`;
    const res = await this.api.pushToTempo(from, to);
    this.saving = false;
    if (res.ok) await this.load();
  }
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}
