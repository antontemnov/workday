// Meeting suggestions — fully derived on every read: cached calendar
// instances for the date, minus entry filters (BUSY only, not cancelled,
// not all-day, private hidden only when configured, a row is born at
// DTSTART), minus covered (a ManualEntry carrying the instance's sourceRef
// exists in the day log), minus dismissed keys. Accepts are never stored.
//
// A day pushed to Tempo at least once (log.pushedAt) is silenced for good:
// its dismissed keys are pruned at that point, so resurrecting on
// pushed→outdated drift would revive explicit rejections. Every calendar
// day gets the same full treatment — there is no day-off concept.
import { MS_PER_MINUTE, SUGGESTION_SOURCE_MEETING } from './constants.js';
import { suggestionKey } from './suggestions-state.js';
import {
  SuggestionsDayState,
  type CalendarInstance,
  type DailyLog,
  type Suggestion,
  type SuggestionsResponse,
} from './types.js';

export function meetingSourceRef(uid: string, date: string): string {
  return `${SUGGESTION_SOURCE_MEETING}:${uid}:${date}`;
}

export interface DeriveSuggestionsInput {
  readonly date: string;
  readonly instances: readonly CalendarInstance[];  // full cache, any dates
  readonly log: DailyLog | null;
  readonly dismissedKeys: ReadonlySet<string>;
  readonly hidePrivate: boolean;
  readonly nowMs: number;
}

export function deriveSuggestions(input: DeriveSuggestionsInput): SuggestionsResponse {
  const { date, log, nowMs } = input;
  if (log?.pushedAt) {
    return { date, state: SuggestionsDayState.Pushed, suggestions: [] };
  }

  const covered = new Set<string>();
  for (const entry of log?.manualEntries ?? []) {
    if (entry.sourceRef) covered.add(entry.sourceRef);
  }

  const suggestions: Suggestion[] = [];
  for (const instance of input.instances) {
    if (instance.date !== date) continue;
    if (instance.cancelled || instance.allDay) continue;
    if (instance.busyStatus !== 'BUSY') continue;
    if (instance.isPrivate && input.hidePrivate) continue;
    const startMs = Date.parse(instance.start);
    const endMs = Date.parse(instance.end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (startMs > nowMs) continue;
    if (covered.has(meetingSourceRef(instance.uid, instance.date))) continue;
    if (input.dismissedKeys.has(suggestionKey(instance.uid, instance.date))) continue;

    suggestions.push({
      uid: instance.uid,
      date: instance.date,
      title: instance.title,
      start: instance.start,
      end: instance.end,
      plannedMinutes: Math.max(1, Math.round((endMs - startMs) / MS_PER_MINUTE)),
      ongoing: nowMs < endMs,
      isPrivate: instance.isPrivate === true,
      source: SUGGESTION_SOURCE_MEETING,
    });
  }

  suggestions.sort((a, b) => a.start.localeCompare(b.start) || a.uid.localeCompare(b.uid));
  return { date, state: SuggestionsDayState.Active, suggestions };
}
