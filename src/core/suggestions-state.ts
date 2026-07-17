// Dismissed-suggestion state — the ONLY stored bit of the suggestions model
// (accept is derived from day logs; deleting the entry revives the row).
// Keys are `<uid>:<date>`. A key is pruned once its day was pushed to Tempo
// (that day's suggestions are silenced for good) or fell out of the calendar
// cache window. Load prunes in memory only; the file compacts on the next
// dismiss write, so reads stay side-effect free.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from './config.js';
import { CALENDAR_WINDOW_PAST_DAYS, SUGGESTIONS_STATE_FILE, TMP_EXTENSION } from './constants.js';
import { readDailyLog } from './daily-log.js';

const DAY_MS = 86_400_000;

export interface SuggestionsState {
  readonly dismissed: Record<string, { readonly dismissedAt: string }>;
}

export function suggestionKey(uid: string, date: string): string {
  return `${uid}:${date}`;
}

// The date is always the key's last 10 chars — uids may contain ':'.
function keyDate(key: string): string {
  return key.slice(-10);
}

/** Pure prune — exported for tests. */
export function pruneSuggestionsState(
  state: SuggestionsState,
  nowMs: number,
  isDayPushed: (date: string) => boolean,
): SuggestionsState {
  const cutoff = new Date(nowMs - CALENDAR_WINDOW_PAST_DAYS * DAY_MS).toISOString().slice(0, 10);
  const dismissed: Record<string, { dismissedAt: string }> = {};
  const pushedByDate = new Map<string, boolean>();
  for (const [key, value] of Object.entries(state.dismissed)) {
    const date = keyDate(key);
    if (date < cutoff) continue;
    let pushed = pushedByDate.get(date);
    if (pushed === undefined) {
      pushed = isDayPushed(date);
      pushedByDate.set(date, pushed);
    }
    if (pushed) continue;
    dismissed[key] = value;
  }
  return { dismissed };
}

function defaultIsDayPushed(date: string): boolean {
  return readDailyLog(date)?.pushedAt != null;
}

export function loadSuggestionsState(nowMs: number = Date.now()): SuggestionsState {
  let raw: SuggestionsState | null = null;
  try {
    const parsed = JSON.parse(readFileSync(getStatePath(), 'utf-8')) as SuggestionsState;
    if (parsed && parsed.dismissed && typeof parsed.dismissed === 'object') raw = parsed;
  } catch { /* missing/corrupt → empty */ }
  if (!raw) return { dismissed: {} };
  return pruneSuggestionsState(raw, nowMs, defaultIsDayPushed);
}

/** Record a dismissal (idempotent), prune, write atomically. */
export function dismissSuggestionKey(uid: string, date: string, nowMs: number = Date.now()): SuggestionsState {
  const state = loadSuggestionsState(nowMs);
  const next: SuggestionsState = {
    dismissed: {
      ...state.dismissed,
      [suggestionKey(uid, date)]: { dismissedAt: new Date(nowMs).toISOString() },
    },
  };
  writeState(next);
  return next;
}

function getStatePath(): string {
  return join(getDataDir(), SUGGESTIONS_STATE_FILE);
}

function writeState(state: SuggestionsState): void {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = getStatePath();
  const tmpPath = path + TMP_EXTENSION;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmpPath, path);
}
