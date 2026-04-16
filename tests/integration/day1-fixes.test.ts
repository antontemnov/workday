/**
 * Integration tests for Day-1 bug fixes.
 *
 * Run: npx tsx tests/integration/day1-fixes.test.ts
 * Exit code: 0 = all pass, 1 = any fail
 *
 * Creates temp git repos, swaps config, starts daemon, runs real git ops,
 * verifies all 6 fixes, cleans up.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Paths ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');
const CONFIG_PATH = join(PROJECT_ROOT, 'config.json');
const SECRETS_PATH = join(PROJECT_ROOT, 'secrets.json');
const DATA_DIR = join(PROJECT_ROOT, 'data');

// ─── Test config ─────────────────────────────────────────────────────────

const TEST_PORT = 19213;
const POLL_SECONDS = 5;
const DEDUP_SECONDS = 60;
const TEST_DIR = join(tmpdir(), `workday-test-${randomBytes(4).toString('hex')}`);
const REPO_ALPHA = join(TEST_DIR, 'repo-alpha');
const REPO_BETA = join(TEST_DIR, 'repo-beta');
const RESULTS_FILE = join(PROJECT_ROOT, 'tests', 'integration', 'test-results.txt');

// ─── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitPolls(n: number): Promise<void> {
  return sleep(n * POLL_SECONDS * 1000 + 2500);
}

function git(repoPath: string, args: string): string {
  return execSync(`git -C "${repoPath}" ${args}`, {
    encoding: 'utf-8',
    windowsHide: true,
  }).trim();
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`);
  const body = await res.json() as { ok: boolean; data: T; error?: string };
  if (!body.ok) throw new Error(`API ${path}: ${body.error}`);
  return body.data;
}

// ─── Daily log reader ────────────────────────────────────────────────────

let computeWorkingDateFn: ((ts: number, bh: number, tz: string) => string) | null = null;

interface LogSignal {
  readonly ts: number;
  readonly type: string;
  readonly repo: string;
  readonly delta?: { readonly added: number; readonly removed: number; readonly untracked?: number };
  readonly task?: string | null;
}

interface LogData {
  readonly signals: readonly LogSignal[];
  readonly sessions: readonly Record<string, unknown>[];
}

function readLog(): LogData | null {
  if (!computeWorkingDateFn) throw new Error('Config module not loaded');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date = computeWorkingDateFn(Date.now(), 4, tz);
  const [year, month, day] = date.split('-');
  const filePath = join(DATA_DIR, `${year}-${month}`, `${month}-${day}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8')) as LogData;
}

// ─── Test runner ─────────────────────────────────────────────────────────

interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly assertions: readonly AssertResult[];
  readonly error?: string;
}

interface AssertResult {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

const results: TestResult[] = [];

function assert(label: string, condition: boolean, detail?: string): AssertResult {
  return { label, passed: condition, detail: detail ?? (condition ? 'OK' : 'FAILED') };
}

function recordTest(name: string, assertions: AssertResult[], error?: string): void {
  const passed = !error && assertions.every(a => a.passed);
  results.push({ name, passed, assertions, error });
}

// ─── Setup / Teardown ────────────────────────────────────────────────────

let originalConfig: string = '';
let originalSecrets: string = '';
let daemon: { start: (opts?: { foreground?: boolean }) => Promise<void>; stop: () => Promise<void> } | null = null;
let testDate: string = '';

function setupTempRepos(): void {
  mkdirSync(REPO_ALPHA, { recursive: true });
  mkdirSync(REPO_BETA, { recursive: true });

  // repo-alpha: init with a tracked base file, then checkout test branch
  git(REPO_ALPHA, 'init');
  writeFileSync(join(REPO_ALPHA, 'base.txt'), 'alpha base\n');
  git(REPO_ALPHA, 'add .');
  git(REPO_ALPHA, 'commit -m "Init alpha"');
  git(REPO_ALPHA, 'checkout -b atemnov/ATL-9999-test');
  // Extra commit on test branch (for reflog test)
  writeFileSync(join(REPO_ALPHA, 'feature.txt'), 'feature code\n');
  git(REPO_ALPHA, 'add .');
  git(REPO_ALPHA, 'commit -m "ATL-9999 add feature"');

  // repo-beta: init with tracked base file, then checkout test branch
  git(REPO_BETA, 'init');
  writeFileSync(join(REPO_BETA, 'base.txt'), 'beta base\n');
  git(REPO_BETA, 'add .');
  git(REPO_BETA, 'commit -m "Init beta"');
  git(REPO_BETA, 'checkout -b atemnov/ATL-8888-test');
}

function swapConfig(): void {
  originalConfig = readFileSync(CONFIG_PATH, 'utf-8');
  originalSecrets = readFileSync(SECRETS_PATH, 'utf-8');

  const testConfig = {
    repos: [REPO_ALPHA, REPO_BETA],
    schedule: { start: 10, end: 4 },
    taskPattern: 'ATL-\\d+',
    genericBranches: ['develop', 'main', 'master', 'HEAD'],
    session: {
      diffPollSeconds: POLL_SECONDS,
      minSessionMinutes: 15,
      minConfidence: 0.3,
      signalDeduplicationSeconds: DEDUP_SECONDS,
      dayBoundaryCheckSeconds: 3600,
      reflogCount: 20,
    },
    report: { roundToHalfHour: true },
    workDays: [1, 2, 3, 4, 5, 6, 7],
    holidays: [],
    apiPort: TEST_PORT,
  };

  const testSecrets = {
    Developer: 'atemnov',
    Jira_Email: 'test@test.com',
    Jira_BaseUrl: 'https://test.atlassian.net',
    Jira_Token: 'test-token',
    Tempo_Token: 'test-token',
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2), 'utf-8');
  writeFileSync(SECRETS_PATH, JSON.stringify(testSecrets, null, 2), 'utf-8');
}

function restoreConfig(): void {
  if (originalConfig) writeFileSync(CONFIG_PATH, originalConfig, 'utf-8');
  if (originalSecrets) writeFileSync(SECRETS_PATH, originalSecrets, 'utf-8');
}

function cleanupDataDir(): void {
  if (!testDate) return;
  const [year, month, day] = testDate.split('-');
  const logPath = join(DATA_DIR, `${year}-${month}`, `${month}-${day}.json`);
  if (existsSync(logPath)) rmSync(logPath);
  const pidPath = join(DATA_DIR, 'workday.pid');
  if (existsSync(pidPath)) rmSync(pidPath);
}

function writeResults(): void {
  const lines: string[] = [];
  lines.push('=== Workday Day-1 Fixes Integration Tests ===');
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`Platform: ${process.platform}`);
  lines.push('');

  let totalA = 0;
  let passedA = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`[${r.passed ? 'PASS' : 'FAIL'}] Test ${i + 1}: ${r.name}`);
    if (r.error) lines.push(`  ERROR: ${r.error}`);
    for (const a of r.assertions) {
      lines.push(`  [${a.passed ? '+' : '-'}] ${a.label}: ${a.detail}`);
      totalA++;
      if (a.passed) passedA++;
    }
    lines.push('');
  }

  const allPassed = results.every(r => r.passed);
  lines.push('─'.repeat(50));
  lines.push(`Tests: ${results.filter(r => r.passed).length}/${results.length} passed`);
  lines.push(`Assertions: ${passedA}/${totalA} passed`);
  lines.push(`Result: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);

  const content = lines.join('\n');
  writeFileSync(RESULTS_FILE, content, 'utf-8');
  console.log(content);
}

// ─── Test Cases ──────────────────────────────────────────────────────────

/**
 * Test 1: Reflog parsing via GitClient (Fix 1: format escaping).
 *
 * Verifies the full reflog pipeline: GitClient.fetchRepoState() → ReflogParser → entries.
 * Uses GitClient directly (not execSync) to confirm that reflog output
 * is correctly formatted and parsed through the actual production code path.
 *
 * Also verifies source code no longer has platform-dependent %% escaping.
 */
async function test1_reflogParsing(): Promise<void> {
  const name = 'Reflog parsing via GitClient (Fix 1: format escaping)';
  try {
    const { GitClient } = await import('../../src/collectors/git-client.js');
    const { ReflogParser } = await import('../../src/collectors/reflog-parser.js');
    const client = new GitClient(20);
    const parser = new ReflogParser('ATL-\\d+');

    // Fetch via GitClient (production code path)
    const raw = await client.fetchRepoState(REPO_ALPHA);
    const reflogRaw = raw.reflog;
    const entries = parser.parseEntries(reflogRaw);

    const commitEntries = entries.filter(e => e.type === 'commit');
    const checkoutEntries = entries.filter(e => e.type === 'checkout');

    const assertions: AssertResult[] = [
      assert(
        'GitClient reflog output is non-empty',
        reflogRaw.length > 0,
        `${reflogRaw.length} chars`,
      ),
      assert(
        'Reflog contains HEAD@{ timestamp } format',
        /HEAD@\{\d{4}-\d{2}-\d{2}/.test(reflogRaw),
        reflogRaw.substring(0, 80),
      ),
      assert(
        'Parsed entries exist',
        entries.length > 0,
        `${entries.length} entries`,
      ),
      assert(
        'Commit entries found (>= 2: init + feature)',
        commitEntries.length >= 2,
        `${commitEntries.length} commits`,
      ),
      assert(
        'Commit timestamps are valid (> 0, not NaN)',
        commitEntries.every(e => e.ts > 0 && !isNaN(e.ts)),
        commitEntries.map(e => new Date(e.ts).toISOString()).join(', '),
      ),
      assert(
        'Checkout entry found (branch switch in setup)',
        checkoutEntries.length >= 1,
        `${checkoutEntries.length} checkouts`,
      ),
    ];

    // Verify task extraction from reflog commit message
    const featureCommit = commitEntries.find(e => e.message.includes('ATL-9999'));
    assertions.push(assert(
      'Feature commit message contains task key',
      !!featureCommit,
      featureCommit ? featureCommit.message : 'not found',
    ));

    if (featureCommit) {
      const task = parser.extractTaskFromMessage(featureCommit.message);
      assertions.push(assert(
        'Task extracted from commit message',
        task === 'ATL-9999',
        `task = ${task}`,
      ));
    }

    // Source code check: git-client.ts no longer has platform-dependent escaping
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'collectors', 'git-client.ts'), 'utf-8');
    assertions.push(assert(
      'git-client.ts has no platform-dependent %% escaping',
      !src.includes("'%%'") && !src.includes('process.platform'),
      !src.includes("'%%'") ? 'no %% found (fixed)' : '%% still present',
    ));

    recordTest(name, assertions);
  } catch (err) {
    recordTest(name, [], (err as Error).message);
  }
}

/**
 * Test 2: Signal dedup uses milliseconds (Fix 2: * 1000).
 *
 * The dedup window comparison is `signal.ts - prev.ts < dedup * 1000`.
 * Without the * 1000, millisecond timestamps would never be within the
 * seconds-based window, so every signal would be appended instead of accumulated.
 *
 * Uses tracked file modifications to produce addedDelta > 0.
 */
async function test2_signalDedupMilliseconds(): Promise<void> {
  const name = 'Signal dedup uses milliseconds (Fix 2: * 1000)';
  try {
    // Modify tracked file (base.txt committed in setup)
    writeFileSync(join(REPO_ALPHA, 'base.txt'), 'alpha base\nextra line 1\n');
    await waitPolls(1);

    // Count alpha diff_dynamics signals
    const log1 = readLog()!;
    const countBefore = log1.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha').length;

    // Modify tracked file again (within 60s dedup window)
    writeFileSync(join(REPO_ALPHA, 'base.txt'), 'alpha base\nextra line 1\nextra line 2\n');
    await waitPolls(1);

    const log2 = readLog()!;
    const countAfter = log2.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha').length;
    const alphaSignals = log2.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha');
    const lastSignal = alphaSignals[alphaSignals.length - 1];

    const assertions = [
      assert(
        'At least one alpha signal before second change',
        countBefore > 0,
        `countBefore = ${countBefore}`,
      ),
      assert(
        'Signal count unchanged after second change (deduped)',
        countAfter === countBefore,
        `before=${countBefore}, after=${countAfter}`,
      ),
      assert(
        'Last signal has accumulated added >= 2',
        (lastSignal?.delta?.added ?? 0) >= 2,
        `added = ${lastSignal?.delta?.added}`,
      ),
    ];

    // Source code check: daily-log.ts multiplies by 1000
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'daily-log.ts'), 'utf-8');
    assertions.push(assert(
      'daily-log.ts contains "deduplicationSeconds * 1000"',
      src.includes('deduplicationSeconds * 1000'),
      src.includes('deduplicationSeconds * 1000') ? 'found' : 'NOT FOUND',
    ));

    recordTest(name, assertions);
  } catch (err) {
    recordTest(name, [], (err as Error).message);
  }
}

/**
 * Test 3: Signal dedup is per-repo (Fix 3: backward search by repo).
 *
 * The backward search finds the last diff_dynamics for the SAME repo,
 * not just the globally last signal. This ensures interleaved signals
 * from different repos don't break deduplication.
 *
 * Sequence: alpha change → beta change → alpha change.
 * Alpha should dedup despite beta's signal in between.
 */
async function test3_signalDedupPerRepo(): Promise<void> {
  const name = 'Signal dedup is per-repo (Fix 3: backward search by repo)';
  try {
    const log0 = readLog()!;
    const alphaBefore = log0.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha').length;
    const betaBefore = log0.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-beta').length;

    // Alpha change: add another line to tracked file
    writeFileSync(join(REPO_ALPHA, 'base.txt'), 'alpha base\nextra line 1\nextra line 2\nextra line 3\n');
    await waitPolls(1);

    // Beta change: modify tracked file (interleaving signal from different repo)
    writeFileSync(join(REPO_BETA, 'base.txt'), 'beta base\nbeta extra 1\n');
    await waitPolls(1);

    // Alpha change again (within 60s dedup window)
    writeFileSync(join(REPO_ALPHA, 'base.txt'), 'alpha base\nextra line 1\nextra line 2\nextra line 3\nextra line 4\n');
    await waitPolls(1);

    const log1 = readLog()!;
    const alphaAfter = log1.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha').length;
    const betaAfter = log1.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-beta').length;

    // Last alpha signal should have accumulated deltas
    const alphaSignals = log1.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha');
    const lastAlpha = alphaSignals[alphaSignals.length - 1];

    const assertions = [
      assert(
        'Beta got a new signal (+1)',
        betaAfter === betaBefore + 1,
        `betaBefore=${betaBefore}, betaAfter=${betaAfter}`,
      ),
      assert(
        'Alpha signals deduped (count unchanged or +1 max)',
        alphaAfter <= alphaBefore + 1,
        `alphaBefore=${alphaBefore}, alphaAfter=${alphaAfter}`,
      ),
      assert(
        'Last alpha signal has accumulated added deltas',
        (lastAlpha?.delta?.added ?? 0) >= 2,
        `added = ${lastAlpha?.delta?.added}`,
      ),
    ];

    // Source code check: backward loop searching by repo
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'daily-log.ts'), 'utf-8');
    assertions.push(assert(
      'addSignal does backward search checking repo',
      src.includes('prev.repo !== signal.repo'),
      src.includes('prev.repo !== signal.repo') ? 'found' : 'NOT FOUND',
    ));

    recordTest(name, assertions);
  } catch (err) {
    recordTest(name, [], (err as Error).message);
  }
}

/**
 * Test 4: activatedAt field (Fix 4).
 *
 * startedAt is preserved as session creation time.
 * activatedAt is set when Pending → Active promotion happens.
 * These must be different timestamps.
 */
async function test4_activatedAtField(): Promise<void> {
  const name = 'activatedAt field (Fix 4: startedAt preserved, activatedAt set on promotion)';
  try {
    const today = await apiGet<{
      sessions: Array<{
        repo: string;
        state: string;
        startedAt: string;
        activatedAt: string | null;
        closedBy: string | null;
      }>;
    }>('/api/today');

    const alphaSession = today.sessions.find(s => s.repo === 'repo-alpha' && !s.closedBy);

    const assertions = [
      assert(
        'Alpha session exists and is open',
        !!alphaSession,
        alphaSession ? 'found' : 'not found',
      ),
      assert(
        'activatedAt is not null',
        alphaSession?.activatedAt != null,
        `activatedAt = ${alphaSession?.activatedAt}`,
      ),
      assert(
        'activatedAt !== startedAt (different timestamps)',
        alphaSession?.activatedAt !== alphaSession?.startedAt,
        `activatedAt=${alphaSession?.activatedAt}, startedAt=${alphaSession?.startedAt}`,
      ),
      assert(
        'activatedAt > startedAt (promoted later)',
        !!alphaSession && new Date(alphaSession.activatedAt!).getTime() > new Date(alphaSession.startedAt).getTime(),
        alphaSession ? `diff = ${new Date(alphaSession.activatedAt!).getTime() - new Date(alphaSession.startedAt).getTime()}ms` : 'N/A',
      ),
      assert(
        'state === "active"',
        alphaSession?.state === 'active',
        `state = ${alphaSession?.state}`,
      ),
    ];

    recordTest(name, assertions);
  } catch (err) {
    recordTest(name, [], (err as Error).message);
  }
}

/**
 * Test 5: Untracked in signal delta (Fix 5).
 *
 * DiffDynamicsSignal.delta includes `untracked` field from untrackedDelta.
 * Creating an untracked file changes the untracked count, generating dynamics.
 */
async function test5_untrackedInSignalDelta(): Promise<void> {
  const name = 'Untracked in signal delta (Fix 5: delta.untracked field)';
  try {
    // Create new untracked file (no git add) — changes untracked count
    writeFileSync(join(REPO_ALPHA, 'untracked-probe.tmp'), 'probe data\n');
    await waitPolls(1);

    const log = readLog()!;
    const alphaSignals = log.signals.filter(s => s.type === 'diff_dynamics' && s.repo === 'repo-alpha');
    const lastSignal = alphaSignals[alphaSignals.length - 1];

    const assertions = [
      assert(
        'Alpha diff_dynamics signals exist',
        alphaSignals.length > 0,
        `count = ${alphaSignals.length}`,
      ),
      assert(
        'delta.untracked field exists (not undefined)',
        lastSignal?.delta?.untracked !== undefined,
        `untracked = ${lastSignal?.delta?.untracked}`,
      ),
      assert(
        'delta.untracked is a number',
        typeof lastSignal?.delta?.untracked === 'number',
        `type = ${typeof lastSignal?.delta?.untracked}`,
      ),
    ];

    // Source code check: session-tracker logs untrackedDelta
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'session-tracker.ts'), 'utf-8');
    assertions.push(assert(
      'session-tracker.ts passes untrackedDelta to signal',
      src.includes('untrackedDelta'),
      src.includes('untrackedDelta') ? 'found' : 'NOT FOUND',
    ));

    recordTest(name, assertions);
  } catch (err) {
    recordTest(name, [], (err as Error).message);
  }
}

/**
 * Test 6: EMA precision (Fix 6: toFixed(2) instead of toFixed(1)).
 *
 * With 5s polls, emaAlpha = 1/120 ≈ 0.00833.
 * After 1 active tick, ema ≈ 0.00833.
 * toFixed(1) = "0.0" (invisible), toFixed(2) = "0.01" (visible).
 */
async function test6_emaPrecision(): Promise<void> {
  const name = 'EMA precision (Fix 6: toFixed(2) instead of toFixed(1))';
  try {
    const { ActivityEvaluator } = await import('../../src/core/activity-evaluator.js');
    const evaluator = new ActivityEvaluator(POLL_SECONDS);

    // Process 1 tick with activity
    const result = evaluator.processAllTicks([{
      sessionId: 'test-ema',
      signals: { hasDynamics: true, hasCommit: false, deltaMagnitude: 5 },
      autoPauseDisabled: false,
    }]);

    const score = result.scores.get('test-ema')!;
    const ema = score.ema;

    const assertions = [
      assert(
        'EMA > 0 after activity',
        ema > 0,
        `ema = ${ema}`,
      ),
      assert(
        'toFixed(1) === "0.0" (invisible with old precision)',
        ema.toFixed(1) === '0.0',
        `toFixed(1) = "${ema.toFixed(1)}"`,
      ),
      assert(
        'toFixed(2) !== "0.00" (visible with new precision)',
        ema.toFixed(2) !== '0.00',
        `toFixed(2) = "${ema.toFixed(2)}"`,
      ),
    ];

    // Source code check: status-renderer uses toFixed(2) for EMA
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'core', 'status-renderer.ts'), 'utf-8');
    assertions.push(assert(
      'status-renderer.ts uses toFixed(2) for EMA',
      src.includes('toFixed(2)'),
      src.includes('toFixed(2)') ? 'found' : 'NOT FOUND',
    ));
    assertions.push(assert(
      'status-renderer.ts does NOT use ema.toFixed(1)',
      !src.includes('ema.toFixed(1)'),
      !src.includes('ema.toFixed(1)') ? 'correct' : 'FOUND (should not be)',
    ));

    recordTest(name, assertions);
  } catch (err) {
    recordTest(name, [], (err as Error).message);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('=== Workday Day-1 Fixes Integration Tests ===\n');
  console.log(`Temp dir: ${TEST_DIR}`);
  console.log(`Test port: ${TEST_PORT}`);
  console.log(`Poll interval: ${POLL_SECONDS}s\n`);

  try {
    // 1. Setup temp repos (with tracked base files)
    console.log('[setup] Creating temp repos...');
    setupTempRepos();

    // 2. Swap config
    console.log('[setup] Swapping config...');
    swapConfig();

    // 3. Load config module after config swap
    const configModule = await import('../../src/core/config.js');
    computeWorkingDateFn = configModule.computeWorkingDate;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    testDate = configModule.computeWorkingDate(Date.now(), 4, tz);
    console.log(`[setup] Working date: ${testDate}`);

    // 4. Test 1 runs BEFORE daemon (direct git-client + reflog-parser test)
    console.log('\n[test 1] Reflog parsing on Windows...');
    await test1_reflogParsing();
    console.log(`  => ${results[results.length - 1].passed ? 'PASS' : 'FAIL'}\n`);

    // 5. Start daemon
    console.log('[setup] Starting daemon...');
    const { Daemon } = await import('../../src/daemon.js');
    const d = new Daemon();
    daemon = d;
    await d.start({ foreground: false });
    console.log('[setup] Daemon started.');

    // Wait for 2 baseline polls (sets previousSnapshot + opens Pending sessions)
    console.log('[setup] Waiting for baseline polls...');
    await waitPolls(2);

    // 6. Tests 2-6 (daemon is running)
    console.log('[test 2] Signal dedup uses milliseconds...');
    await test2_signalDedupMilliseconds();
    console.log(`  => ${results[results.length - 1].passed ? 'PASS' : 'FAIL'}\n`);

    console.log('[test 3] Signal dedup is per-repo...');
    await test3_signalDedupPerRepo();
    console.log(`  => ${results[results.length - 1].passed ? 'PASS' : 'FAIL'}\n`);

    console.log('[test 4] activatedAt field...');
    await test4_activatedAtField();
    console.log(`  => ${results[results.length - 1].passed ? 'PASS' : 'FAIL'}\n`);

    console.log('[test 5] Untracked in signal delta...');
    await test5_untrackedInSignalDelta();
    console.log(`  => ${results[results.length - 1].passed ? 'PASS' : 'FAIL'}\n`);

    console.log('[test 6] EMA precision...');
    await test6_emaPrecision();
    console.log(`  => ${results[results.length - 1].passed ? 'PASS' : 'FAIL'}\n`);

  } finally {
    // Teardown
    console.log('\n[teardown] Stopping daemon...');
    if (daemon) {
      try { await daemon.stop(); } catch { /* ignore */ }
    }

    console.log('[teardown] Restoring config...');
    restoreConfig();

    console.log('[teardown] Cleaning data dir...');
    cleanupDataDir();

    console.log('[teardown] Removing temp repos...');
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }

    // Write results to file
    writeResults();
    console.log(`\nResults written to: ${RESULTS_FILE}`);
  }

  const allPassed = results.every(r => r.passed);
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  restoreConfig();
  process.exit(1);
});
