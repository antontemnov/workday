use tauri::image::Image;

/// Status drives the daemon's eyes. `Live` (tracking) lights them green;
/// every other state leaves the sockets empty.
#[derive(Debug, Clone, Copy)]
pub enum TrayStatus {
    Live,    // tracking — green eyes
    Pending, // empty sockets
    Idle,    // empty sockets
    Paused,  // empty sockets
    None,    // empty sockets
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

    fn eyes_svg(self) -> &'static str {
        // Use r##"..."## so the SVG attribute sequence `"#` (e.g. fill="#a6e3a1")
        // doesn't terminate the raw string the way r#"..."# would.
        match self {
            TrayStatus::Live => {
                r##"<ellipse cx="23.6" cy="42.8" rx="4.6" ry="7.2" fill="#a6e3a1"/>
                    <ellipse cx="40.4" cy="42.8" rx="4.6" ry="7.2" fill="#a6e3a1"/>"##
            }
            _ => "",
        }
    }
}

/// The workday daemon (64 viewBox): bell head with horns, lavender #b7bdda.
/// Eye sockets are punched through the head path (fill-rule evenodd), so at
/// rest the taskbar shows through them — literally empty eyes.
/// Horns are bolder than the Start-menu tile's: at 16–24px thin horns
/// dissolve into antialiasing.
const DEMON_SVG_BODY: &str = r##"
  <path d="M 12.8 32.8 Q 9.6 22.4 14.6 13.6 Q 21.8 20 25.6 28 Z" fill="#b7bdda"/>
  <path d="M 51.2 32.8 Q 54.4 22.4 49.4 13.6 Q 42.2 20 38.4 28 Z" fill="#b7bdda"/>
  <path fill-rule="evenodd" fill="#b7bdda" d="M 9.4 55 C 9.6 46 10.8 40 13.2 36 C 15.6 27.6 22.4 25.6 32 25.6 C 41.6 25.6 48.4 27.6 50.8 36 C 53.2 40 54.4 46 54.6 55 Q 32 62.5 9.4 55 Z M 16.8 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z M 33.6 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z"/>
"##;

/// Optically centers the glyph (its own center of mass sits at y≈36.8 of 64,
/// which read as "sunk" in the taskbar) and scales it up to fill the canvas.
const GLYPH_TRANSFORM: &str = "translate(32 32) scale(1.17) translate(-32 -36.8)";

/// Build an RGBA icon at `size` px: daemon silhouette + status eyes.
/// `size` should be the physical tray icon size (16 × DPI scale) — rendering
/// the vector at the exact size avoids the shell's blurry downscale.
/// Returns a Tauri `Image` ready to hand to `tray.set_icon(...)`.
pub fn build(status: TrayStatus, size: u32) -> Result<Image<'static>, String> {
    let size = size.clamp(16, 64);
    let svg = format!(
        r##"<svg width="{size}" height="{size}" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
              <g transform="{transform}">
                {body}
                {eyes}
              </g>
            </svg>"##,
        size = size,
        transform = GLYPH_TRANSFORM,
        body = DEMON_SVG_BODY,
        eyes = status.eyes_svg()
    );

    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default())
        .map_err(|e| format!("parse svg: {}", e))?;
    let mut pixmap = tiny_skia::Pixmap::new(size, size).ok_or("alloc pixmap")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );

    // tiny-skia produces premultiplied RGBA. Tauri's Image::new_owned expects
    // straight (non-premultiplied) RGBA — convert before handing it over so
    // semi-transparent edges (antialiased pixels) don't render darker.
    let rgba = unpremultiply(pixmap.data());
    Ok(Image::new_owned(rgba, size, size))
}

/// Premultiplied → straight RGBA. Both inputs and outputs are RGBA8.
fn unpremultiply(premul: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(premul.len());
    for chunk in premul.chunks_exact(4) {
        let (r, g, b, a) = (chunk[0], chunk[1], chunk[2], chunk[3]);
        if a == 0 {
            out.extend_from_slice(&[0, 0, 0, 0]);
        } else if a == 255 {
            out.extend_from_slice(&[r, g, b, a]);
        } else {
            let af = a as f32 / 255.0;
            out.push(((r as f32 / af).round().min(255.0)) as u8);
            out.push(((g as f32 / af).round().min(255.0)) as u8);
            out.push(((b as f32 / af).round().min(255.0)) as u8);
            out.push(a);
        }
    }
    out
}
