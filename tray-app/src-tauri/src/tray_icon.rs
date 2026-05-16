use tauri::image::Image;

/// Status drives the colour of the dot painted in the icon's bottom-right
/// corner. `None` means "no dot", reserved for the no-session state.
#[derive(Debug, Clone, Copy)]
pub enum TrayStatus {
    Live,    // green
    Pending, // yellow
    Idle,    // orange
    Paused,  // grey (hollow)
    None,    // no dot — base octocat only
}

impl TrayStatus {
    pub fn parse(kind: &str) -> Self {
        match kind {
            "live" => TrayStatus::Live,
            "pending" => TrayStatus::Pending,
            "idle" => TrayStatus::Idle,
            "paused" => TrayStatus::Paused,
            _ => TrayStatus::None,
        }
    }

    fn dot_svg(self) -> &'static str {
        match self {
            TrayStatus::Live =>
                r#"<circle cx="50" cy="50" r="10" fill="#a6e3a1" stroke="#1e1e2e" stroke-width="2"/>"#,
            TrayStatus::Pending =>
                r#"<circle cx="50" cy="50" r="10" fill="#f9e2af" stroke="#1e1e2e" stroke-width="2"/>"#,
            TrayStatus::Idle =>
                r#"<circle cx="50" cy="50" r="10" fill="#fab387" stroke="#1e1e2e" stroke-width="2"/>"#,
            TrayStatus::Paused =>
                r#"<circle cx="50" cy="50" r="9" fill="none" stroke="#6c7086" stroke-width="2.5"/>"#,
            TrayStatus::None => "",
        }
    }
}

/// Octocat path from GitHub's mark-github octicon (MIT-licensed via primer/octicons).
/// 24x24 viewBox; we scale and translate it inside a 64x64 canvas.
const OCTOCAT_PATH: &str = "M10.226 17.284c-2.965-.36-5.054-2.493-5.054-5.256 0-1.123.404-2.336 1.078-3.144-.292-.741-.247-2.314.09-2.965.898-.112 2.111.36 2.83 1.01.853-.269 1.752-.404 2.853-.404 1.1 0 1.999.135 2.807.382.696-.629 1.932-1.1 2.83-.988.315.606.36 2.179.067 2.942.72.854 1.101 2 1.101 3.167 0 2.763-2.089 4.852-5.098 5.234.763.494 1.28 1.572 1.28 2.807v2.336c0 .674.561 1.056 1.235.786 4.066-1.55 7.255-5.615 7.255-10.646C23.5 6.188 18.334 1 11.978 1 5.62 1 .5 6.188.5 12.545c0 4.986 3.167 9.12 7.435 10.669.606.225 1.19-.18 1.19-.786V20.63a2.9 2.9 0 0 1-1.078.224c-1.483 0-2.359-.808-2.987-2.313-.247-.607-.517-.966-1.034-1.033-.27-.023-.359-.135-.359-.27 0-.27.45-.471.898-.471.652 0 1.213.404 1.797 1.235.45.651.921.943 1.483.943.561 0 .92-.202 1.437-.719.382-.381.674-.718.944-.943";

/// Build a 64×64 RGBA icon: octocat silhouette + optional status dot.
/// Returns a Tauri `Image` ready to hand to `tray.set_icon(...)`.
pub fn build(status: TrayStatus) -> Result<Image<'static>, String> {
    const SIZE: u32 = 64;
    // Octocat path is 24×24. We scale by ~2.4 to fit inside 64×64 with ~4px
    // breathing room on each side; transform=scale(2.4) translate(2, 1).
    let svg = format!(
        r##"<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" xmlns="http://www.w3.org/2000/svg">
              <g transform="translate(2,1) scale(2.4)">
                <path d="{path}" fill="#cdd6f4"/>
              </g>
              {dot}
            </svg>"##,
        size = SIZE,
        path = OCTOCAT_PATH,
        dot = status.dot_svg()
    );

    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default())
        .map_err(|e| format!("parse svg: {}", e))?;
    let mut pixmap = tiny_skia::Pixmap::new(SIZE, SIZE).ok_or("alloc pixmap")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );

    // Encode to PNG so we can hand Tauri's Image::from_bytes a self-describing
    // buffer — avoids fragile assumptions about RGBA pre-multiplication and
    // returns an owned Image<'static> in one step.
    let png = pixmap
        .encode_png()
        .map_err(|e| format!("encode png: {}", e))?;
    Image::from_bytes(&png).map_err(|e| format!("decode png: {}", e))
}
