import { computeEffectiveDuration, computeTotalPauseDuration } from './daily-log.js';
import { SensitivityLevel } from './types.js';
import type { Session, SessionDetail } from './types.js';

/**
 * A session as stored on disk, in the API shape — no live fields (score,
 * pause state, leadership). Those exist only for today's open sessions.
 */
export function toStoredSessionDetail(s: Session): SessionDetail {
  return {
    id: s.id,
    repo: s.repo,
    task: s.task,
    branch: s.branch,
    state: s.state,
    startedAt: s.startedAt,
    activatedAt: s.activatedAt,
    lastSeenAt: s.lastSeenAt,
    paused: false,
    pauseSource: null,
    effectiveDurationMs: computeEffectiveDuration(s),
    score: 0,
    normalizedScore: 0,
    pauseEtaMs: null,
    isLeader: false,
    sensitivity: SensitivityLevel.Normal,
    closedBy: s.closedBy,
    evidence: s.evidence,
    pauseCount: s.pauses.length,
    totalPauseDurationMs: computeTotalPauseDuration(s),
  };
}
