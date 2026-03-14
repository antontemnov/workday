import type { ReflogEntry, ReflogEntryType } from '../core/types.js';

/**
 * Parses git reflog output into structured entries.
 * Migrated from legacy timesheet.mjs (parseReflogEntries + extract helpers).
 */
export class ReflogParser {
  private readonly taskPattern: RegExp;

  public constructor(taskPattern: string) {
    this.taskPattern = new RegExp(taskPattern);
  }

  /**
   * Parse raw reflog text into structured entries sorted ascending by time.
   * Classifies each entry: 'commit', 'checkout', or 'other'.
   *
   * Ported from legacy parseReflogEntries().
   */
  public parseEntries(text: string): ReflogEntry[] {
    if (!text) return [];

    const entries: (ReflogEntry & { readonly lineIndex: number })[] = [];
    const lines = text.split('\n');

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const match = line.match(
        /HEAD@\{(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})\}\s+(.*)/
      );
      if (!match) continue;

      // Include timezone offset for correct absolute timestamp
      const ts = Date.parse(`${match[1]}T${match[2]}${match[3]}`);
      const action = match[4];

      if (isNaN(ts)) continue;

      let type: ReflogEntryType;
      if (action.startsWith('commit')) {
        type = 'commit';
      } else if (action.startsWith('checkout')) {
        type = 'checkout';
      } else if (action.startsWith('reset')) {
        type = 'reset';
      } else {
        type = 'other';
      }

      entries.push({ ts, type, message: action, lineIndex });
    }

    // Ascending by time; for same-second ties, higher lineIndex = earlier event
    entries.sort((a, b) => a.ts - b.ts || b.lineIndex - a.lineIndex);

    return entries;
  }

  /**
   * Extract target branch from checkout message.
   * "moving from X to Y" → Y
   *
   * Ported from legacy extractCheckoutTarget().
   */
  public extractCheckoutTarget(message: string): string | null {
    const match = message.match(/moving from \S+ to (\S+)/);
    return match ? match[1] : null;
  }

  /**
   * Extract task key from a commit/reflog message.
   * Uses configurable taskPattern.
   *
   * Ported from legacy extractTaskFromMessage().
   */
  public extractTaskFromMessage(message: string): string | null {
    const match = message.match(this.taskPattern);
    return match ? match[0] : null;
  }
}
