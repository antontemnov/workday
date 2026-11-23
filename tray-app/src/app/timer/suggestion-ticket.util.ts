import { DEFAULT_MANUAL_ACTIVITY, Suggestion, SuggestionTicket } from '../models/workday.models';

export function suggestionKey(s: Pick<Suggestion, 'uid' | 'date'>): string {
  return `${s.uid}:${s.date}`;
}

/**
 * The suggestions with the tickets given to them in the feed (task?), by
 * `uid:date`. Such a suggestion is from then on a suggestion with a ticket,
 * like one whose series the daemon knows — in the feed and on the widget. The
 * activity is what the pick said (a candidate's, a favorite's), Other
 * otherwise. A ticket the daemon knows stands.
 */
export function withTickets(
  suggestions: readonly Suggestion[],
  tickets: ReadonlyMap<string, SuggestionTicket>,
): readonly Suggestion[] {
  return suggestions.map(s => {
    const ticket = s.resolved ? undefined : tickets.get(suggestionKey(s));
    if (!ticket) return s;
    return { ...s, resolved: { task: ticket.task, activity: ticket.activity ?? DEFAULT_MANUAL_ACTIVITY, level: 'picked' } };
  });
}
