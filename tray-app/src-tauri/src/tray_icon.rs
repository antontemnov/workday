use tauri::image::Image;

/// Status drives the daemon's eyes: they burn with the colour of whoever
/// counts — green for a session (`Live`), orange for a manual timer
/// (`Timer`). Every other state leaves the sockets empty.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TrayStatus {
    Live,    // a session counts — green eyes
    Timer,   // a manual timer counts — orange eyes
    Pending, // empty sockets
    Idle,    // empty sockets
    Paused,  // empty sockets
    None,    // empty sockets
}

impl TrayStatus {
    pub fn parse(kind: &str) -> Self {
        match kind {
            "live" => TrayStatus::Live,
            "timer" => TrayStatus::Timer,
            "pending" => TrayStatus::Pending,
            "idle" => TrayStatus::Idle,
            "paused" => TrayStatus::Paused,
            _ => TrayStatus::None,
        }
    }

    fn eyes_svg(self) -> &'static str {
        // Use r##"..."## so the SVG attribute sequence `"#` (e.g. fill="#2aa757")
        // doesn't terminate the raw string the way r#"..."# would.
        //
        // Two layers per eye: saturated green iris nearly filling the socket
        // plus a pale glowing core. The old single pastel #a6e3a1 ellipse had
        // almost the same luminance as the lavender face — invisible at 16px.
        match self {
            TrayStatus::Live => {
                r##"<ellipse cx="23.6" cy="42.8" rx="6.4" ry="8.9" fill="#2aa757"/>
                    <ellipse cx="40.4" cy="42.8" rx="6.4" ry="8.9" fill="#2aa757"/>
                    <ellipse cx="23.6" cy="42.8" rx="3" ry="4.6" fill="#d9ffe0"/>
                    <ellipse cx="40.4" cy="42.8" rx="3" ry="4.6" fill="#d9ffe0"/>"##
            }
            // The iris is darker than the app's timer orange: at that
            // brightness it would melt into the lavender face.
            TrayStatus::Timer => {
                r##"<ellipse cx="23.6" cy="42.8" rx="6.4" ry="8.9" fill="#e8690a"/>
                    <ellipse cx="40.4" cy="42.8" rx="6.4" ry="8.9" fill="#e8690a"/>
                    <ellipse cx="23.6" cy="42.8" rx="3" ry="4.6" fill="#ffe2bf"/>
                    <ellipse cx="40.4" cy="42.8" rx="3" ry="4.6" fill="#ffe2bf"/>"##
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

#[cfg(test)]
mod tests {
    use super::*;

    // The left eye's centre on a 64px canvas, after the glyph transform.
    const EYE: (u32, u32) = (22, 39);
    // A point of the iris ring, outside the pale core.
    const IRIS: (u32, u32) = (17, 39);

    fn pixel(status: TrayStatus, at: (u32, u32)) -> [u8; 4] {
        let icon = build(status, 64).unwrap();
        let i = ((at.1 * icon.width() + at.0) * 4) as usize;
        let rgba = icon.rgba();
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn a_session_lights_green_eyes() {
        assert_eq!(pixel(TrayStatus::Live, EYE), [0xd9, 0xff, 0xe0, 255]);
        assert_eq!(pixel(TrayStatus::Live, IRIS), [0x2a, 0xa7, 0x57, 255]);
    }

    #[test]
    fn a_timer_lights_orange_eyes() {
        assert_eq!(pixel(TrayStatus::Timer, EYE), [0xff, 0xe2, 0xbf, 255]);
        assert_eq!(pixel(TrayStatus::Timer, IRIS), [0xe8, 0x69, 0x0a, 255]);
    }

    #[test]
    fn nobody_counts_the_sockets_are_empty() {
        for status in [TrayStatus::Pending, TrayStatus::Idle, TrayStatus::Paused, TrayStatus::None] {
            assert_eq!(pixel(status, EYE)[3], 0, "{status:?}");
            assert_eq!(pixel(status, IRIS)[3], 0, "{status:?}");
        }
    }

    #[test]
    fn the_kind_word_picks_the_eyes() {
        assert_eq!(TrayStatus::parse("live"), TrayStatus::Live);
        assert_eq!(TrayStatus::parse("timer"), TrayStatus::Timer);
        assert_eq!(TrayStatus::parse("paused"), TrayStatus::Paused);
        assert_eq!(TrayStatus::parse("anything else"), TrayStatus::None);
    }
}
