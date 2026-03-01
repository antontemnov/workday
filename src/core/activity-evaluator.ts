import type { TickInput, EvaluatorResult, SessionScore } from './types.js';
import {
  MIN_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  EMA_WINDOW_MINUTES,
  ACTIVITY_RATIO,
  MAGNITUDE_SCALE,
  MAGNITUDE_BONUS_MAX,
  COMMIT_BONUS_SECONDS,
  BASE_DECAY,
} from './constants.js';

interface SessionState {
  score: number;
  ema: number;
}

/**
 * Pure computational class — no I/O.
 * Maintains per-session activity score and EMA, determines cross-repo leadership.
 */
export class ActivityEvaluator {
  private readonly minTicks: number;
  private readonly maxTicks: number;
  private readonly emaAlpha: number;
  private readonly commitBonus: number;
  private readonly state: Map<string, SessionState> = new Map();

  public constructor(diffPollSeconds: number) {
    this.minTicks = MIN_TIMEOUT_MINUTES * 60 / diffPollSeconds;
    this.maxTicks = MAX_TIMEOUT_MINUTES * 60 / diffPollSeconds;
    const emaWindowTicks = EMA_WINDOW_MINUTES * 60 / diffPollSeconds;
    this.emaAlpha = 1 / emaWindowTicks;
    this.commitBonus = COMMIT_BONUS_SECONDS / diffPollSeconds;
  }

  /**
   * Process one tick for all sessions. Returns scores and leader.
   * Manually paused sessions must NOT be included in ticks (caller responsibility).
   */
  public processAllTicks(ticks: readonly TickInput[]): EvaluatorResult {
    const scores = new Map<string, SessionScore>();

    // Update state for each session
    for (const tick of ticks) {
      const st = this.getOrCreateState(tick.sessionId);
      const hasActivity = tick.signals.hasDynamics || tick.signals.hasCommit;

      // 1. EMA update (binary input)
      st.ema = this.emaAlpha * (hasActivity ? 1 : 0) + (1 - this.emaAlpha) * st.ema;

      // 2. Adaptive max score
      const dynamicMaxScore = this.maxTicks - (this.maxTicks - this.minTicks) * Math.min(1, st.ema);

      // 3. Activity points from dynamics
      if (tick.signals.hasDynamics) {
        const magnitudeBonus = 1 + Math.min(1, Math.log2(1 + tick.signals.deltaMagnitude) / MAGNITUDE_SCALE) * MAGNITUDE_BONUS_MAX;
        st.score += dynamicMaxScore * ACTIVITY_RATIO * magnitudeBonus;
      }

      // 4. Commit bonus
      if (tick.signals.hasCommit) {
        st.score += this.commitBonus;
      }

      // 5. Cap at adaptive ceiling
      st.score = Math.min(st.score, dynamicMaxScore);

      // 6. Decay
      st.score = Math.max(0, st.score - BASE_DECAY);

      // Build result for this session
      const normalizedScore = dynamicMaxScore > 0 ? st.score / dynamicMaxScore : 0;
      scores.set(tick.sessionId, {
        score: st.score,
        maxScore: dynamicMaxScore,
        normalizedScore,
        ema: st.ema,
        isIdleTimeout: st.score === 0,
      });
    }

    // Determine leader: highest normalizedScore with score > 0
    let leaderId: string | null = null;
    let bestNorm = 0;
    for (const [sessionId, sessionScore] of scores) {
      if (sessionScore.score > 0 && sessionScore.normalizedScore > bestNorm) {
        bestNorm = sessionScore.normalizedScore;
        leaderId = sessionId;
      }
    }

    return { scores, leaderId };
  }

  /** Remove session state on close */
  public removeSession(sessionId: string): void {
    this.state.delete(sessionId);
  }

  /** Clear all state (day boundary, daemon stop) */
  public clear(): void {
    this.state.clear();
  }

  private getOrCreateState(sessionId: string): SessionState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { score: 0, ema: 0 };
      this.state.set(sessionId, st);
    }
    return st;
  }
}
