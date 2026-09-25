// What the feed offers — a tray-side display preference (the daemon only sees
// it per request): 'hidden' = no suggestion rows at all (nothing is requested;
// the daemon keeps its own calendar cadence, so switching back is instant),
// 'started' = a row is born when its event starts (default), 'all' = the
// not-yet-started meetings of today too (reads carry includeFuture). Same
// storage idiom as the feed sort.

import { readPref, writePref } from '../../services/tray-prefs.store';

export type SuggestionsMode = 'hidden' | 'started' | 'all';

export const SUGGESTIONS_MODES: readonly SuggestionsMode[] = ['hidden', 'started', 'all'];
export const SUGGESTIONS_MODE_DEFAULT: SuggestionsMode = 'started';

const MODE_STORAGE_KEY = 'workday.suggestions.mode';

export function loadSuggestionsMode(): SuggestionsMode {
  const stored = readPref(MODE_STORAGE_KEY) as SuggestionsMode | null;
  return stored !== null && SUGGESTIONS_MODES.includes(stored) ? stored : SUGGESTIONS_MODE_DEFAULT;
}

export function persistSuggestionsMode(mode: SuggestionsMode): void {
  writePref(MODE_STORAGE_KEY, mode);
}
