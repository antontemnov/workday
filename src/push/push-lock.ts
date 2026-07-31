// Cross-process single-flight for Tempo mutations. Push (daemon HTTP and CLI
// alike) and import rewrite push-log.json via read-modify-write — two
// interleaved runs plan against the same pre-push Tempo state and create
// every pending worklog twice (observed live 2026-07-31). A lock FILE covers
// all processes; a crashed holder expires by file age.

import { mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '../core/config.js';
import { PUSH_LOCK_FILE, PUSH_LOCK_STALE_MS } from '../core/constants.js';

export class PushLockError extends Error {}

/** Take the lock or throw PushLockError. Returns the release function. */
export function acquirePushLock(operation: string): () => void {
  mkdirSync(getDataDir(), { recursive: true });
  const lockPath = join(getDataDir(), PUSH_LOCK_FILE);
  const payload = JSON.stringify({ pid: process.pid, operation, startedAt: new Date().toISOString() });
  try {
    writeFileSync(lockPath, payload, { flag: 'wx' });
  } catch {
    let stale: boolean;
    try {
      stale = Date.now() - statSync(lockPath).mtimeMs > PUSH_LOCK_STALE_MS;
    } catch {
      stale = true; // vanished between wx-fail and stat — holder just released
    }
    if (!stale) {
      throw new PushLockError('A Tempo push/import is already running — wait for it to finish');
    }
    writeFileSync(lockPath, payload);
  }
  return () => {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  };
}
