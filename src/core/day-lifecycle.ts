import type { DailyLog } from './types.js';

/**
 * Lazy-day gate: a day exists on disk only after a confirmed fact.
 *
 * Facts are: an activated session, a manual entry, a review checkout (the
 * fact behind a pending suggestion — must survive restarts and rollover),
 * or the file already existing on disk (loaded days keep being written so
 * recovery/edits are never lost). Signals alone do NOT materialize a day —
 * a quiet weekend with a couple of ordinary checkouts leaves nothing behind.
 */
export function isDayMaterialized(log: DailyLog, loadedFromDisk: boolean): boolean {
  return loadedFromDisk
    || log.sessions.length > 0
    || (log.manualEntries?.length ?? 0) > 0
    || (log.reviewCheckouts?.length ?? 0) > 0;
}
