# Auto-Update Architecture

How the two deliverables — the **tray app** (Tauri, GitHub Releases) and the
**daemon** (`workday-daemon`, npm registry) — keep themselves current, and the
invariants that keep the process stable.

## Channels

| What | Source | Checked by | Cadence |
|------|--------|-----------|---------|
| Tray app | GitHub Releases `latest.json` | the tray itself (Tauri updater) | at launch + every 6 h |
| Daemon | npm registry (`workday-daemon`) | the running daemon | ~1 h after start, then every 6 h (+jitter) |
| Daemon (cold) | npm registry | CLI `workday start` | before spawning, only when no daemon is alive |
| Daemon (manual) | npm registry | Settings → **Check updates** | on click |
| Daemon (repair) | npm | tray, on `apiVersion` mismatch | once per 10 min max |

## Invariants

1. **Install first, restart second.** Nothing is ever stopped before the new
   version is installed and verified on disk (`package.json` version must
   equal the pinned target). A failed `npm install` leaves the old daemon
   running untouched.
2. **Pinned versions.** Updates install `workday-daemon@<checked version>`,
   never `@latest` — a release landing mid-flow can't produce an unchecked
   version. Prereleases (`-beta` etc.) are never auto-installed.
3. **Quiet-window restarts.** A self-update installed by the running daemon
   waits for a moment with no open unpaused session (re-tested every ~60 s on
   the day-boundary timer; the nightly boundary is a guaranteed slot). The
   tray's **Update now** button skips the wait — the user asked explicitly.
4. **Self-restart = respawn the same script path.** npm has already replaced
   the file contents; the daemon does a full graceful stop (final poll, flush,
   port released, PID file removed) and spawns itself detached.
5. **`workday start` never installs over a live daemon.** The old flow
   npm-installed first and then said "already running" — the user believed
   they were updated while the old code kept running.
6. **Tray exits during self-update never stop the daemon** (`SELF_UPDATING`
   flag). On Windows the Tauri updater kills the process to run the
   installer; elsewhere the tray restarts itself silently after install.

## API version gate (tray ↔ daemon)

Every API response carries `apiVersion`. The tray compares it with its
`EXPECTED_API_VERSION` — **direction-aware**, with a 10-minute cooldown:

- daemon **behind** → the tray runs `upgrade_daemon` (install → verify →
  stop → start);
- daemon **ahead** → the *tray* is stale: trigger the tray's own updater.
  Never "upgrade" the daemon here — npm would reinstall the same new version
  and the mismatch would loop forever (the pre-0.6 tray did exactly that,
  restarting the daemon and closing the day's sessions every poll cycle).

**Bump `API_VERSION` only on breaking changes** — additive endpoints and
fields don't count. Release ritual for a bump: publish the tray release
first, give live trays a day to self-update (6 h check cycle), then
`npm publish` the daemon.

## Daemon update endpoints

- `GET /api/update/check` → `{ current, latest, updateAvailable }` — registry
  lookup, no side effects.
- `POST /api/update/apply` → installs (if needed) and restarts the daemon;
  responds before the restart so the client sees the outcome. The Settings
  view then polls `/api/settings` until `daemonVersion` equals the target.

## Known gaps (accepted for now)

- A daemon restart closes the day's open sessions (`DaemonStop`) and resets
  in-memory stamina/EMA; new sessions reopen on the next activity tick.
  Mitigated by quiet-window scheduling; full state handoff is future work.
- `enriched_path()` fixes GUI PATH for Windows only; on macOS the tray's
  npm/workday lookups may miss user-installed Node (daemon self-update is
  unaffected — it runs inside the daemon's own environment).
- Daemon npm publishing is manual; the tray release is tag-driven
  (`tray-v*`). Keep versions moving together.
