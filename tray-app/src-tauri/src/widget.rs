// Desktop widget: a third webview window ("widget") that keeps the day's
// manual timers on the desktop — transparent, always on top, off the taskbar,
// never focusable (clicks land, focus never moves). Created on demand and
// destroyed when there is nothing to show, like the toast.
//
// The window catches the mouse with its whole rectangle, so it is exactly the
// plate: the frontend reports the plate's logical size (fit_widget) and Rust
// sizes the window to it in physical pixels. The height follows the rows; only
// the width is the user's. The window grows away from the screen edge it is
// nearest to — that edge (the anchor) stays put. On Windows the widget may
// stand on the taskbar as well; there it is kept above the taskbar (see the
// taskbar module below).
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

/// Some of the window lies outside the work area — on the taskbar.
fn on_taskbar(rect: Rect, work: Rect) -> bool {
    keep_inside(rect, work) != rect
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

fn work_rect(monitor: &Monitor) -> Rect {
    let area = monitor.work_area();
    Rect {
        x: area.position.x,
        y: area.position.y,
        w: area.size.width as i32,
        h: area.size.height as i32,
    }
}

/// Where the widget may stand. On Windows — the whole screen: the taskbar is a
/// place too. Elsewhere — the work area: the Dock and the menu bar draw over
/// any window of ours.
fn bounds_rect(monitor: &Monitor) -> Rect {
    if cfg!(windows) {
        let position = monitor.position();
        let size = monitor.size();
        Rect { x: position.x, y: position.y, w: size.width as i32, h: size.height as i32 }
    } else {
        work_rect(monitor)
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

/// The window has taken its place: on the taskbar it is kept above it.
#[cfg(windows)]
fn settle(window: &WebviewWindow, rect: Rect, work: Rect) {
    match window.hwnd() {
        Ok(hwnd) if on_taskbar(rect, work) => taskbar::keep_above(hwnd.0 as isize),
        _ => taskbar::leave(),
    }
}

#[cfg(not(windows))]
fn settle(_window: &WebviewWindow, _rect: Rect, _work: Rect) {}

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
        #[cfg(windows)]
        taskbar::leave();
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

    let rect = place(&geometry, plate_size(geometry.width, min_width, height, scale), bounds_rect(&monitor));
    apply_rect(&window, rect)?;
    window.show().map_err(|e| e.to_string())?;
    settle(&window, rect, work);
    Ok(())
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

/// The drag is over: the window settles inside its screen (on Windows the
/// taskbar is part of it), its nearest corner becomes the anchor, and the main
/// window gets the geometry to keep.
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
    let bounds = bounds_rect(&monitor);
    let scale = monitor.scale_factor();
    let settled = keep_inside(rect, bounds);
    // A move leaves the user's width as it was: the window may be wider than
    // it only because its rows need more.
    let width = match (drag.grab, stored) {
        (Grab::Move, Some(g)) => g.width,
        _ => settled.w as f64 / scale,
    };
    let geometry = anchor_of(settled, bounds, width);
    // The plate as its rows want it now — they may have changed under the drag.
    let fitted = if height > 0.0 {
        place(&geometry, plate_size(geometry.width, min_width, height, scale), bounds)
    } else {
        settled
    };
    if fitted != rect {
        apply_rect(&window, fitted)?;
    }
    settle(&window, fitted, work);
    if stored == Some(geometry) {
        return Ok(());
    }
    STATE.lock().unwrap().geometry = Some(geometry);
    app.emit_to("main", "widget-geometry", geometry).map_err(|e| e.to_string())
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

// ─── On the taskbar (Windows) ───────────────────────────────────────────
//
// The taskbar is a topmost window as well, and every click on it brings it
// above the other topmost ones — over a widget standing on it. Such a widget
// is put back on top: at once when the foreground window changes (a click on
// the taskbar is one), and on a slow timer for what comes without that event.
// Only a taskbar lying over the widget moves it; menus and tooltips do not.
#[cfg(windows)]
mod taskbar {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Once;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, EnumWindows, GetClassNameW, GetMessageW, GetWindowRect, IsWindow,
        IsWindowVisible, SetTimer, SetWindowPos, EVENT_SYSTEM_FOREGROUND, HWND_TOPMOST, MSG,
        SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WINEVENT_OUTOFCONTEXT, WM_TIMER,
    };

    const RECHECK_MS: u32 = 500;
    const TASKBAR_CLASSES: [&str; 2] = ["Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// The widget's window while it stands on the taskbar; 0 — it does not.
    static WIDGET: AtomicIsize = AtomicIsize::new(0);
    static WATCH: Once = Once::new();

    struct Probe {
        widget: HWND,
        rect: RECT,
        covered: bool,
    }

    /// The widget stands on the taskbar from now on.
    pub fn keep_above(hwnd: isize) {
        WIDGET.store(hwnd, Ordering::Relaxed);
        // The watch starts with the first widget put on the taskbar and lives
        // on: without one it has nothing to lift.
        WATCH.call_once(|| {
            std::thread::spawn(watch);
        });
        lift();
    }

    /// The widget left the taskbar, or is gone.
    pub fn leave() {
        WIDGET.store(0, Ordering::Relaxed);
    }

    // The hook's callbacks arrive through this thread's message loop.
    fn watch() {
        unsafe {
            SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(on_foreground),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            SetTimer(std::ptr::null_mut(), 0, RECHECK_MS, None);
            let mut message: MSG = std::mem::zeroed();
            while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                if message.message == WM_TIMER {
                    lift();
                }
                DispatchMessageW(&message);
            }
        }
    }

    unsafe extern "system" fn on_foreground(
        _hook: HWINEVENTHOOK,
        _event: u32,
        _hwnd: HWND,
        _object: i32,
        _child: i32,
        _thread: u32,
        _time: u32,
    ) {
        lift();
    }

    fn lift() {
        let widget = WIDGET.load(Ordering::Relaxed) as HWND;
        if widget.is_null() {
            return;
        }
        unsafe {
            let mut probe = Probe { widget, rect: std::mem::zeroed(), covered: false };
            if IsWindow(widget) == 0 || GetWindowRect(widget, &mut probe.rect) == 0 {
                return;
            }
            EnumWindows(Some(above), &mut probe as *mut Probe as LPARAM);
            if probe.covered {
                SetWindowPos(
                    widget,
                    HWND_TOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                );
            }
        }
    }

    // Windows come from the top down: a taskbar met before the widget lies over it.
    unsafe extern "system" fn above(hwnd: HWND, lparam: LPARAM) -> i32 {
        let probe = &mut *(lparam as *mut Probe);
        if hwnd == probe.widget {
            return 0;
        }
        if is_taskbar(hwnd) && IsWindowVisible(hwnd) != 0 && overlaps(hwnd, &probe.rect) {
            probe.covered = true;
            return 0;
        }
        1
    }

    unsafe fn is_taskbar(hwnd: HWND) -> bool {
        let mut name = [0u16; 32];
        let length = GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32);
        let class = String::from_utf16_lossy(&name[..length.max(0) as usize]);
        TASKBAR_CLASSES.contains(&class.as_str())
    }

    unsafe fn overlaps(hwnd: HWND, rect: &RECT) -> bool {
        let mut other: RECT = std::mem::zeroed();
        GetWindowRect(hwnd, &mut other) != 0
            && other.left < rect.right
            && rect.left < other.right
            && other.top < rect.bottom
            && rect.top < other.bottom
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 1920x1080 screen at 125 % with a 48px taskbar at the bottom.
    const WORK: Rect = Rect { x: 0, y: 0, w: 1920, h: 1032 };
    const SCREEN: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };

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
    fn the_taskbar_is_a_place_too() {
        let on_the_bar = Rect { x: 1372, y: 1040, w: 328, h: 33 };
        assert_eq!(keep_inside(on_the_bar, SCREEN), on_the_bar, "the screen keeps it where it was put");
        assert!(on_taskbar(on_the_bar, WORK));
        assert!(on_taskbar(Rect { y: 1010, ..on_the_bar }, WORK), "half on it counts");
        assert!(!on_taskbar(Rect { y: 999, ..on_the_bar }, WORK), "right above it does not");

        let stored = anchor_of(on_the_bar, SCREEN, 262.0);
        assert_eq!(stored, geometry(1700, 1073, true, true, 262.0));
        assert_eq!(place(&stored, (328, 33), SCREEN), on_the_bar, "and it comes back there");
        let two_rows = place(&stored, (328, 66), SCREEN);
        assert_eq!(two_rows.y + two_rows.h, 1073, "rows still grow upwards from it");
    }

    #[test]
    fn a_drag_past_the_screen_edge_is_brought_back_to_it() {
        let below = keep_inside(Rect { x: 1700, y: 1070, w: 328, h: 33 }, SCREEN);
        assert_eq!(below, Rect { x: 1592, y: 1047, w: 328, h: 33 });
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
