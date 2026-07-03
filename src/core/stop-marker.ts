import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkdayHome } from './config.js';
import { STOP_MARKER_FILE_NAME } from './constants.js';

/**
 * Manual-stop marker: written on an explicit daemon stop (CLI `workday stop`,
 * tray Stop button — both land in Daemon.stop()), cleared on daemon start.
 * The tray watchdog respects it: a manually stopped daemon is NOT respawned
 * until the user starts it again or logs in anew (the tray clears the marker
 * on an autostart launch — a fresh login always starts tracking).
 * Self-update restarts skip the marker — the daemon is coming right back.
 */

function markerPath(): string {
  return join(getWorkdayHome(), STOP_MARKER_FILE_NAME);
}

export function writeStopMarker(): void {
  try {
    writeFileSync(markerPath(), new Date().toISOString(), 'utf-8');
  } catch { /* best effort — a missing marker only means the watchdog restarts sooner */ }
}

export function clearStopMarker(): void {
  try {
    if (existsSync(markerPath())) unlinkSync(markerPath());
  } catch { /* best effort */ }
}

export function hasStopMarker(): boolean {
  return existsSync(markerPath());
}
