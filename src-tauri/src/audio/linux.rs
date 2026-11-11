//! Linux backend: PulseAudio / PipeWire-pulse through `pactl`.
//! Ids: devices are `dev|<sink index>`, app streams are `app|<sink-input index>`.
use super::{App, Device, State};
use serde_json::Value;
use std::process::Command;

fn pactl(args: &[&str]) -> Option<String> {
    let o = Command::new("pactl").args(args).output().ok()?;
    o.status
        .success()
        .then(|| String::from_utf8_lossy(&o.stdout).to_string())
}

fn json(args: &[&str]) -> Vec<Value> {
    let mut a = vec!["-f", "json"];
    a.extend_from_slice(args);
    pactl(&a)
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

fn percent(v: &Value) -> f32 {
    v["volume"]
        .as_object()
        .and_then(|m| m.values().next())
        .and_then(|c| c["value_percent"].as_str())
        .and_then(|s| s.trim_end_matches('%').parse::<f32>().ok())
        .map(|p| (p / 100.0).min(1.0))
        .unwrap_or(1.0)
}

pub fn state() -> State {
    let default = pactl(&["get-default-sink"]).unwrap_or_default().trim().to_string();
    let mut st = State::default();
    for s in json(&["list", "sinks"]) {
        let idx = s["index"].as_u64().unwrap_or(0);
        st.devices.push(Device {
            id: format!("dev|{idx}"),
            name: s["description"].as_str().unwrap_or("Output").to_string(),
            sub: s["name"].as_str().unwrap_or("").to_string(),
            volume: percent(&s),
            muted: s["mute"].as_bool().unwrap_or(false),
            peak: 0.0,
            is_default: s["name"].as_str() == Some(default.as_str()),
        });
    }
    for it in json(&["list", "sink-inputs"]) {
        let p = &it["properties"];
        let name = p["application.name"]
            .as_str()
            .or(p["media.name"].as_str())
            .unwrap_or("Unknown")
            .to_string();
        st.apps.push(App {
            id: format!("app|{}", it["index"].as_u64().unwrap_or(0)),
            name,
            sub: p["media.name"].as_str().unwrap_or("").to_string(),
            volume: percent(&it),
            muted: it["mute"].as_bool().unwrap_or(false),
            peak: 0.0,
            device_id: format!("dev|{}", it["sink"].as_u64().unwrap_or(0)),
            pid: 0,
            mirrors: Vec::new(),
            eq: None,
            dynamics: None,
            takeover: None,
        });
    }
    st
}

fn run(args: &[&str]) -> Result<(), String> {
    pactl(args)
        .map(|_| ())
        .ok_or_else(|| "pactl failed".to_string())
}

pub fn set_volume(id: &str, v: f32) -> Result<(), String> {
    let pct = format!("{}%", (v * 100.0).round() as u32);
    if let Some(i) = id.strip_prefix("dev|") {
        run(&["set-sink-volume", i, &pct])
    } else if let Some(i) = id.strip_prefix("app|") {
        run(&["set-sink-input-volume", i, &pct])
    } else {
        Err("bad id".into())
    }
}

pub fn set_mute(id: &str, m: bool) -> Result<(), String> {
    let f = if m { "1" } else { "0" };
    if let Some(i) = id.strip_prefix("dev|") {
        run(&["set-sink-mute", i, f])
    } else if let Some(i) = id.strip_prefix("app|") {
        run(&["set-sink-input-mute", i, f])
    } else {
        Err("bad id".into())
    }
}

pub fn set_route(app_id: &str, device_id: &str) -> Result<(), String> {
    let a = app_id.strip_prefix("app|").ok_or("bad app id")?;
    let d = device_id.strip_prefix("dev|").ok_or("bad device id")?;
    run(&["move-sink-input", a, d])
}

pub fn set_mirrors(_pid: u32, mirrors: &[super::MirrorReq]) -> Result<(), String> {
    if mirrors.is_empty() {
        Ok(())
    } else {
        Err("Mirrored outputs aren't implemented on Linux yet".into())
    }
}

pub fn set_dynamics(_pid: u32, _cfg: &super::Dyn) -> Result<(), String> {
    Err("The compressor and gate aren't implemented on Linux yet".into())
}

pub fn set_eq(_pid: u32, _enabled: bool, _preamp: f32, _gains: &[f32]) -> Result<(), String> {
    Err("The equalizer isn't implemented on Linux yet".into())
}

pub fn set_takeover(_pid: u32, _app_id: &str, _park: &str, _enable: bool) -> Result<(), String> {
    Err("EQ take-over isn't implemented on Linux yet".into())
}

pub fn restore_all() {}

/// App icons are only implemented on Windows.
pub fn app_icon(_pid: u32) -> Option<String> {
    None
}

pub fn set_default_device(device_id: &str) -> Result<(), String> {
    let d = device_id.strip_prefix("dev|").ok_or("bad device id")?;
    run(&["set-default-sink", d])
}
