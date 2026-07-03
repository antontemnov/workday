import { GAP_THRESHOLD_POLL_MULTIPLIER, GAP_THRESHOLD_FLOOR_SECONDS } from './constants.js';

/**
 * Observation-gap detection (PC sleep / hibernate / suspended process).
 *
 * Node timers do not fire while the machine sleeps: the evaluator never
 * decays and lastSeenAt never advances, so without a gap check the first
 * tick after wake-up would credit the whole gap as work. Pure math here;
 * the daemon reacts (retro-pause, drop candidates, reset evaluator).
 */

export type GapKind = 'none' | 'gap' | 'clock_jump_back';

export interface GapCheckResult {
  readonly kind: GapKind;
  readonly gapMs: number;
}

/**
 * Gap threshold: several missed polls, but never below a floor — a single
 * slow git poll or GC hiccup must not read as a sleep gap.
 */
export function gapThresholdMs(pollSeconds: number): number {
  return Math.max(GAP_THRESHOLD_POLL_MULTIPLIER * pollSeconds, GAP_THRESHOLD_FLOOR_SECONDS) * 1000;
}

/** Compare now against the last time the process was known to be alive. */
export function checkGap(nowMs: number, lastAliveMs: number, pollSeconds: number): GapCheckResult {
  const gapMs = nowMs - lastAliveMs;
  if (gapMs < 0) {
    return { kind: 'clock_jump_back', gapMs };
  }
  if (gapMs >= gapThresholdMs(pollSeconds)) {
    return { kind: 'gap', gapMs };
  }
  return { kind: 'none', gapMs };
}
