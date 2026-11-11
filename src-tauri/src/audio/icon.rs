//! Windows: extract an app's icon (from its process exe) as a PNG data URL.
use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Gdi::*;
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::System::Threading::*;
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

fn cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static C: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn exe_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1040];
        let mut len = buf.len() as u32;
        let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
        let _ = CloseHandle(h);
        r.ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// PNG data URL of the icon of the process `pid`, or None.
pub fn app_icon(pid: u32) -> Option<String> {
    let path = exe_path(pid)?;
    if let Some(v) = cache().lock().ok()?.get(&path) {
        return v.clone();
    }
    let v = unsafe { extract(&path) }.map(|(w, h, rgba)| format!("data:image/png;base64,{}", b64(&png(w, h, &rgba))));
    cache().lock().ok()?.insert(path, v.clone());
    v
}

unsafe fn dib(hdc: HDC, hbm: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut bi = BITMAPINFO::default();
    bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB.0;
    let mut px = vec![0u8; (w * h * 4) as usize];
    let n = GetDIBits(hdc, hbm, 0, h as u32, Some(px.as_mut_ptr() as *mut c_void), &mut bi, DIB_RGB_COLORS);
    if n == 0 {
        None
    } else {
        Some(px)
    }
}

unsafe fn extract(path: &str) -> Option<(u32, u32, Vec<u8>)> {
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let mut info = SHFILEINFOW::default();
    let r = SHGetFileInfoW(
        PCWSTR(wide.as_ptr()),
        FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut info),
        std::mem::size_of::<SHFILEINFOW>() as u32,
        SHGFI_ICON | SHGFI_LARGEICON,
    );
    if r == 0 || info.hIcon.is_invalid() {
        return None;
    }
    let mut ii = ICONINFO::default();
    let got = GetIconInfo(info.hIcon, &mut ii).is_ok();
    let mut out = None;
    if got && !ii.hbmColor.is_invalid() {
        let mut bm = BITMAP::default();
        GetObjectW(ii.hbmColor.into(), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut c_void));
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        let hdc = GetDC(None);
        if w > 0 && h > 0 {
            if let Some(mut px) = dib(hdc, ii.hbmColor, w, h) {
                if px.chunks(4).all(|p| p[3] == 0) {
                    // icon without an alpha channel: build it from the mask
                    if let Some(mask) = dib(hdc, ii.hbmMask, w, h) {
                        for (p, m) in px.chunks_mut(4).zip(mask.chunks(4)) {
                            p[3] = if m[0] > 127 { 0 } else { 255 };
                        }
                    }
                }
                for p in px.chunks_mut(4) {
                    p.swap(0, 2); // BGRA -> RGBA
                }
                out = Some((w as u32, h as u32, px));
            }
        }
        ReleaseDC(None, hdc);
    }
    if !ii.hbmColor.is_invalid() {
        let _ = DeleteObject(ii.hbmColor.into());
    }
    if !ii.hbmMask.is_invalid() {
        let _ = DeleteObject(ii.hbmMask.into());
    }
    let _ = DestroyIcon(info.hIcon);
    out
}

// ---- minimal PNG (stored deflate) + base64 ----
fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &x in data {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend((data.len() as u32).to_be_bytes());
    let mut body = kind.to_vec();
    body.extend(data);
    out.extend(&body);
    out.extend(crc32(&body).to_be_bytes());
}

fn png(w: u32, h: u32, rgba: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity((w * h * 4 + h) as usize);
    for row in rgba.chunks((w * 4) as usize) {
        raw.push(0);
        raw.extend(row);
    }
    let mut z = vec![0x78, 0x01];
    let mut chunks = raw.chunks(65535).peekable();
    while let Some(c) = chunks.next() {
        z.push(if chunks.peek().is_none() { 1 } else { 0 });
        z.extend((c.len() as u16).to_le_bytes());
        z.extend((!(c.len() as u16)).to_le_bytes());
        z.extend(c);
    }
    z.extend(adler32(&raw).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut ihdr = Vec::new();
    ihdr.extend(w.to_be_bytes());
    ihdr.extend(h.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &z);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn b64(d: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(d.len() * 4 / 3 + 4);
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}
