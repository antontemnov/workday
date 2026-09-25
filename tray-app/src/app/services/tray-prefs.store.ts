import { invoke } from '@tauri-apps/api/core';

// Tray display preferences (feed sort, suggestions mode, column widths) live
// in prefs.json next to the tray, not in WebView2 localStorage: one torn
// record in its LevelDB log makes Chromium drop every later write on each
// launch. The file is read once before bootstrap, so reads stay synchronous.
// Browser preview (no Tauri) keeps plain localStorage.

const LEGACY_KEY_PREFIX = 'workday.';

const IS_TAURI: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let prefs: Readonly<Record<string, string>> = {};
let fileBacked: boolean = false;
let saveChain: Promise<void> = Promise.resolve();

export async function loadTrayPrefs(): Promise<void> {
  if (!IS_TAURI) return;
  try {
    const text = await invoke<string | null>('load_prefs');
    fileBacked = true;
    if (text !== null) {
      prefs = parsePrefs(text);
      return;
    }
    prefs = readLegacyPrefs();
    if (Object.keys(prefs).length > 0) savePrefs();
  } catch { /* unreadable file — fall back to localStorage */ }
}

export function readPref(key: string): string | null {
  if (fileBacked) return prefs[key] ?? null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  if (!fileBacked) {
    try {
      localStorage.setItem(key, value);
    } catch { /* storage unavailable — keep the in-memory value */ }
    return;
  }
  prefs = { ...prefs, [key]: value };
  savePrefs();
}

// Chained: each save carries the full snapshot, the last one must land last.
function savePrefs(): void {
  const json = JSON.stringify(prefs, null, 2);
  saveChain = saveChain
    .then(() => invoke<void>('save_prefs', { json }))
    .catch(() => { /* keep the in-memory value */ });
}

function parsePrefs(text: string): Readonly<Record<string, string>> {
  try {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  } catch {
    return {};
  }
}

// One-time move of whatever localStorage still holds.
function readLegacyPrefs(): Readonly<Record<string, string>> {
  const legacy: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !key.startsWith(LEGACY_KEY_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) legacy[key] = value;
    }
  } catch { /* storage unavailable — start from defaults */ }
  return legacy;
}
