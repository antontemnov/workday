use std::process::Command;
use tauri::{
    tray::TrayIconEvent,
    Manager,
    RunEvent,
    WindowEvent,
};

fn is_command_available(cmd: &str) -> bool {
    Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn ensure_npm_package() {
    if is_command_available("workday") {
        return;
    }

    if !is_command_available("npm") {
        eprintln!("workday: npm not found — please install Node.js >= 20");
        return;
    }

    eprintln!("workday: CLI not found, installing workday-daemon via npm...");
    let result = Command::new("npm")
        .args(["install", "-g", "workday-daemon"])
        .output();

    match result {
        Ok(out) if out.status.success() => {
            eprintln!("workday: workday-daemon installed successfully");
        }
        Ok(out) => {
            eprintln!(
                "workday: npm install failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        Err(e) => {
            eprintln!("workday: failed to run npm: {}", e);
        }
    }
}

fn start_daemon() {
    let _ = Command::new("workday")
        .arg("start")
        .spawn();
}

fn stop_daemon() {
    let _ = Command::new("workday")
        .arg("stop")
        .output();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Ensure workday CLI is installed, then start daemon
            ensure_npm_package();
            start_daemon();

            // Hide window on startup — tray-only until double-click
            let window = app.get_webview_window("main").unwrap();
            window.hide().unwrap();

            // Tray: double-click → show/hide window
            let tray = app.tray_by_id("main").expect("tray not found");
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
