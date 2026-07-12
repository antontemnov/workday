// Notification center: daemon-side source of truth for desktop notifications.
// Rules are evaluated lazily on read (the tray polls GET /api/notifications)
// behind a short memo — no daemon-loop wiring. Delivery state is persisted to
// data/notifications-state.json so each notification fires at most once per
// id even across daemon restarts; the state file is the dedup authority, the
// memo is only a load-shedder.
//
// v1 rule — timesheet-push: on the last working day of the month (workDays +
// holidays from config, no Tempo dependency), from notifyHour until the month
// ends, while the month still has unpushed days. Timing is wall-clock in the
// configured timezone; boundaryHour is deliberately not involved.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatDate, getDataDir, getHourInTimezone } from './config.js';
import { isWorkingDay } from './daily-log.js';
import { buildMonthResponse } from '../push/month-report.js';
import { NOTIFICATIONS_STATE_FILE, NOTIFICATION_MEMO_TTL_MS, TMP_EXTENSION } from './constants.js';
import { NotificationStatus } from './types.js';
import type { AppConfig, NotificationAckAction, NotificationItem, NotificationStateEntry } from './types.js';

const TIMESHEET_KIND = 'timesheet-push';
const TEST_KIND = 'test';

export interface NotificationCenterDeps {
  readonly getConfig: () => AppConfig;
  /** Flush today's in-memory log to disk before the month aggregate reads it. */
  readonly flushToday: () => void;
  /** Injectable clock — tests only. */
  readonly now?: () => number;
  /** Injectable unpushed-day counter — tests only; defaults to the month aggregate. */
  readonly getUnpushedDays?: (year: number, month: number, config: AppConfig) => number;
}

export interface NotificationAckResult {
  readonly ok: boolean;
  readonly status?: NotificationStatus;
  readonly error?: string;
}

interface TestNotification {
  readonly item: NotificationItem;
  readonly expiresAt: number;
  status: NotificationStatus;
}

function defaultUnpushedDays(year: number, month: number, config: AppConfig): number {
  const totals = buildMonthResponse(year, month, config).totals;
  return totals.pendingDays + totals.outdatedDays;
}

export class NotificationCenter {
  private readonly deps: NotificationCenterDeps;
  private readonly getUnpushedDays: (year: number, month: number, config: AppConfig) => number;
  private state: Record<string, NotificationStateEntry>;
  // Synthetic notifications injected via /api/notifications/test — in-memory
  // only, they exercise the delivery pipeline without touching real state.
  private readonly testItems: Map<string, TestNotification> = new Map();
  private memo: readonly NotificationItem[] | null = null;
  private memoAt: number = 0;

  public constructor(deps: NotificationCenterDeps) {
    this.deps = deps;
    this.getUnpushedDays = deps.getUnpushedDays ?? defaultUnpushedDays;
    this.state = this.loadState();
  }

  /** Active (pending) notifications the tray should deliver. */
  public getActive(): readonly NotificationItem[] {
    const now = this.now();
    if (this.memo && now - this.memoAt < NOTIFICATION_MEMO_TTL_MS) return this.memo;

    const items: NotificationItem[] = [];
    this.collectTestNotifications(now, items);
    this.collectTimesheetReminder(now, items);
    this.memo = items;
    this.memoAt = now;
    return items;
  }

  /**
   * Lifecycle transition: 'shown' pending→delivered (idempotent — the tray
   * acks BEFORE toasting for the at-most-once guarantee), 'opened'/'hidden'
   * →consumed (allowed straight from pending: covers a lost 'shown' ack).
   */
  public ack(id: string, action: NotificationAckAction): NotificationAckResult {
    const now = this.now();
    this.memoAt = 0;

    const test = this.testItems.get(id);
    if (test) {
      test.status = action === 'shown' ? NotificationStatus.Delivered : NotificationStatus.Consumed;
      return { ok: true, status: test.status };
    }

    const entry = this.state[id];
    if (!entry) return { ok: false, error: `Unknown notification: ${id}` };

    if (action === 'shown') {
      if (entry.status === NotificationStatus.Pending) {
        this.state[id] = { ...entry, status: NotificationStatus.Delivered, deliveredAt: new Date(now).toISOString() };
        this.persist();
      }
      return { ok: true, status: this.state[id].status };
    }

    if (entry.status !== NotificationStatus.Consumed) {
      this.state[id] = { ...entry, status: NotificationStatus.Consumed, consumedAt: new Date(now).toISOString(), consumedBy: action };
      this.persist();
    }
    return { ok: true, status: NotificationStatus.Consumed };
  }

  /** Inject a synthetic pending notification for the e2e pipeline check. */
  public injectTest(minutes: number): NotificationItem {
    const now = this.now();
    const id = `${TEST_KIND}:${now.toString(36)}`;
    const item: NotificationItem = {
      id,
      kind: TEST_KIND,
      createdAt: new Date(now).toISOString(),
      title: 'Test notification',
      body: `Pipeline check — expires in ${minutes} min.`,
      sticky: true,
      actions: [{ id: 'open', label: 'Open Timesheets', view: 'sheet' }],
    };
    this.testItems.set(id, { item, expiresAt: now + minutes * 60_000, status: NotificationStatus.Pending });
    this.memoAt = 0;
    return item;
  }

  // ─── Rules ─────────────────────────────────────────────────────────────

  private collectTestNotifications(now: number, out: NotificationItem[]): void {
    for (const [id, test] of this.testItems) {
      if (test.expiresAt <= now) {
        this.testItems.delete(id);
        continue;
      }
      if (test.status === NotificationStatus.Pending) out.push(test.item);
    }
  }

  private collectTimesheetReminder(now: number, out: NotificationItem[]): void {
    const config = this.deps.getConfig();
    const reminder = config.notifications.timesheetReminder;
    if (!reminder.enabled) return;

    const today = formatDate(now, config.timezone);
    const yearMonth = today.slice(0, 7);
    const id = `${TIMESHEET_KIND}:${yearMonth}`;
    this.pruneOldMonths(yearMonth);

    const year = Number(yearMonth.slice(0, 4));
    const month = Number(yearMonth.slice(5, 7));
    const lastWorking = lastWorkingDay(year, month, config);
    if (lastWorking === null) return;

    // Window = [last working day @ notifyHour, end of month] — the tail keeps
    // the reminder alive over month-end weekends the PC was off for.
    const hour = getHourInTimezone(now, config.timezone);
    const windowOpen = today > lastWorking || (today === lastWorking && hour >= reminder.notifyHour);
    if (!windowOpen) return;

    const entry = this.state[id];
    if (entry && entry.status !== NotificationStatus.Pending) return; // at most once per month

    // Condition is re-checked every eval: a push mid-window silently retires
    // the reminder, drift appearing later in the window revives it.
    this.deps.flushToday();
    const unpushed = this.getUnpushedDays(year, month, config);
    if (unpushed === 0) return;

    if (!entry) {
      this.state[id] = { status: NotificationStatus.Pending, createdAt: new Date(now).toISOString() };
      this.persist();
    }

    // Copy matches the approved toast design (compact card, single line each).
    const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
    const days = unpushed === 1 ? '1 day' : `${unpushed} days`;
    out.push({
      id,
      kind: TIMESHEET_KIND,
      createdAt: this.state[id].createdAt,
      title: `Push ${monthName} timesheets`,
      body: today === lastWorking ? `Last working day · ${days} unpushed` : `${monthName} is ending · ${days} unpushed`,
      sticky: true,
      actions: [{ id: 'open', label: 'Open Timesheets', view: 'sheet' }],
    });
  }

  /** Drop timesheet entries from previous months — each month is a fresh id. */
  private pruneOldMonths(currentYearMonth: string): void {
    let changed = false;
    for (const id of Object.keys(this.state)) {
      const [kind, yearMonth] = id.split(':');
      if (kind === TIMESHEET_KIND && yearMonth < currentYearMonth) {
        delete this.state[id];
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  // ─── Persistence ───────────────────────────────────────────────────────

  private statePath(): string {
    return join(getDataDir(), NOTIFICATIONS_STATE_FILE);
  }

  private loadState(): Record<string, NotificationStateEntry> {
    const filePath = this.statePath();
    if (!existsSync(filePath)) return {};
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, NotificationStateEntry>;
    } catch {
      return {};
    }
  }

  private persist(): void {
    mkdirSync(getDataDir(), { recursive: true });
    const filePath = this.statePath();
    const tmpPath = filePath + TMP_EXTENSION;
    writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
    renameSync(tmpPath, filePath);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

/** Last calendar day of the month that is a working day, or null if none. */
export function lastWorkingDay(year: number, month: number, config: AppConfig): string | null {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  for (let day = daysInMonth; day >= 1; day--) {
    const date = `${prefix}-${String(day).padStart(2, '0')}`;
    if (isWorkingDay(date, config)) return date;
  }
  return null;
}
