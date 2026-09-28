import { Injectable, signal } from '@angular/core';
import { AdoptedEntry, PushFailure } from '../models/workday.models';

/**
 * Timesheets memory that survives view switches. The Timesheets component
 * lives under an ngSwitch — leaving the tab destroys the instance:
 * - an instance-level push flag would re-arm the Push button while the
 *   daemon is still pushing (double-push incident, 2026-07-31);
 * - rows a read of Tempo adopted must stay "new" until shown, and a refused
 *   worklog keeps its reason until its day goes out — tray memory only, a
 *   restart forgets both.
 */
@Injectable({ providedIn: 'root' })
export class PushStateService {
  readonly pushing = signal(false);

  // entryId → where the adopted row landed.
  readonly unseen = new Map<string, AdoptedEntry>();
  refusals: readonly PushFailure[] = [];
  // Bumped on every change of the two above — views memoize by it.
  version = 0;
}
