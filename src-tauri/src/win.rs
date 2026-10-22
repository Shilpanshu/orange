//! Thin Win32 helpers: window placement (per-monitor DPI), showing without activation, shell
//! thumbnails, and Explorer reveal/open.

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, POINT, RECT, SIZE};
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

pub struct Placed {
    /// Cursor position relative to the window, in CSS pixels.
    pub cursor_x: f64,
    pub cursor_y: f64,
}

/// DPI scale of the monitor nearest a physical screen point.
pub fn monitor_scale(p: POINT) -> (f64, RECT) {
    unsafe {
        let mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        let _ = GetMonitorInfoW(mon, &mut mi);
        let (mut dx, mut dy) = (96u32, 96u32);
        let _ = GetDpiForMonitor(mon, MDT_EFFECTIVE_DPI, &mut dx, &mut dy);
        (dx as f64 / 96.0, mi.rcWork)
    }
}

/// Centres a square window of `size` CSS px on the cursor, kept inside the work area of the
/// cursor's monitor. All maths is in physical pixels at that monitor's scale, so it is right on
/// mixed-DPI setups whichever monitor the window was on before.
pub fn place_under_cursor(hwnd: HWND, size: f64) -> Placed {
    unsafe {
        let mut p = POINT::default();
        let _ = GetCursorPos(&mut p);
        let (scale, wa) = monitor_scale(p);
        let s = (size * scale).round() as i32;
        let x = (p.x - s / 2).clamp(wa.left, (wa.right - s).max(wa.left));
        let y = (p.y - s / 2).clamp(wa.top, (wa.bottom - s).max(wa.top));
        let flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER;
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, s, s, flags);
        // Moving onto a monitor with another DPI makes Windows send WM_DPICHANGED, which can
        // resize the window to its own suggestion: put it back exactly.
        let mut r = RECT::default();
        let _ = GetWindowRect(hwnd, &mut r);
        if r.left != x || r.top != y || r.right - r.left != s || r.bottom - r.top != s {
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, s, s, flags);
        }
        Placed { cursor_x: (p.x - x) as f64 / scale, cursor_y: (p.y - y) as f64 / scale }
    }
}

/// Offset of the client area inside the window rect, and the client size (diagnostics).
pub fn frame_inset(hwnd: HWND) -> (i32, i32, i32, i32) {
    unsafe {
        let (mut r, mut c, mut o) = (RECT::default(), RECT::default(), POINT::default());
        let _ = GetWindowRect(hwnd, &mut r);
        let _ = GetClientRect(hwnd, &mut c);
        let _ = ClientToScreen(hwnd, &mut o);
        (o.x - r.left, o.y - r.top, c.right, c.bottom)
    }
}

/// Shows a window on top without taking focus from the app the user is dragging from.
/// `activate` is for click mode, where the wheel needs the keyboard.
pub fn show_no_activate(hwnd: HWND, activate: bool) {
    unsafe {
        if activate {
            let _ = ShowWindow(hwnd, SW_SHOW);
            let _ = SetForegroundWindow(hwnd);
        } else {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

pub fn hide(hwnd: HWND) {
    unsafe {
        let _ = ShowWindow(hwnd, SW_HIDE);
    }
}

/// The shell's thumbnail (or file-type icon) for a path, as a PNG data URL.
pub fn thumbnail_data_url(path: &str, px: i32) -> Option<String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
        let hbm = factory.GetImage(SIZE { cx: px, cy: px }, SIIGBF_RESIZETOFIT | SIIGBF_BIGGERSIZEOK).ok()?;
        let rgba = bitmap_rgba(hbm);
        let _ = DeleteObject(hbm.into());
        let (w, h, px) = rgba?;
        let img = image::RgbaImage::from_raw(w, h, px)?;
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
        Some(format!("data:image/png;base64,{}", base64(&png)))
    }
}

pub unsafe fn bitmap_rgba(hbm: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
    let mut bm = BITMAP::default();
    if GetObjectW(hbm.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
        return None;
    }
    let (w, h) = (bm.bmWidth, bm.bmHeight);
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let dc = GetDC(None);
    let lines = GetDIBits(dc, hbm, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
    ReleaseDC(None, dc);
    if lines == 0 {
        return None;
    }
    // BGRA, premultiplied when the bitmap has alpha. Icons without an alpha channel come back
    // with alpha all zero: treat those as opaque.
    let has_alpha = buf.chunks_exact(4).any(|p| p[3] != 0);
    for p in buf.chunks_exact_mut(4) {
        let a = if has_alpha { p[3] } else { 255 };
        let un = |c: u8| if a == 0 || a == 255 { c } else { ((c as u32 * 255 + a as u32 / 2) / a as u32).min(255) as u8 };
        let (b, g, r) = (un(p[0]), un(p[1]), un(p[2]));
        p[0] = r;
        p[1] = g;
        p[2] = b;
        p[3] = a;
    }
    Some((w as u32, h as u32, buf))
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Opens an Explorer window with the file selected.
pub fn reveal(path: &str) {
    let _ = std::process::Command::new("explorer.exe").arg(format!("/select,{path}")).spawn();
}

/// Opens a file with its default app.
pub fn open_path(path: &str) {
    unsafe {
        let _ = ShellExecuteW(None, &HSTRING::from("open"), &HSTRING::from(path), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(super::base64(b""), "");
        assert_eq!(super::base64(b"f"), "Zg==");
        assert_eq!(super::base64(b"fo"), "Zm8=");
        assert_eq!(super::base64(b"foobar"), "Zm9vYmFy");
    }
}
