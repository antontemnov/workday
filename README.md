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
workday resume [repo]                  Resume paused sessions
workday autopause on|off [repo]        Toggle idle auto-pause
workday log <task> <min> "<desc>"      Log manual time on a task
workday log-added <task> <min>         Set a ticket's manual added total (bare Development time; 0 removes)
workday timer                          Today's manual timers
workday timer new ["<desc>"]           Start a timer without a ticket
workday timer start <#|id>             Start a timer (--entry <#|id> puts one on a manual entry)
workday timer pause [#|id]             Pause a timer (default: the live one)
workday timer describe <#|id> "<text>" Describe a timer (one with a ticket: its entry's description)
workday timer bind <#|id> <task> ["<desc>"]   Give a timer its ticket (--activity T, --minutes N)
workday timer remove <entry #|id>      Remove the timer from an entry (its time goes)
workday timer delete <#|id>            Remove a timer (one with a ticket takes its time out of the entry)
workday timer cancel <#|id>            Undo a New timer made by mistake
workday timer hide <#|id>              Take a paused timer off the desktop widget
workday timer widget [on|off]          Desktop widget switch
workday timer suggested [meeting|review on|off]   Suggested timers switch, per suggestion source
workday fav-add <task> <min> "<name>"  Add a favorite (reusable log template)
workday fav-remove <#|id>              Remove a favorite
workday fav-list                       List favorites
workday jira-search "<query>"          Live Jira issue search (key + summary)
workday jira-in-progress               My Jira issues in status In Progress
workday session-stop <target>          Stop an open session now (live or frozen)
workday session-delete <target>        Delete a junk session (add --date for past days)
workday task-delete <KEY>              Delete a ticket's tracked block: sessions + manual adds (add --date for past days)
workday task-delete <KEY> --stop       Same, open sessions are stopped and deleted too
workday tempo                          Show report (month to date)
workday tempo --push                   Push to Tempo
workday month [YYYY-MM]                Month view: day statuses vs Tempo
workday tempo-sync [YYYY-MM]           Refresh the month's Tempo snapshot (mirror pull)
workday tempo-import [YYYY-MM]         Adopt Tempo-only worklogs as local entries
workday schedule [YYYY-MM]             Tempo work schedule (required hours, holidays)
workday approval [YYYY-MM] [--fresh]   Tempo timesheet approval status (--fresh skips the cache)
workday balance [YYYY]                 Year balance: Tempo's ahead/behind over the months before this one
workday notifications                  Active desktop notifications (tray toasts)
workday notifications test [minutes]   Inject a test notification (pipeline check)
workday notifications ack <id> <act>   Acknowledge (shown|opened|hidden)
workday calendar                       Outlook ICS feed status (meeting suggestions)
workday calendar refresh               Re-fetch the calendar feed now
workday suggestions [--date D] [--all] Pending meeting suggestions for a day (--all adds today's upcoming meetings)
workday suggestions accept <#N|uid>    Log a suggested meeting (--task optional once learned)
workday suggestions timer <#N|uid>     Take a live suggestion by a timer (rows marked [timer]; --task gives it a ticket)
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
  "calendar": { "enabled": true, "hidePrivate": false },
  "timer": { "desktopWidget": true, "suggested": { "meeting": false, "review": false } }
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
good. An all-day read (`workday suggestions --all`,
`GET /api/suggestions?includeFuture=1`) also offers today's meetings that
have not started yet, marked `upcoming`; such a read keeps the feed at most
30 min old and waits for the fetch (5s at most) rather than serve rows the
next fetch would erase. Feed re-fetches hourly during the 10:00–14:00 morning window, every
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

**Manual timers** cover work that leaves no trace in git. A timer is a source
of time for a manual entry, not a record of its own: it adds whole minutes to
the entry it feeds and remembers its own share, so `Remove timer` takes out
exactly what it counted and leaves what was typed by hand. A number typed
into the entry does not touch what the timer counted; only a number smaller
than that cuts the timer down to it. A timer with a ticket has no text of its
own — its description is the entry's. A timer started without a ticket
(`workday timer new`) is outside the day total until it gets one
(`workday timer bind`); bare Development time lands on the ticket's manual
added record, as any bare add does.

One counts at a time — a session or a timer. Starting a timer supersedes the
session that was counting. A timer counts through work on its own ticket — a
Development record of the session's ticket: the session waits, keeps its
commits and lines, and takes the count when the timer is paused by hand. A
session on other work (another ticket, another activity on the same one, a
timer without a ticket) pauses the timer with an edit that lifts its stamina
above the touch floor: a commit, a save of a few lines, or any edit while the
work is still warm. A stray touch does not. A paused timer stays paused —
nothing but a hand starts it again. Sleep, a crash, a reboot or a
self-update are simply time nobody tracked: a live timer is cut where it was
last seen and goes on by itself. `workday stop` pauses timers. At the day
boundary every timer stops; a timer still without a ticket stays in its day's
file as unlinked time. `timer.desktopWidget` is the tray's switch for the
small always-on-top list of timers. A timer without a ticket gets one right
there: the widget lists what the tray knows already (the day's tickets, Jira
in progress, and every favorite as the Log cloud shows it) and searches Jira.
A ticket makes a Development record with the timer's description; a favorite
binds as it says — its activity, and its name when the timer has no
description. Without a description the time lands on the ticket's Development
record that has no description — an ordinary record, shown as "no
description": it can be named later in its card, in the timer island or on
the widget, and a Development description taken away puts the time back.

**Suggested timers** join the two: a suggestion that is live — a meeting
until it ends, a review while its branch is checked out — can be taken by a
timer instead of being logged with a planned number. Off by default, one
switch per source: `timer.suggested.meeting` (Settings → Timer → Suggest
timers for meetings) and `timer.suggested.review` (Suggest timers for
reviews). While a switched-on
suggestion is live it stands on the desktop widget below the timers — an
amber star and a zero that does not tick; a click on it, `Start timer` in the
suggestion's menu or `workday suggestions timer` takes it: with a known
ticket that is a record with the suggestion's activity and description, no
minutes yet and a running timer on it; without one, a running timer without a
ticket named after the meeting. A ticket picked for a suggestion that has
none (`task?` in the feed, `--task` in the CLI) is its ticket from then on:
the star row shows the key and the timer takes it. A timer that took a
meeting without a ticket remembers the meeting: the ticket it gets later —
on the widget, in the island or with `workday timer bind` — makes the
meeting's record (`Other` unless another activity is chosen, never
Development by default) and the series learns it, so the next meeting of the
series comes with the ticket and the activity. A suggestion without history
is `Other` on every path. The suggestion leaves the day for good —
removing the timer later does not bring it back. Nothing starts by itself,
and a meeting that ends does not stop the timer.

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
