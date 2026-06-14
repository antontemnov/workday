// Shared duration parsing/formatting for the Tempo-style duration fields
// (LOG TIME composer + Add Manual Time popover). Kept framework-free so both
// the DurationFieldComponent and its host components can reuse it.

export interface DurationQuickPick {
  readonly label: string;
  readonly minutes: number;
}

// Quick-pick durations for the composer.
export const MINUTE_QUICK_PICKS: ReadonlyArray<DurationQuickPick> = [
  { label: '20m', minutes: 20 },
  { label: '30m', minutes: 30 },
  { label: '1h',  minutes: 60 },
];

// Below this, a bare number reads as hours; at or above, as minutes. App-
// specific (Tempo treats every bare number as hours) — keeps "5" = 5h while
// sparing the "45" = 45h footgun (→ 45m).
const BARE_HOURS_THRESHOLD = 10;

// Tempo-style duration parsing → minutes (null = unparseable).
// Bare number: < 10 → hours ("1.5" → 90), ≥ 10 → minutes ("45" → 45). Units
// h/m/d/w override ("90m" → 90, "1h 30m" → 90); whitespace ignored ("4 5 m" →
// 45); a trailing unit-less number is minutes ("1h30" → 90).
export function parseDurationToMinutes(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = parseFloat(s);
    return Math.round(n < BARE_HOURS_THRESHOLD ? n * 60 : n);
  }

  const tokenRe = /(\d+(?:\.\d+)?)(h|m|d|w)/y; // sticky → tokens must be contiguous
  let total = 0;
  let pos = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(s)) !== null) {
    const n = parseFloat(match[1]);
    switch (match[2]) {
      case 'h': total += n * 60; break;
      case 'm': total += n; break;
      case 'd': total += n * 8 * 60; break;     // Tempo workday = 8h
      case 'w': total += n * 5 * 8 * 60; break; // Tempo workweek = 5d
    }
    pos = tokenRe.lastIndex;
  }
  // Trailing unit-less number = minutes, e.g. "1h30" → 90.
  const rest = s.slice(pos);
  if (rest && /^\d+(\.\d+)?$/.test(rest)) { total += parseFloat(rest); pos = s.length; }
  if (pos !== s.length || total <= 0) return null;
  return Math.round(total);
}

// 90 → "1h 30m", 45 → "45m", 120 → "2h".
export function formatDurationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
