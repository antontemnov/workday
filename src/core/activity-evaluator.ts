import type { TickInput, EvaluatorResult, SessionScore } from './types.js';
import {
  EMA_WINDOW_MINUTES,
  ATTENTION_WINDOW_MINUTES,
  STAMINA_FLOOR_RATIO,
  FREQUENCY_GAIN_MAX,
  STAMINA_LINES_PER_MINUTE,
  VOLUME_GAIN_MAX,
  COMMIT_BONUS_SECONDS,
  BASE_DECAY,
  DECAY_BOOST,
} from './constants.js';

interface SessionState {
  score: number;
  ema: number;
  attention: number;
}

/**
 * Pure computational class — no I/O.
 * Maintains per-session activity score and EMA, determines cross-repo leadership.
 *
 * Per-session maxTicks comes from the caller (resolved from sensitivity); the
 * touch floor is derived from it via STAMINA_FLOOR_RATIO.
 */
export class ActivityEvaluator {
  private readonly emaAlpha: number;
  private readonly attentionAlpha: number;
  private readonly commitBonus: number;
  private readonly linesPerGainTick: number;
  private readonly state: Map<string, SessionState> = new Map();
  private lastLeaderId: string | null = null;

  public constructor(diffPollSeconds: number) {
    const emaWindowTicks = EMA_WINDOW_MINUTES * 60 / diffPollSeconds;
    this.emaAlpha = 1 / emaWindowTicks;
    const attentionWindowTicks = ATTENTION_WINDOW_MINUTES * 60 / diffPollSeconds;
    this.attentionAlpha = 1 / attentionWindowTicks;
    this.commitBonus = COMMIT_BONUS_SECONDS / diffPollSeconds;
    this.linesPerGainTick = STAMINA_LINES_PER_MINUTE * diffPollSeconds / 60;
  }

  /**
   * Process one tick for all sessions. Returns scores and leader.
   * Manually paused sessions must NOT be included in ticks (caller responsibility).
   *
   * Scoring algorithm ("stamina"):
   * 1. EMA — binary moving average of activity (1 if dynamics/commit, 0 otherwise)
   * 2. Touch floor — any active tick lifts score to STAMINA_FLOOR_RATIO * maxTicks.
   *    A single stray keystroke buys a leash (Normal: ~11 min), nothing more —
   *    generous enough to ride out a normal "stop and think" gap unaided.
   * 3. Frequency gain — ema * FREQUENCY_GAIN_MAX per active tick. Only a sustained
   *    tick-after-tick stream of updates (EMA → 1) outpaces decay on its own.
   * 4. Volume gain — deltaMagnitude / linesPerGainTick (STAMINA_LINES_PER_MINUTE,
   *    tick-normalized), capped at VOLUME_GAIN_MAX, so a bulk paste can't fill
   *    the bar in one tick.
   * 5. Commit bonus — instant COMMIT_BONUS_SECONDS / diffPollSeconds ticks
   * 6. Cap score at maxTicks (fixed ceiling)
   * 7. Decay — BASE_DECAY on active ticks; on idle ticks BASE_DECAY +
   *    DECAY_BOOST × EMA (asymmetric fade: the denser the recent work, the
   *    faster the buffer cools once activity stops — a full Normal bar drains
   *    in ~30 min after an abrupt stop, not 45; gentle enough that a think gap
   *    after a burst isn't mistaken for a break)
   * 8. score == 0 → idle timeout → eligible for auto-pause
   *
   * Leadership is driven by a separate short-window attention EMA (~2 min),
   * not by the stamina score — see pickLeader. This keeps repo handover fast
   * (~2 min) regardless of how full the bars are, while a single stray touch
   * can never steal leadership.
   *
   * Net effect (30s ticks, Normal 11–45 min): light sporadic edits hover at the
   * floor; pulsed work (bursts with think gaps) now accumulates a buffer instead
   * of collapsing back to the floor; a relentless every-tick stream saturates in
   * ~40 min; ~15 lines per tick saturates in ~15 min; reaching 100% is
   * intentionally hard.
   */
  public processAllTicks(ticks: readonly TickInput[]): EvaluatorResult {
    const scores = new Map<string, SessionScore>();

    for (const tick of ticks) {
      const st = this.getOrCreateState(tick.sessionId);
      const hasActivity = tick.signals.hasDynamics || tick.signals.hasCommit;

      // 1. EMA updates (binary input): slow EMA = activity frequency for the
      //    stamina formula, fast attention EMA = leadership signal.
      st.ema = this.emaAlpha * (hasActivity ? 1 : 0) + (1 - this.emaAlpha) * st.ema;
      st.attention = this.attentionAlpha * (hasActivity ? 1 : 0) + (1 - this.attentionAlpha) * st.attention;

      if (hasActivity) {
        // 2. Touch floor
        st.score = Math.max(st.score, tick.maxTicks * STAMINA_FLOOR_RATIO);

        // 3. Frequency gain
        st.score += Math.min(1, st.ema) * FREQUENCY_GAIN_MAX;

        // 4. Volume gain
        st.score += Math.min(VOLUME_GAIN_MAX, tick.signals.deltaMagnitude / this.linesPerGainTick);

        // 5. Commit bonus
        if (tick.signals.hasCommit) {
          st.score += this.commitBonus;
        }

        // 6. Cap at the sensitivity ceiling
        st.score = Math.min(st.score, tick.maxTicks);
      }

      // 7. Decay — asymmetric: idle ticks after dense work drain faster, but
      //    the boost only eats the earned part above the floor. Below the
      //    floor the fade is always 1/tick, so the "any touch buys
      //    floor-minutes" guarantee holds at any EMA.
      const floorTicks = tick.maxTicks * STAMINA_FLOOR_RATIO;
      if (!hasActivity && st.score > floorTicks) {
        const boosted = BASE_DECAY + DECAY_BOOST * Math.min(1, st.ema);
        st.score = Math.max(floorTicks, st.score - boosted);
      } else {
        st.score = Math.max(0, st.score - BASE_DECAY);
      }

      // Build result for this session
      const normalizedScore = tick.maxTicks > 0 ? st.score / tick.maxTicks : 0;
      scores.set(tick.sessionId, {
        score: st.score,
        maxScore: tick.maxTicks,
        normalizedScore,
        ema: st.ema,
        etaTicks: this.estimateIdleTicks(st, floorTicks),
        isIdleTimeout: st.score === 0,
      });
    }

    const leaderId = this.pickLeader(scores);
    this.lastLeaderId = leaderId;
    return { scores, leaderId };
  }

  /**
   * Leadership by attention EMA with takeover hysteresis.
   *
   * Candidates: sessions with score > 0. The current leader keeps the lead
   * until a challenger's attention exceeds it by more than attentionAlpha —
   * one isolated touch's worth — so a stray save can never steal leadership
   * by construction, while a genuine switch (old repo idle, new repo active
   * tick after tick) hands over within ~2 minutes. Without a defending
   * leader the most-attended candidate wins (normalizedScore as tiebreak).
   */
  private pickLeader(scores: ReadonlyMap<string, SessionScore>): string | null {
    let best: string | null = null;
    let bestAttention = -1;
    let bestNorm = -1;
    for (const [sessionId, sessionScore] of scores) {
      if (sessionScore.score <= 0) continue;
      const attention = this.state.get(sessionId)?.attention ?? 0;
      if (attention > bestAttention || (attention === bestAttention && sessionScore.normalizedScore > bestNorm)) {
        best = sessionId;
        bestAttention = attention;
        bestNorm = sessionScore.normalizedScore;
      }
    }

    const prev = this.lastLeaderId;
    if (prev !== null && prev !== best && (scores.get(prev)?.score ?? 0) > 0) {
      const prevAttention = this.state.get(prev)?.attention ?? 0;
      if (bestAttention <= prevAttention + this.attentionAlpha) {
        return prev;
      }
    }
    return best;
  }

  /**
   * Ticks until score hits 0 with no further activity. With asymmetric decay
   * this is no longer score/BASE_DECAY — simulate the fade (EMA cools too,
   * and the boost stops at the floor). Bounded by the score itself
   * (decay ≥ 1), i.e. at most maxTicks iterations.
   */
  private estimateIdleTicks(st: SessionState, floorTicks: number): number {
    let score = st.score;
    let ema = st.ema;
    let ticks = 0;
    while (score > 0) {
      ema *= 1 - this.emaAlpha;
      score = score > floorTicks
        ? Math.max(floorTicks, score - (BASE_DECAY + DECAY_BOOST * Math.min(1, ema)))
        : score - BASE_DECAY;
      ticks++;
    }
    return ticks;
  }

  /** Remove session state on close */
  public removeSession(sessionId: string): void {
    this.state.delete(sessionId);
    if (this.lastLeaderId === sessionId) {
      this.lastLeaderId = null;
    }
  }

  /** Clear all state (day boundary, daemon stop) */
  public clear(): void {
    this.state.clear();
    this.lastLeaderId = null;
  }

  private getOrCreateState(sessionId: string): SessionState {
    let st = this.state.get(sessionId);
    if (!st) {
      st = { score: 0, ema: 0, attention: 0 };
      this.state.set(sessionId, st);
    }
    return st;
  }
}
