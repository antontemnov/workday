# workday-daemon

Background daemon that tracks developer activity via git and pushes timesheets to Tempo.

Polls git repos every 30s, detects work sessions from diffs/reflog/commits, scores activity, and produces daily JSON logs. Supports multi-repo tracking with automatic leader election, adaptive idle timeouts, and manual time adjustments.

## Install

```bash
npm install -g workday-daemon
```

Requires Node.js 20+.

## Quick Start

```bash
workday init                  # creates ~/.workday/ with config templates
# edit ~/.workday/config.json — add repo paths
# edit ~/.workday/secrets.json — set Developer name
workday start                 # start background daemon
workday status                # check running sessions
workday today                 # full day summary
```

## Commands

```
workday init                           Initialize config in ~/.workday/
workday start                          Start daemon (background)
workday stop                           Stop daemon
workday status                         Show daemon status and sessions
workday today                          Today's summary
workday day YYYY-MM-DD                 Past day summary
workday pause [repo]                   Pause sessions
workday resume                         Resume paused sessions
workday autopause on|off [repo]        Toggle idle auto-pause
workday adjust <target> +N "reason"    Add manual time
workday set-start HH:MM               Set day start earlier
workday tempo                          Show report (month to date)
workday tempo --push                   Push to Tempo
workday daemon                         Run in foreground (live dashboard)
```

## Configuration

**~/.workday/config.json**

```json
{
  "repos": ["/path/to/repo-a", "/path/to/repo-b"],
  "dayBoundaryHour": 4,
  "taskPattern": "PROJ-\\d+",
  "genericBranches": ["develop", "main", "master"],
  "session": {
    "diffPollSeconds": 30,
    "signalDeduplicationSeconds": 300,
    "reflogCount": 20
  },
  "report": { "roundingMinutes": 15 },
  "workDays": [1, 2, 3, 4, 5]
}
```

**~/.workday/secrets.json**

```json
{
  "Developer": "your-git-username",
  "TempoToken": "",
  "JiraToken": "",
  "JiraBaseUrl": ""
}
```

Config can also live next to `package.json` for local development — the daemon checks there first before falling back to `~/.workday/`.

## How It Works

1. Polls `git diff --numstat`, `git status`, and `git reflog` for each repo
2. Filters branches by developer name
3. Computes diff deltas between snapshots (dynamics = actual keystrokes)
4. Manages session lifecycle: IDLE → PENDING → ACTIVE
5. Scores activity via EMA with adaptive idle timeout (15–45 min)
6. Elects a leader session across repos (highest score wins)
7. Writes atomic JSON logs to `~/.workday/data/YYYY-MM/MM-DD.json`
8. Day boundary detected automatically (default 4:00 AM)

## Data

Daily logs stored as JSON in `~/.workday/data/`. Sessions recover after crashes (up to 7 days lookback).

## License

MIT
