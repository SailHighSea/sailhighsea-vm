//! Files kept next to the executable:
//! - `sailhighsea-vm.ini`  settings (written by the UI, read at start and injected into the webviews)
//! - `crash.log`           panics (with a backtrace) and JavaScript errors, appended
use serde_json::{Map, Value};
use std::io::Write;
use std::path::PathBuf;

/// Folder for the settings and logs. Portable: the folder of the program itself. For an AppImage that is
/// the folder holding the .AppImage file (the program runs from a temporary mount), and for a macOS
/// app bundle the folder that holds the .app.
pub fn app_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("APPIMAGE").map(PathBuf::from) {
        if let Some(d) = p.parent() {
            return d.to_path_buf();
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(exe) = std::env::current_exe() {
        for a in exe.ancestors() {
            if a.extension().map_or(false, |e| e == "app") {
                if let Some(d) = a.parent() {
                    return d.to_path_buf();
                }
            }
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn ini_path() -> PathBuf {
    app_dir().join("sailhighsea-vm.ini")
}

fn crash_path() -> PathBuf {
    app_dir().join("crash.log")
}

/// Parse the INI into `{ section: { key: "raw value" } }` (the UI decodes the values).
pub fn read_ini_json() -> Value {
    let mut root = Map::new();
    let Ok(text) = std::fs::read_to_string(ini_path()) else {
        return Value::Object(root);
    };
    let mut section = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_string();
            root.entry(section.clone()).or_insert_with(|| Value::Object(Map::new()));
        } else if let Some((k, v)) = line.split_once('=') {
            if section.is_empty() {
                continue;
            }
            if let Some(Value::Object(m)) = root.get_mut(&section) {
                m.insert(k.trim().to_string(), Value::String(v.trim().to_string()));
            }
        }
    }
    Value::Object(root)
}

pub fn write_ini(text: &str) -> Result<(), String> {
    let tmp = ini_path().with_extension("ini.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, ini_path()).map_err(|e| e.to_string())
}

/// "YYYY-MM-DD HH:MM:SS" (UTC) without extra dependencies.
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC", rem / 3600, rem % 3600 / 60, rem % 60)
}

pub fn log_crash(kind: &str, message: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(crash_path()) {
        let _ = writeln!(
            f,
            "[{}] {} (v{})\n{}\n{}\n",
            timestamp(),
            kind,
            env!("CARGO_PKG_VERSION"),
            message.trim_end(),
            "-".repeat(60)
        );
    }
}

/// Append a line to debug.log next to the exe (routing attempts etc.); the file is reset when it grows past 256 KB.
pub fn log_debug(msg: &str) {
    let path = app_dir().join("debug.log");
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] {}", timestamp(), msg);
    }
}

/// Write every Rust panic (any thread) to crash.log before the process aborts.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(no message)".into());
        let bt = std::backtrace::Backtrace::force_capture();
        log_crash(
            "PANIC",
            &format!("thread '{}' panicked at {}\n{}\n\nbacktrace:\n{}", thread.name().unwrap_or("?"), loc, msg, bt),
        );
        default(info);
    }));
}
