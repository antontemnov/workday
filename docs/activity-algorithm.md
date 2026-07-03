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
- **Predictable stamina**: every gain is small and tied to observable work — a single
  keystroke buys a fixed small leash, only sustained frequency and volume fill the bar,
  and reaching 100% is intentionally hard
- **No pause noise**: any touch guarantees a multi-minute leash (touch floor),
  never "1 line = 1 minute"
- **Behavior-change pause detection**: drain is asymmetric — the denser the
  recent work, the faster the buffer cools after an abrupt stop (full Normal
  bar fades in ~30 min, not 45), but the boost never breaches the touch floor —
  the floor minutes are guaranteed at any EMA
- **Cross-repo awareness**: only one repo can hold attention at a time; leadership
  follows a short attention window, independent of how full the bars are
- **Time-unit independence**: algorithm works correctly regardless of `diffPollSeconds` value

---

## 2. Constants & Time Independence <a name="constants"></a>

**All algorithm constants are expressed in human-readable time units (minutes, seconds).**
Tick-based values are derived at `ActivityEvaluator` construction time.

### Source constants (time-based)

The repo's **sensitivity** sets a single knob — the max timeout / stamina ceiling
(`SENSITIVITY_TIMEOUTS`). The touch floor is *derived* from it
(`× STAMINA_FLOOR_RATIO = 1/4`), there is no separate min constant:

| Sensitivity | max (ceiling) | derived touch floor |
|-------------|---------------|---------------------|
| `low` | 15 min | 3.75 min |
| `normal` (default) | 45 min | 11.25 min |
| `patient` | 90 min | 22.5 min |
| `always_on` | 45 min (idle timeout ignored) | 11.25 min |

| Constant | Value | Unit | Description |
|----------|-------|------|-------------|
| `STAMINA_FLOOR_RATIO` | 1/4 | — | Touch floor as a fraction of the ceiling |
| `EMA_WINDOW_MINUTES` | 10 | min | Frequency EMA smoothing window |
| `ATTENTION_WINDOW_MINUTES` | 2 | min | Attention EMA window (cross-repo leadership) |
| `COMMIT_BONUS_SECONDS` | 240 | sec | Extra score from a commit (in timeout equivalent) |
| `FREQUENCY_GAIN_MAX` | 2 | — | Frequency gain per active tick at EMA = 1 |
| `STAMINA_LINES_PER_MINUTE` | 8 | lines | Churn worth +1 score/min (→ 4 lines per 30s tick) |
| `VOLUME_GAIN_MAX` | 8 | — | Cap on the volume gain per tick |
| `DECAY_BOOST` | 2 | — | Extra drain per idle tick × EMA (asymmetric fade, never breaches the floor) |
| `IN_PLACE_CHURN_LINES` | 8 | lines | Line-equivalent per file rewritten in place (flat diff numbers, changed content hash) |
| `CHURN_MAX_FILES` | 100 | files | Churn scanner cap: max files read/hashed per tick |
| `CHURN_MAX_FILE_BYTES` | 2 MB | bytes | Churn scanner cap: oversized files skipped (binaries too) |

### Derived constants (tick-based)

All computed from `diffPollSeconds` (config value, default 30):

```
tickSeconds = config.session.diffPollSeconds

MAX_TICKS           = sensitivity.max * 60 / tickSeconds
FLOOR_TICKS         = MAX_TICKS * STAMINA_FLOOR_RATIO
EMA_ALPHA           = 1 / (EMA_WINDOW_MINUTES * 60 / tickSeconds)
ATTENTION_ALPHA     = 1 / (ATTENTION_WINDOW_MINUTES * 60 / tickSeconds)
COMMIT_BONUS        = COMMIT_BONUS_SECONDS / tickSeconds
LINES_PER_GAIN_TICK = STAMINA_LINES_PER_MINUTE * tickSeconds / 60   // 4 at 30s
```

### Derivation table for different `diffPollSeconds` (normal sensitivity)

| Config | MAX_TICKS | FLOOR_TICKS | EMA_ALPHA | ATTENTION_ALPHA | COMMIT_BONUS |
|--------|-----------|-------------|-----------|-----------------|--------------|
| 15s    | 180       | 45          | ~0.025    | 0.125           | 16           |
| 30s    | 90        | 22.5        | ~0.05     | 0.25            | 8            |
| 45s    | 60        | 15          | ~0.075    | 0.375           | ~5           |
| 60s    | 45        | 11.25       | ~0.10     | 0.5             | 4            |

The timeout range [11.25, 45] minutes is preserved regardless of tick duration.

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

## 4. Stamina Score Model <a name="adaptive-max"></a>

The score is a **stamina buffer**: ticks remaining until auto-pause, and the
value behind the Stamina bar (`normalizedScore = score / MAX_TICKS`). The
ceiling is fixed at `MAX_TICKS`; what varies is how fast the buffer fills —
small, explicit gains tied to observable work.

### Score update per tick

```
if (hasActivity):                          // dynamics or commit
  1. score = max(score, MAX_TICKS × STAMINA_FLOOR_RATIO)              // touch floor
  2. score += min(1, intensityEMA) × FREQUENCY_GAIN_MAX               // frequency gain
  3. score += min(VOLUME_GAIN_MAX, deltaMagnitude / LINES_PER_GAIN_TICK)  // volume gain
  4. if (hasCommit): score += COMMIT_BONUS
  5. score = min(score, MAX_TICKS)                                    // fixed ceiling

6. floor = MAX_TICKS × STAMINA_FLOOR_RATIO
   if (!hasActivity AND score > floor):
     score = max(floor, score - (1 + DECAY_BOOST × min(1, intensityEMA)))
     // asymmetric fade — the boost never breaches the floor, see below
   else:
     score = max(0, score - 1)             // active tick, or at/below the floor
7. if (score == 0): → AutoPause decision
```

### Touch floor

Any active tick lifts the score to at least `MAX_TICKS × STAMINA_FLOOR_RATIO`
(Normal: 45 / 4 = **11.25 min**, 25% of the bar). Two guarantees at once:

- a single keystroke can't jump the bar to half (old algorithm: one tick = ~52%)
- a single keystroke still buys a multi-minute leash — never "1 line = 1 minute
  to pause", so light work doesn't generate pause noise

### Frequency gain

`min(1, EMA) × FREQUENCY_GAIN_MAX` (max +2/tick) — rewards a sustained stream
of updates. With decay −1/tick, frequency alone outpaces decay once EMA > 0.5,
which takes ~7 minutes of tick-after-tick activity. Sporadic edits (EMA ≪ 0.5)
never climb on frequency alone — they hover at the floor.

### Volume gain

`min(VOLUME_GAIN_MAX, lines / LINES_PER_GAIN_TICK)` — linear in lines changed
within the tick, capped:

| Lines changed in tick | Volume gain | Net vs decay (−1) |
|----------------------|------------|--------------------|
| 1 | +0.25 | negative |
| 4 | +1.0 | breakeven |
| 8 | +2.0 | +1 |
| 12 | +3.0 | +2 |
| 24 | +6.0 | +5 |
| 32+ | +8.0 (cap) | +7 |

The cap means a bulk paste of a generated file is worth at most +8 — filling
the bar always requires *sustained* activity, never a single event.

### Asymmetric fade (pause detection)

Filling is slow and earned; draining is **behavior-change detection**. On idle
ticks **above the touch floor** the drain is `1 + DECAY_BOOST × EMA`: the denser
the recent activity, the faster the buffer cools once it stops. An abrupt silence
after tick-after-tick coding is the strongest pause signal there is — and the EMA
itself cools during the silence, so the drain relaxes back to 1/tick over ~10 minutes.

The boost is **shielded by the floor**: within one idle segment it can drain the
score down to the floor but never through it, and at/below the floor the drain
is always a plain 1/tick. So the guarantee "any touch buys the floor minutes
(Normal: 11.25 min) before a pause" holds at *any* EMA. Without the shield a hot
EMA (≈1) would drain a floor-level bar far faster, producing a storm of
pauses whenever an intense stream went quiet for a moment.

| State at stop (Normal) | Time to auto-pause |
|------------------------|--------------------|
| Full bar, EMA ≈ 1 (intense streak) | ~30 min (fast segment to the floor ~18 min + floor segment ~11 min) |
| Half bar, EMA ≈ 0.5 (moderate work) | ~18 min |
| Floor-level bar, EMA ≈ 1 (hot stream just started) | ~11 min (floor shield) |
| Floor after a single touch, EMA ≈ 0 | ~11 min |
| Patient, full bar, EMA ≈ 1 | ~71 min (a long walk-away is caught) |

Since drain is no longer constant, the auto-pause countdown is reported as
`etaTicks` (simulated fade), not as the raw score.

### Time to fill the bar (Normal sensitivity, 30s ticks)

| Work pattern | Bar behavior |
|--------------|--------------|
| Single touch | jumps to 25%, fades, pause ~11 min later |
| Sporadic 1-line edits every few minutes | hovers at ~25%, never climbs |
| Update every tick, 1–3 lines | saturates in ~30–40 min of continuity |
| Every tick, ~10 lines | saturates in ~13 min |
| Every tick, 32+ churn line-equivalents (cap) — typed, agent-rewritten or committed | saturates in ~5 min — still not instant |

---

## 5. Volume Component <a name="magnitude"></a>

Delta magnitude (line-equivalents churned) feeds the **volume gain**, not EMA.
EMA tracks frequency of activity (binary: active or not).
Volume tracks intensity of each activity event (how much churn happened).

### Churn source: per-file, three layers

`deltaMagnitude` is a per-file **churn** estimate in line-equivalents, never a
difference of summed totals:

1. **Per-file diff churn** — `|Δadded| + |Δremoved|` per file over the
   *evidence diff* (committed + staged + worktree vs the fresh merge-base;
   falls back to the plain worktree diff when no base exists). Because the
   diff is anchored at the merge-base, chunks that are committed immediately
   stay visible, and movement between files can't net out. A file *entering*
   the churn map counts whole; a file *leaving* counts its last known size
   (revert / re-anchor).
2. **Untracked files** — brand-new files are invisible to any git diff, so
   they're listed via `git ls-files --others --exclude-standard` (added to
   the same git batch) and read from disk: their line count is their "added".
   An agent dumping a 300-line new file registers 300 line-equivalents
   immediately. Binary and oversized (> `CHURN_MAX_FILE_BYTES` = 2 MB) files
   are skipped; the whole scan is capped at `CHURN_MAX_FILES` = 100 files
   per tick.
3. **Rewrite-in-place detection** — a file whose diff numbers are flat
   between ticks but whose content hash changed (the lines already differed
   from the base, so numstat can't see the rewrite) contributes
   `IN_PLACE_CHURN_LINES` = 8 line-equivalents. Hashes are computed only for
   flat files, so the cost is low; detection lags one tick the first time a
   file goes flat.

The gain formula in the evaluator is unchanged:
`min(VOLUME_GAIN_MAX, deltaMagnitude / LINES_PER_GAIN_TICK)` — at most +8 per
30s tick, reached at 32 churn line-equivalents.

### Why per-file churn, not netted totals?

The previous source was `|Δadded| + |Δremoved|` of the *summed worktree
numstat* between ticks. Netting totals was blind to: (a) rewrites of
already-modified lines (the numstat numbers don't move), (b) cross-file
movement (one file's +20 cancels another's −20), (c) untracked files (no
diff at all), (d) chunks committed immediately (they leave the worktree
diff). In practice an agent rewriting big pieces and committing each step
registered ~0 volume — the bar hovered near the floor during heavy
machine-speed work.

### Design: separation of concerns

| Metric | Contribution | Question it answers |
|--------|-------------|---------------------|
| EMA (binary) | frequency gain (max +2/tick) | "How often does the developer produce changes?" |
| Magnitude | volume gain (max +8/tick) | "How big are the changes when they happen?" |

Both feed the same stamina buffer additively, so the bar reflects *frequency ×
volume* — exactly the intuition "how intensely is this repo being worked on".

### Why linear with a cap (not log)?

The previous model used a logarithmic bonus (`log2(1+n)/7`, capped at ×1.5)
on top of a huge per-tick base (50% of the ceiling). Result: 1 line and 1000
lines were nearly indistinguishable, and any two active ticks saturated the
bar. The linear-with-cap volume gain makes the difference between 2 lines
(+0.5) and 12 lines (+3) visible, while the cap (32+ lines) prevents bulk
pastes from cheating the bar.

---

## 6. Cross-Repo Leadership <a name="leadership"></a>

### Principle

**Only one session can be the "leader" (actively tracking time) at any moment.**
The leader is determined by a dedicated **attention EMA** (2-minute window, binary
input like the frequency EMA) with takeover hysteresis — *not* by the stamina
score. Stamina is slow and hard to fill by design, so comparing stamina would
delay a repo handover by 5–10 minutes; attention follows the developer within
~2 minutes regardless of how full the bars are.

### Mechanism

```
Each processAllTicks() call:
  1. Update score and attention EMA for ALL sessions (except manually paused)
  2. Candidates = sessions with score > 0
  3. The current leader keeps the lead until a challenger's attention exceeds
     it by more than ATTENTION_ALPHA (= one isolated touch's contribution)
  4. Without a defending leader: highest attention wins
     (normalizedScore as tiebreak)
  5. All other sessions with score > 0: paused (PauseSource.Superseded)
  6. Sessions with score == 0: paused (PauseSource.IdleTimeout)

Important: non-leader sessions are NOT frozen in the evaluator.
  Their scores continue to update (accumulate on activity, decay on idle).
  This allows them to compete and overtake the current leader.
```

### Why hysteresis?

A single active tick bumps attention by exactly `ATTENTION_ALPHA` (0.25 at 30s
ticks). The takeover margin is the same value, so **one stray save can never
steal leadership by construction** — even if the current leader has been idle
for a while. A genuine switch (old repo idle, new repo active tick after tick)
crosses the margin within ~4–5 ticks (~2 min at 30s polls).

When both repos sit idle, attention EMAs decay proportionally, so their order —
and the leader — stays stable (no flapping).

### Multiple repos with activity (same tick)

If two repos both have dynamics in the same tick, both attention EMAs grow
equally and the hysteresis keeps the current leader (rare edge case — usually
the frontend/backend of the same task anyway).

### PauseSource

```typescript
enum PauseSource {
  Manual = 'manual',           // workday pause
  IdleTimeout = 'idle_timeout', // score reached 0
  Superseded = 'superseded',   // another session has higher normalized score
  TeamsAway = 'teams_away',    // Phase 3
}
```

### Key difference from previous designs

| | AttentionSteal (v0) | Normalized score (v1) | Attention EMA (v2, current) |
|---|---|---|---|
| Detection | consecutiveActiveTicks counter | stamina score crossover | dedicated 2-min EMA |
| Handover speed | 2 min (hard threshold) | fast only because one tick gave 50% of the bar | ~2 min, independent of bar fullness |
| Stray-touch immunity | threshold-based | norm < leader's norm | impossible by construction (margin = one touch) |
| Stability when idle | — | decays from higher value | proportional decay, order preserved |

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
  `startedAt` is not yet set. Promotion requires score > 0 AND leadership.
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
  2. the session is the leader (attention EMA, see §6)

  startedAt = now
  state = Active
  Time tracking begins
```

**Both conditions are required.** A session with score = 0 cannot become the leader,
even if it's the only session. This prevents promoting "empty" sessions.

For single-repo setups: first dynamics → score > 0 → only session → leader → Active.
For multi-repo: session may stay Pending while another session leads, accumulating
attention until it takes over.

### Normal operation (Active session)

```
Each tick:
  1. Update frequency EMA and attention EMA (binary: activity=1, idle=0)
  2. On activity: touch floor, frequency gain, volume gain, commit bonus,
     cap at MAX_TICKS
  3. Apply decay (1 on active ticks; 1 + DECAY_BOOST × EMA on idle ticks
     above the floor — never through the floor; 1/tick at/below it)
  4. Pick the leader (attention EMA with takeover hysteresis, §6)
  5. If still leader → continue tracking time
  6. If score == 0 → IdleTimeout pause
  7. If a challenger took over → Superseded pause
```

### Auto-pause: IdleTimeout (score == 0)

```
On IdleTimeout (Active session, score reached 0):
  Pause record: PauseSource.IdleTimeout
  Evaluator continues processing (score updates, EMA decays)
  Resume: when dynamics/commit arrives → score > 0 → may become leader again
```

### Idle auto-close + trailing trim (honest session end)

```
An open IdleTimeout pause older than config session.idleCloseHours
(default 3, 0 disables) closes the session: ClosedBy.IdleTimeout.
Checked at the start of every daemon tick — after a PC-sleep gap the stale
session closes before wake-up activity births a new one.

Every close path (checkout, rollover, stop, crash recovery, idle auto-close)
trims the trailing pause chain: session end = where the chain began (last
real activity), the chain is dropped from the record. Back-to-back pauses
(Superseded → IdleTimeout transition) trim as one chain. A closed trailing
pause (activity followed it) is never trimmed. Effective duration is
unchanged — trimmed pauses were already subtracted.

Manual pause is exempt from auto-close (a frozen session waits for the
user) but its trailing chain is trimmed on close like any other.
New activity after an auto-close births a fresh session (lazy sessions).
```

### Observation gap (PC sleep / hibernate)

```
Timers do not fire while the machine sleeps: the evaluator never decays and
lastSeenAt never advances, so the first tick after wake-up would credit the
whole gap as work. The daemon tracks lastAliveAt (refreshed by the poll tick
and the 60s boundary timer) and checks it on both:

  gap = now − lastAliveAt > max(3 × diffPollSeconds, 120s)

On a gap:
  1. Every open UNPAUSED session gets a retroactive IdleTimeout pause at its
     own pre-gap lastSeenAt — the last moment work was actually observed.
     Already-paused sessions keep their pause (it spans the gap naturally);
     manual pauses are untouched.
  2. Candidates are dropped and evaluator state is cleared — the scores are
     pre-sleep leftovers; real activity re-earns both (touch floor).
  3. Idle auto-close runs immediately: gap ≥ idleCloseHours → the session
     closes right away with the honest end (last pre-sleep activity).

Net effect: a short lid-close (< idleCloseHours) is a pause inside the same
session, auto-resumed by activity; a night's sleep closes the session at the
pre-sleep end and morning activity births a new one. The gap check also runs
before rollover, so a sleep across the day boundary never closes sessions at
the wake-up moment. A backwards clock jump (NTP) only re-anchors lastAliveAt.
```

### Auto-pause: Superseded (lost leadership)

```
On Superseded (Active session, another session took over the attention lead):
  Pause record: PauseSource.Superseded
  Evaluator continues processing (score updates, EMA updates)
  Score may still be > 0 — session can compete and reclaim leadership
  Resume: when its attention crosses the takeover margin again → close pause
```

**Key: Superseded sessions are NOT frozen.** Their evaluator state keeps updating.
They can regain leadership by drawing the developer's attention back.

### Auto-resume

```
When a paused Active session becomes the leader again:
  Close the Pause record (set `to` timestamp)
  Session resumes tracking time

This happens naturally through the attention comparison.
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
    whatever stamina was left at pause time is the budget to start coding
    again (the frozen EMA also resumes, so the fade speed is preserved)
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

The stamina glasses fill and drain independently; **attention** (who is being
poured into right now) decides who tracks time:

```
Repo A (Active):  [████████░░]  attention≈1.0   "leader, tracking time"
Repo B (Pending): [░░░░░░░░░░]  attention=0     "accumulating, not tracking"

Developer switches to B (A goes idle, B active every tick):

Tick 1:  B att=0.25 vs A att=0.75+0.25 margin → A still leads
Tick 2:  B att=0.44 vs A att=0.56+0.25       → A still leads
Tick 4:  B att=0.68 vs A att=0.32+0.25=0.57  → B takes over!
         B: Pending → Active (startedAt = now, time tracking begins)
         A: Active → paused (Superseded)

Developer returns to A: symmetric, A reclaims within ~4 ticks.
```

### Why not explicit transfer?

We considered: "repo B gains → repo A loses (zero-sum budget)".

The leadership model is simpler: both glasses exist independently, and the
attention EMA decides who tracks time. No transfer, no redistribution —
natural competition through activity and decay.

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
Developer writes code with dynamics nearly every tick for 2 hours (10–15 lines/tick).

Phase 1: Working
  EMA → ~1.0 within ~10 min (binary input, activity every tick)
  Per-tick gain ≈ 2 (frequency) + 3–4 (volume) − 1 (decay) → net +4..5
  Score: from the 22.5-tick floor to the 90-tick cap in ~10-13 min, then capped
  (Agent-driven work behaves the same: per-file churn counts big rewrites,
  new files and immediately committed steps, so a Claude Code session
  saturates the bar just as fast as hand-typing.)

Phase 2: Lunch break starts (bar was full, EMA ≈ 1)
  Asymmetric fade: drain = 1 + 2×EMA ≈ 3/tick at first, relaxing as EMA
  cools and stopping at the floor (below it: always 1/tick)
  Score 90 → floor 22.5 in ~36 ticks, → 0 in ~59 ticks total
  AutoPause (IdleTimeout) ~30 min after the last edit —
  an abrupt stop after dense work fades faster than a sporadic one,
  but gently enough that a long think isn't mistaken for a break

Phase 3: Return from lunch (1 hour later)
  EMA during pause: 1.0 × (1-0.05)^120 ≈ 0.002 (fully decayed)
  First dynamics → AutoResume, score = floor 22.5 (+ small gains) ≈ 11 min leash
  The bar rebuilds as the stream of edits resumes
```

### Scenario B: Light coding (1 line every 15 min)

```
Developer reads code and makes occasional small changes.
Gap between dynamics: 30 ticks (15 min) — longer than the 22.5-tick floor.

Each touch:
  score = floor 22.5 (+ ~0.3 gains) → decays to 0 in ~22 ticks
  → IdleTimeout ~11 min after the touch
  → auto-resume at the next touch

With Normal sensitivity this style logs ~11 min per touch with pauses
between. That's by design: 15 idle minutes between one-line edits are
mostly not work. If for this repo they ARE work (research-heavy code),
switch the repo to Patient: floor = 90/4 = 22.5 min — every gap up to
22.5 min is then covered, and the session stays continuous.
```

### Scenario C: Cross-repo switch (attention leadership)

```
Two repos: atlas-frontend (A), appone-backend (B).

12:00  Working in A. attention_A ≈ 1.0, bar at ~60%.
12:05  Switch to B, start coding (A goes idle).

Tick 1: B att = 0.25 vs A att 0.75 + 0.25 margin → A still leads ✓
Tick 2: B att = 0.44 vs A att 0.56 + 0.25       → A still leads
Tick 4: B att = 0.68 vs A att 0.32 + 0.25 = 0.57 → B takes leadership!
        (~2 min after the switch)
        B: Pending → Active (startedAt = now)
        A: Pause { source: "superseded" }, score keeps decaying (not frozen)

12:30  Return to A → symmetric: A reclaims within ~4 ticks,
       A pause closed, B → Superseded → decays → IdleTimeout eventually.

Result:
  A logged: 12:00-12:07 active, 12:07-12:32 paused(superseded), 12:32+ active
  B logged: startedAt=12:07 (promoted from Pending), active until 12:32
  Overlap: 0 sec
```

### Scenario D: Stray touch in inactive repo

```
Developer is actively working in repo A (leader, attention ≈ 1.0).
Accidentally saves a file in repo B.

Tick 0: dynamics in B (1 line)
  B: score = floor 22.5 (bar 25%), attention = 0.25
  A: attention ≈ 1.0 → challenger needs > 1.25 — impossible
  A stays leader; B stays Pending

Even if A had been idle for a few minutes, a single touch bumps attention
by exactly the takeover margin — it can never exceed it. Stray saves are
structurally unable to steal leadership.

No more activity in B:
  B score decays: 15 → 14 → ... → 0 at tick ~15
  B closed as Pending on score=0 or checkout → excluded from report
```

### Scenario E: Commit then continue coding

```
Developer is coding (bar ~50%, score ≈ 45), commits, then continues.

Tick N+1: git add . && git commit
  Worktree diff: 0/0 (clean tree) → worktree totals swing → hasDynamics = TRUE
  Evidence diff (vs merge-base) is unchanged by the commit →
  per-file churn magnitude ≈ 0 (committing is not new churn)
  reflog: new commit → hasCommit = TRUE

  Score: 45 + 2 (frequency) + 0 (volume) + 8 (COMMIT_BONUS) − 1 ≈ 54
  Commit visibly tops up the bar, never drops it.

Tick N+2 (no new coding yet):
  no churn, no totals movement → hasDynamics = FALSE → normal decay, score 53
  Plenty of leash to think about the next step.
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
       Score: floor + gains, bar rebuilds
       workday autopause on → re-enable normal behavior
```

### Scenario G: 60s poll interval (time-unit independence)

```
diffPollSeconds = 60, Normal sensitivity.

Derived constants:
  MAX_TICKS = 45 * 60 / 60 = 45 ticks
  FLOOR_TICKS = 45 / 4 = 11.25 ticks (= 11.25 min, same as with 30s polls ✓)
  EMA_ALPHA = 1/10 = 0.10
  ATTENTION_ALPHA = 1/2 = 0.5

A touch buys the same 11.25 minutes; the ceiling is the same 45 minutes;
filling the bar requires the same lines-per-minute intensity (the volume
divisor is per tick, and ticks are twice as long). All time guarantees
are preserved regardless of tick duration.
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

A rebase can generate large diff dynamics (100+ lines) that are not real
development. The volume cap (`VOLUME_GAIN_MAX` = 6) limits the stamina impact
of any single burst to a few ticks.

Evidence counters (commits / lines on the session) are rebase-stable by
construction: they're computed against the *fresh* merge-base with the default
branch each tick, with a baseline-delta per session (see session-tracker).
Squash, amend, drop, and cherry-pick don't corrupt them either — commits are
accumulated from positive jumps of the branch commit count only.

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

### Algorithm constants (hardcoded in constants.ts)

| Constant | Value | Rationale |
|----------|-------|-----------|
| `SENSITIVITY_TIMEOUTS` | low 15 / normal 45 / patient 90 / always_on 45 min | The single per-level knob: stamina ceiling = max leash |
| `STAMINA_FLOOR_RATIO` | 1/4 | Touch floor = ceiling / 4 (Normal: 11.25 min) — no pause noise, no bar jump, rides out a think gap unaided |
| `EMA_WINDOW_MINUTES` | 10 | Frequency memory of ~15 min, forgets after ~30 min idle |
| `ATTENTION_WINDOW_MINUTES` | 2 | Leadership follows the developer within ~2 min |
| `FREQUENCY_GAIN_MAX` | 2 | A sustained every-tick stream outpaces decay on its own |
| `STAMINA_LINES_PER_MINUTE` | 8 | 8 lines/min = +1 score per tick; breakeven at 4 lines per 30s tick |
| `VOLUME_GAIN_MAX` | 8 | Bulk pastes capped — filling the bar requires sustained activity |
| `IN_PLACE_CHURN_LINES` | 8 | Line-equivalent for a file rewritten in place (flat numstat, changed content hash) |
| `CHURN_MAX_FILES` | 100 | Churn scan cap per tick (file reads/hashes) |
| `CHURN_MAX_FILE_BYTES` | 2 MB | Oversized/binary files contribute no churn |
| `COMMIT_BONUS_SECONDS` | 240 | Commit adds ~4 min of buffer — committing every few minutes while prepping a review branch shouldn't pause |
| `BASE_DECAY` | 1 | Drain on active ticks and at/below the floor |
| `DECAY_BOOST` | 2 | Idle drain above the floor = 1 + 2×EMA, never through the floor — dense coders cool down faster than sporadic ones, but gently (full Normal bar ≈ 30 min) so a think gap isn't read as a break |

### Contract (TypeScript)

```typescript
interface ActivitySignals {
  readonly hasDynamics: boolean;
  readonly hasCommit: boolean;
  readonly deltaMagnitude: number;  // per-file churn line-equivalents
                                    // (evidence diff + untracked + in-place, see §5)
}

interface TickInput {
  readonly sessionId: string;
  readonly signals: ActivitySignals;
  readonly maxTicks: number;            // sensitivity ceiling in ticks
  readonly ignoreIdleTimeout: boolean;  // always_on
  // Note: manually paused sessions are NOT sent to evaluator at all (full freeze)
}

interface EvaluatorResult {
  readonly scores: Map<string, SessionScore>;
  readonly leaderId: string | null;  // attention leader (see §6), null if all scores=0
}

interface SessionScore {
  readonly score: number;
  readonly maxScore: number;         // = maxTicks
  readonly normalizedScore: number;  // score / maxScore (0..1) — the Stamina bar
  readonly ema: number;
  readonly etaTicks: number;         // ticks to auto-pause (simulated asymmetric fade)
  readonly isIdleTimeout: boolean;   // score == 0
}

class ActivityEvaluator {
  constructor(diffPollSeconds: number);
  processAllTicks(ticks: readonly TickInput[]): EvaluatorResult;
  removeSession(sessionId: string): void;
}
```
