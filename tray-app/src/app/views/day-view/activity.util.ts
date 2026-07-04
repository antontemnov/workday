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
