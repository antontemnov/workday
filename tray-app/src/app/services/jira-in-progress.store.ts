import { JiraSearchHit } from '../models/workday.models';

const IN_PROGRESS_STORAGE_KEY = 'wd.logCloud.inProgress';

/** The in-progress list of the previous run: painted at once, before Jira answers. */
export function loadStoredInProgress(): readonly JiraSearchHit[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(IN_PROGRESS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter((h): h is JiraSearchHit =>
      typeof h?.key === 'string' && typeof h?.summary === 'string');
  } catch {
    return [];
  }
}

export function storeInProgress(hits: readonly JiraSearchHit[]): void {
  try {
    localStorage.setItem(IN_PROGRESS_STORAGE_KEY, JSON.stringify(hits));
  } catch { /* storage is a convenience — the list works without it */ }
}

export function sameHits(a: readonly JiraSearchHit[], b: readonly JiraSearchHit[]): boolean {
  return a.length === b.length && a.every((h, i) => h.key === b[i].key && h.summary === b[i].summary);
}
