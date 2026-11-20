// Desktop widget: a third webview window ("widget") that keeps the day's
// manual timers on the desktop — transparent, always on top, off the taskbar,
// not focusable (clicks land, focus never moves). Only while a description is
// typed on it does it take the keyboard, and it gives it back after. Created
// on demand and destroyed when there is nothing to show, like the toast.
//
// The window catches the mouse with its whole rectangle, so it is exactly the
// plate: the frontend reports the plate's logical size (fit_widget) and Rust
// sizes the window to it in physical pixels. The height follows the rows; only
// the width is the user's. The window grows away from the screen edge it is
// nearest to — that edge (the anchor) stays put. The widget stands in the
// work area only: the taskbar is a topmost window as well, the shell puts it
// above the others whenever it likes, and no window of ours can stay on it.
//
// The main window is the brain: it decides whether the widget exists and hands
// it the rows (sync_widget); the widget only shows them and sends clicks back
// (widget_action). Dragging is driven by the widget's pointer events but
// measured here from the OS cursor, so every number stays physical.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

const WIDGET_LABEL: &str = "widget";
/// Logical px — the width a widget is born with.
const DEFAULT_WIDTH: f64 = 262.0;
/// Logical px — the first widget's gap from the work-area corner.
const DEFAULT_MARGIN: f64 = 12.0;
/// Logical px — the hidden window's size until the first fit.
const INITIAL_HEIGHT: f64 = 26.0;
const ROUNDING_NOISE: f64 = 1e-6;

/// Where the widget stands. The anchor is the corner that stays in place while
/// the window grows: physical px. The width is the user's, logical px.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetGeometry {
    anchor_x: i32,
    anchor_y: i32,
    from_right: bool,
    from_bottom: bool,
    width: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grab {
    Move,
    Left,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[derive(Clone, Copy)]
struct Drag {
    grab: Grab,
    cursor: (f64, f64),
    rect: Rect,
}

struct WidgetState {
    payload: Option<serde_json::Value>,
    geometry: Option<WidgetGeometry>,
    /// Logical px, as the frontend last reported them.
    min_width: f64,
    height: f64,
    drag: Option<Drag>,
}

static STATE: Mutex<WidgetState> = Mutex::new(WidgetState {
    payload: None,
    geometry: None,
    min_width: 0.0,
    height: 0.0,
    drag: None,
});

// ─── Geometry (pure) ────────────────────────────────────────────────────

/// The plate in physical px: never narrower than its rows need. Rounded up,
/// minus the noise of a width that went through a division by the scale.
fn plate_size(width: f64, min_width: f64, height: f64, scale: f64) -> (i32, i32) {
    let w = (width.max(min_width) * scale - ROUNDING_NOISE).ceil() as i32;
    let h = (height * scale - ROUNDING_NOISE).ceil() as i32;
    (w.max(1), h.max(1))
}

/// The window's rectangle: it hangs off its anchor and stays inside the bounds.
fn place(geometry: &WidgetGeometry, size: (i32, i32), bounds: Rect) -> Rect {
    let (w, h) = size;
    let x = if geometry.from_right { geometry.anchor_x - w } else { geometry.anchor_x };
    let y = if geometry.from_bottom { geometry.anchor_y - h } else { geometry.anchor_y };
    keep_inside(Rect { x, y, w, h }, bounds)
}

fn keep_inside(rect: Rect, bounds: Rect) -> Rect {
    let w = rect.w.min(bounds.w);
    let x = rect.x.min(bounds.x + bounds.w - w).max(bounds.x);
    let y = rect.y.min(bounds.y + bounds.h - rect.h).max(bounds.y);
    Rect { x, y, w, h: rect.h }
}

/// The rectangle a drag has reached. Only the width is ever dragged.
fn dragged(drag: &Drag, cursor: (f64, f64), min_width: i32) -> Rect {
    let dx = (cursor.0 - drag.cursor.0).round() as i32;
    let dy = (cursor.1 - drag.cursor.1).round() as i32;
    let r = drag.rect;
    match drag.grab {
        Grab::Move => Rect { x: r.x + dx, y: r.y + dy, ..r },
        Grab::Right => Rect { w: (r.w + dx).max(min_width), ..r },
        Grab::Left => {
            let w = (r.w - dx).max(min_width);
            Rect { x: r.x + r.w - w, w, ..r }
        }
    }
}

/// The corner nearest to the screen's edges becomes the anchor.
fn anchor_of(rect: Rect, bounds: Rect, width: f64) -> WidgetGeometry {
    let from_right = 2 * rect.x + rect.w > 2 * bounds.x + bounds.w;
    let from_bottom = 2 * rect.y + rect.h > 2 * bounds.y + bounds.h;
    WidgetGeometry {
        anchor_x: if from_right { rect.x + rect.w } else { rect.x },
        anchor_y: if from_bottom { rect.y + rect.h } else { rect.y },
        from_right,
        from_bottom,
        width,
    }
}

fn default_geometry(work: Rect, scale: f64) -> WidgetGeometry {
    let margin = (DEFAULT_MARGIN * scale).round() as i32;
    WidgetGeometry {
        anchor_x: work.x + work.w - margin,
        anchor_y: work.y + work.h - margin,
        from_right: true,
        from_bottom: true,
        width: DEFAULT_WIDTH,
    }
}

// ─── Screen ─────────────────────────────────────────────────────────────

/// Where the widget may stand: the taskbar, the Dock and the menu bar draw
/// over any window of ours.
fn work_rect(monitor: &Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width as i32,
        h: area.size.height as i32,
    }
}

/// The monitor under a point; no point, or one off every screen, falls back
/// to the primary.
fn monitor_at(app: &AppHandle, point: Option<(i32, i32)>) -> Result<Option<Monitor>, String> {
    if let Some((x, y)) = point {
        if let Some(monitor) = app.monitor_from_point(x as f64, y as f64).map_err(|e| e.to_string())? {
            return Ok(Some(monitor));
        }
    }
    if let Some(monitor) = app.primary_monitor().map_err(|e| e.to_string())? {
        return Ok(Some(monitor));
    }
    Ok(app.available_monitors().map_err(|e| e.to_string())?.into_iter().next())
}

/// A point of the window next to its anchor: the anchor itself may lie on the
/// screen's far edge, which belongs to the next monitor.
fn inner_point(geometry: &WidgetGeometry) -> (i32, i32) {
    (
        if geometry.from_right { geometry.anchor_x - 1 } else { geometry.anchor_x },
        if geometry.from_bottom { geometry.anchor_y - 1 } else { geometry.anchor_y },
    )
}

fn window_rect(window: &WebviewWindow) -> Result<Rect, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(Rect { x: position.x, y: position.y, w: size.width as i32, h: size.height as i32 })
}

// Position first: crossing to a monitor of another scale resizes the window,
// and the size set after it is the one that stays.
fn apply_rect(window: &WebviewWindow, rect: Rect) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(rect.x, rect.y))
        .map_err(|e| e.to_string())?;
    window
        .set_size(PhysicalSize::new(rect.w as u32, rect.h as u32))
        .map_err(|e| e.to_string())
}

fn widget_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(WIDGET_LABEL).ok_or_else(|| "widget window not found".to_string())
}

// ─── Commands ───────────────────────────────────────────────────────────

/// The main window's word on the widget: rows to show, or none — then the
/// window goes. The stored geometry is taken once; after that Rust owns it.
/// async is load-bearing: building a webview on the main thread deadlocks the
/// app on Windows (wry#583).
#[tauri::command]
pub async fn sync_widget(
    app: AppHandle,
    payload: Option<serde_json::Value>,
    geometry: Option<WidgetGeometry>,
) -> Result<(), String> {
    let Some(payload) = payload else {
        {
            let mut state = STATE.lock().unwrap();
            state.payload = None;
            state.drag = None;
        }
        if let Some(window) = app.get_webview_window(WIDGET_LABEL) {
            window.close().map_err(|e| e.to_string())?;
        }
        return Ok(());
    };

    {
        let mut state = STATE.lock().unwrap();
        state.payload = Some(payload.clone());
        if state.geometry.is_none() {
            state.geometry = geometry;
        }
    }
    if app.get_webview_window(WIDGET_LABEL).is_some() {
        return app
            .emit_to(WIDGET_LABEL, "widget-payload", payload)
            .map_err(|e| e.to_string());
    }

    WebviewWindowBuilder::new(&app, WIDGET_LABEL, WebviewUrl::App("index.html".into()))
        .title("Workday timers")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .shadow(false)
        .visible(false)
        .inner_size(DEFAULT_WIDTH, INITIAL_HEIGHT)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The rows for the widget frontend's bootstrap pull.
#[tauri::command]
pub fn get_pending_widget() -> Option<serde_json::Value> {
    STATE.lock().unwrap().payload.clone()
}

/// The widget has laid its rows out: size the window to the plate, put it at
/// its anchor and show it. Logical px in, physical px out.
#[tauri::command]
pub fn fit_widget(app: AppHandle, min_width: f64, height: f64) -> Result<(), String> {
    let window = widget_window(&app)?;
    let stored = {
        let mut state = STATE.lock().unwrap();
        state.min_width = min_width;
        state.height = height;
        // Rows changed under a drag: the release fits the window.
        if state.drag.is_some() {
            return Ok(());
        }
        state.geometry
    };
    // Headless edge (RDP without monitors): show unplaced.
    let Some(monitor) = monitor_at(&app, stored.as_ref().map(inner_point))? else {
        return window.show().map_err(|e| e.to_string());
    };
    let scale = monitor.scale_factor();
    let work = work_rect(&monitor);
    let geometry = stored.unwrap_or_else(|| default_geometry(work, scale));
    STATE.lock().unwrap().geometry = Some(geometry);

    let rect = place(&geometry, plate_size(geometry.width, min_width, height, scale), work);
    apply_rect(&window, rect)?;
    window.show().map_err(|e| e.to_string())
}

/// A drag begins: by the body (move) or by an edge (width).
#[tauri::command]
pub fn widget_grab(app: AppHandle, grab: Grab) -> Result<(), String> {
    let window = widget_window(&app)?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let rect = window_rect(&window)?;
    STATE.lock().unwrap().drag = Some(Drag { grab, cursor: (cursor.x, cursor.y), rect });
    Ok(())
}

/// The pointer moved under a drag: the window follows the OS cursor.
#[tauri::command]
pub fn widget_drag(app: AppHandle) -> Result<(), String> {
    let (drag, min_width) = {
        let state = STATE.lock().unwrap();
        (state.drag, state.min_width)
    };
    let Some(drag) = drag else { return Ok(()) };
    let window = widget_window(&app)?;
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let rect = dragged(&drag, (cursor.x, cursor.y), (min_width * scale).ceil() as i32);
    apply_rect(&window, rect)
}

/// The drag is over: the window settles inside the work area (one dropped on
/// the taskbar comes to stand right above it), its nearest corner becomes the
/// anchor, and the main window gets the geometry to keep.
#[tauri::command]
pub fn widget_release(app: AppHandle) -> Result<(), String> {
    let (drag, stored, min_width, height) = {
        let mut state = STATE.lock().unwrap();
        (state.drag.take(), state.geometry, state.min_width, state.height)
    };
    let Some(drag) = drag else { return Ok(()) };
    let window = widget_window(&app)?;
    let rect = window_rect(&window)?;
    let Some(monitor) = monitor_at(&app, Some((rect.x + rect.w / 2, rect.y + rect.h / 2)))? else {
        return Ok(());
    };
    let work = work_rect(&monitor);
    let scale = monitor.scale_factor();
    let settled = keep_inside(rect, work);
    // A move leaves the user's width as it was: the window may be wider than
    // it only because its rows need more.
    let width = match (drag.grab, stored) {
        (Grab::Move, Some(g)) => g.width,
        _ => settled.w as f64 / scale,
    };
    let geometry = anchor_of(settled, work, width);
    // The plate as its rows want it now — they may have changed under the drag.
    let fitted = if height > 0.0 {
        place(&geometry, plate_size(geometry.width, min_width, height, scale), work)
    } else {
        settled
    };
    if fitted != rect {
        apply_rect(&window, fitted)?;
    }
    if stored == Some(geometry) {
        return Ok(());
    }
    STATE.lock().unwrap().geometry = Some(geometry);
    app.emit_to("main", "widget-geometry", geometry).map_err(|e| e.to_string())
}

/// A description is typed right on the widget: for that time the window takes
/// the keyboard, and gives it back to the window that had it.
#[tauri::command]
pub fn widget_typing(app: AppHandle, on: bool) -> Result<(), String> {
    let window = widget_window(&app)?;
    if !on {
        window.set_focusable(false).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        keyboard::give_back(&window);
        return Ok(());
    }
    window.set_focusable(true).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let taken = keyboard::take(&window);
    #[cfg(not(windows))]
    let taken = false;
    if taken {
        return Ok(());
    }
    window.set_focus().map_err(|e| e.to_string())
}

/// The keyboard went to another window while a description is still being
/// typed: that window is the one to get it back.
#[tauri::command]
pub fn widget_away(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    keyboard::remember(&widget_window(&app)?);
    #[cfg(not(windows))]
    let _ = app;
    Ok(())
}

/// The daemon refused a description typed on the widget: its row shows the
/// stored text again.
#[tauri::command]
pub fn widget_refused(app: AppHandle, id: String) -> Result<(), String> {
    if app.get_webview_window(WIDGET_LABEL).is_none() {
        return Ok(());
    }
    app.emit_to(WIDGET_LABEL, "widget-refused", id).map_err(|e| e.to_string())
}

/// The ticket block is about to open: up — the window grows upward from its
/// anchor, and the block stands above its row.
#[tauri::command]
pub fn widget_grows_up() -> bool {
    STATE.lock().unwrap().geometry.map_or(true, |geometry| geometry.from_bottom)
}

/// The main window's answer to the widget's ticket block: the tickets the app
/// knows, or what Jira found.
#[tauri::command]
pub fn widget_tickets(app: AppHandle, message: serde_json::Value) -> Result<(), String> {
    if app.get_webview_window(WIDGET_LABEL).is_none() {
        return Ok(());
    }
    app.emit_to(WIDGET_LABEL, "widget-tickets", message).map_err(|e| e.to_string())
}

/// A click on a row's button — the main window acts on it through its own gate.
#[tauri::command]
pub fn widget_action(app: AppHandle, action: serde_json::Value) -> Result<(), String> {
    app.emit_to("main", "widget-action", action).map_err(|e| e.to_string())
}

/// Double click on the widget: bring the app up as it is.
#[tauri::command]
pub fn open_main(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window not found")?;
    window.show().map_err(|e| e.to_string())?;
    let _ = window.unminimize();
    window.set_focus().map_err(|e| e.to_string())
}

// ─── The keyboard (Windows) ─────────────────────────────────────────────
//
// The widget never has the keyboard, except while a description is typed on
// it. The window that had it before is remembered and gets it back — but only
// if the keyboard is still on the widget: the user may be elsewhere already.
//
// An activation may already be on its way when the edit ends (a press made
// through the accessibility tree focuses the window after its click), and the
// page learns nothing of it. So for a short while after the edit the keyboard
// is handed back whenever it turns up on the widget. The system lets a window
// pass the keyboard on only when the last input was its own; when it was not,
// the widget presses a modifier key itself and asks once more.
#[cfg(windows)]
mod keyboard {
    use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
    use std::time::Duration;
    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYEVENTF_KEYUP, VK_MENU,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsWindow, SetForegroundWindow,
    };

    const GUARD_STEP: Duration = Duration::from_millis(100);
    const GUARD_STEPS: u32 = 20;

    /// The window the keyboard came from; 0 — none.
    static OWNER: AtomicIsize = AtomicIsize::new(0);
    /// A description is being typed on the widget.
    static TYPING: AtomicBool = AtomicBool::new(false);

    fn handle(window: &WebviewWindow) -> isize {
        window.hwnd().map(|hwnd| hwnd.0 as isize).unwrap_or(0)
    }

    pub fn remember(window: &WebviewWindow) {
        let foreground = unsafe { GetForegroundWindow() } as isize;
        if foreground != 0 && foreground != handle(window) {
            OWNER.store(foreground, Ordering::Relaxed);
        }
    }

    /// The click that asked for the edit was ours, so the plain call is
    /// allowed to take the foreground. False — it was not: the caller falls
    /// back to the window's own set_focus.
    pub fn take(window: &WebviewWindow) -> bool {
        TYPING.store(true, Ordering::Relaxed);
        remember(window);
        let widget = handle(window);
        widget != 0 && unsafe { SetForegroundWindow(widget as HWND) } != 0
    }

    pub fn give_back(window: &WebviewWindow) {
        TYPING.store(false, Ordering::Relaxed);
        let widget = handle(window);
        pass_on(widget, false);
        std::thread::spawn(move || {
            let mut tries = 0;
            for _ in 0..GUARD_STEPS {
                std::thread::sleep(GUARD_STEP);
                if TYPING.load(Ordering::Relaxed) || tries > 1 {
                    return;
                }
                if pass_on(widget, tries == 1) {
                    tries += 1;
                }
            }
        });
    }

    /// Give the keyboard, if the widget holds it, to the window it came from.
    /// `insist` — the plain call was refused: a key press of the widget's own
    /// comes first. True — the widget held the keyboard.
    fn pass_on(widget: isize, insist: bool) -> bool {
        if widget == 0 || unsafe { GetForegroundWindow() } as isize != widget {
            return false;
        }
        let owner = OWNER.load(Ordering::Relaxed) as HWND;
        unsafe {
            if owner.is_null() || IsWindow(owner) == 0 {
                return true;
            }
            if insist {
                let mut keys: [INPUT; 2] = std::mem::zeroed();
                for key in keys.iter_mut() {
                    key.r#type = INPUT_KEYBOARD;
                    key.Anonymous.ki.wVk = VK_MENU;
                }
                keys[1].Anonymous.ki.dwFlags = KEYEVENTF_KEYUP;
                SendInput(2, keys.as_ptr(), std::mem::size_of::<INPUT>() as i32);
            }
            SetForegroundWindow(owner);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 1920x1080 screen at 125 % with a 48px taskbar at the bottom.
    const WORK: Rect = Rect { x: 0, y: 0, w: 1920, h: 1032 };

    fn geometry(anchor_x: i32, anchor_y: i32, from_right: bool, from_bottom: bool, width: f64) -> WidgetGeometry {
        WidgetGeometry { anchor_x, anchor_y, from_right, from_bottom, width }
    }

    #[test]
    fn plate_is_never_narrower_than_its_rows_need() {
        assert_eq!(plate_size(262.0, 104.0, 26.04, 1.0), (262, 27));
        assert_eq!(plate_size(120.0, 168.0, 52.08, 1.0), (168, 53));
        assert_eq!(plate_size(262.0, 104.0, 26.04, 1.25), (328, 33));
    }

    #[test]
    fn a_dragged_width_does_not_creep() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            for physical in [130, 211, 328, 329, 401, 777] {
                let logical = physical as f64 / scale;
                assert_eq!(plate_size(logical, 0.0, 26.04, scale).0, physical, "{physical}px at {scale}");
            }
        }
    }

    #[test]
    fn default_widget_sits_in_the_lower_right_corner() {
        let g = default_geometry(WORK, 1.25);
        assert_eq!((g.anchor_x, g.anchor_y), (1905, 1017));
        assert!(g.from_right && g.from_bottom);
        let rect = place(&g, plate_size(g.width, 104.0, 26.04, 1.25), WORK);
        assert_eq!(rect, Rect { x: 1577, y: 984, w: 328, h: 33 });
    }

    #[test]
    fn rows_grow_away_from_the_anchored_edge() {
        let bottom = geometry(1905, 1017, true, true, 262.0);
        let one = place(&bottom, (328, 33), WORK);
        let three = place(&bottom, (328, 91), WORK);
        assert_eq!(one.y + one.h, three.y + three.h, "the lower edge stays");
        assert!(three.y < one.y, "rows are added upwards");

        let top = geometry(20, 20, false, false, 262.0);
        let one = place(&top, (328, 33), WORK);
        let three = place(&top, (328, 91), WORK);
        assert_eq!((one.x, one.y), (three.x, three.y), "the upper left corner stays");
    }

    #[test]
    fn a_wider_plate_grows_from_the_anchored_side() {
        let right = geometry(1905, 1017, true, true, 104.0);
        let narrow = place(&right, (130, 33), WORK);
        let list = place(&right, (210, 62), WORK);
        assert_eq!(narrow.x + narrow.w, list.x + list.w, "the right edge stays");
    }

    #[test]
    fn a_stored_place_off_the_screen_is_brought_back() {
        let lost = geometry(4000, 3000, true, true, 262.0);
        let rect = place(&lost, (328, 33), WORK);
        assert_eq!(rect, Rect { x: 1592, y: 999, w: 328, h: 33 });
        let above = geometry(-500, -500, false, false, 262.0);
        assert_eq!(place(&above, (328, 33), WORK), Rect { x: 0, y: 0, w: 328, h: 33 });
    }

    #[test]
    fn the_taskbar_is_not_a_place() {
        let on_the_bar = Rect { x: 1372, y: 1040, w: 328, h: 33 };
        let settled = keep_inside(on_the_bar, WORK);
        assert_eq!(settled, Rect { y: 999, ..on_the_bar }, "a widget dropped on it stands right above it");
        assert_eq!(anchor_of(settled, WORK, 262.0), geometry(1700, 1032, true, true, 262.0));

        // A place kept from the days the taskbar was one.
        let stored = geometry(1700, 1073, true, true, 262.0);
        assert_eq!(place(&stored, (328, 33), WORK), settled, "it comes back above the taskbar");
        let two_rows = place(&stored, (328, 66), WORK);
        assert_eq!(two_rows.y + two_rows.h, 1032, "and its rows grow upwards from there");
    }

    #[test]
    fn a_drag_past_the_work_area_is_brought_back_to_it() {
        let below = keep_inside(Rect { x: 1700, y: 1070, w: 328, h: 33 }, WORK);
        assert_eq!(below, Rect { x: 1592, y: 999, w: 328, h: 33 });
    }

    #[test]
    fn a_plate_wider_than_the_screen_takes_the_screen() {
        let rect = keep_inside(Rect { x: -40, y: 10, w: 2400, h: 33 }, WORK);
        assert_eq!(rect, Rect { x: 0, y: 10, w: 1920, h: 33 });
    }

    #[test]
    fn dragging_the_body_moves_and_keeps_the_size() {
        let drag = Drag { grab: Grab::Move, cursor: (1700.0, 1000.0), rect: Rect { x: 1577, y: 984, w: 328, h: 33 } };
        let rect = dragged(&drag, (1500.4, 700.6), 130);
        assert_eq!(rect, Rect { x: 1377, y: 685, w: 328, h: 33 });
    }

    #[test]
    fn dragging_an_edge_changes_the_width_only() {
        let start = Rect { x: 1000, y: 500, w: 328, h: 33 };
        let right = Drag { grab: Grab::Right, cursor: (1328.0, 510.0), rect: start };
        assert_eq!(dragged(&right, (1400.0, 900.0), 130), Rect { x: 1000, y: 500, w: 400, h: 33 });
        assert_eq!(dragged(&right, (900.0, 510.0), 130), Rect { x: 1000, y: 500, w: 130, h: 33 }, "not under the least width");

        let left = Drag { grab: Grab::Left, cursor: (1000.0, 510.0), rect: start };
        let wider = dragged(&left, (900.0, 510.0), 130);
        assert_eq!(wider, Rect { x: 900, y: 500, w: 428, h: 33 });
        assert_eq!(wider.x + wider.w, start.x + start.w, "the right edge stays");
        let least = dragged(&left, (1300.0, 510.0), 130);
        assert_eq!(least, Rect { x: 1198, y: 500, w: 130, h: 33 });
    }

    #[test]
    fn the_corner_nearest_to_the_screen_edges_is_the_anchor() {
        let lower_right = anchor_of(Rect { x: 1577, y: 984, w: 328, h: 33 }, WORK, 262.0);
        assert_eq!(lower_right, geometry(1905, 1017, true, true, 262.0));
        let upper_left = anchor_of(Rect { x: 20, y: 30, w: 328, h: 33 }, WORK, 262.0);
        assert_eq!(upper_left, geometry(20, 30, false, false, 262.0));
        let upper_right = anchor_of(Rect { x: 1500, y: 30, w: 328, h: 33 }, WORK, 262.0);
        assert_eq!(upper_right, geometry(1828, 30, true, false, 262.0));
    }

    #[test]
    fn a_place_survives_the_round_trip() {
        let g = geometry(1905, 1017, true, true, 262.0);
        let rect = place(&g, plate_size(g.width, 104.0, 26.04, 1.25), WORK);
        assert_eq!(anchor_of(rect, WORK, g.width), g);
    }

    #[test]
    fn geometry_travels_in_camel_case() {
        let g = geometry(1905, 1017, true, false, 262.5);
        let json = serde_json::to_value(g).unwrap();
        assert_eq!(json, serde_json::json!({ "anchorX": 1905, "anchorY": 1017, "fromRight": true, "fromBottom": false, "width": 262.5 }));
        assert_eq!(serde_json::from_value::<WidgetGeometry>(json).unwrap(), g);
        assert_eq!(serde_json::from_str::<Grab>("\"left\"").unwrap(), Grab::Left);
    }
}
