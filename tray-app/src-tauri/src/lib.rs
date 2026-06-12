use std::process::Command;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconEvent,
    AppHandle,
    Manager,
    RunEvent,
    WindowEvent,
};
use tauri_plugin_updater::UpdaterExt;

mod tray_icon;
use tray_icon::TrayStatus;

/// Set when the user clicks "Quit" in the tray context menu — signals the
/// ExitRequested handler to leave the daemon running. Crash / OS shutdown
/// paths reach ExitRequested without this flag set, so they keep stopping
/// the daemon as before.
static MANUAL_QUIT: AtomicBool = AtomicBool::new(false);

/// Set right before the updater downloads/installs a tray update. On Windows
/// the updater kills the process to run the installer; on other platforms we
/// call restart() ourselves. Either way the exit must NOT stop the daemon —
/// the tray is coming right back.
static SELF_UPDATING: AtomicBool = AtomicBool::new(false);

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

fn stop_daemon() {
    let _ = shell_run("workday stop", &enriched_path());
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

/// Frontend-triggered tray self-update check (e.g. when the daemon's API
/// version is ahead of this app). Same flow as the periodic check.
#[tauri::command]
async fn check_app_update(app: AppHandle) -> Result<String, String> {
    check_for_updates(app).await.map_err(|e| e.to_string())?;
    Ok("Update check finished".to_string())
}

#[tauri::command]
async fn start_daemon() -> Result<String, String> {
    let path = enriched_path();
    shell_spawn("workday start", &path);
    Ok("Daemon starting...".to_string())
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
        .invoke_handler(tauri::generate_handler![upgrade_daemon, start_daemon, check_app_update, list_local_days, read_local_day, set_tray_status])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Check for UI updates in background (non-blocking): once at
            // launch, then periodically — the tray lives for weeks, a
            // launch-only check would never fire again.
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

            // Hide window on startup — tray-only until double-click
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
                    // Manual quit leaves the daemon running so background
                    // tracking survives a tray restart. Crash/shutdown paths
                    // still tear it down via ExitRequested.
                    MANUAL_QUIT.store(true, Ordering::Relaxed);
                    app_handle.exit(0);
                } else if event.id() == "show" {
                    let _ = menu_window.show();
                    let _ = menu_window.set_focus();
                }
            });

            // Tray: double-click → show/hide window
            let window_clone = window.clone();
            tray.on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::DoubleClick { .. } = event {
                    let w = &window_clone;
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            });

            // Close to tray instead of quitting
            let window_for_close = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window_for_close.hide();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_handle, event| {
        // Manual Quit and self-update exits skip the stop — the daemon stays
        // alive across tray restarts. Crash / OS shutdown still stop it.
        if let RunEvent::ExitRequested { .. } = event {
            if !MANUAL_QUIT.load(Ordering::Relaxed) && !SELF_UPDATING.load(Ordering::Relaxed) {
                stop_daemon();
            }
        }
    });
}

async fn check_for_updates(handle: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let updater = handle.updater()?;

    match updater.check().await {
        Ok(Some(update)) => {
            eprintln!(
                "workday: update available: {} -> {}",
                update.current_version,
                update.version
            );

            // The updater exit (Windows: installer kills the process;
            // elsewhere: our restart() below) must not stop the daemon.
            SELF_UPDATING.store(true, Ordering::Relaxed);

            // Download and install silently
            let mut downloaded: u64 = 0;
            let install_result = update
                .download_and_install(
                    |chunk, _total| {
                        downloaded += chunk as u64;
                    },
                    || {
                        eprintln!("workday: update downloaded and staged");
                    },
                )
                .await;
            if let Err(e) = install_result {
                // Failed mid-download — this process is staying alive, so
                // exits must go back to stopping the daemon as usual.
                SELF_UPDATING.store(false, Ordering::Relaxed);
                return Err(e.into());
            }

            // On Windows download_and_install never returns (the installer
            // relaunches the app). Elsewhere the update applies on restart —
            // do it now: the tray is a background app, a silent relaunch is
            // invisible to the user.
            eprintln!("workday: update installed, restarting app");
            handle.restart();
        }
        Ok(None) => {
            eprintln!("workday: app is up to date");
        }
        Err(e) => {
            eprintln!("workday: could not check for updates: {}", e);
        }
    }

    Ok(())
}
