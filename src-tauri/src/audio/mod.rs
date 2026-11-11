use serde::Serialize;

/// An output device (speakers, headphones, HDMI, virtual cable ...).
#[derive(Serialize, Clone, Debug)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub sub: String,
    /// 0.0 ..= 1.0
    pub volume: f32,
    pub muted: bool,
    /// current output peak, 0.0 ..= 1.0 (0 where the platform can't report it)
    pub peak: f32,
    pub is_default: bool,
}

/// A mirrored output: a captured copy of an app played on another device.
#[derive(Serialize, Clone, Debug)]
pub struct Mirror {
    pub device_id: String,
    /// 0.0 ..= 1.0
    pub volume: f32,
    pub delay_ms: u32,
}

/// Request to mirror an app to a device.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct MirrorReq {
    pub device_id: String,
    pub volume: f32,
    pub delay_ms: u32,
}

/// 10-band equalizer settings of an app (applied to its mirrored/taken-over copy).
#[derive(Serialize, Clone, Debug)]
pub struct Eq {
    pub enabled: bool,
    pub preamp: f32,
    pub gains: Vec<f32>,
}

fn default_ceiling() -> f32 {
    -1.0
}

/// Compressor, noise gate, limiter, balance and mono settings of an app (applied to its mirrored/taken-over copy).
#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct Dyn {
    pub comp_on: bool,
    /// dB, -60 ..= 0
    pub threshold: f32,
    /// n:1, 1 ..= 20
    pub ratio: f32,
    /// ms
    pub attack: f32,
    /// ms
    pub release: f32,
    /// dB, 0 ..= 24
    pub makeup: f32,
    pub gate_on: bool,
    /// dB, -80 ..= -10
    pub gate_threshold: f32,
    /// ms
    pub gate_release: f32,
    #[serde(default)]
    pub limit_on: bool,
    /// dB, -12 ..= 0
    #[serde(default = "default_ceiling")]
    pub limit_ceiling: f32,
    /// balance -1 (left) ..= 1 (right)
    #[serde(default)]
    pub pan: f32,
    #[serde(default)]
    pub mono: bool,
    /// current gain reduction in dB (0 or more); output only
    #[serde(default)]
    pub reduction: f32,
}

/// EQ take-over: the app plays on a silent "park" output; its audio is captured,
/// equalised and replayed on `orig_device`.
#[derive(Serialize, Clone, Debug)]
pub struct Takeover {
    pub orig_device: String,
    pub park_device: String,
}

/// One audio stream of an application, playing on `device_id`.
#[derive(Serialize, Clone, Debug)]
pub struct App {
    pub id: String,
    pub name: String,
    pub sub: String,
    pub volume: f32,
    pub muted: bool,
    pub peak: f32,
    pub device_id: String,
    /// Process id of the stream (0 when unknown).
    pub pid: u32,
    /// Extra devices this app is mirrored to (copy of the audio).
    pub mirrors: Vec<Mirror>,
    pub eq: Option<Eq>,
    pub dynamics: Option<Dyn>,
    pub takeover: Option<Takeover>,
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct State {
    pub devices: Vec<Device>,
    pub apps: Vec<App>,
}

/// Split "Speakers (Realtek Audio)" into ("Speakers", "Realtek Audio").
#[allow(dead_code)]
pub fn split_name(full: &str) -> (String, String) {
    if let (Some(a), true) = (full.find('('), full.ends_with(')')) {
        let name = full[..a].trim();
        if !name.is_empty() {
            return (name.to_string(), full[a + 1..full.len() - 1].to_string());
        }
    }
    (full.to_string(), String::new())
}

#[cfg(target_os = "windows")]
mod windows_impl;
#[cfg(target_os = "windows")]
pub use windows_impl::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;
