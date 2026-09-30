// Closed-month watch (daemon-side). Keeps the tracker's lock and the cut in
// step with the Tempo status, read from the approval cache every tick (any
// process may have written it: tray requests, CLI, push gate). Asks Tempo on
// its own only when a submit is likely: right after a push, and in the
// submit window while work goes on — or while the month is closed, so a
// REJECTED unlocks it.

import {
  APPROVAL_PUSH_WATCH_INTERVAL_MS, APPROVAL_PUSH_WATCH_MS,
} from '../core/constants.js';
import { computeWorkingDate } from '../core/config.js';
import { inSubmissionWindow } from '../core/month-lock.js';
import type { AppConfig, Secrets } from '../core/types.js';
import { cachedApprovals, resolveMonthApproval } from './tempo-approvals.js';

export interface ApprovalWatchDeps {
  readonly getSecrets: () => Secrets | null;
  readonly getConfig: () => AppConfig;
  readonly now?: () => number;
}

export interface DueCut {
  readonly month: string;
  readonly cutAt: string;
}

/** "YYYY-MM" of every month the range touches. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let [year, month] = from.slice(0, 7).split('-').map(Number);
  const last = to.slice(0, 7);
  for (;;) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    if (key > last) return months;
    months.push(key);
    month++;
    if (month > 12) { month = 1; year++; }
  }
}

function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return m === 1 ? `${year - 1}-12` : `${year}-${String(m - 1).padStart(2, '0')}`;
}

export class ApprovalWatch {
  // month → when it closed (null: the status came without a moment)
  private readonly closed = new Map<string, string | null>();
  private readonly cutApplied = new Map<string, string>();
  private readonly watchUntil = new Map<string, number>();
  private readonly lastWatchAsk = new Map<string, number>();
  private asking = false;

  public constructor(private readonly deps: ApprovalWatchDeps) {}

  /**
   * Take the cached statuses in; returns the cuts now due. A missing entry
   * keeps the last known state (the cache is dropped after every push). A
   * cut is due only for this or the previous month, and only when the month
   * closed within its own days — a submit made later leaves nothing tracked
   * after it in that month.
   */
  public sync(today: string): readonly DueCut[] {
    for (const [month, approval] of cachedApprovals()) {
      if (!approval.available || approval.statusKey === null) continue;
      if (approval.closed) {
        this.closed.set(month, approval.closedAt ?? this.closed.get(month) ?? null);
      } else {
        this.closed.delete(month);
        this.cutApplied.delete(month);
      }
    }

    const config = this.deps.getConfig();
    const current = today.slice(0, 7);
    const recent = new Set([current, previousMonth(current)]);
    const due: DueCut[] = [];
    for (const [month, cutAt] of this.closed) {
      if (!cutAt || !recent.has(month) || this.cutApplied.get(month) === cutAt) continue;
      const closedOn = computeWorkingDate(Date.parse(cutAt), config.boundaryHour, config.timezone);
      if (closedOn.slice(0, 7) !== month) continue;
      due.push({ month, cutAt });
    }
    return due;
  }

  public markCut(cut: DueCut): void {
    this.cutApplied.set(cut.month, cut.cutAt);
  }

  public isClosed(month: string): boolean {
    return this.closed.has(month);
  }

  /** A submit usually follows a push: watch the pushed months closely. */
  public armAfterPush(months: readonly string[]): void {
    const until = this.now() + APPROVAL_PUSH_WATCH_MS;
    for (const month of months) {
      this.watchUntil.set(month, until);
      this.lastWatchAsk.delete(month);
    }
  }

  /** The watch's own Tempo reads. Fire and forget — never blocks a tick. */
  public async ask(today: string, hasActivity: boolean): Promise<void> {
    if (this.asking) return;
    const secrets = this.deps.getSecrets();
    if (!secrets) return;
    this.asking = true;
    try {
      const now = this.now();
      for (const [month, until] of [...this.watchUntil]) {
        if (now > until || this.closed.has(month)) {
          this.watchUntil.delete(month);
          continue;
        }
        if (now - (this.lastWatchAsk.get(month) ?? 0) < APPROVAL_PUSH_WATCH_INTERVAL_MS) continue;
        this.lastWatchAsk.set(month, now);
        await resolveMonthApproval(Number(month.slice(0, 4)), Number(month.slice(5, 7)), secrets, 0);
      }

      const month = today.slice(0, 7);
      if (hasActivity && (this.closed.has(month) || inSubmissionWindow(today, this.deps.getConfig()))) {
        await resolveMonthApproval(Number(month.slice(0, 4)), Number(month.slice(5, 7)), secrets);
      }
    } catch (err) {
      console.warn(`[approval] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.asking = false;
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}
