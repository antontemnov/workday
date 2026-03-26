use std::process::Command;
use std::env;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconEvent,
    Manager,
    RunEvent,
    WindowEvent,
};
use tauri_plugin_updater::UpdaterExt;

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
fn shell_run(command: &str, path: &str) -> Result<std::process::Output, std::io::Error> {
    if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", command])
            .env("PATH", path)
            .output()
    } else {
        Command::new("sh")
            .args(["-c", command])
            .env("PATH", path)
            .output()
    }
}

fn shell_spawn(command: &str, path: &str) {
    if cfg!(target_os = "windows") {
        let _ = Command::new("cmd")
            .args(["/C", command])
            .env("PATH", path)
            .spawn();
    } else {
        let _ = Command::new("sh")
            .args(["-c", command])
            .env("PATH", path)
            .spawn();
    }
}

#[tauri::command]
async fn upgrade_daemon() -> Result<String, String> {
    let path = enriched_path();

    // Stop old daemon
    let _ = shell_run("workday stop", &path);

    // Install latest version
    let output = shell_run("npm install -g workday-daemon", &path)
        .map_err(|e| format!("Failed to run npm: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "npm install failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Start updated daemon
    shell_spawn("workday start", &path);

    Ok("Daemon upgraded and restarted".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![upgrade_daemon])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Check for UI updates in background (non-blocking)
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = check_for_updates(handle).await {
                    eprintln!("workday: update check failed: {}", e);
                }
            });

            // Hide window on startup — tray-only until double-click
            let window = app.get_webview_window("main").unwrap();
            window.hide().unwrap();

            // Tray context menu
            let tray = app.tray_by_id("main").expect("tray not found");

            let show_item = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            tray.set_menu(Some(menu))?;
            tray.set_show_menu_on_left_click(false)?;

            let app_handle = app.handle().clone();
            let menu_window = window.clone();
            tray.on_menu_event(move |_tray, event| {
                if event.id() == "quit" {
                    stop_daemon();
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
        if let RunEvent::ExitRequested { .. } = event {
            stop_daemon();
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

            // Download and install silently
            let mut downloaded: u64 = 0;
            update
                .download_and_install(
                    |chunk, _total| {
                        downloaded += chunk as u64;
                    },
                    || {
                        eprintln!("workday: update downloaded, will apply on next restart");
                    },
                )
                .await?;
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
