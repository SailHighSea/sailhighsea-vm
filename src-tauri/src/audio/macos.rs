//! macOS backend: CoreAudio has no public per-app volume API, so only the
//! default output is exposed as a single device (controlled via AppleScript).
use super::{Device, State};
use std::process::Command;

fn osa(script: &str) -> Option<String> {
    let o = Command::new("osascript").args(["-e", script]).output().ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

pub fn state() -> State {
    let volume = osa("output volume of (get volume settings)")
        .and_then(|s| s.parse::<f32>().ok())
        .unwrap_or(0.0)
        / 100.0;
    let muted = osa("output muted of (get volume settings)")
        .map(|s| s == "true")
        .unwrap_or(false);
    State {
        devices: vec![Device {
            id: "dev|default".into(),
            name: "System output".into(),
            sub: "Default device".into(),
            volume,
            muted,
            peak: 0.0,
            is_default: true,
        }],
        apps: vec![],
    }
}

pub fn set_volume(_id: &str, v: f32) -> Result<(), String> {
    osa(&format!(
        "set volume output volume {}",
        (v * 100.0).round() as u32
    ))
    .map(|_| ())
    .ok_or_else(|| "osascript failed".to_string())
}

pub fn set_mute(_id: &str, m: bool) -> Result<(), String> {
    osa(&format!("set volume output muted {m}"))
        .map(|_| ())
        .ok_or_else(|| "osascript failed".to_string())
}

pub fn set_route(_app_id: &str, _device_id: &str) -> Result<(), String> {
    Err("Per-app routing isn't available on macOS".into())
}

pub fn set_mirrors(_pid: u32, mirrors: &[super::MirrorReq]) -> Result<(), String> {
    if mirrors.is_empty() {
        Ok(())
    } else {
        Err("Mirrored outputs aren't available on macOS".into())
    }
}

pub fn set_dynamics(_pid: u32, _cfg: &super::Dyn) -> Result<(), String> {
    Err("The compressor and gate aren't available on macOS".into())
}

pub fn set_eq(_pid: u32, _enabled: bool, _preamp: f32, _gains: &[f32]) -> Result<(), String> {
    Err("The equalizer isn't available on macOS".into())
}

pub fn set_takeover(_pid: u32, _app_id: &str, _park: &str, _enable: bool) -> Result<(), String> {
    Err("EQ take-over isn't available on macOS".into())
}

pub fn restore_all() {}

/// App icons are only implemented on Windows.
pub fn app_icon(_pid: u32) -> Option<String> {
    None
}

pub fn set_default_device(_device_id: &str) -> Result<(), String> {
    Err("Switching the default output isn't available on macOS yet".into())
}
