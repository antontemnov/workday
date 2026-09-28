import { ActivityType } from '../../models/workday.models';

/** Display label for a Tempo activity value; falls back to the raw value. */
export function activityLabel(types: readonly ActivityType[], value: string): string {
  return types.find(a => a.value === value)?.name ?? value;
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
