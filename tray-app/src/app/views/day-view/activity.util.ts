import { ActivityType } from '../../models/workday.models';

/** Display label for a Tempo activity value; falls back to the raw value. */
export function activityLabel(types: readonly ActivityType[], value: string): string {
  return types.find(a => a.value === value)?.name ?? value;
}

/** CSS tone modifier so a few common activities get a distinct badge tint. */
export function activityTone(value: string): string {
  switch (value) {
    case 'CodeReview':
    case 'CodeReviewFixes':
    case 'TestReview':   return 'rev';
    case 'Development':
    case 'Bugfixing':    return 'dev';
    default:             return 'other';
  }
}

/**
 * Picker options: the allow-list applied over the full catalog (empty = all).
 * `current` — the edited entry's activity — is always kept so an existing
 * entry with a scoped-out activity still resolves in the select. Labels must
 * keep resolving from the full catalog, never from this list.
 */
export function activityOptions(
  types: readonly ActivityType[],
  allowed: readonly string[],
  current?: string,
): readonly ActivityType[] {
  const base = types.length ? types : [{ value: 'Other', name: 'Other' }];
  if (allowed.length === 0) return base;
  const scoped = base.filter(a => allowed.includes(a.value) || a.value === current);
  return scoped.length ? scoped : base; // stale allow-list → don't brick the picker
}
