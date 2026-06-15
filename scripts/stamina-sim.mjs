// Stamina algorithm simulator + parameter search.
//
// Faithful, dependency-free re-implementation of the ActivityEvaluator tick
// loop (src/core/activity-evaluator.ts). Used to tune the scoring constants
// against realistic work patterns and to guard against regressions when the
// algorithm is touched.
//
//   node scripts/stamina-sim.mjs
//
// Design goal encoded in the loss function: a FALSE PAUSE (real work whose
// time goes unlogged) is strictly worse than a LATE pause (a few idle minutes
// logged). Pause-timing precision is secondary — 5 vs 15 min to a pause does
// not matter; pause NOISE during genuine pulsed/LLM work does.
//
// A companion visual playground lives at
// tray-app/design-preview/stamina-playground.html.

const TICK_SEC = 30;
const MIN = 2; // ticks per minute at 30s

// Constants currently SHIPPED in src/core/constants.ts. Keep in sync.
const SHIPPED = {
  EMA_WINDOW_MINUTES: 10, FREQUENCY_GAIN_MAX: 2, STAMINA_LINES_PER_MINUTE: 8,
  VOLUME_GAIN_MAX: 6, COMMIT_BONUS_SECONDS: 150, BASE_DECAY: 1, DECAY_BOOST: 2,
  STAMINA_FLOOR_RATIO: 1 / 4,
};
// The pre-tuning values, kept for the before/after comparison only.
const OLD_DEFAULTS = {
  EMA_WINDOW_MINUTES: 10, FREQUENCY_GAIN_MAX: 2, STAMINA_LINES_PER_MINUTE: 10,
  VOLUME_GAIN_MAX: 4, COMMIT_BONUS_SECONDS: 150, BASE_DECAY: 1, DECAY_BOOST: 4,
  STAMINA_FLOOR_RATIO: 1 / 6,
};

// ---- faithful single-session tick simulator ----
function simulate(params, maxTicksMin, ticks) {
  const {
    EMA_WINDOW_MINUTES, FREQUENCY_GAIN_MAX, STAMINA_LINES_PER_MINUTE,
    VOLUME_GAIN_MAX, COMMIT_BONUS_SECONDS, BASE_DECAY, DECAY_BOOST,
    STAMINA_FLOOR_RATIO,
  } = params;

  const maxTicks = maxTicksMin * 60 / TICK_SEC;
  const emaAlpha = 1 / (EMA_WINDOW_MINUTES * 60 / TICK_SEC);
  const linesPerGainTick = STAMINA_LINES_PER_MINUTE * TICK_SEC / 60;
  const commitBonus = COMMIT_BONUS_SECONDS / TICK_SEC;
  const floor = maxTicks * STAMINA_FLOOR_RATIO;

  let score = 0, ema = 0;
  const trace = [];
  for (const t of ticks) {
    const active = t.active;
    ema = emaAlpha * (active ? 1 : 0) + (1 - emaAlpha) * ema;
    if (active) {
      score = Math.max(score, floor);
      score += Math.min(1, ema) * FREQUENCY_GAIN_MAX;
      score += Math.min(VOLUME_GAIN_MAX, t.delta / linesPerGainTick);
      if (t.commit) score += commitBonus;
      score = Math.min(score, maxTicks);
    }
    if (!active && score > floor) {
      score = Math.max(floor, score - (BASE_DECAY + DECAY_BOOST * Math.min(1, ema)));
    } else {
      score = Math.max(0, score - BASE_DECAY);
    }
    trace.push({ score, ema, paused: score === 0, normalized: score / maxTicks });
  }
  return { trace, maxTicks, floor };
}

// ---- scenario builder ----
// seg(durationMin, period, delta, commit): active every `period` ticks.
//   period=1 -> duty 1.0 ; 2 -> 0.5 ; 3 -> 0.33 ; Infinity -> idle
function seg(durMin, period, delta = 0, commit = false) {
  const n = Math.round(durMin * MIN);
  const out = [];
  for (let i = 0; i < n; i++) {
    const active = period !== Infinity && i % period === 0;
    out.push({ active, delta: active ? delta : 0, commit: active && commit && i % period === 0 });
  }
  return out;
}
const idle = (m) => seg(m, Infinity);
const cat = (...xs) => [].concat(...xs);

function firstActive(ticks) { return ticks.findIndex(t => t.active); }

// ---- scenarios ----
// label 'work'  : must NOT pause anywhere after first activity (false pause = bad)
// label 'break' : has a trailing idle tail; must reach pause by end of tail.
function scn(name, label, ticks, idleStart) { return { name, label, ticks, idleStart }; }

const SCENARIOS = [
  // ---------- genuine work (must not pause) ----------
  scn('pulsed_light  (2m burst d.5 / 7m think) x5', 'work',
    cat(...Array.from({ length: 5 }, () => cat(seg(2, 2, 8), idle(7))))),
  scn('pulsed_heavy  (3m burst d.6 / 10m think) x4', 'work',
    cat(...Array.from({ length: 4 }, () => cat(seg(3, 2, 15), idle(10))))),
  scn('llm_paste     (paste150+commit / 9m think / 2m edits) x4', 'work',
    cat(...Array.from({ length: 4 }, () => cat(seg(0.5, 1, 150, true), idle(9), seg(2, 2, 8))))),
  scn('deep_think    (4m burst / 13m think / 4m burst)', 'work',
    cat(seg(4, 2, 12), idle(13), seg(4, 2, 12))),
  scn('slow_steady   (duty .33 small edits, 40m)', 'work',
    seg(40, 3, 6)),
  scn('llm_long_read (paste200+commit / 16m read / 3m edits) x3', 'work',
    cat(...Array.from({ length: 3 }, () => cat(seg(0.5, 1, 200, true), idle(16), seg(3, 2, 10))))),

  // ---------- real breaks (must pause by end) ----------
  scn('break_after_short (6m work, 40m idle)', 'break',
    cat(seg(6, 2, 8), idle(40)), 6 * MIN),
  scn('break_eod         (12m work, 60m idle)', 'break',
    cat(seg(12, 2, 10), idle(60)), 12 * MIN),
  scn('paste_then_leave  (paste150+commit, 40m idle)', 'break',
    cat(seg(0.5, 1, 150, true), idle(40)), Math.round(0.5 * MIN)),
  scn('warmup_then_leave (20m pulsing d.5, 60m idle)', 'break',
    cat(seg(20, 2, 12), idle(60)), 20 * MIN),
];

function evalScenario(params, level, s) {
  const { trace } = simulate(params, level, s.ticks);
  const warm = firstActive(s.ticks);
  if (s.label === 'work') {
    let falsePauses = 0, firstPauseMin = null;
    for (let i = warm + 1; i < trace.length; i++) {
      if (trace[i].paused) { falsePauses++; if (firstPauseMin === null) firstPauseMin = (i - warm) / MIN; }
    }
    return { falsePause: falsePauses > 0, firstPauseMin, peakNorm: Math.max(...trace.map(t => t.normalized)) };
  }
  let pauseIdx = -1;
  for (let i = s.idleStart; i < trace.length; i++) if (trace[i].paused) { pauseIdx = i; break; }
  let prefixPause = false;
  for (let i = warm + 1; i < s.idleStart; i++) if (trace[i].paused) { prefixPause = true; break; }
  const latencyMin = pauseIdx < 0 ? Infinity : (pauseIdx - s.idleStart) / MIN;
  return { paused: pauseIdx >= 0, latencyMin, prefixPause };
}

// ---- loss: asymmetric. false pause on work = catastrophic. ----
const W_FALSE_PAUSE = 100, W_FALSE_PAUSE_N = 80, W_MISS_BREAK = 25;
const W_LAT_OVER = 0.4, LAT_TARGET = 25, W_LAT_UNDER_FLOOR = 8;

function loss(params) {
  let L = 0;
  const detail = {};
  for (const s of SCENARIOS) {
    if (s.label === 'work') {
      const rel = evalScenario(params, 90, s);
      const nor = evalScenario(params, 45, s);
      if (rel.falsePause) L += W_FALSE_PAUSE;
      if (nor.falsePause) L += W_FALSE_PAUSE_N;
      detail[s.name] = { relPause: rel.falsePause, norPause: nor.falsePause, relPeak: +rel.peakNorm.toFixed(2) };
    } else {
      const rel = evalScenario(params, 90, s);
      if (rel.prefixPause) L += W_FALSE_PAUSE;
      if (!rel.paused) L += W_MISS_BREAK;
      else {
        if (rel.latencyMin > LAT_TARGET) L += (rel.latencyMin - LAT_TARGET) * W_LAT_OVER;
        if (rel.latencyMin < 6) L += W_LAT_UNDER_FLOOR;
      }
      detail[s.name] = { paused: rel.paused, latMin: rel.latencyMin === Infinity ? 'never' : +rel.latencyMin.toFixed(0), prefixPause: rel.prefixPause };
    }
  }
  return { L, detail };
}

// ---- parameter grid ----
const GRID = {
  EMA_WINDOW_MINUTES: [5, 10, 15],
  FREQUENCY_GAIN_MAX: [2, 3, 4, 5, 6],
  STAMINA_LINES_PER_MINUTE: [8, 10, 15],
  VOLUME_GAIN_MAX: [2, 3, 4, 6],
  COMMIT_BONUS_SECONDS: [60, 150, 300],
  BASE_DECAY: [1],
  DECAY_BOOST: [0, 0.5, 1, 1.5, 2, 3],
  STAMINA_FLOOR_RATIO: [1 / 6, 1 / 5, 1 / 4],
};

function* product(grid) {
  const keys = Object.keys(grid);
  const idx = keys.map(() => 0);
  while (true) {
    const o = {};
    keys.forEach((k, i) => o[k] = grid[k][idx[i]]);
    yield o;
    let p = keys.length - 1;
    while (p >= 0) { idx[p]++; if (idx[p] < grid[keys[p]].length) break; idx[p] = 0; p--; }
    if (p < 0) break;
  }
}

const fr = (x) => (Math.abs(x - 1 / 6) < 1e-9 ? '1/6' : Math.abs(x - 1 / 5) < 1e-9 ? '1/5' : Math.abs(x - 1 / 4) < 1e-9 ? '1/4' : x);
const fmtP = (p) => `ema=${p.EMA_WINDOW_MINUTES} freqMax=${p.FREQUENCY_GAIN_MAX} lpm=${p.STAMINA_LINES_PER_MINUTE} volMax=${p.VOLUME_GAIN_MAX} commit=${p.COMMIT_BONUS_SECONDS} boost=${p.DECAY_BOOST} floor=${fr(p.STAMINA_FLOOR_RATIO)}`;

// ---- run search ----
const best = [];
let count = 0;
for (const p of product(GRID)) { count++; best.push({ p, L: loss(p).L }); }
best.sort((a, b) => a.L - b.L);

console.log(`searched ${count} combos\n`);
console.log('=== SHIPPED (current src/core/constants.ts) ===');
console.log('loss =', loss(SHIPPED).L.toFixed(1), '|', fmtP(SHIPPED));
for (const [k, v] of Object.entries(loss(SHIPPED).detail)) console.log('   ', k, JSON.stringify(v));

console.log('\n=== TOP 8 PARAM SETS ===');
for (const { p, L } of best.slice(0, 8)) console.log('loss =', L.toFixed(1), '|', fmtP(p));

// ---- leash curves ----
function leashAfter(params, level, warmMin, period) {
  const { trace } = simulate(params, level, cat(seg(warmMin, period, 12), idle(300)));
  const start = warmMin * MIN;
  for (let i = start; i < trace.length; i++) if (trace[i].paused) return (i - start) / MIN;
  return Infinity;
}
function leashTable(params, label) {
  console.log(`\n=== ${label}: idle-to-pause leash (minutes) ===`);
  console.log('   level    1touch  10m@d.5  20m@d.5  20m@d1.0  paste+commit');
  for (const [lvl, lm] of [['Sharp', 15], ['Normal', 45], ['Relaxed', 90]]) {
    const pt = (() => {
      const { trace } = simulate(params, lm, cat(seg(0.5, 1, 150, true), idle(300)));
      const start = Math.round(0.5 * MIN);
      for (let i = start; i < trace.length; i++) if (trace[i].paused) return (i - start) / MIN;
      return Infinity;
    })();
    const f = (x) => (x === Infinity ? 'never' : x.toFixed(1)).padStart(6);
    console.log(`   ${lvl.padEnd(8)} ${f(leashAfter(params, lm, 0.5, 1))} ${f(leashAfter(params, lm, 10, 2))} ${f(leashAfter(params, lm, 20, 2))} ${f(leashAfter(params, lm, 20, 1))}  ${f(pt)}`);
  }
}
leashTable(OLD_DEFAULTS, 'OLD DEFAULTS (pre-tune)');
leashTable(SHIPPED, 'SHIPPED');
