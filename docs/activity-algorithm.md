# Activity Evaluator Algorithm

Detailed specification of the adaptive decay algorithm for auto-pause/auto-resume.

## Table of Contents

1. [Overview](#overview)
2. [Constants & Time Independence](#constants)
3. [EMA Intensity Model](#ema)
4. [Adaptive Max Score](#adaptive-max)
5. [Magnitude Enrichment](#magnitude)
6. [Cross-Repo Leadership](#leadership)
7. [Score Lifecycle & State Machine](#score-lifecycle)
8. [The "Glass of Water" Model](#glass-of-water)
9. [CLI Commands](#cli-commands)
10. [Scenario Walkthroughs](#scenarios)
11. [Edge Cases](#edge-cases)
12. [Constants Summary](#constants-summary)

---

## 1. Overview <a name="overview"></a>

The `ActivityEvaluator` maintains a per-session **activity score** that represents
remaining confidence that the developer is still working. The score increases on
git activity (diff dynamics, commits) and decays linearly each poll tick.

When score reaches 0 → auto-pause. When activity resumes on a paused session → auto-resume.

Key design goals:
- **Adaptive timeout**: heavy coders get shorter timeout (15 min), light coders get longer (45 min)
- **Cross-repo awareness**: only one repo can hold attention at a time
- **Time-unit independence**: algorithm works correctly regardless of `diffPollSeconds` value

---

## 2. Constants & Time Independence <a name="constants"></a>

**All algorithm constants are expressed in human-readable time units (minutes, seconds).**
Tick-based values are derived at `ActivityEvaluator` construction time.

### Source constants (time-based)

| Constant | Value | Unit | Description |
|----------|-------|------|-------------|
| `MIN_TIMEOUT_MINUTES` | 15 | min | Minimum auto-pause timeout (for heavy work) |
| `MAX_TIMEOUT_MINUTES` | 45 | min | Maximum auto-pause timeout (for light work) |
| `EMA_WINDOW_MINUTES` | 10 | min | EMA smoothing window (how fast EMA reacts) |
| `COMMIT_BONUS_SECONDS` | 150 | sec | Extra score from a commit (in timeout equivalent) |

### Derived constants (tick-based)

All computed from `diffPollSeconds` (config value, default 30):

```
tickSeconds = config.session.diffPollSeconds

MIN_TIMEOUT_TICKS  = MIN_TIMEOUT_MINUTES * 60 / tickSeconds
MAX_TIMEOUT_TICKS  = MAX_TIMEOUT_MINUTES * 60 / tickSeconds
EMA_WINDOW_TICKS   = EMA_WINDOW_MINUTES * 60 / tickSeconds
EMA_ALPHA          = 1 / EMA_WINDOW_TICKS
COMMIT_BONUS       = COMMIT_BONUS_SECONDS / tickSeconds
```

### Derivation table for different `diffPollSeconds`

| Config | MIN_TICKS | MAX_TICKS | EMA_ALPHA | COMMIT_BONUS |
|--------|-----------|-----------|-----------|--------------|
| 15s    | 60        | 180       | ~0.025    | 10           |
| 30s    | 30        | 90        | ~0.05     | 5            |
| 45s    | 20        | 60        | ~0.075    | ~3           |
| 60s    | 15        | 45        | ~0.10     | ~3           |

The timeout range [15, 45] minutes is preserved regardless of tick duration.

---

## 3. EMA Intensity Model <a name="ema"></a>

**Exponential Moving Average** tracks how intensely the developer has been working.

### Formula

```
Each tick:
  hasActivity = hasDynamics || hasCommit
  activityLevel = hasActivity ? 1.0 : 0.0

  intensityEMA = EMA_ALPHA × activityLevel + (1 - EMA_ALPHA) × intensityEMA
```

EMA uses **binary input** (activity present or not). Delta magnitude is applied
separately to activity points (see §5), not to EMA. This keeps the EMA semantics
clean: it answers "how often does the developer produce changes?", not "how big
are the changes?".

### EMA behavior

EMA ranges from 0.0 (no recent activity) to ~1.0 (continuous activity).
With `EMA_ALPHA ≈ 0.05` (10-min window, 30s ticks):

| Work pattern | Steady-state EMA | Calculation |
|-------------|------------------|-------------|
| Every tick (heavy) | ~1.00 | Converges to 1.0 |
| Every 3rd tick | ~0.33 | α / (1 - (1-α)^3) with α=0.05 |
| Every 5th tick | ~0.22 | α / (1 - (1-α)^5) |
| Every 10th tick (5 min gap) | ~0.12 | α / (1 - (1-α)^10) |
| Every 30th tick (15 min gap) | ~0.05 | α / (1 - (1-α)^30) |

### EMA decay during idle

With the 10-minute window, EMA retains memory through short breaks:

| Idle time | EMA (was 0.65) | Meaning |
|-----------|---------------|---------|
| 0 min | 0.65 | Just stopped |
| 2.5 min | 0.53 | Still remembers intensity |
| 5 min | 0.39 | Moderate memory |
| 10 min | 0.23 | Starting to forget |
| 15 min | 0.14 | Mostly forgotten |
| 30 min | 0.03 | Nearly fresh |
| 45 min | ~0 | Clean slate |

### EMA during pause

- **Manual pause**: full freeze. Evaluator does not receive the session → EMA, score,
  and all state remain exactly as they were. On resume, processing continues
  from the frozen state. The frozen score naturally serves as a grace period.
- **Auto-pause** (IdleTimeout/Superseded): evaluator still receives the session.
  Score updates normally (may accumulate on activity).
  EMA continues to update each tick.

---

## 4. Adaptive Max Score <a name="adaptive-max"></a>

The core mechanism: **the score ceiling adapts based on work intensity**.

### Formula

```
dynamicMaxScore = MAX_TIMEOUT_TICKS - (MAX_TIMEOUT_TICKS - MIN_TIMEOUT_TICKS) × min(1.0, intensityEMA)
```

No normalization constant needed — EMA with binary input naturally reaches 1.0
for heavy coders and stays low for light coders.

### Mapping (with diffPollSeconds=30)

| EMA | dynamicMaxScore (ticks) | Timeout equivalent |
|-----|------------------------|--------------------|
| 0.00 | 90 | 45 min |
| 0.05 | 87 | 43.5 min |
| 0.12 | 83 | 41.5 min |
| 0.22 | 77 | 38.5 min |
| 0.33 | 70 | 35 min |
| 0.50 | 60 | 30 min |
| 0.75 | 45 | 22.5 min |
| 1.00 | 30 | 15 min |

### Activity points

Each dynamics event gives points proportional to the adaptive max,
scaled by delta magnitude (see §5):

```
ACTIVITY_RATIO = 0.5
magnitudeBonus = 1 + min(1, log2(1 + |addedDelta| + |removedDelta|) / MAGNITUDE_SCALE) × 0.5
activityPoints = dynamicMaxScore × ACTIVITY_RATIO × magnitudeBonus
```

`magnitudeBonus` ranges from ×1.0 (no changes / commit-only) to ×1.5 (128+ lines).
This means heavy changes fill the score buffer faster, but the buffer SIZE (dynamicMaxScore)
is determined solely by EMA (frequency of activity).

| EMA | dynamicMax | activityPoints (1 line) | activityPoints (30 lines) |
|-----|-----------|------------------------|--------------------------|
| 1.00 | 30 | 15.5 | 20.3 |
| 0.33 | 70 | 36.2 | 47.3 |
| 0.12 | 83 | 42.9 | 56.1 |
| 0.00 | 90 | 46.5 | 60.8 |

### Score update per tick

```
1. if (hasDynamics):  score += activityPoints  (with magnitudeBonus)
2. if (hasCommit):    score += COMMIT_BONUS
3. score = min(score, dynamicMaxScore)    // cap at adaptive ceiling
4. score = max(0, score - BASE_DECAY)     // BASE_DECAY = 1 per tick always
5. if (score == 0): → AutoPause decision
```

Note: BASE_DECAY is always 1 per tick. The adaptation happens through dynamicMaxScore
and activityPoints, not through variable decay rates. This keeps the model simple.

---

## 5. Magnitude Enrichment <a name="magnitude"></a>

Delta magnitude (lines changed) affects **activity points**, not EMA.
EMA tracks frequency of activity (binary: active or not).
Magnitude tracks intensity of each activity event (how many lines changed).

### Design: separation of concerns

| Metric | Determines | Question it answers |
|--------|-----------|---------------------|
| EMA (binary) | dynamicMaxScore (buffer size) | "How often does the developer produce changes?" |
| Magnitude | activityPoints (buffer fill speed) | "How big are the changes when they happen?" |

This separation avoids the need for an EMA normalization constant (the removed `EMA_SATURATION`).
EMA with binary input naturally reaches 1.0 for every-tick activity.

### Formula

```
magnitudeBonus = 1 + min(1, log2(1 + |addedDelta| + |removedDelta|) / MAGNITUDE_SCALE) × 0.5

MAGNITUDE_SCALE = 7  // log2(128) ≈ 7 → 127+ lines = max bonus

activityPoints = dynamicMaxScore × ACTIVITY_RATIO × magnitudeBonus
```

### Magnitude bonus mapping

| Lines changed | log2(1+n)/7 | magnitudeBonus | Effect |
|---------------|-------------|----------------|--------|
| 0 (commit only) | 0 | ×1.00 | Base points only |
| 1 | 0.14 | ×1.07 | Minimal extra |
| 3 | 0.29 | ×1.14 | Light edit |
| 7 | 0.43 | ×1.21 | Moderate edit |
| 15 | 0.57 | ×1.29 | Active coding |
| 30 | 0.71 | ×1.36 | Heavy coding |
| 63 | 0.86 | ×1.43 | Very heavy |
| 127+ | 1.00 | ×1.50 | Maximum (capped) |

### Effect

Magnitude bonus ×1.0–×1.5 means heavy changes fill the score buffer up to 50% faster.
This matters for score accumulation speed, not for the timeout ceiling:

- Developer changing 127+ lines per tick fills the buffer 50% faster
- But the buffer SIZE is the same (determined by EMA alone)
- Practical effect: fewer ticks needed to reach the score cap after a break

---

## 6. Cross-Repo Leadership <a name="leadership"></a>

### Principle

**Only one session can be the "leader" (actively tracking time) at any moment.**
The leader is determined by comparing **normalized scores** across all sessions.
No special counters or thresholds needed — the existing score mechanism handles everything.

### Normalized score

```
normalizedScore = score / dynamicMaxScore    // 0.0 .. 1.0
```

This puts all sessions on the same scale regardless of their adaptive timeout.
A heavy coder's score of 30/30 (1.0) and a light coder's 80/90 (0.89) are
now directly comparable.

### Mechanism

```
Each processAllTicks() call:
  1. Compute scores for ALL sessions (except manually paused)
  2. For each session: normalizedScore = score / dynamicMaxScore
  3. The session with the HIGHEST normalizedScore = leader
  4. All other sessions with score > 0: paused (PauseSource.Superseded)
  5. Sessions with score == 0: paused (PauseSource.IdleTimeout)

Important: non-leader sessions are NOT frozen in the evaluator.
  Their scores continue to update (accumulate on activity, decay on idle).
  This allows them to compete and overtake the current leader.
```

### Why normalized?

Raw scores have different scales: a new session (dynamicMax=90) gets 46 points
from one dynamics, while a heavy coder's session (dynamicMax=30) caps at 30.
Raw comparison would give instant false switches.

With normalization:
- One stray dynamics in B: normalizedB = 46/87 = 0.53 vs normalizedA = 30/30 = 1.0 → A wins
- Two consecutive dynamics in B: normalizedB = 87/87 = 1.0 vs normalizedA = 28/30 = 0.93 → B wins
- Return to A: normalizedA = 30/30 = 1.0 vs normalizedB = 85/87 = 0.98 → A wins back instantly

### Multiple repos with activity (same tick)

If two repos both have dynamics in the same tick:
- The one with the higher normalized score is the leader
- Ties (equal normalized): both stay active (extremely rare edge case, same task anyway)

### PauseSource

```typescript
enum PauseSource {
  Manual = 'manual',           // workday pause
  IdleTimeout = 'idle_timeout', // score reached 0
  Superseded = 'superseded',   // another session has higher normalized score
  TeamsAway = 'teams_away',    // Phase 3
}
```

### Key difference from previous AttentionSteal

| | Old: AttentionSteal | New: Leadership |
|---|---|---|
| Detection | Separate counter (consecutiveActiveTicks) | Existing score |
| Threshold | Fixed (4 ticks / 2 min) | Organic (normalized score crossover) |
| False positives | Rebase could trigger | Stray dynamics doesn't win (norm < 1.0) |
| Complexity | Extra state per session | No extra state |
| Rebalance | Hard threshold, binary | Gradual, natural |

---

## 7. Score Lifecycle & State Machine <a name="score-lifecycle"></a>

### State machine

```
                 became leader (score > 0)
  Pending ───────────────────────────────► Active
    │                                        │  ▲
    │                                        │  │ regained leadership
    │                                        │  │ (close pause)
    │                                        ▼  │
    │                                    Active(paused)
    │                                    Superseded / IdleTimeout
    │                                        │
    │  checkout / day boundary / stop         │
    └───────────────► Closed ◄───────────────┘
```

States:
- **Pending**: session exists, evaluator computes score, time is NOT tracked.
  `startedAt` is not yet set. Promotion requires score > 0 AND highest normalizedScore.
- **Active**: session was or is the leader, time IS tracked.
  `startedAt` is set at the moment of Pending → Active promotion.
  May be paused (Superseded/IdleTimeout) but remains Active.
- **Closed**: session ended. `closedBy` records the reason.

Important: **Active never demotes back to Pending.** Losing leadership = pause, not demotion.

### Session opens

```
score = 0
intensityEMA = 0
state = Pending
startedAt = null (set on promotion to Active)
```

Session starts in `Pending` state. Evaluator receives it and computes score.
No time tracking until the session becomes the leader.

### Pending → Active (promotion)

```
Happens when:
  1. score > 0 (at least one activity event occurred)
  2. normalizedScore is the highest among all sessions

  startedAt = now
  state = Active
  Time tracking begins
```

**Both conditions are required.** A session with score = 0 cannot become the leader,
even if it's the only session. This prevents promoting "empty" sessions.

For single-repo setups: first dynamics → score > 0 → only session → leader → Active.
For multi-repo: session may stay Pending while another session leads, accumulating
score until it overtakes.

### Normal operation (Active session)

```
Each tick:
  1. Update EMA (binary: activity=1, idle=0)
  2. Compute dynamicMaxScore
  3. Add activity points if any (with magnitude bonus)
  4. Apply decay (BASE_DECAY = 1)
  5. Compare normalized scores across all sessions
  6. If still leader → continue tracking time
  7. If score == 0 → IdleTimeout pause
  8. If another session has higher normalized score → Superseded pause
```

### Auto-pause: IdleTimeout (score == 0)

```
On IdleTimeout (Active session, score reached 0):
  Pause record: PauseSource.IdleTimeout
  Evaluator continues processing (score updates, EMA decays)
  Resume: when dynamics/commit arrives → score > 0 → may become leader again
```

### Auto-pause: Superseded (lost leadership)

```
On Superseded (Active session, another session has higher normalized score):
  Pause record: PauseSource.Superseded
  Evaluator continues processing (score updates, EMA updates)
  Score may still be > 0 — session can compete and reclaim leadership
  Resume: when normalized score becomes highest again → close pause
```

**Key: Superseded sessions are NOT frozen.** Their evaluator state keeps updating.
They can regain leadership by accumulating higher normalized score.

### Auto-resume

```
When a paused Active session becomes the leader again:
  Close the Pause record (set `to` timestamp)
  Session resumes tracking time

This happens naturally through normalized score comparison.
Also: dynamics/commit on a manually paused session → auto-resume (forgot to resume).
```

### Manual pause

```
workday pause [repo]:
  Applies only to Active sessions (Pending sessions don't track time anyway).
  SessionTracker stops sending this session to ActivityEvaluator.
  Evaluator state (score, EMA) stays frozen.
  Auto-resume IS possible on git activity (dynamics or commit).
  SessionTracker handles this: detects activity → closes pause → unfreezes.
```

### Manual resume (workday resume)

```
workday resume:
  Closes ALL open pauses (manual, idle_timeout, superseded)
  SessionTracker resumes sending sessions to ActivityEvaluator
  Evaluator continues from frozen state (score, EMA preserved)
  The frozen score serves as a natural grace period:
    - Heavy coder (score=30): 15 min to start coding
    - Light coder (score=80): 40 min to start coding
  No special resume logic needed in the evaluator
```

### Autopause disabled (workday autopause off)

```
workday autopause off [repo]:
  Score continues updating (for status display) but:
    - IdleTimeout suppressed (score=0 does not trigger pause)
    - Leadership changes still apply (Superseded still works)
  Session stays active as leader indefinitely until:
    - workday autopause on [repo]
    - workday pause [repo]
    - Another session overtakes (Superseded)
    - Day boundary
    - Daemon stop
```

### Session closes

```
evaluator.removeSession(sessionId):
  Delete all in-memory state (score, EMA)
```

---

## 8. The "Glass of Water" Model <a name="glass-of-water"></a>

Developer attention is a finite resource, like water in a glass.

### The metaphor

```
Both sessions have scores updating simultaneously.
Leadership is determined by who has more water (normalized):

Repo A (Active):  [████████░░]  norm=0.93   "leader, tracking time"
Repo B (Pending): [░░░░░░░░░░]  norm=0.00   "accumulating, not tracking"

Developer switches to B:

Tick 1:  B dynamics → B norm=0.53, A norm=0.97 → A still leads
         B stays Pending (score accumulating, not yet leader)
Tick 2:  B dynamics → B norm=1.00, A norm=0.93 → B wins!
         B: Pending → Active (startedAt = now, time tracking begins)
         A: Active → paused (Superseded)

Repo A (paused):  [████████░░]  norm=0.90 (decaying, competing)
Repo B (Active):  [██████████]  norm=1.00   "leader, tracking time"

Developer returns to A:

Tick N:  A dynamics → A norm=1.00, B norm=0.95 → A wins!
         A: pause closed (resumes tracking)
         B: Active → paused (Superseded)
```

### Why not explicit transfer?

We considered: "repo B gains → repo A loses (zero-sum budget)".

The leadership model is simpler: both glasses exist independently,
the fuller one (normalized) gets to track time. No transfer, no redistribution.
Natural competition through score accumulation and decay.

---

## 9. CLI Commands <a name="cli-commands"></a>

### workday resume

Closes ALL open pauses regardless of source (manual, idle_timeout, superseded).
If the user explicitly says "resume", they know what they're doing.

Future: Teams integration will call the resume HTTP endpoint to signal "user is back".

### workday autopause off [repo]

Disables IdleTimeout for the specified repo or all repos if no argument given.
Leadership changes (Superseded) still apply — can't be leader of two repos at once.

Session won't get IdleTimeout when score=0. Score still updates (visible in `workday status`).

Reset on:
- `workday autopause on [repo]`
- Day boundary (clean slate for new day)
- Daemon stop/restart

`workday status` should show warning: "autopause disabled for atlas-frontend (since 14:30)"

### workday pause [repo]

Manual pause. Overrides auto-pause behavior. Can be lifted by:
- `workday resume` — explicit manual resume
- Git activity (dynamics or commit) — automatic, handles "forgot to resume" case

---

## 10. Scenario Walkthroughs <a name="scenarios"></a>

All examples use `diffPollSeconds=30` (1 tick = 30 seconds).

### Scenario A: Heavy coding session, then lunch

```
Developer writes code with dynamics nearly every tick for 2 hours.

Phase 1: Working (ticks 0-240, 2 hours)
  EMA → ~1.0 (binary input, activity every tick)
  dynamicMaxScore = 30 ticks (15 min)
  activityPoints = 15 × magnitudeBonus (~1.3 for typical edits) ≈ 19.5
  Score: capped at 30

Phase 2: Lunch break starts
  Tick 241: no dynamics, score = 30 - 1 = 29
  Tick 242: no dynamics, score = 28
  ...
  Tick 270: no dynamics, score = 1
  Tick 271: score = 0 → AutoPause (IdleTimeout)

  Time from last activity to pause: 30 ticks × 30s = 15 min ✓

Phase 3: Return from lunch (1 hour later)
  EMA during pause: 1.0 × (1-0.05)^120 ≈ 0.002 (fully decayed)
  Tick 391: dynamics → AutoResume
  dynamicMaxScore ≈ 90 (EMA≈0, fresh start with generous timeout)
  score ≈ 46.5 (activityPoints = 90 × 0.5 × magnitudeBonus)

  Pause logged: 15 min after last activity to resume = ~1 hour pause
```

### Scenario B: Light coding (1 line every 15 min)

```
Developer reads code and makes occasional small changes.
Gap between dynamics: 30 ticks (15 min).

Steady state:
  EMA → ~0.05 (very low, binary input every 30th tick)
  dynamicMaxScore = 87 ticks (43.5 min)
  activityPoints = 87 × 0.5 × 1.07 (1 line magnitude) ≈ 46.5

Score trajectory:
  Tick 0:  dynamics → score = 46.5
  Tick 1-29: decay → score = 46.5 - 29 = 17.5
  Tick 30: dynamics → score = 17.5 + 46.5 = 64.0, cap 87 → 64.0
  Tick 31-59: decay → score = 64.0 - 29 = 35.0
  Tick 60: dynamics → score = 35.0 + 46.5 = 81.5
  Tick 61-89: decay → score = 81.5 - 29 = 52.5
  Tick 90: dynamics → score = 52.5 + 46.5 = 99.0, cap 87 → 87.0
  ...converges at dynamicMaxScore (87)

  Score never reaches 0 during normal operation ✓

After final dynamics (stopping work):
  Score ≈ 80-87, decay at 1/tick
  Timeout: 80-87 ticks = 40-43 min ✓ (within [15,45] range)
```

### Scenario C: Cross-repo switch (normalized score leadership)

```
Two repos: atlas-frontend (A), appone-backend (B).

12:00  Working in A. Score_A=30, EMA_A≈1.0, dynamicMax_A=30.
12:05  Open B, start coding.

12:05:00  Tick 1: B dynamics. B score=46.5, dynamicMax=87, norm=0.53.
          A: no activity. score=29, norm=0.97.
          A(0.97) > B(0.53) → A is still leader ✓

12:05:30  Tick 2: B dynamics. B score=87(cap), norm=1.00.
          A: score=28, norm=0.93.
          B(1.00) > A(0.93) → B takes leadership!
          A: Pause { from: "12:05:30", to: null, source: "superseded" }
          A score continues decaying (NOT frozen, evaluator still sees it)

12:05:30 - 12:30  B is the leader. A is paused but still scored.

12:30  Return to A. Dynamics in A.
       A score was decaying: ≈0 (50 ticks of decay). dynamics → +activityPoints.
       A: EMA decayed during pause, dynamicMax ≈ 80. activityPoints ≈ 42.
       A score = 42, norm = 42/80 = 0.53.
       B: no dynamics. score ≈ 40 (decaying from 87), norm = 40/87 = 0.46.
       A(0.53) > B(0.46) → A reclaims leadership!
       A pause closed: { from: "12:05:30", to: "12:30:00" }

12:30+  A is the leader again. B decays → IdleTimeout eventually.

Result:
  A logged: 12:00-12:05:30 active, 12:05:30-12:30 paused(superseded), 12:30+ active
  B logged: startedAt=12:05:30 (promoted from Pending), 12:05:30-12:30 active, 12:30+ paused
  Overlap: 0 sec (B was Pending until it became leader, A was paused from that moment)
```

### Scenario D: Stray touch in inactive repo

```
Developer is actively working in repo A (leader, score=30, norm=1.0).
Accidentally saves a file in repo B.

Tick 0: dynamics in B (1 line)
  B: score = 46.5, dynamicMax = 87, norm = 0.53
  A: score = 29, norm = 0.97
  A(0.97) > B(0.53) → A is still leader
  B stays Pending (not promoted — A has higher normalizedScore)

No more activity in B:
  B score decays: 46.5 → 45.5 → ... → 0 at tick 47
  B closed as Pending on score=0 or checkout

Result: stray save didn't steal leadership from A.
Session B remained Pending → excluded from report.
```

### Scenario E: Commit then continue coding

```
Developer is coding, commits, then continues.

Tick N:   dynamics (last edit before commit)
  Score: ~30 (heavy coder, EMA≈1.0)

Tick N+1: git add . && git commit
  git diff --numstat: 0/0 (clean tree)
  delta: addedDelta = 0-50 = -50 → hasDynamics = TRUE
  reflog: new commit → hasCommit = TRUE

  Score: 30 + ~20 (activityPoints with magnitude) + 5 (COMMIT_BONUS) = ~55, cap 30 → 30
  (Still at cap, no penalty from commit)

Tick N+2: start coding again → dynamics
  diff: +3/+1, delta: +3/+1 → hasDynamics = TRUE
  Score: 30 + 15 = 45, cap 30 → 30

Tick N+2 (alternative: no new coding):
  diff: 0/0, delta: 0/0 → hasDynamics = FALSE
  Score: 30 - 1 = 29
  Normal decay begins

Conclusion: commit itself is an activity signal (double boost). Score doesn't drop.
Transition is seamless whether developer continues or stops.
```

### Scenario F: Autopause disabled (reading/thinking)

```
Developer returns from lunch, wants to read code for a while.

13:00  workday resume → all pauses closed
13:00  workday autopause off → autopause disabled for all sessions
       Status shows: "⚠ autopause disabled (since 13:00)"

13:00-14:30  Developer reads code, no git changes.
       Score: 0 (no activity). But AutoPause suppressed.
       Sessions remain active. Time is logged.

14:30  Developer starts coding → dynamics appear
       Score: 0 + activityPoints
       workday autopause on → re-enable normal behavior
```

### Scenario G: Very slow coder with 60s poll interval

```
diffPollSeconds = 60. Developer makes changes every 15 min.

Derived constants:
  MIN_TIMEOUT_TICKS = 15 * 60 / 60 = 15 ticks
  MAX_TIMEOUT_TICKS = 45 * 60 / 60 = 45 ticks
  EMA_ALPHA = 1 / (10 * 60 / 60) = 1/10 = 0.10
  ATTENTION_STEAL_TICKS = 120 / 60 = 2 ticks

Gap between dynamics: 15 ticks (15 min at 60s/tick).

Steady-state EMA: α / (1 - (1-α)^15) = 0.10 / (1 - 0.90^15) ≈ 0.13
dynamicMaxScore = 45 - 30 × 0.13 = 41.1 ticks
activityPoints = 41.1 × 0.5 × 1.07 (small change) ≈ 22.0

Score after dynamics: +22.0
After 15 idle ticks: 22.0 - 15 = 7.0 (survives the gap ✓)

After stopping (final dynamics):
  Score ≈ 35-41 → timeout = 35-41 ticks × 60s = 35-41 min ✓
  Within [15, 45] range ✓
```

---

## 11. Edge Cases <a name="edge-cases"></a>

### Crash recovery

On daemon restart, `ActivityEvaluator` has no in-memory state.
All sessions start with score=0, EMA=0. Existing open sessions:
- If next poll has dynamics → treated like cold start (generous timeout)
- If no dynamics → score=0 → AutoPause on first tick

This is acceptable: a crash means we lost state anyway. Quick auto-pause
followed by auto-resume on activity is the safest behavior.

### Day boundary

All sessions closed by `ClosedBy.DayBoundary`. Evaluator state wiped.
New day starts completely fresh.

### Rapid repo switching (ping-pong)

Developer alternates between repo A and B every minute (frontend + backend of same task).
Leadership shifts by normalized score: whoever is coding right now is the leader.
Superseded pauses are created and closed at each switch.

If the task is the same (ATL-123 in both repos) — overlaps don't affect the final report,
because the report groups time by task, not by repo.

### Three repos

The leader is always the single session with the highest normalized score:

A: Active → Superseded (B overtook) → stays Active(paused)
B: Pending → Active (became leader) → Superseded (C overtook)
C: Pending → Pending → Active (became leader)

### Rebase / merge dynamics

A rebase can generate large diff dynamics (100+ lines) that are not real development.
Currently handled by existing classification (reflog type = 'other').

Future improvement: detect `.git/rebase-merge/` directory and suppress dynamics
during rebase. Not part of current algorithm.

### Session in Pending state

Pending sessions accumulate score in the evaluator but don't track time.
They compete for leadership through normalized score comparison.

A Pending session transitions to Active when it becomes the leader.
Until then, it stays Pending regardless of how much dynamics it receives.

Pending sessions are closed by:
- Checkout to another branch → ClosedBy.CheckoutOtherTask
- Day boundary → ClosedBy.DayBoundary
- Never became Active → excluded from report (no time tracked)

---

## 12. Constants Summary <a name="constants-summary"></a>

### Configurable (in config.json → session)

| Field | Default | Description |
|-------|---------|-------------|
| `diffPollSeconds` | 30 | Polling interval. Algorithm adapts to any value. |
| `idleTimeoutMinutes` | 20 | NOT used directly by adaptive algorithm. Kept for future simple-mode fallback. |

### Algorithm constants (hardcoded in ActivityEvaluator)

| Constant | Value | Rationale |
|----------|-------|-----------|
| `MIN_TIMEOUT_MINUTES` | 15 | Minimum practical work session detection |
| `MAX_TIMEOUT_MINUTES` | 45 | Maximum patience for very slow but steady coding |
| `EMA_WINDOW_MINUTES` | 10 | Memory of ~15 min, forgets after ~30 min idle |
| `ACTIVITY_RATIO` | 0.5 | One dynamics = 50% of timeout window (before magnitude bonus) |
| `MAGNITUDE_SCALE` | 7 | log2(128): 127+ lines/tick = maximum magnitude bonus (×1.5) |
| `MAGNITUDE_BONUS_MAX` | 0.5 | Max extra multiplier for large changes (activityPoints × 1.0–1.5) |
| `COMMIT_BONUS_SECONDS` | 150 | Commit adds ~2.5 min of buffer |
| `BASE_DECAY` | 1 | Always 1 per tick (adaptation via maxScore, not decay rate) |

### Contract (TypeScript)

```typescript
interface ActivitySignals {
  readonly hasDynamics: boolean;
  readonly hasCommit: boolean;
  readonly deltaMagnitude: number;  // |addedDelta| + |removedDelta|
}

interface TickInput {
  readonly sessionId: string;
  readonly signals: ActivitySignals;
  readonly autoPauseDisabled: boolean;
  // Note: manually paused sessions are NOT sent to evaluator at all (full freeze)
}

interface EvaluatorResult {
  readonly scores: Map<string, SessionScore>;
  readonly leaderId: string | null;  // session with highest normalized score, null if all scores=0
}

interface SessionScore {
  readonly score: number;
  readonly maxScore: number;
  readonly normalizedScore: number;  // score / maxScore (0..1)
  readonly ema: number;
  readonly isIdleTimeout: boolean;   // score == 0
}

class ActivityEvaluator {
  constructor(diffPollSeconds: number);
  processAllTicks(ticks: readonly TickInput[]): EvaluatorResult;
  removeSession(sessionId: string): void;
}
```
