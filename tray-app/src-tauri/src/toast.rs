// Toast window management: a second webview window ("toast") that renders
// desktop notifications Telegram-style — bottom-right above the taskbar,
// always-on-top, never focusable (WS_EX_NOACTIVATE: clicks land, focus never
// steals). Created lazily on show and destroyed on hide: a second WebView2
// process must not idle 24/7 for a once-a-month notification.
//
// Payload delivery uses the pull handshake (same pattern as
// PENDING_APP_UPDATE in lib.rs): show_toast stores the payload and builds the
// window hidden; the toast frontend pulls it via get_pending_toast, renders,
// then invokes toast_ready — only then is the window positioned and shown.
// No emit-before-listener race, no white flash of an empty webview.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

static PENDING_TOAST: Mutex<Option<serde_json::Value>> = Mutex::new(None);

const TOAST_LABEL: &str = "toast";
/// Logical size — tao scales it per-DPI. Compact card (~360×64) plus 16px
/// bleed for the CSS shadow on every side (the window itself is transparent).
const TOAST_WIDTH: f64 = 392.0;
const TOAST_HEIGHT: f64 = 100.0;
/// Gap from the work-area corner, in logical px (scaled before use).
const TOAST_MARGIN: f64 = 12.0;

/// Milliseconds since the last keyboard/mouse input. Non-Windows returns 0
/// ("present") — presence gating simply degrades to always-deliver there.
#[tauri::command]
pub fn get_idle_ms() -> u64 {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) != 0 {
            // wrapping_sub: GetTickCount rolls over every ~49.7 days.
            return GetTickCount().wrapping_sub(info.dwTime) as u64;
        }
    }
    0
}

/// Queue a notification payload and make sure the toast window exists.
/// The window stays hidden until its frontend reports ready.
#[tauri::command]
pub fn show_toast(app: AppHandle, payload: serde_json::Value) -> Result<(), String> {
    *PENDING_TOAST.lock().unwrap() = Some(payload.clone());

    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        // Reuse path — the webview is live, its listener is attached.
        app.emit_to(TOAST_LABEL, "toast-payload", payload)
            .map_err(|e| e.to_string())?;
        position_toast(&app, &window)?;
        window.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, TOAST_LABEL, WebviewUrl::App("index.html".into()))
        .title("Workday notification")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .shadow(false)
        .visible(false)
        .inner_size(TOAST_WIDTH, TOAST_HEIGHT)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pending payload for the toast frontend's bootstrap pull.
#[tauri::command]
pub fn get_pending_toast() -> Option<serde_json::Value> {
    PENDING_TOAST.lock().unwrap().clone()
}

/// Toast frontend has rendered the card — position and reveal the window.
#[tauri::command]
pub fn toast_ready(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(TOAST_LABEL)
        .ok_or("toast window not found")?;
    position_toast(&app, &window)?;
    window.show().map_err(|e| e.to_string())
}

/// Close (destroy) the toast window and drop the pending payload.
#[tauri::command]
pub fn hide_toast(app: AppHandle) -> Result<(), String> {
    *PENDING_TOAST.lock().unwrap() = None;
    if let Some(window) = app.get_webview_window(TOAST_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toast action: bring up the main window on a specific view. The main
/// webview lives (hidden) the whole session — its listener is attached.
#[tauri::command]
pub fn open_main_at_view(app: AppHandle, view: String) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window not found")?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())?;
    app.emit_to("main", "navigate-view", view).map_err(|e| e.to_string())
}

/// Bottom-right of the primary monitor's work area (taskbar excluded).
/// Physical coordinates end-to-end; the margin is scaled and rounded to whole
/// physical pixels — fractional-DPI safety on WebView2.
fn position_toast(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    let monitor = match app.primary_monitor().map_err(|e| e.to_string())? {
        Some(m) => Some(m),
        None => app
            .available_monitors()
            .map_err(|e| e.to_string())?
            .into_iter()
            .next(),
    };
    // Headless edge (RDP without monitors): show unpositioned.
    let Some(monitor) = monitor else { return Ok(()) };

    let work_area = monitor.work_area();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let margin = (TOAST_MARGIN * monitor.scale_factor()).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - size.width as i32 - margin;
    let y = work_area.position.y + work_area.size.height as i32 - size.height as i32 - margin;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}
