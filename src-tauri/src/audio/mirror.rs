//! Windows mirror engine.
//!
//! An app plays natively on one device. For every extra ("mirror") device we
//! capture that app's audio with WASAPI *process loopback* (Windows 10 2004+,
//! no driver needed) and play the copy on the target device.
//!
//! The copy arrives a little later than the native output. Each mirror keeps a
//! small buffer of `delay_ms` so the user can line the devices up, plus a gain.
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use wasapi::*;

const RATE: usize = 48_000;
const BPF: usize = 8; // 2 channels * f32

#[derive(Clone)]
pub struct MirrorCfg {
    /// raw endpoint id (without the "dev|" prefix)
    pub device_id: String,
    pub volume: f32,
    pub delay_ms: u32,
}

struct Handle {
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    volume: Arc<AtomicU32>,
    delay: Arc<AtomicU32>,
}

type Key = (u32, String);
static ACTIVE: OnceLock<Mutex<HashMap<Key, Handle>>> = OnceLock::new();

fn active() -> std::sync::MutexGuard<'static, HashMap<Key, Handle>> {
    ACTIVE
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Make the running mirrors of `pid` match `wanted`.
pub fn apply(pid: u32, wanted: &[MirrorCfg]) {
    let mut map = active();
    // stop mirrors that are no longer wanted, or whose thread has died
    map.retain(|(p, dev), h| {
        if *p != pid {
            return h.alive.load(Ordering::Relaxed);
        }
        let keep = wanted.iter().any(|w| &w.device_id == dev) && h.alive.load(Ordering::Relaxed);
        if !keep {
            h.stop.store(true, Ordering::Relaxed);
        }
        keep
    });
    for w in wanted {
        let key = (pid, w.device_id.clone());
        if let Some(h) = map.get(&key) {
            h.volume.store(w.volume.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
            h.delay.store(w.delay_ms.min(1000), Ordering::Relaxed);
            continue;
        }
        let h = Handle {
            stop: Arc::new(AtomicBool::new(false)),
            alive: Arc::new(AtomicBool::new(true)),
            volume: Arc::new(AtomicU32::new(w.volume.clamp(0.0, 1.0).to_bits())),
            delay: Arc::new(AtomicU32::new(w.delay_ms.min(1000))),
        };
        let (stop, alive, vol, delay) = (h.stop.clone(), h.alive.clone(), h.volume.clone(), h.delay.clone());
        let dev = w.device_id.clone();
        std::thread::Builder::new()
            .name(format!("mirror-{pid}"))
            .spawn(move || {
                let _ = run(pid, &dev, &stop, &vol, &delay);
                alive.store(false, Ordering::Relaxed);
            })
            .ok();
        map.insert(key, h);
    }
}

/// Active mirrors of a process.
pub fn list(pid: u32) -> Vec<MirrorCfg> {
    let mut map = active();
    map.retain(|_, h| h.alive.load(Ordering::Relaxed));
    map.iter()
        .filter(|((p, _), _)| *p == pid)
        .map(|((_, dev), h)| MirrorCfg {
            device_id: dev.clone(),
            volume: f32::from_bits(h.volume.load(Ordering::Relaxed)),
            delay_ms: h.delay.load(Ordering::Relaxed),
        })
        .collect()
}

fn run(
    pid: u32,
    device_id: &str,
    stop: &AtomicBool,
    vol: &AtomicU32,
    delay: &AtomicU32,
) -> Result<(), Box<dyn std::error::Error>> {
    initialize_mta().ok()?;
    let fmt = WaveFormat::new(32, 32, SampleType::Float, RATE, 2, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };

    // capture the app
    let mut cap = AudioClient::new_application_loopback_client(pid, true)?;
    cap.initialize_client(&fmt, Direction::Capture, mode, None)?;
    let cap_ev = cap.set_get_eventhandle()?;
    let cap_cl = cap.get_audiocaptureclient()?;

    // render on the target device
    let dev = DeviceEnumerator::new()?.get_device(device_id)?;
    let mut ren = dev.get_iaudioclient()?;
    ren.initialize_client(&fmt, Direction::Render, mode, None)?;
    let ren_ev = ren.set_get_eventhandle()?;
    let ren_cl = ren.get_audiorenderclient()?;

    let eq = eq_arc(pid);
    let mut bq = [Biquad::default(); BANDS];
    let dynsh = dyn_arc(pid);
    let mut dsp = Dynamics::new();
    let mut seen_dver = 0u32;
    let mut seen_ver = 0u32;
    let mut pre_lin = 1.0f32;
    let mut inq: VecDeque<u8> = VecDeque::new();
    let mut out: VecDeque<u8> = VecDeque::new();
    cap.start_stream()?;
    ren.start_stream()?;

    while !stop.load(Ordering::Relaxed) {
        let _ = cap_ev.wait_for_event(15);

        // capture -> gain -> out buffer
        if cap_cl.get_next_packet_size()?.unwrap_or(0) > 0 {
            cap_cl.read_from_device_to_deque(&mut inq)?;
        }
        let gain = f32::from_bits(vol.load(Ordering::Relaxed));
        let ver = eq.ver.load(Ordering::Relaxed);
        if ver != seen_ver {
            seen_ver = ver;
            for i in 0..BANDS {
                bq[i].set_peaking(RATE as f32, FREQS[i], f32::from_bits(eq.gains[i].load(Ordering::Relaxed)));
            }
            pre_lin = 10f32.powf(f32::from_bits(eq.preamp.load(Ordering::Relaxed)) / 20.0);
        }
        let eq_on = eq.enabled.load(Ordering::Relaxed);
        let dver = dynsh.ver.load(Ordering::Relaxed);
        if dver != seen_dver {
            seen_dver = dver;
            dsp.set(dynsh.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone());
        }
        let dyn_on = dsp.active();
        if !dyn_on {
            dsp.reset();
        }
        while inq.len() >= BPF {
            let mut s = [0f32; 2];
            for c in s.iter_mut() {
                let b = [inq.pop_front().unwrap(), inq.pop_front().unwrap(), inq.pop_front().unwrap(), inq.pop_front().unwrap()];
                *c = f32::from_le_bytes(b);
            }
            if eq_on {
                for band in bq.iter_mut().filter(|b| b.active) {
                    s[0] = band.run(0, s[0]);
                    s[1] = band.run(1, s[1]);
                }
                s[0] = (s[0] * pre_lin).clamp(-1.0, 1.0);
                s[1] = (s[1] * pre_lin).clamp(-1.0, 1.0);
            }
            if dyn_on {
                dsp.process(&mut s);
            }
            out.extend((s[0] * gain).to_le_bytes());
            out.extend((s[1] * gain).to_le_bytes());
        }

        if dyn_on {
            dynsh.reduction.store(dsp.take_reduction().to_bits(), Ordering::Relaxed);
        } else {
            dynsh.reduction.store(0f32.to_bits(), Ordering::Relaxed);
        }

        // Hold back `reserve` frames so the delay trim stays in effect;
        // only play what is beyond it.
        let reserve = delay.load(Ordering::Relaxed) as usize * RATE / 1000;
        let ready = (out.len() / BPF).saturating_sub(reserve);
        let space = ren.get_available_space_in_frames().unwrap_or(0) as usize;
        let n = space.min(ready);
        if n > 0 {
            ren_cl.write_to_device_from_deque(n, &mut out, None)?;
        }

        // bound latency growth from clock drift (keep at most 250 ms beyond the reserve)
        let max = (reserve + RATE / 4) * BPF;
        if out.len() > max {
            let drop = (out.len() - max) / BPF * BPF;
            out.drain(..drop);
        }
        let _ = ren_ev.wait_for_event(0);
    }
    let _ = cap.stop_stream();
    let _ = ren.stop_stream();
    Ok(())
}

// ---------------------------------------------------------------------------
// 10-band graphic equaliser (peaking biquads), shared per process
// ---------------------------------------------------------------------------

pub const BANDS: usize = 10;
const FREQS: [f32; BANDS] = [31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0];
const Q: f32 = 1.41;

pub struct EqShared {
    ver: AtomicU32,
    enabled: AtomicBool,
    preamp: AtomicU32,
    gains: [AtomicU32; BANDS],
}

impl EqShared {
    fn new() -> Self {
        EqShared {
            ver: AtomicU32::new(1),
            enabled: AtomicBool::new(false),
            preamp: AtomicU32::new(0f32.to_bits()),
            gains: std::array::from_fn(|_| AtomicU32::new(0f32.to_bits())),
        }
    }
}

static EQS: OnceLock<Mutex<HashMap<u32, Arc<EqShared>>>> = OnceLock::new();

fn eq_arc(pid: u32) -> Arc<EqShared> {
    EQS.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(pid)
        .or_insert_with(|| Arc::new(EqShared::new()))
        .clone()
}

pub fn eq_set(pid: u32, enabled: bool, preamp: f32, gains: &[f32]) {
    let e = eq_arc(pid);
    e.enabled.store(enabled, Ordering::Relaxed);
    e.preamp.store(preamp.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    for (i, g) in gains.iter().take(BANDS).enumerate() {
        e.gains[i].store(g.clamp(-12.0, 12.0).to_bits(), Ordering::Relaxed);
    }
    e.ver.fetch_add(1, Ordering::Relaxed);
}

/// (enabled, preamp dB, gains dB) if an EQ was ever configured for `pid`.
pub fn eq_get(pid: u32) -> Option<(bool, f32, Vec<f32>)> {
    let map = EQS.get()?.lock().unwrap_or_else(|e| e.into_inner());
    let e = map.get(&pid)?;
    Some((
        e.enabled.load(Ordering::Relaxed),
        f32::from_bits(e.preamp.load(Ordering::Relaxed)),
        e.gains.iter().map(|g| f32::from_bits(g.load(Ordering::Relaxed))).collect(),
    ))
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: [f32; 2],
    z2: [f32; 2],
    active: bool,
}

impl Biquad {
    /// RBJ peaking EQ.
    fn set_peaking(&mut self, fs: f32, f0: f32, gain_db: f32) {
        self.active = gain_db.abs() > 0.05;
        let a = 10f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * f0 / fs;
        let alpha = w0.sin() / (2.0 * Q);
        let cw = w0.cos();
        let a0 = 1.0 + alpha / a;
        self.b0 = (1.0 + alpha * a) / a0;
        self.b1 = (-2.0 * cw) / a0;
        self.b2 = (1.0 - alpha * a) / a0;
        self.a1 = (-2.0 * cw) / a0;
        self.a2 = (1.0 - alpha / a) / a0;
    }
    #[inline]
    fn run(&mut self, ch: usize, x: f32) -> f32 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }
}

// ---------------------------------------------------------------------------
// Compressor + noise gate (stereo-linked), shared settings per process
// ---------------------------------------------------------------------------

use super::Dyn;

pub struct DynShared {
    ver: AtomicU32,
    cfg: Mutex<Dyn>,
    reduction: AtomicU32,
}

fn default_dyn() -> Dyn {
    Dyn {
        comp_on: false,
        threshold: -18.0,
        ratio: 3.0,
        attack: 10.0,
        release: 120.0,
        makeup: 0.0,
        gate_on: false,
        gate_threshold: -50.0,
        gate_release: 150.0,
        limit_on: false,
        limit_ceiling: -1.0,
        pan: 0.0,
        mono: false,
        reduction: 0.0,
    }
}

static DYNS: OnceLock<Mutex<HashMap<u32, Arc<DynShared>>>> = OnceLock::new();

fn dyn_arc(pid: u32) -> Arc<DynShared> {
    DYNS.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(pid)
        .or_insert_with(|| {
            Arc::new(DynShared { ver: AtomicU32::new(1), cfg: Mutex::new(default_dyn()), reduction: AtomicU32::new(0) })
        })
        .clone()
}

pub fn dyn_set(pid: u32, c: &Dyn) {
    let d = dyn_arc(pid);
    let fin = |v: f32, lo: f32, hi: f32, def: f32| if v.is_finite() { v.clamp(lo, hi) } else { def };
    *d.cfg.lock().unwrap_or_else(|e| e.into_inner()) = Dyn {
        comp_on: c.comp_on,
        threshold: fin(c.threshold, -60.0, 0.0, -18.0),
        ratio: fin(c.ratio, 1.0, 20.0, 3.0),
        attack: fin(c.attack, 0.5, 200.0, 10.0),
        release: fin(c.release, 10.0, 2000.0, 120.0),
        makeup: fin(c.makeup, 0.0, 24.0, 0.0),
        gate_on: c.gate_on,
        gate_threshold: fin(c.gate_threshold, -80.0, -10.0, -50.0),
        gate_release: fin(c.gate_release, 10.0, 2000.0, 150.0),
        limit_on: c.limit_on,
        limit_ceiling: fin(c.limit_ceiling, -12.0, 0.0, -1.0),
        pan: fin(c.pan, -1.0, 1.0, 0.0),
        mono: c.mono,
        reduction: 0.0,
    };
    d.ver.fetch_add(1, Ordering::Relaxed);
}

/// Settings of `pid` (with the live gain reduction) if they were ever configured.
pub fn dyn_get(pid: u32) -> Option<Dyn> {
    let map = DYNS.get()?.lock().unwrap_or_else(|e| e.into_inner());
    let d = map.get(&pid)?;
    let mut c = d.cfg.lock().unwrap_or_else(|e| e.into_inner()).clone();
    c.reduction = f32::from_bits(d.reduction.load(Ordering::Relaxed));
    Some(c)
}

/// Per-thread DSP state.
struct Dynamics {
    cfg: Dyn,
    // compressor
    env_db: f32,
    att: f32,
    rel: f32,
    makeup_db: f32,
    // gate
    peak: f32,
    gate_gain: f32,
    g_rel: f32,
    g_peak_rel: f32,
    gr_max: f32,
    // limiter
    lim_gain: f32,
    lim_rel: f32,
    ceil_lin: f32,
    // balance
    pan_l: f32,
    pan_r: f32,
}

const GATE_FLOOR: f32 = 0.001; // -60 dB when closed
const KNEE_DB: f32 = 6.0;

fn coeff(ms: f32) -> f32 {
    (-1.0 / (ms.max(0.01) * 0.001 * RATE as f32)).exp()
}

impl Dynamics {
    fn new() -> Self {
        let mut d = Dynamics {
            cfg: default_dyn(),
            env_db: -100.0,
            att: 0.0,
            rel: 0.0,
            makeup_db: 0.0,
            peak: 0.0,
            gate_gain: 1.0,
            g_rel: 0.0,
            g_peak_rel: coeff(50.0),
            gr_max: 0.0,
            lim_gain: 1.0,
            lim_rel: coeff(60.0),
            ceil_lin: 0.89,
            pan_l: 1.0,
            pan_r: 1.0,
        };
        d.set(default_dyn());
        d
    }

    fn set(&mut self, c: Dyn) {
        self.att = coeff(c.attack);
        self.rel = coeff(c.release);
        self.makeup_db = c.makeup;
        self.g_rel = coeff(c.gate_release);
        self.ceil_lin = 10f32.powf(c.limit_ceiling / 20.0);
        self.pan_l = (1.0 - c.pan).min(1.0);
        self.pan_r = (1.0 + c.pan).min(1.0);
        self.cfg = c;
    }

    fn active(&self) -> bool {
        let c = &self.cfg;
        c.comp_on || c.gate_on || c.limit_on || c.mono || c.pan.abs() > 0.005
    }

    fn reset(&mut self) {
        self.lim_gain = 1.0;
        self.env_db = -100.0;
        self.peak = 0.0;
        self.gate_gain = 1.0;
        self.gr_max = 0.0;
    }

    /// Largest gain reduction (dB, positive) since the last call.
    fn take_reduction(&mut self) -> f32 {
        std::mem::take(&mut self.gr_max)
    }

    #[inline]
    fn process(&mut self, s: &mut [f32; 2]) {
        let lvl = s[0].abs().max(s[1].abs());
        let mut gain = 1.0f32;

        if self.cfg.gate_on {
            // peak detector with a short release, so the gate doesn't chatter on waveform zero crossings
            self.peak = if lvl > self.peak { lvl } else { self.peak * self.g_peak_rel };
            let thr = 10f32.powf(self.cfg.gate_threshold / 20.0);
            if self.peak > thr {
                // open fast (~2 ms)
                self.gate_gain += (1.0 - self.gate_gain) * 0.01;
                if self.gate_gain > 1.0 {
                    self.gate_gain = 1.0;
                }
            } else {
                self.gate_gain = (self.gate_gain * self.g_rel).max(GATE_FLOOR);
            }
            gain *= self.gate_gain;
            self.gr_max = self.gr_max.max(-20.0 * self.gate_gain.log10());
        } else {
            self.gate_gain = 1.0;
        }

        if self.cfg.comp_on {
            let lvl_db = 20.0 * lvl.max(1e-6).log10();
            let c = if lvl_db > self.env_db { self.att } else { self.rel };
            self.env_db = c * self.env_db + (1.0 - c) * lvl_db;
            let over = self.env_db - self.cfg.threshold;
            let slope = 1.0 / self.cfg.ratio - 1.0; // <= 0
            let gr = if over <= -KNEE_DB / 2.0 {
                0.0
            } else if over < KNEE_DB / 2.0 {
                slope * (over + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)
            } else {
                slope * over
            };
            self.gr_max = self.gr_max.max(-gr);
            gain *= 10f32.powf((gr + self.makeup_db) / 20.0);
        }

        s[0] *= gain;
        s[1] *= gain;

        if self.cfg.mono {
            let m = (s[0] + s[1]) * 0.5;
            *s = [m, m];
        }
        s[0] *= self.pan_l;
        s[1] *= self.pan_r;

        if self.cfg.limit_on {
            // instant attack (no overshoot past the ceiling), smooth release
            let pk = s[0].abs().max(s[1].abs());
            let need = if pk > self.ceil_lin { self.ceil_lin / pk } else { 1.0 };
            if need < self.lim_gain {
                self.lim_gain = need;
            } else {
                self.lim_gain = 1.0 - (1.0 - self.lim_gain) * self.lim_rel;
            }
            s[0] *= self.lim_gain;
            s[1] *= self.lim_gain;
            self.gr_max = self.gr_max.max(-20.0 * self.lim_gain.log10());
        } else {
            self.lim_gain = 1.0;
        }
        s[0] = s[0].clamp(-1.0, 1.0);
        s[1] = s[1].clamp(-1.0, 1.0);
    }
}
