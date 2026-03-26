use std::process::Command;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconEvent,
    Manager,
    RunEvent,
    WindowEvent,
};
use tauri_plugin_updater::UpdaterExt;

fn stop_daemon() {
    let _ = Command::new("workday")
        .arg("stop")
        .output();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
