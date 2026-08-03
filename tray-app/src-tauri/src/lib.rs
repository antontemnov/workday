use std::process::Command;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconEvent},
    AppHandle,
    Emitter,
    Manager,
    WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;

mod toast;
mod tray_icon;
use tray_icon::TrayStatus;

/// Version found by the last background update check. The webview may not be
/// listening yet when the launch check fires, so the frontend also pulls this
/// once on init via get_pending_app_update.
static PENDING_APP_UPDATE: Mutex<Option<String>> = Mutex::new(None);

/// When the main window last lost focus. A left-click on the tray icon
/// activates the shell's tray window, so the main window may already read as
/// unfocused by the time we handle the click. Treating a just-lost focus as
/// "was in front" lets the toggle hide a foreground window instead of only
/// re-focusing it.
static LAST_MAIN_BLUR: Mutex<Option<Instant>> = Mutex::new(None);

/// How often the running tray re-checks for its own updates. The old
/// launch-only check meant a tray that lives for weeks never updated.
const APP_UPDATE_CHECK_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(6 * 60 * 60);

/// Build a PATH that includes standard Node.js/npm locations.
/// GUI apps on Windows don't inherit the full user PATH.
fn enriched_path() -> String {
    let mut path = env::var("PATH").unwrap_or_default();

    if cfg!(target_os = "windows") {
        if let Ok(appdata) = env::var("APPDATA") {
            path = format!("{appdata}\\npm;{path}");
        }
        if let Ok(pf) = env::var("ProgramFiles") {
            path = format!("{pf}\\nodejs;{path}");
        }
        // nvm-windows
        if let Ok(nvm_home) = env::var("NVM_SYMLINK") {
            path = format!("{nvm_home};{path}");
        }
    }

    path
}

/// Run a shell command (cmd.exe /c on Windows, sh -c on Unix).
/// Needed because npm/workday are .cmd files on Windows.
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn shell_run(command: &str, path: &str) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.env("PATH", path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output()
}

fn shell_spawn(command: &str, path: &str) {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command]);
        c
    };
    cmd.env("PATH", path);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let _ = cmd.spawn();
}

#[tauri::command]
async fn upgrade_daemon() -> Result<String, String> {
    let path = enriched_path();

    // Install FIRST. If npm fails the running daemon is left untouched —
    // the old order (stop → install → start) left the daemon dead when
    // the install failed mid-way.
    let output = shell_run("npm install -g workday-daemon@latest", &path)
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "npm install failed (daemon left running): {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Only now swap the process: stop old, start new.
    let _ = shell_run("workday stop", &path);
    shell_spawn("workday start", &path);

    Ok("Daemon upgraded and restarted".to_string())
}

/// Frontend-triggered tray self-update check (Settings "Check updates").
/// Same check-only flow as the periodic check: a found update raises the
/// banner, install waits for the user's click. Returns the found version
/// (None = already up to date) so the UI can show the result inline.
#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<Option<String>, String> {
    check_for_updates(app).await.map_err(|e| e.to_string())
}

/// Current tray-app version (from tauri.conf.json). A command instead of the
/// app JS plugin so no extra capability or npm package is needed.
#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Pending tray update found by a background check, if any. Called once by
/// the frontend on init — the launch check can fire before its listener is up.
#[tauri::command]
fn get_pending_app_update() -> Option<String> {
    PENDING_APP_UPDATE.lock().unwrap().clone()
}

/// User clicked the update banner: download, install and restart now.
#[tauri::command]
async fn install_app_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = match updater.check().await.map_err(|e| e.to_string())? {
        Some(u) => u,
        None => {
            // Stale banner (release pulled / already updated) — nothing to do.
            *PENDING_APP_UPDATE.lock().unwrap() = None;
            return Err("Already up to date".to_string());
        }
    };

    let install_result = update
        .download_and_install(
            |_chunk, _total| {},
            || {
                eprintln!("workday: update downloaded and staged");
            },
        )
        .await;
    if let Err(e) = install_result {
        return Err(e.to_string());
    }

    // On Windows download_and_install never returns (the installer relaunches
    // the app). Elsewhere the update applies on restart — do it now.
    eprintln!("workday: update installed, restarting app");
    app.restart()
}

#[tauri::command]
async fn start_daemon() -> Result<String, String> {
    let path = enriched_path();
    shell_spawn("workday start", &path);
    Ok("Daemon starting...".to_string())
}

/// Whether the workday CLI resolves on the (enriched) PATH — lets the
/// offline screen distinguish "not installed" (first run → auto-install)
/// from "installed but not running" (watchdog restarts it).
#[tauri::command]
async fn daemon_installed() -> bool {
    let path = enriched_path();
    let probe = if cfg!(target_os = "windows") {
        "where workday"
    } else {
        "command -v workday"
    };
    match shell_run(probe, &path) {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

/// Node.js version string ("v22.1.0"), or None when node is absent — the
/// first-run daemon install needs Node >= 20 and the UI must say so.
#[tauri::command]
async fn node_version() -> Option<String> {
    let path = enriched_path();
    match shell_run("node --version", &path) {
        Ok(out) if out.status.success() => {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => None,
    }
}

/// Manual-stop marker written by the daemon on an explicit stop. The
/// frontend watchdog checks it before respawning: a deliberately stopped
/// daemon stays stopped until the user starts it (or the next login).
fn stop_marker_path() -> Option<PathBuf> {
    workday_home().map(|h| h.join("daemon.stopped"))
}

#[tauri::command]
fn daemon_stop_marker_present() -> bool {
    stop_marker_path().map(|p| p.exists()).unwrap_or(false)
}

/// Autostart toggle for the Settings view. Wrapped in commands (instead of
/// the plugin's JS guest API) so no extra capability or npm package is needed.
#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

/// Update the tray icon's status dot and tooltip.
/// `kind` is one of: "live" | "pending" | "idle" | "paused" | "none".
/// `tooltip` defaults to "Workday" when empty.
#[tauri::command]
fn set_tray_status(app: AppHandle, kind: String, tooltip: Option<String>) -> Result<(), String> {
    let status = TrayStatus::parse(&kind);
    let icon = tray_icon::build(status)?;
    let tray = app.tray_by_id("main").ok_or("tray not found")?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    let tooltip_text = tooltip.unwrap_or_else(|| "Workday".to_string());
    tray.set_tooltip(Some(&tooltip_text)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve workday home — WORKDAY_HOME env wins, else ~/.workday/.
fn workday_home() -> Option<PathBuf> {
    if let Ok(h) = env::var("WORKDAY_HOME") {
        return Some(PathBuf::from(h));
    }
    let home_var = if cfg!(target_os = "windows") { "USERPROFILE" } else { "HOME" };
    env::var(home_var).ok().map(|h| PathBuf::from(h).join(".workday"))
}

/// List available day dates (YYYY-MM-DD) directly from disk — works even when
/// the daemon is not running. Layout: <home>/data/YYYY-MM/MM-DD.json.
#[tauri::command]
async fn list_local_days() -> Result<Vec<String>, String> {
    let data_dir = match workday_home() {
        Some(h) => h.join("data"),
        None => return Ok(vec![]),
    };
    if !data_dir.exists() {
        return Ok(vec![]);
    }

    let mut dates: Vec<String> = Vec::new();
    for month_entry in fs::read_dir(&data_dir).map_err(|e| e.to_string())? {
        let month_entry = match month_entry { Ok(e) => e, Err(_) => continue };
        if !month_entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let year_month = match month_entry.file_name().into_string() { Ok(s) => s, Err(_) => continue };
        // Expect "YYYY-MM"
        let ym_parts: Vec<&str> = year_month.split('-').collect();
        if ym_parts.len() != 2 || ym_parts[0].len() != 4 || ym_parts[1].len() != 2 {
            continue;
        }

        for day_entry in fs::read_dir(month_entry.path()).map_err(|e| e.to_string())? {
            let day_entry = match day_entry { Ok(e) => e, Err(_) => continue };
            let name = match day_entry.file_name().into_string() { Ok(s) => s, Err(_) => continue };
            if !name.ends_with(".json") { continue; }
            let stem = &name[..name.len() - 5]; // "MM-DD"
            let dd_parts: Vec<&str> = stem.split('-').collect();
            if dd_parts.len() != 2 || dd_parts[1].len() != 2 { continue; }
            dates.push(format!("{}-{}-{}", ym_parts[0], ym_parts[1], dd_parts[1]));
        }
    }
    // Descending — newest first, matches /api/days contract.
    dates.sort_by(|a, b| b.cmp(a));
    Ok(dates)
}

/// Read a single day's raw JSON (the daemon's DailyLog) directly from disk.
/// Caller decodes; computed fields (durations, intervals) are derived client-side.
#[tauri::command]
async fn read_local_day(date: String) -> Result<String, String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return Err(format!("invalid date: {}", date));
    }
    let home = workday_home().ok_or_else(|| "no workday home".to_string())?;
    let path = home.join("data")
        .join(format!("{}-{}", parts[0], parts[1]))
        .join(format!("{}-{}.json", parts[1], parts[2]));
    fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Single-instance MUST be registered before any other plugin.
        // Second launch focuses the existing window instead of starting again.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--autostart-launch"]),
        ))
        .invoke_handler(tauri::generate_handler![upgrade_daemon, start_daemon, daemon_installed, node_version, check_app_update, get_app_version, get_pending_app_update, install_app_update, list_local_days, read_local_day, set_tray_status, daemon_stop_marker_present, get_autostart_enabled, set_autostart_enabled, toast::get_idle_ms, toast::show_toast, toast::get_pending_toast, toast::toast_ready, toast::hide_toast, toast::open_main_at_view])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Autostart default-on: enabled once on the first run (marker in
            // ~/.workday), then the user's choice in Settings is respected.
            if let Some(home) = workday_home() {
                let initialized = home.join("tray.autostart-initialized");
                if !initialized.exists() {
                    match app.autolaunch().enable() {
                        Ok(()) => {
                            let _ = fs::create_dir_all(&home);
                            let _ = fs::write(&initialized, "1");
                        }
                        Err(e) => eprintln!("workday: failed to enable autostart: {}", e),
                    }
                }
            }

            // The 24/7 contract: a login always starts tracking. An autostart
            // launch voids any manual-stop intent left from the previous
            // session; any launch spawns the daemon unless deliberately
            // stopped (workday's single-instance guard makes extra spawns
            // no-ops). The frontend watchdog keeps guarding it afterwards.
            if env::args().any(|a| a == "--autostart-launch") {
                if let Some(marker) = stop_marker_path() {
                    let _ = fs::remove_file(marker);
                }
            }
            if !daemon_stop_marker_present() {
                shell_spawn("workday start", &enriched_path());
            }

            // Check for UI updates in background (check-only, banner-driven
            // install): once at launch, then periodically — the tray lives
            // for weeks, a launch-only check would never fire again.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_for_updates(handle).await {
                    eprintln!("workday: update check failed: {}", e);
                }
            });
            let periodic_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(APP_UPDATE_CHECK_INTERVAL);
                let h = periodic_handle.clone();
                if let Err(e) = tauri::async_runtime::block_on(check_for_updates(h)) {
                    eprintln!("workday: periodic update check failed: {}", e);
                }
            });

            // Hide window on startup — tray-only until the tray icon is clicked
            let window = app.get_webview_window("main").unwrap();
            window.hide().unwrap();

            // Tray context menu
            let tray = app.tray_by_id("main").expect("tray not found");

            // Replace the static "placeholder" icon from tauri.conf.json with
            // the freshly rendered octocat silhouette (no dot yet — the
            // frontend will call set_tray_status once data arrives).
            if let Ok(icon) = tray_icon::build(TrayStatus::None) {
                let _ = tray.set_icon(Some(icon));
            }

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            tray.set_menu(Some(menu))?;
            tray.set_show_menu_on_left_click(false)?;

            let app_handle = app.handle().clone();
            let menu_window = window.clone();
            tray.on_menu_event(move |_tray, event| {
                if event.id() == "quit" {
                    // Quit closes only the tray — the daemon is 24/7 and
                    // never dies with its window.
                    app_handle.exit(0);
                } else if event.id() == "show" {
                    let _ = menu_window.show();
                    let _ = menu_window.unminimize();
                    let _ = menu_window.set_focus();
                }
            });

            // Tray: single left-click toggles the window Telegram-style.
            // Hidden → show; visible but behind another window → bring to
            // front; visible and in front → hide. Only the button-up edge
            // fires (Windows emits both down and up, which would double-toggle).
            let window_clone = window.clone();
            tray.on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let w = &window_clone;
                    if !w.is_visible().unwrap_or(false) {
                        let _ = w.show();
                        let _ = w.unminimize();
                        let _ = w.set_focus();
                    } else {
                        let focused = w.is_focused().unwrap_or(false);
                        let last_blur = *LAST_MAIN_BLUR.lock().unwrap();
                        let recently_focused = last_blur
                            .map(|t| t.elapsed() < std::time::Duration::from_millis(250))
                            .unwrap_or(false);
                        if focused || recently_focused {
                            let _ = w.hide();
                        } else {
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                }
            });

            // Close and minimize both retreat to the tray, never to the
            // taskbar. There is no dedicated minimize event, so we catch the
            // resize into a minimized state and hide instead (unminimize first
            // so the next show restores a normal-sized window). Focus loss is
            // timestamped for the tray-click toggle above.
            let window_for_event = window.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window_for_event.hide();
                }
                WindowEvent::Resized(_) => {
                    if window_for_event.is_minimized().unwrap_or(false) {
                        let _ = window_for_event.unminimize();
                        let _ = window_for_event.hide();
                    }
                }
                WindowEvent::Focused(false) => {
                    *LAST_MAIN_BLUR.lock().unwrap() = Some(Instant::now());
                }
                _ => {}
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // No exit hook on purpose: the daemon is a 24/7 service, fully decoupled
    // from the tray's lifecycle. Tray quit/crash/OS shutdown never stop it —
    // stopping is an explicit user action (Settings toggle / workday stop).
    app.run(|_handle, _event| {});
}

/// Background check — never installs. A found update is remembered and
/// announced to the webview (banner with a restart button); the install
/// itself runs only when the user clicks — a silent mid-work restart used
/// to kill the window (and any half-typed manual entry) without warning.
async fn check_for_updates(handle: tauri::AppHandle) -> Result<Option<String>, Box<dyn std::error::Error>> {
    let updater = handle.updater()?;

    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!(
                "workday: update available: {} -> {}",
                update.current_version,
                update.version
            );
            *PENDING_APP_UPDATE.lock().unwrap() = Some(update.version.clone());
            let _ = handle.emit("app-update-available", update.version.clone());
            Ok(Some(update.version))
        }
        Ok(None) => {
            eprintln!("workday: app is up to date");
            Ok(None)
        }
        Err(e) => Err(e.into()),
    }
}
