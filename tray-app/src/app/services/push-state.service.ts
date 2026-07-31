import { Injectable, signal } from '@angular/core';

/**
 * Push-in-flight flag that survives view switches. The Timesheets component
 * lives under an ngSwitch — leaving the tab destroys the instance, and an
 * instance-level flag would re-arm the Push button while the daemon is still
 * pushing (double-push incident, 2026-07-31).
 */
@Injectable({ providedIn: 'root' })
export class PushStateService {
  readonly pushing = signal(false);
}
