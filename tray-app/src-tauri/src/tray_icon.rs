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

/// The workday daemon at 64×64: bell head with horns, lavender #b7bdda.
/// Eye sockets are punched through the head path (fill-rule evenodd), so at
/// rest the taskbar shows through them — literally empty eyes.
const DEMON_SVG_BODY: &str = r##"
  <path d="M 14.4 32.8 Q 11.2 22.4 15.2 13.6 Q 20.8 20 24 28 Z" fill="#b7bdda"/>
  <path d="M 49.6 32.8 Q 52.8 22.4 48.8 13.6 Q 43.2 20 40 28 Z" fill="#b7bdda"/>
  <path fill-rule="evenodd" fill="#b7bdda" d="M 8.8 60 C 9.2 46.4 10.8 40 13.2 36 C 15.6 27.6 22.4 25.6 32 25.6 C 41.6 25.6 48.4 27.6 50.8 36 C 53.2 40 54.8 46.4 55.2 60 Z M 16.8 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z M 33.6 42.8 a 6.8 9.4 0 1 0 13.6 0 a 6.8 9.4 0 1 0 -13.6 0 Z"/>
"##;

/// Build a 64×64 RGBA icon: daemon silhouette + status eyes.
/// Returns a Tauri `Image` ready to hand to `tray.set_icon(...)`.
pub fn build(status: TrayStatus) -> Result<Image<'static>, String> {
    const SIZE: u32 = 64;
    let svg = format!(
        r##"<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}" xmlns="http://www.w3.org/2000/svg">
              {body}
              {eyes}
            </svg>"##,
        size = SIZE,
        body = DEMON_SVG_BODY,
        eyes = status.eyes_svg()
    );

    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default())
        .map_err(|e| format!("parse svg: {}", e))?;
    let mut pixmap = tiny_skia::Pixmap::new(SIZE, SIZE).ok_or("alloc pixmap")?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );

    // tiny-skia produces premultiplied RGBA. Tauri's Image::new_owned expects
    // straight (non-premultiplied) RGBA — convert before handing it over so
    // semi-transparent edges (antialiased pixels) don't render darker.
    let rgba = unpremultiply(pixmap.data());
    Ok(Image::new_owned(rgba, SIZE, SIZE))
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
