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
workday start                 # first run self-creates ~/.workday/ templates
workday setup                 # setup checklist + links to token pages
# finish setup in the tray app's wizard, or edit ~/.workday/*.json by hand
workday status                # check running sessions
workday today                 # full day summary
```

The tray app drives the whole first run itself: it npm-installs the daemon
when missing and opens a setup wizard (site → tokens → tracking → calendar).

## Commands

```
workday init                           Initialize config in ~/.workday/
workday setup                          Setup status + token-page links
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
workday task-delete <KEY>              Delete a ticket's tracked block: sessions + manual adds (add --date for past days)
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
workday suggestions [--date D]         Pending meeting suggestions for a day (→ learned ticket)
workday suggestions accept <#N|uid>    Log a suggested meeting (--task optional once learned)
workday suggestions dismiss <#N|uid>   Dismiss a suggestion (permanent per meeting+day)
workday suggestions mute <#N|uid>      Mute a meeting series (--days N, default forever)
workday suggestions muted              Manually muted series
workday suggestions unmute <uid|--all> Release muted series
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
  },
  "calendar": { "enabled": true, "hidePrivate": false }
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
expanded meeting instances of the last 90 days and derives **meeting
suggestions** from it: every started BUSY meeting (not cancelled, not
all-day) becomes an offer to log a manual entry, until it is accepted or
dismissed. Accepts are never stored — the created entry carries a
`sourceRef` marker, so deleting it revives the suggestion; dismissals live
in `data/suggestions-state.json`. A day pushed to Tempo is silenced for
good. Feed re-fetches hourly during the 10:00–14:00 morning window, every
~3h otherwise; `calendar.enabled: false` in config.json switches it off,
`calendar.hidePrivate: true` hides CLASS:PRIVATE meetings from suggestions.

Accepting a meeting **teaches** the daemon (`data/meeting-associations.json`):
the next instance of the series prefills the same ticket, activity and — when
you typed a custom one — description. A recreated series (new UID, same
normalized title) resolves by title; when the title maps to *different*
tickets the suggestion carries the conflicting candidates instead of guessing.
A noisy series can be muted for a week, a month, or forever — right-click the
suggestion in the tray (or `workday suggestions mute`); muted series are
listed under Settings → Calendar and in `workday suggestions muted`.

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
