# Workday — Lightweight Activity Tracker & Timesheet Tool

## Vision

Лёгкий кроссплатформенный daemon на Node.js, который:
- Тихо собирает рабочую активность в фоне (git, Jira, Teams)
- Накапливает данные в ежедневные JSON-файлы
- В конце дня предлагает review и push в Tempo
- При старте нового дня предупреждает о незапушенных данных
- Без тяжёлого UI (CLI + system notifications), UI — в будущем

```
         ┌──────────────────────────────────────────────┐
         │              WORKDAY DAEMON                   │
         │                                              │
         │  ┌───────────┐ ┌───────────┐ ┌────────────┐ │
         │  │    Git     │ │   Jira    │ │   Teams    │ │
         │  │ Collector  │ │ Collector │ │ Collector  │ │
         │  └─────┬─────┘ └─────┬─────┘ └─────┬──────┘ │
         │        └──────┬──────┘──────────────┘        │
         │               ▼                              │
         │        ┌─────────────┐                       │
         │        │  Aggregator │ (merge, deduplicate)  │
         │        └──────┬──────┘                       │
         │               ▼                              │
         │     ┌──────────────────┐                     │
         │     │  Daily Log Store │ → JSON per day      │
         │     └──────────────────┘                     │
         │               │                              │
         │     ┌─────────┴──────────┐                   │
         │     │  Day Boundary      │                   │
         │     │  Detector          │                   │
         │     │  → unpushed warn   │                   │
         │     └────────────────────┘                   │
         └──────────────────────────────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
     ┌────────────────┐    ┌──────────────┐
     │  CLI (review,  │    │ Tempo Push   │
     │  edit, status) │    │ (confirmed   │
     │                │    │  → pushed)   │
     └────────────────┘    └──────────────┘
```

---

## Core Principles

1. **Git = source of truth.** Ветка с именем разработчика + git diff dynamics + коммиты — главный и достаточный механизм трекинга. Всё остальное (Jira, Teams) — обогащение.
2. **JSON файлы — хранилище.** Читаемые, grep'аемые, git-diffable. Atomic writes для надёжности. Никаких баз данных.
3. **Update in place.** Активная сессия обновляется на месте (endedAt, evidence counters). Один файл на день, один rewrite за tick. Чисто и предсказуемо.
4. **Log everything, filter at review.** Daemon пишет максимум данных. Фильтрация (minSession, minConfidence) — только при отчёте/push.
5. **Human-in-the-loop.** Daemon собирает, но только человек подтверждает и пушит.
6. **Graceful degradation.** Jira недоступна? Работаем на git. Teams не настроен? Игнорируем. Каждый collector независим.
7. **Git diff dynamics = primary signal.** Не "есть ли изменения", а "меняются ли изменения". Дельта между snapshots — главный индикатор активного кодирования.
8. **No timeouts, no auto-close.** Сессия закрывается только явным сигналом (другая задача, конец дня, manual stop). Изучение кода без изменений — валидная работа, просто с низким confidence.
9. **Zero mandatory deps.** Только Node.js + TypeScript. Никаких native modules, Electron, базы данных.
10. **Cross-platform.** Никаких OS-specific API. Только git CLI + HTTP APIs.

---

## Project Structure

```
workday/
├── src/
│   ├── daemon.ts                   # Daemon entry point (poll loop)
│   ├── cli.ts                      # CLI interface (start/stop/status/review)
│   │
│   ├── collectors/
│   │   ├── git-tracker.ts          # git diff --stat dynamics + reflog reader
│   │   ├── jira-poller.ts          # Jira "In Progress" query (Phase 2)
│   │   └── teams-poller.ts         # Teams presence API (Phase 3)
│   │
│   ├── core/
│   │   ├── session-tracker.ts      # Session state machine (IDLE/ACTIVE per repo)
│   │   ├── confidence.ts           # Confidence scoring (computed at review time)
│   │   ├── day-boundary.ts         # Detect day changes, manage warnings
│   │   ├── daily-log.ts            # Read/write daily session log files (atomic)
│   │   ├── config.ts               # Load & validate config.json + secrets.json
│   │   └── types.ts                # Shared types and interfaces
│   │
│   └── push/
│       └── tempo-pusher.ts         # Tempo API integration (session-aware)
│
├── legacy/
│   ├── timesheet.mjs              # Old timeline-based algorithm (kept for reference)
│   └── tempo-push.mjs             # Old push script (kept for reference)
│
├── tsconfig.json
├── package.json                    # tsx for dev, tsc for build
├── config.json                     # User settings (repos, signals, session params)
├── secrets.json                    # API tokens (gitignored)
│
└── data/
    └── 2026-02/
        ├── 02-12.json              # Daily session log for Feb 12
        ├── 02-13.json
        └── ...
```

---

## Day Start: Manual vs Automatic

### `workday start [task]`
User explicitly marks the start of the workday:
```
$ workday start
Day started at 14:23. Watching for activity...

$ workday start ATL-6466
Day started at 14:23 on ATL-6466. Watching for activity...
```

Записывает точный timestamp в daily log как `manualStart`.

### Priority chain for day start
```
1. workday start           → exact user timestamp (strongest signal)
2. Jira "In Progress"      → first transition of the day (Phase 2)
3. First git activity      → first session.startedAt of the day
```

No config fallback — day start is always derived from actual events.

---

## Daemon Lifecycle

### Startup
```
1. Load config.json + secrets.json
2. Validate repos exist on disk
3. Check data/ for unpushed days (status != "pushed")
4. If unpushed days exist:
   → Print warning: "3 unpushed days (Feb 10, 11, 12). Run `workday review`."
5. Initialize session tracker (IDLE state for all repos)
6. Start poll loop (every config.session.diffPollSeconds)
7. Start day boundary timer (every 60s)
8. Write PID file
9. Register graceful shutdown (SIGINT/SIGTERM)
```

### Poll Loop (single loop, multiple checks)

Every 30 seconds (configurable). Each repo tracked **independently**.

```
for each repo in config.repos:
  1. snapshot = git status --porcelain + git diff --numstat (one batched shell call)
     → tracked changes: lines added/removed per file
     → untracked files: count of ?? entries
  2. branch = parse from git rev-parse --abbrev-ref HEAD (included in batch)
  3. if branch doesn't contain developer name → skip (not my branch)
  4. task = extractTask(branch)

  5. compare snapshot with previousSnapshot[repo]:
     → trackedDelta: changes in added/removed lines (tracked files)
     → untrackedDelta: change in count of ?? files (new files created/removed)
     → hasDynamics = trackedDelta != 0 || untrackedDelta != 0

  6. read reflog since lastReflogPosition → detect new commits/checkouts
     → if new checkout to own branch → open PENDING session
     → if new commit → record signal, promote PENDING → ACTIVE

  7. update session state:
     → if no session exists for this repo+task → create PENDING
     → if PENDING + hasDynamics → promote to ACTIVE
     → if PENDING + commit → promote to ACTIVE
     → if ACTIVE + hasDynamics → update endedAt, increment evidence
     → if ACTIVE + no dynamics → update endedAt only (still active, user may be reading)

  8. previousSnapshot[repo] = snapshot
  9. flush daily log to disk (atomic write)
```

**Batched git call** (one process spawn per repo):
```bash
git -C /repo rev-parse --abbrev-ref HEAD && git -C /repo diff --numstat && echo "---" && git -C /repo status --porcelain
```

**Cost**: ~80ms per repo per poll (one process spawn). Two repos = ~160ms every 30s. Negligible.

### Day Boundary Detection
```
setInterval (every 60s):
  if computeWorkingDate(now) !== currentDate:
    → close all active sessions (closedBy: "day_boundary")
    → flush today's log to disk
    → notify: "Yesterday: ATL-6466 5h, ATL-6810 3h."
    → start fresh day
    → reset session states to IDLE
```

Uses `computeWorkingDate()` — so 03:30 AM still counts as "yesterday".

### Shutdown
```
1. Close all active sessions (closedBy: "daemon_stop")
2. Clear poll interval
3. Flush today's log to disk
4. Remove PID file
```

---

## Daily Log Format: `data/2026-02/02-12.json`

```json
{
  "date": "2026-02-12",
  "status": "draft",
  "dayType": "workday",
  "manualStart": "2026-02-12T14:23:00",
  "sessions": [
    {
      "id": "a1b2c3d4",
      "repo": "atlas-frontend",
      "task": "ATL-6466",
      "branch": "ATL-6466-atemnov-implement-fees",
      "state": "active",
      "startedAt": "2026-02-12T14:23:00",
      "endedAt": "2026-02-12T19:30:00",
      "closedBy": "checkout_other_task",
      "evidence": {
        "commits": 4,
        "dynamicsHeartbeats": 67,
        "totalSnapshots": 102,
        "reflogEvents": 8
      }
    },
    {
      "id": "e5f6g7h8",
      "repo": "atlas-frontend",
      "task": "ATL-6810",
      "branch": "ATL-6810-atemnov-fix-credit",
      "state": "active",
      "startedAt": "2026-02-12T19:30:00",
      "endedAt": "2026-02-12T23:00:00",
      "closedBy": "day_boundary",
      "evidence": {
        "commits": 3,
        "dynamicsHeartbeats": 45,
        "totalSnapshots": 70,
        "reflogEvents": 5
      }
    },
    {
      "id": "f9g0h1i2",
      "repo": "appone-backend",
      "task": "ATL-6810",
      "branch": "ATL-6810-atemnov-fix-credit-api",
      "state": "pending",
      "startedAt": "2026-02-12T17:00:00",
      "endedAt": "2026-02-12T23:00:00",
      "closedBy": "day_boundary",
      "evidence": {
        "commits": 0,
        "dynamicsHeartbeats": 0,
        "totalSnapshots": 60,
        "reflogEvents": 1
      }
    }
  ],
  "signals": [
    { "ts": 1739368800, "type": "diff_dynamics", "repo": "atlas-frontend", "delta": { "added": 8, "removed": 2 } },
    { "ts": 1739369000, "type": "commit", "repo": "atlas-frontend", "task": "ATL-6466" },
    { "ts": 1739372400, "type": "checkout", "repo": "appone-backend", "task": "ATL-6810" }
  ],
  "confirmedAt": null,
  "pushedAt": null,
  "note": ""
}
```

### Почему per-day файлы, а не per-month
- Можно открыть один файл и понять один день
- Git diff показывает изменения по дням
- Нет проблемы concurrent writes (daemon пишет сегодня, user ревьюит вчера)
- Удалить/пересобрать один день — без риска для остальных

---

## CLI Interface: `workday`

```
workday daemon               # Start daemon (foreground)
workday daemon --background  # Start daemon (detach from terminal)
workday daemon stop          # Stop running daemon

workday start                # Mark start of workday (exact timestamp)
workday start ATL-6466       # Mark start + set initial task

workday status               # Show current month summary + unpushed warnings
workday today                # Show today's collected hours (live)
workday review               # Interactive review of all draft days
workday review 2026-02-12    # Review specific day
workday push                 # Push all confirmed days to Tempo (dry run)
workday push --commit        # Actually push to Tempo

workday recollect 2026-02-12 # Re-run collectors for a specific date (overwrites draft)
workday log 2026-02-12       # Show raw events for a day (debug)

workday autostart enable     # Register daemon for OS autostart
workday autostart disable    # Remove OS autostart registration
```

### `workday status` output

```
Workday — February 2026

  Date        Status     Hours  Tasks
  ──────────────────────────────────────────
  2026-02-10  ✓ pushed    8.5h  ATL-6466, ATL-6571
  2026-02-11  ✓ pushed   10.0h  ATL-6466
  2026-02-12  ● confirm   8.5h  ATL-6466, ATL-6810     ← needs review
  2026-02-13  ● draft     5.0h  ATL-6466               ← needs review
  2026-02-14  ○ today     2.5h  ATL-6811               ← collecting...
  ──────────────────────────────────────────
  Total pushed: 18.5h | Pending: 16.0h | Today: 2.5h

  ⚠ 2 days need review. Run `workday review`.
```

### `workday review` flow

```
──────────────────────────────────────────
2026-02-12 (Wednesday)       Status: draft
──────────────────────────────────────────

  Coding:
    ATL-6466  Implement Fees Tab         5.0h
    ATL-6810  Fix CustomerCredit         3.5h
                                     ────────
                                         8.5h
  Meetings:
    Sprint Planning                      1.0h
                                     ────────
  Total:                                 9.5h

  [C]onfirm  [E]dit hours  [S]kip  [N]ote  [Q]uit
  >
```

---

## Collectors Detail

### Git Tracker (Phase 1 — primary)

**Three responsibilities in one batched shell call per repo:**

**1. Branch detection** — `git rev-parse --abbrev-ref HEAD`
```
Filter: only developer's branches (contains developer name from secrets.json)
Edge case: detached HEAD during rebase → use last known branch context
```

**2. Tracked file dynamics** — `git diff --numstat`
```
Input:  per-file line counts (added/removed)
Output: aggregate delta between snapshots → dynamics heartbeat

Example:
  snapshot[t-1]: total +32 -10 across 5 files
  snapshot[t]:   total +45 -15 across 5 files
  delta:         +13 -5 → DYNAMICS HEARTBEAT (active coding)
```

**3. Untracked file dynamics** — `git status --porcelain` (filtered to `??` lines)
```
Input:  count of untracked files (new components, test files)
Output: delta in count between snapshots → dynamics heartbeat

Example:
  snapshot[t-1]: 3 untracked files
  snapshot[t]:   5 untracked files
  delta:         +2 → DYNAMICS HEARTBEAT (creating new files)
```

**4. Reflog reader** — `git reflog` (read since last known position)
```
Input:  append-only reflog
Output: commit and checkout events with timestamps and tasks

Reuses existing parseReflogEntries + extractTask logic from legacy timesheet.mjs.
Detects: commits (→ promote PENDING to ACTIVE), checkouts (→ open PENDING)
```

**All batched in one shell call** (~80ms per repo):
```bash
git -C /repo rev-parse --abbrev-ref HEAD && \
git -C /repo diff --numstat && \
echo "---SEP---" && \
git -C /repo status --porcelain && \
echo "---SEP---" && \
git -C /repo reflog -20 --date=iso --format="%gd %gs"
```

### Jira Poller (Phase 2 — on-demand, not continuous)

**NOT a continuous poller.** Jira is queried only:
1. At daemon start / day start → fetch "In Progress" issues assigned to me
2. Once per hour → refresh "In Progress" set (status changes are rare)
3. At review time → enrich sessions with issue summaries

Key query:
```sql
assignee = currentUser() AND status = "In Progress"
```

If a task in "In Progress" matches an active session's task → confidence +0.15.
If a new "In Progress" appears and a matching branch exists → open session.

### Teams Presence (Phase 3 — enrichment)

Poll `GET /me/presence` every 2 min:
- Available/Busy → at computer (confidence boost)
- Away → no action (breaks are normal)
- Offline → close all sessions

Teams call records for meeting tracking (separate category from coding).

---

## Work vs Personal: Как отличить рабочий день

### Три уровня фильтрации

**Уровень 1: Repo whitelist (уже работает)**
Daemon трекает только repos из config. Pet-project в `D:/projects/my-cool-app` — невидим.
Это главный и достаточный фильтр.

**Уровень 2: Work calendar**
Config определяет рабочие дни:
```json
{
  "workDays": [1, 2, 3, 4, 5],
  "holidays": ["2026-01-01", "2026-03-08", "2026-05-01"]
}
```

Активность в нерабочие дни собирается, но помечается:
```json
{
  "date": "2026-02-08",
  "dayType": "weekend",
  "status": "draft",
  ...
}
```

При `workday review` выходной день получает особый промпт:
```
⚠ 2026-02-08 is SUNDAY
  ATL-6466  3.0h

  This is a non-working day. Options:
  [L]og as overtime    — push to Tempo
  [S]kip               — don't push (keep in log as "skipped")
  [M]ove to Friday     — attribute to previous workday (2026-02-06)
```

**Уровень 3: Branch ownership (уже работает)**
Только ветки с `atemnov` в имени считаются рабочими.
Checkout на чужую ветку → task = null → время не считается.

### dayType values
- `workday` — обычный рабочий день (Mon-Fri, не holiday)
- `weekend` — суббота/воскресенье
- `holiday` — праздничный день из config
- `overtime` — нерабочий день, но пользователь подтвердил логирование

---

## Autostart: `workday autostart`

### Команды
```
workday autostart enable    # Register for current platform
workday autostart disable   # Remove registration
workday autostart status    # Show current state
```

### Windows: VBS wrapper в Startup
Почему VBS: `node daemon.mjs` открывает console window. VBS скрывает его.

```
workday autostart enable
  → Creates: %APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/workday.vbs
```

Содержимое `workday.vbs`:
```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "node ""D:\projects\tools\workday\daemon.mjs""", 0, False
```

`0` = hidden window. Процесс запускается при логине, без видимого окна.

### Mac: LaunchAgent plist

```
workday autostart enable
  → Creates: ~/Library/LaunchAgents/com.workday.daemon.plist
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.workday.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>node</string>
        <string>/Users/dev/tools/workday/daemon.mjs</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

### Linux: systemd user service

```
workday autostart enable
  → Creates: ~/.config/systemd/user/workday.service
  → Runs: systemctl --user enable workday
```

```ini
[Unit]
Description=Workday Activity Daemon

[Service]
ExecStart=/usr/bin/node /home/dev/tools/workday/daemon.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

### Implementation: platform detection

```typescript
import { platform } from 'node:os';

interface AutostartStrategy {
  enable(): void;
  disable(): void;
  status(): boolean;
}

function getAutostartStrategy(): AutostartStrategy {
  switch (platform()) {
    case 'win32':  return new WindowsStartupFolder();
    case 'darwin': return new MacLaunchAgent();
    case 'linux':  return new LinuxSystemdUser();
    default:       throw new Error(`Unsupported platform: ${platform()}`);
  }
}
```

---

## Technology Decisions

### TypeScript + tsx
- **TypeScript** for type safety — app is growing, types prevent bugs in session/signal logic
- **tsx** for development: `tsx src/daemon.ts` — zero config, instant startup
- **tsc** for production build: `tsc && node dist/daemon.js`
- Minimal tsconfig: strict mode, ESM output, Node 20+ target

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

### Why Node.js (not Go, Rust, Python)
- Already the stack — existing tools are .mjs, easy migration to .ts
- Excellent for I/O polling (event loop, non-blocking)
- Cross-platform without compilation
- `node-notifier` for system notifications (no native deps)
- Future UI: can integrate with web-based tray (e.g., menubar + simple HTML)

### Storage: JSON files with atomic writes

**Why NOT a database:**
- SQLite adds native dependency (not cross-platform without node-gyp)
- Elasticsearch is 100x overkill for a single-user app
- LevelDB/RocksDB = native deps
- JSON files are human-readable, grep-able, git-diffable

**Reliability: atomic write pattern:**
```typescript
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmpPath, filePath);  // atomic on same volume
}
```
- Crash during write → old file intact (tmp is incomplete)
- Crash after rename → new file intact
- Max data loss on crash: 30 seconds (one poll cycle)

**Update-in-place model:**
- Daily log = live object in daemon memory
- Each poll tick: update `session.endedAt`, increment evidence counters
- Flush to disk via atomic write every tick (30s)
- On session switch: close old session, open new one — same file, one rewrite
- No append-only log, no growing arrays of raw events per tick

**Signals array management:**
- Signals are appended during the day, but deduplicated by type+interval
- Consecutive `diff_dynamics` signals within 5 min → keep only first and last
- Commits and checkouts always kept (rare, high-value events)
- Typical day: ~50-200 signal entries, <50KB JSON

### Running as daemon
**Development**: `tsx src/daemon.ts` in terminal (foreground, Ctrl+C to stop)
**Production**: `node dist/daemon.js` (compiled)
**Background options** (zero extra deps):
- **Windows**: VBS wrapper to hide console window
- **Mac/Linux**: `nohup node dist/daemon.js &`
- **Cross-platform**: Simple PID file for start/stop management

No PM2, no forever, no systemd units. Just a Node process and a PID file:
```typescript
const PID_FILE = join(DATA_DIR, 'workday.pid');

if (existsSync(PID_FILE)) {
  const oldPid = readFileSync(PID_FILE, 'utf-8').trim();
  if (isProcessRunning(oldPid)) {
    console.error(`Daemon already running (PID ${oldPid})`);
    process.exit(1);
  }
}
writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => unlinkSync(PID_FILE));
```

### System notifications (no Electron)
```typescript
import notifier from 'node-notifier';

notifier.notify({
  title: 'Workday',
  message: 'Yesterday: ATL-6466 5h, ATL-6810 3h.\nRun `workday review` to confirm.',
  icon: join(SCRIPT_DIR, 'icon.png'),
});
```

Falls back to:
- Windows: PowerShell toast
- Mac: osascript notification
- Linux: notify-send

### Future UI (Phase 5+)
When CLI isn't enough:
- **Tauri** (Rust + webview): ~5MB binary, real native window. Best option.
- **menubar** (npm): Electron-lite, tray icon + small HTML popup. ~30MB.
- **Ink** (React for CLI): Rich terminal UI without leaving the console.

---

## Implementation Phases (Revised 2026-02-28)

### Phase 0: Timeline Algorithm ✅ (legacy, will be replaced by session tracking)
- ✅ Timeline-based computeHours
- ✅ Rebase/cherry-pick noise filtering
- ✅ Developer branch ownership filter
- ✅ Multi-repo timeline merge
- ✅ tempo-push --date filter

### Phase 1: Config + Session-Based Git Tracker (MVP)

**Goal**: Replace naive timeline merge with session-based tracking.
Primary signal: `git diff --stat` dynamics on developer's branches.

**Status (2026-02-28):** MVP complete. Daemon runs, tracks activity, writes daily logs.
- ✅ 1a. Config extraction
- ✅ 1b. Git snapshot tracker (4 classes: GitClient, ReflogParser, SnapshotParser, GitTracker)
- ✅ 1c. Session state machine (SessionTracker)
- ✅ 1d. Daily log format (atomic JSON writes)
- ✅ 1e. Daemon process (poll loop, day boundary, PID, shutdown)
- ✅ 1f. CLI commands (daemon / daemon --background / daemon stop)
- ⬜ 1f-cli. CLI commands: start, pause/resume, status, today
- ⬜ 1f-live. Live dashboard in foreground mode
- ⬜ 1g. Confidence computation
- ⬜ 1h. Overlap resolution

**Decisions (2026-02-28):**
- `dayType` is metadata only — no algorithms depend on it until Phase 4 (review/push)
- `workDays`/`holidays` are stubs for future calendar integration (Outlook/Teams)
- Day start: manualStart → first session.startedAt (no config fallback)
- Pauses stored per-session (`pauses: Pause[]`), full freeze during pause (no endedAt/evidence/signals updates)
- Pause/resume is manual only for now; auto-resume deferred
- Duration formula: `(endedAt - startedAt) - totalPauseDuration`

#### 1a. Config extraction
- Create `config.json` — move repos, taskPattern out of code
- Keep `secrets.json` for tokens only (already gitignored)
- All scripts read config.json, no more hardcoded paths

```json
{
  "repos": [
    "D:/projects/atlas-frontend",
    "D:/projects/appone-backend"
  ],
  "taskPattern": "ATL-\\d+",
  "genericBranches": ["develop", "main", "master", "HEAD"],
  "session": {
    "diffPollSeconds": 30,
    "minSessionMinutes": 15,
    "minConfidence": 0.3
  },
  "report": {
    "roundToHalfHour": true
  },
  "workDays": [1, 2, 3, 4, 5],
  "holidays": []
}
```

#### 1b. Git snapshot tracker (core mechanism)

The daemon polls git state every N seconds for each repo independently.
Uses `git status --porcelain` + `git diff --numstat` for complete picture.

**Two types of dynamics detected:**

1. **Tracked file dynamics** — `git diff --numstat` delta between snapshots:
   - Lines added/removed changed → active coding
   - Strongest confidence signal

2. **Untracked file dynamics** — `git status --porcelain` `??` entry count:
   - New files appearing/disappearing → creating new components/tests
   - Good signal, but weaker than tracked dynamics (files may be generated)

**What constitutes "dynamics":**
```
previousSnapshot = { trackedLines: { added: 32, removed: 10 }, untrackedCount: 3 }
currentSnapshot  = { trackedLines: { added: 45, removed: 15 }, untrackedCount: 4 }
delta            = { addedDelta: +13, removedDelta: +5, untrackedDelta: +1 }
hasDynamics      = true (any delta != 0)
```

**Batched in one shell call** per repo (~80ms):
```bash
git -C /repo rev-parse --abbrev-ref HEAD && git -C /repo diff --numstat && echo "---SEPARATOR---" && git -C /repo status --porcelain
```

**Git state edge cases:**
- During rebase/merge: `HEAD` is detached → preserve previous branch context from last known state
- During stash: diff drops to 0, unstash = burst → treat stash/unstash as single event, not dynamics
- Index.lock present: git commands may fail → skip tick, retry next cycle

#### 1c. Session state machine (per repo, three states)

```
                    ┌────────────────────────────────────────┐
                    │          PER-REPO STATE MACHINE         │
                    │     (repos are fully independent)       │
                    └────────────────────────────────────────┘

    ┌────────┐   checkout to    ┌───────────┐   dynamics or   ┌──────────┐
    │  IDLE  │──────────────────│  PENDING   │────────────────│  ACTIVE  │
    │        │   own branch     │ conf = 0   │   commit       │ conf > 0 │
    └────────┘                  └───────────┘                 └──────────┘
         ▲                           │                             │
         │     checkout to           │  day boundary               │ day boundary
         │     non-own branch        │  workday stop               │ workday stop
         │     workday stop          │  checkout to other task     │ checkout to other task
         └───────────────────────────┘                             │   (→ new PENDING)
         └─────────────────────────────────────────────────────────┘

IDLE:
  - No session for this repo
  - Watching for checkout to developer's branch

PENDING (confidence = 0):
  - Session exists with startedAt timestamp
  - No evidence of actual work yet (no dynamics, no commits)
  - Could be: studying code, reading PR, just checked out branch
  - At review time: shown separately → "2h on ATL-6173, no code changes. Include?"

ACTIVE (confidence > 0):
  - At least one dynamics heartbeat or commit recorded
  - endedAt updated every tick
  - evidence counters incrementing

PENDING → ACTIVE promotion:
  - Any tracked/untracked dynamics detected
  - Any commit on this branch
  - Once promoted, never goes back to PENDING (only to IDLE)

Repos are NEVER preempted by other repos.
All sessions logged independently. Overlap resolved at report time.
```

**Crash recovery:**
- On startup: read today's log file
- If session has no `closedBy` → resume (ACTIVE if has evidence, PENDING if not)
- First tick after restart = baseline snapshot (no dynamics generated)
  to avoid false positive from null → current delta

#### 1d. Daily log format (session-based)

Log everything. Filter at report/push time.

```json
{
  "date": "2026-02-27",
  "status": "draft",
  "sessions": [
    {
      "id": "a1b2c3",
      "repo": "atlas-frontend",
      "task": "ATL-6173",
      "branch": "ATL-6173-atemnov-integrate-reminders",
      "state": "active",
      "startedAt": "2026-02-27T14:23:00",
      "endedAt": "2026-02-27T20:15:00",
      "closedBy": "day_boundary",
      "evidence": {
        "commits": 5,
        "dynamicsHeartbeats": 89,
        "totalSnapshots": 142,
        "reflogEvents": 12
      }
    },
    {
      "id": "d4e5f6",
      "repo": "appone-backend",
      "task": "ATL-6870",
      "branch": "ATL-6870-atemnov-fix-busy",
      "state": "pending",
      "startedAt": "2026-02-27T16:00:00",
      "endedAt": "2026-02-27T20:15:00",
      "closedBy": "day_boundary",
      "evidence": {
        "commits": 0,
        "dynamicsHeartbeats": 0,
        "totalSnapshots": 50,
        "reflogEvents": 1
      }
    }
  ],
  "signals": [
    { "ts": 1740660180, "type": "diff_dynamics", "repo": "atlas-frontend", "delta": { "added": 13, "removed": 5 } },
    { "ts": 1740660210, "type": "commit", "repo": "atlas-frontend", "task": "ATL-6173" },
    { "ts": 1740660900, "type": "diff_snapshot", "repo": "atlas-frontend", "added": 45, "removed": 15, "files": 5 }
  ]
}
```

**Session `state` field:**
- `"pending"` — checkout happened, no dynamics/commits yet (confidence = 0)
- `"active"` — at least one dynamics heartbeat or commit (confidence > 0)
- `"closed"` — session ended (has `closedBy`)

Open sessions (no `closedBy`) are resumed on daemon restart.

#### 1e. Daemon process
- Poll loop every 30 seconds (configurable)
- For each repo: check branch → git diff --stat → compare → log
- Check reflog for new commits/checkouts (read since last position)
- Day boundary detection (same as before)
- PID file for start/stop management
- Graceful shutdown: flush today's log

#### 1f. CLI commands (Phase 1 scope)
```
workday daemon               # Start daemon (foreground)
workday daemon --background  # Detach
workday daemon stop          # Stop
workday start [task]         # Mark start of workday
workday stop                 # Mark end of workday (close all sessions)
workday status               # Month summary
workday today                # Today's sessions (live)
```

#### 1f-live. Live dashboard in foreground mode

In foreground mode, daemon renders an inplace-updating dashboard to stdout
using native Node.js `readline` API (cursorTo + clearScreenDown). Zero deps.
Redraws every poll tick (30s). Auto-disabled in `--background` mode (stdio detached).

```
Workday daemon ─ 2026-02-27 (Thu) ─ 16:42
──────────────────────────────────────────
ATL-6173  atlas-frontend    2.5h  ● active
ATL-6173  appone-backend    2.5h  ○ pending
──────────────────────────────────────────
Total: 5.0h                    Poll: 12s ago
```

**Implementation:**
- `process.stdout.isTTY` → enable/disable rendering
- `readline.cursorTo(process.stdout, 0, 0)` + `readline.clearScreenDown(process.stdout)`
- Data source: `SessionTracker.getOpenSessions()` + duration computed from `startedAt` to `now`
- Cost: one string concatenation per 30s tick — zero overhead

#### 1g. Confidence computation (at review/report time)

**PENDING sessions** always have confidence = 0.
**ACTIVE sessions** get confidence computed from evidence:

```
confidence = clamp(0..1):
  dynamicsRatio (heartbeats / snapshots) * 0.45   ← strongest weight
  commits:       min(count * 0.05, 0.20)
  reflogEvents:  min(count * 0.02, 0.10)
  sessionLength: if > 2h and dynamicsRatio > 0.3 → +0.10
  jiraInProgress (Phase 2): +0.15
```

| Scenario                                     | State   | ~Score | Verdict           |
|----------------------------------------------|---------|--------|-------------------|
| 4h, 60% dynamics, 5 commits                  | active  | ~0.90  | Auto-confirm      |
| 3h, 0% dynamics, 0 commits (studying)        | pending | 0      | Ask user at review|
| 3h, 0% dynamics, jira InProgress (Phase 2)   | pending | 0      | Ask user (Jira hint shown) |
| 6 min, 1 commit, minimal dynamics            | active  | ~0.15  | Quick fix, filter |
| 2h, 40% dynamics, 2 commits                  | active  | ~0.60  | Show, likely ok   |

**Report-time rules:**
- PENDING sessions: excluded from hours, shown separately → "Include Y/N?"
- ACTIVE below `minSessionMinutes` (15): excluded, shown as "quick fix"
- ACTIVE below `minConfidence` (0.3): included but flagged → "Low confidence, ok?"
- ACTIVE above `minConfidence`: included, auto-confirmed if > 0.7

#### 1h. Overlap resolution (at report time, not during collection)

When sessions from different repos overlap in time:
```
Repo A:  |-------- ATL-6173 --------|       (14:00 - 19:00)
Repo B:       |--- ATL-6870 ---|             (15:30 - 17:00)
Overlap:      |################|             (15:30 - 17:00 = 1.5h)
```

**Rules:**
1. If same task in both repos → merge (no double-counting)
2. If different tasks → split overlap proportionally by dynamics density
   - Repo A has 40 heartbeats in overlap, Repo B has 10 → A gets 75%, B gets 25%
3. If one is PENDING, other is ACTIVE → ACTIVE wins the overlap entirely
4. User can override at review time

This means collection is simple (independent per repo), and all the intelligence
is in the reporting layer — which can be tuned without re-collecting data.

---

### Phase 2: Jira Integration (lightweight)

**Not polling. On-demand only.**

When to query Jira:
1. **Day start**: fetch my "In Progress" issues → seed initial task context
2. **Hourly refresh**: check if "In Progress" set changed (max 1 req/hour)
3. **Review time**: enrich sessions with Jira summaries for display

Jira "In Progress" on a task + branch with my name exists = strong session opener.
This boosts confidence by +0.15 for matching sessions.

No continuous polling. Jira transitions happen 1-2 times per day.

### Phase 3: Teams Presence (optional enrichment)

Poll Teams presence API every 2 min (only while daemon running):
- Available/Busy → at computer, boost confidence +0.05 per check
- Away → no impact (coffee break is normal)
- Offline → close all active sessions

Also: Teams call records for meeting tracking (separate from coding).

### Phase 4: Review + Tempo Push (session-aware)
Rework `workday review` and `tempo-push` to work with session-based logs.
Confidence-based auto-confirm for high-confidence sessions.
Interactive review for low-confidence sessions.

### Phase 5: Tray UI
Tauri or menubar-based tray icon.
Click → show today's summary popup.
Quick confirm/push from tray menu.
Badge with unpushed day count.
