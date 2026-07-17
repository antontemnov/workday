# workday-daemon

Background daemon that tracks developer activity via git and pushes timesheets to Tempo.

Polls git repos every 30s, detects work sessions from diffs/reflog/commits, scores activity, and produces daily JSON logs. Supports multi-repo tracking with automatic leader election, adaptive idle timeouts, and manual log entries.

## Install

```bash
npm install -g workday-daemon
```

Requires Node.js 20+.

## Quick Start

```bash
workday init                  # creates ~/.workday/ with config templates
# edit ~/.workday/config.json — add repo paths, tracked Jira project keys,
#                               and (optionally) your branch-owner name(s)
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
workday log <task> <min> "<desc>"      Log manual time on a task
workday fav-add <task> <min> "<name>"  Add a favorite (reusable log template)
workday fav-remove <#|id>              Remove a favorite
workday fav-list                       List favorites
workday jira-search "<query>"          Live Jira issue search (key + summary)
workday session-delete <target>        Delete a junk session (add --date for past days)
workday tempo                          Show report (month to date)
workday tempo --push                   Push to Tempo
workday month [YYYY-MM]                Month view: day statuses vs Tempo
workday tempo-sync [YYYY-MM]           Refresh the month's Tempo snapshot (mirror pull)
workday tempo-import [YYYY-MM]         Adopt Tempo-only worklogs as local entries
workday schedule [YYYY-MM]             Tempo work schedule (required hours, holidays)
workday approval [YYYY-MM]             Tempo timesheet approval status
workday notifications                  Active desktop notifications (tray toasts)
workday notifications test [minutes]   Inject a test notification (pipeline check)
workday notifications ack <id> <act>   Acknowledge (shown|opened|hidden)
workday calendar                       Outlook ICS feed status (meeting suggestions)
workday calendar refresh               Re-fetch the calendar feed now
workday daemon                         Run in foreground (live dashboard)
```

## Configuration

**~/.workday/config.json**

```json
{
  "repos": ["/path/to/repo-a", "/path/to/repo-b"],
  "boundaryHour": 4,
  "tracking": {
    "projectKeys": ["PROJ", "OTHER"],
    "branchOwners": ["your-username"]
  },
  "genericBranches": ["develop", "main", "master"],
  "session": {
    "diffPollSeconds": 30,
    "signalDeduplicationSeconds": 300,
    "reflogCount": 20,
    "idleCloseHours": 3
  },
  "report": { "roundingMinutes": 15 },
  "workDays": [1, 2, 3, 4, 5],
  "notifications": {
    "timesheetReminder": { "enabled": true, "notifyHour": 14 }
  }
}
```

`tracking.projectKeys` are the Jira projects whose branches/commits the daemon
follows (the branch task regex is derived from them — no hand-written regex).
`tracking.branchOwners` marks branches as yours: a branch is tracked only when
one of the names appears as an exact delimiter-separated word in the branch
name, case-insensitive — `"jdoe"` matches `PROJ-1-jdoe-fix` but not
`PROJ-1-jdoes-fix`, and `"jdo"` never matches `jdoe`. Empty list = every
branch is tracked. In the tray app both live under Settings → Tracking, with
projects picked from the Jira catalog. Legacy configs migrate automatically:
`taskPattern` seeds `projectKeys`, and the old `secrets.json` `Developer`
field seeds `branchOwners`.

`notifications.timesheetReminder` drives the tray's desktop toast: on the last
working day of the month (per `workDays` + `holidays`), from `notifyHour`
until the month ends, while unpushed days remain — delivered once per month,
at the first moment the user is actually at the keyboard.

**~/.workday/secrets.json**

```json
{
  "Jira_Email": "your-email@company.com",
  "Jira_BaseUrl": "https://your-company.atlassian.net",
  "Jira_Token": "",
  "Tempo_Token": "",
  "Calendar_IcsUrl": ""
}
```

`Calendar_IcsUrl` (optional) is an Outlook published-calendar ICS link
(OWA Settings → Calendar → Shared calendars → Publish); the token in the URL
is a secret. When set, the daemon keeps `data/calendar-cache.json` with the
expanded meeting instances of the last 90 days — groundwork for meeting
suggestions. Re-fetched hourly during the 10:00–14:00 morning window, every
~3h otherwise; `calendar.enabled: false` in config.json switches it off.

Config can also live next to `package.json` for local development — the daemon checks there first before falling back to `~/.workday/`.

## How It Works

1. Polls `git diff --numstat`, `git status`, and `git reflog` for each repo
2. Filters branches by tracked project keys and branch-owner names
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
