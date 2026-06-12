import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPackageRoot } from './config.js';
import {
  NPM_PACKAGE_NAME,
  NPM_REGISTRY_LATEST_URL,
  UPDATE_CHECK_TIMEOUT_MS,
  NPM_INSTALL_TIMEOUT_MS,
} from './constants.js';
import type { UpdateCheckResponse } from './types.js';

/**
 * Daemon self-update: registry check + pinned global install + on-disk verify.
 *
 * Hard rules learned from the field:
 * - never stop anything before the new version is installed and verified;
 * - install a PINNED version (the one the check returned), not @latest —
 *   a release landing mid-flow must not produce a version we never checked;
 * - verification reads package.json from the global install dir: if npm
 *   exited 0 but the tree wasn't replaced, we must not restart into the
 *   old code believing it's new.
 *
 * The actual restart is owned by the Daemon (quiet-window policy lives there).
 */

type ExecRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<void>;
type FetchLike = typeof fetch;

export class UpdateManager {
  private readonly fetchFn: FetchLike;
  private readonly execRunner: ExecRunner;
  private readonly readInstalledVersion: () => string;

  public constructor(overrides?: {
    fetchFn?: FetchLike;
    execRunner?: ExecRunner;
    readInstalledVersion?: () => string;
  }) {
    this.fetchFn = overrides?.fetchFn ?? fetch;
    this.execRunner = overrides?.execRunner ?? defaultExecRunner;
    this.readInstalledVersion = overrides?.readInstalledVersion ?? readPackageVersion;
  }

  public getCurrentVersion(): string {
    return this.readInstalledVersion();
  }

  /** Ask the npm registry for the latest published version. Throws on network failure. */
  public async checkForUpdate(): Promise<UpdateCheckResponse> {
    const current = this.readInstalledVersion();
    const res = await this.fetchFn(NPM_REGISTRY_LATEST_URL, {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`registry responded ${res.status}`);
    }
    const data = await res.json() as { version?: string };
    if (!data.version) {
      throw new Error('registry response has no version');
    }
    return {
      current,
      latest: data.version,
      updateAvailable: isNewerVersion(data.version, current),
    };
  }

  /**
   * Install the pinned version globally and verify it landed on disk.
   * Returns normally only when package.json in the install dir reports
   * exactly `version`. The running process keeps executing old code —
   * the caller decides when to restart.
   */
  public async installVersion(version: string): Promise<void> {
    await this.execRunner('npm', ['install', '-g', `${NPM_PACKAGE_NAME}@${version}`], NPM_INSTALL_TIMEOUT_MS);
    const onDisk = this.readInstalledVersion();
    if (onDisk !== version) {
      throw new Error(`install verification failed: expected ${version}, found ${onDisk} on disk`);
    }
  }
}

/**
 * Strictly-newer semver compare on the numeric triple. Prerelease versions
 * are rejected outright — auto-update must never install a beta.
 */
export function isNewerVersion(latest: string, current: string): boolean {
  if (latest.includes('-')) return false;
  const l = latest.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}

function readPackageVersion(): string {
  const pkgPath = join(getPackageRoot(), 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return pkg.version;
}

function defaultExecRunner(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    // shell: true — npm is npm.cmd on Windows
    execFile(cmd, args, { timeout: timeoutMs, shell: true, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.message}${stderr ? ` — ${stderr.slice(0, 300)}` : ''}`));
      } else {
        resolve();
      }
    });
  });
}
