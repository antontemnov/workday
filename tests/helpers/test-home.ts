/**
 * Side-effect module: pins WORKDAY_HOME to a throwaway temp dir BEFORE
 * src/core/config.ts resolves it at module load. Import it as the FIRST
 * import in any test whose code path may flush a daily log to disk —
 * without it, tests would write into the repo's dev data/ directory.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_HOME: string = mkdtempSync(join(tmpdir(), 'workday-test-home-'));
process.env.WORKDAY_HOME = TEST_HOME;

process.on('exit', () => {
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});
