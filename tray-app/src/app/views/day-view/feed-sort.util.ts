// Feed card order — a tray-side display preference (the daemon knows nothing
// about presentation): 'recency' = newest fact first (default), 'sum' =
// biggest day total first. Same storage idiom as the resizable columns.

import { readPref, writePref } from '../../services/tray-prefs.store';

export type FeedSortMode = 'recency' | 'sum';

export const FEED_SORT_DEFAULT: FeedSortMode = 'recency';

const SORT_STORAGE_KEY = 'workday.feed.sort';

export function loadFeedSort(): FeedSortMode {
  return readPref(SORT_STORAGE_KEY) === 'sum' ? 'sum' : FEED_SORT_DEFAULT;
}

export function persistFeedSort(mode: FeedSortMode): void {
  writePref(SORT_STORAGE_KEY, mode);
}
