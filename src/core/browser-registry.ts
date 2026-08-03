// Installed-browser inventory + link opening (Windows-only enumeration).
//
// Browsers register under SOFTWARE\Clients\StartMenuInternet (HKLM = machine,
// HKCU = per-user installs): subkey default value = display name,
// shell\open\command = the exe. Read via a PowerShell one-shot returning
// JSON with [Console]::OutputEncoding forced to UTF-8 — `reg query` prints
// in the OEM codepage and garbles non-ASCII names/paths (cyrillic user
// profile dirs), and PowerShell 5.1 ships with every supported Windows.

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import type { BrowserInfo } from './types.js';

const execFileAsync = promisify(execFile);

const PS_LIST_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$roots = @('HKLM:\\SOFTWARE\\Clients\\StartMenuInternet', 'HKCU:\\SOFTWARE\\Clients\\StartMenuInternet')
$out = foreach ($root in $roots) {
  if (Test-Path $root) {
    Get-ChildItem $root | ForEach-Object {
      $name = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).'(default)'
      $cmdKey = Join-Path $_.PSPath 'shell\\open\\command'
      $command = (Get-ItemProperty -LiteralPath $cmdKey -ErrorAction SilentlyContinue).'(default)'
      [pscustomobject]@{ key = $_.PSChildName; name = $name; command = $command }
    }
  }
}
@($out) | ConvertTo-Json -Compress
`;

export interface RegistryBrowserEntry {
  readonly key: string;
  readonly name: string | null;
  readonly command: string | null;
}

/** Pure mapping half — exported for tests. Strips quotes, drops IE and
 *  commandless entries, dedupes HKCU repeats of HKLM rows, sorts by name. */
export function mapRegistryBrowsers(entries: readonly RegistryBrowserEntry[]): BrowserInfo[] {
  const seen = new Set<string>();
  const result: BrowserInfo[] = [];
  for (const e of entries) {
    if (!e.command) continue;
    const quoted = /^"([^"]+)"/.exec(e.command);
    const path = (quoted ? quoted[1] : e.command).trim();
    if (!path) continue;
    const exe = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
    // IE is registered on every Windows but is a dead end (launches Edge
    // at best) — never offer it.
    if (exe === 'iexplore.exe' || e.key.toLowerCase() === 'iexplore.exe') continue;
    const dedupeKey = path.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push({ name: e.name?.trim() || e.key, path });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/** Installed browsers; empty on non-Windows or any enumeration failure. */
export async function listInstalledBrowsers(): Promise<BrowserInfo[]> {
  if (process.platform !== 'win32') return [];
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PS_LIST_SCRIPT],
      { windowsHide: true, timeout: 15_000 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed) as RegistryBrowserEntry | RegistryBrowserEntry[];
    return mapRegistryBrowsers(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    return [];
  }
}

/**
 * Open a URL in the configured browser exe, or the system default when null.
 * Fire-and-forget: the child is detached and spawn errors only log — the
 * caller has already validated the path exists.
 */
export function openUrlInBrowser(url: string, browserPath: string | null): void {
  const [cmd, args] = browserPath
    ? [browserPath, [url]]
    : process.platform === 'win32'
      // rundll32 hands the URL to the default browser without a cmd shell —
      // `start` would re-parse &-metacharacters in query strings.
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', err => console.warn(`[open] failed to launch ${cmd}: ${err.message}`));
  child.unref();
}
