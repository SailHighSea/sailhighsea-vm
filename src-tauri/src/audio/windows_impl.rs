//! Windows backend: WASAPI endpoints (devices) and per-app audio sessions.
//!
//! Ids: devices are `dev|<endpoint id>`, app streams are `app|<endpoint id>|<session id>`.
use super::{split_name, App, Device, Dyn, Eq, Mirror, MirrorReq, State, Takeover};

#[path = "mirror.rs"]
mod mirror;
#[path = "icon.rs"]
mod icon;
pub use icon::app_icon;
use std::path::Path;
use std::ptr::null;
use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, S_OK};
use windows::Win32::Media::Audio::Endpoints::{IAudioEndpointVolume, IAudioMeterInformation};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;
use windows::Win32::System::Threading::*;
use windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc;

type R<T> = windows::core::Result<T>;

fn init_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

unsafe fn enumerator() -> R<IMMDeviceEnumerator> {
    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
}

unsafe fn take_pwstr(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    let s = p.to_string().unwrap_or_default();
    CoTaskMemFree(Some(p.0 as *const _));
    s
}

unsafe fn device_by_id(id: &str) -> R<IMMDevice> {
    let w: Vec<u16> = id.encode_utf16().chain(Some(0)).collect();
    enumerator()?.GetDevice(PCWSTR(w.as_ptr()))
}

unsafe fn friendly_name(d: &IMMDevice) -> String {
    (|| -> R<String> {
        let store = d.OpenPropertyStore(STGM_READ)?;
        let pv = store.GetValue(&PKEY_Device_FriendlyName)?;
        Ok(take_pwstr(PropVariantToStringAlloc(&pv as *const _)?))
    })()
    .unwrap_or_else(|_| "Unknown device".into())
}

unsafe fn proc_name(pid: u32) -> Option<String> {
    let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 520];
    let mut len = buf.len() as u32;
    let r = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(h);
    r.ok()?;
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    Path::new(&path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
}

/// (app, dedupe key, is_active)
type Found = (App, String, bool);

unsafe fn apps_on(dev: &IMMDevice, dev_id: &str, out: &mut Vec<Found>) -> R<()> {
    let mgr: IAudioSessionManager2 = dev.Activate(CLSCTX_ALL, None)?;
    let sessions = mgr.GetSessionEnumerator()?;
    for i in 0..sessions.GetCount()? {
        let Ok(ctrl) = sessions.GetSession(i) else { continue };
        if ctrl.GetState().ok() == Some(AudioSessionStateExpired) {
            continue;
        }
        let Ok(c2) = ctrl.cast::<IAudioSessionControl2>() else { continue };
        let Ok(vol) = ctrl.cast::<ISimpleAudioVolume>() else { continue };
        let Ok(sid) = c2.GetSessionInstanceIdentifier() else { continue };
        let sid = take_pwstr(sid);
        let pid = c2.GetProcessId().unwrap_or(0);
        let exe = proc_name(pid);
        // our own mirror / take-over playback streams (any running copy of this app) are not apps to mix
        if exe.as_deref().map_or(false, |e| e.to_lowercase().starts_with("sailhighsea-vm")) {
            continue;
        }

        let mut name = String::new();
        if c2.IsSystemSoundsSession() == S_OK {
            name = "System sounds".into();
        }
        if name.is_empty() {
            let dn = take_pwstr(ctrl.GetDisplayName().unwrap_or_default());
            if !dn.is_empty() && !dn.starts_with('@') {
                name = dn;
            }
        }
        if name.is_empty() {
            name = exe.clone().unwrap_or_else(|| format!("PID {pid}"));
        }
        let peak = ctrl
            .cast::<IAudioMeterInformation>()
            .and_then(|m| m.GetPeakValue())
            .unwrap_or(0.0);
        // The same app session is listed on every device; the instance id is
        // "<device id>|<rest>", so `rest` identifies it across devices.
        let key = sid.split_once('|').map(|x| x.1).unwrap_or(&sid).to_string();
        let active = ctrl.GetState().ok() == Some(AudioSessionStateActive);
        out.push((
            App {
                id: format!("app|{dev_id}|{sid}"),
                name,
                sub: exe.unwrap_or_default(),
                volume: vol.GetMasterVolume().unwrap_or(1.0),
                muted: vol.GetMute().map(|b| b.as_bool()).unwrap_or(false),
                peak,
                device_id: format!("dev|{dev_id}"),
                pid,
                mirrors: Vec::new(),
                eq: None,
                dynamics: None,
                takeover: None,
            },
            key,
            active,
        ));
    }
    Ok(())
}

unsafe fn state_inner() -> R<State> {
    let e = enumerator()?;
    let default_id = e
        .GetDefaultAudioEndpoint(eRender, eMultimedia)
        .and_then(|d| d.GetId())
        .map(|p| take_pwstr(p))
        .unwrap_or_default();
    let coll = e.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
    let mut st = State::default();
    let mut found: Vec<Found> = Vec::new();
    for i in 0..coll.GetCount()? {
        let Ok(d) = coll.Item(i) else { continue };
        let Ok(raw) = d.GetId() else { continue };
        let id = take_pwstr(raw);
        let (name, sub) = split_name(&friendly_name(&d));
        let (volume, muted) = match d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None) {
            Ok(ev) => (
                ev.GetMasterVolumeLevelScalar().unwrap_or(0.0),
                ev.GetMute().map(|b| b.as_bool()).unwrap_or(false),
            ),
            Err(_) => (0.0, false),
        };
        let peak = d
            .Activate::<IAudioMeterInformation>(CLSCTX_ALL, None)
            .and_then(|m| m.GetPeakValue())
            .unwrap_or(0.0);
        let _ = apps_on(&d, &id, &mut found);
        st.devices.push(Device {
            is_default: id == default_id,
            id: format!("dev|{id}"),
            name,
            sub,
            volume,
            muted,
            peak,
        });
    }

    // Keep one entry per session: the active one, else the one on the default device.
    let default_dev = format!("dev|{default_id}");
    let mut order: Vec<String> = Vec::new();
    let mut best: std::collections::HashMap<String, (App, u8)> = Default::default();
    for (app, key, active) in found {
        let score = if active { 2 } else if app.device_id == default_dev { 1 } else { 0 };
        match best.get(&key) {
            Some((_, s)) if *s >= score => {}
            Some(_) => {
                best.insert(key, (app, score));
            }
            None => {
                order.push(key.clone());
                best.insert(key, (app, score));
            }
        }
    }
    st.apps = order
        .into_iter()
        .filter_map(|k| best.remove(&k))
        .map(|(mut a, score)| {
            // Idle streams are listed on the default device; show where Windows will really play them.
            if score < 2 {
                if let Some(id) = persisted_device(a.pid) {
                    let dev = format!("dev|{id}");
                    if st.devices.iter().any(|d| d.id == dev) {
                        a.device_id = dev;
                    }
                }
            }
            a
        })
        .collect();
    for a in &mut st.apps {
        if a.pid != 0 {
            a.eq = mirror::eq_get(a.pid).map(|(enabled, preamp, gains)| Eq { enabled, preamp, gains });
            a.dynamics = mirror::dyn_get(a.pid);
            a.takeover = take().get(&a.pid).map(|t| Takeover { orig_device: t.orig.clone(), park_device: t.park.clone() });
            a.mirrors = mirror::list(a.pid)
                .into_iter()
                .map(|m| Mirror {
                    device_id: format!("dev|{}", m.device_id),
                    volume: m.volume,
                    delay_ms: m.delay_ms,
                })
                .collect();
        }
    }
    Ok(st)
}

pub fn state() -> State {
    init_com();
    unsafe { state_inner().unwrap_or_default() }
}

fn es(e: windows::core::Error) -> String {
    e.to_string()
}

unsafe fn find_session(dev_id: &str, sess_id: &str) -> Result<IAudioSessionControl2, String> {
    let dev = device_by_id(dev_id).map_err(es)?;
    let mgr: IAudioSessionManager2 = dev.Activate(CLSCTX_ALL, None).map_err(es)?;
    let sessions = mgr.GetSessionEnumerator().map_err(es)?;
    for i in 0..sessions.GetCount().map_err(es)? {
        let Ok(ctrl) = sessions.GetSession(i) else { continue };
        let Ok(c2) = ctrl.cast::<IAudioSessionControl2>() else { continue };
        let Ok(sid) = c2.GetSessionInstanceIdentifier() else { continue };
        if take_pwstr(sid) == sess_id {
            return Ok(c2);
        }
    }
    Err("session not found (it may have closed)".into())
}

unsafe fn session_volume(dev_id: &str, sess_id: &str) -> Result<ISimpleAudioVolume, String> {
    find_session(dev_id, sess_id)?.cast::<ISimpleAudioVolume>().map_err(es)
}

pub fn set_volume(id: &str, v: f32) -> Result<(), String> {
    init_com();
    unsafe {
        if let Some(dev_id) = id.strip_prefix("dev|") {
            let ev: IAudioEndpointVolume = device_by_id(dev_id)
                .and_then(|d| d.Activate(CLSCTX_ALL, None))
                .map_err(es)?;
            return ev.SetMasterVolumeLevelScalar(v, null()).map_err(es);
        }
        let rest = id.strip_prefix("app|").ok_or("bad id")?;
        let (dev_id, sess_id) = rest.split_once('|').ok_or("bad id")?;
        session_volume(dev_id, sess_id)?
            .SetMasterVolume(v, null())
            .map_err(es)
    }
}

pub fn set_mute(id: &str, m: bool) -> Result<(), String> {
    init_com();
    unsafe {
        if let Some(dev_id) = id.strip_prefix("dev|") {
            let ev: IAudioEndpointVolume = device_by_id(dev_id)
                .and_then(|d| d.Activate(CLSCTX_ALL, None))
                .map_err(es)?;
            return ev.SetMute(m, null()).map_err(es);
        }
        let rest = id.strip_prefix("app|").ok_or("bad id")?;
        let (dev_id, sess_id) = rest.split_once('|').ok_or("bad id")?;
        session_volume(dev_id, sess_id)?.SetMute(m, null()).map_err(es)
    }
}

/// Moves an app to another output device using the undocumented
/// `IAudioPolicyConfigFactory` (Windows 11 / 10 21H2+ layout), the same call
/// Windows' own "App volume and device preferences" page uses.
pub fn set_route(app_id: &str, device_id: &str) -> Result<(), String> {
    init_com();
    let rest = app_id.strip_prefix("app|").ok_or("bad app id")?;
    let (src_dev, sess_id) = rest.split_once('|').ok_or("bad app id")?;
    let target = device_id.strip_prefix("dev|").ok_or("bad device id")?;
    let pid = unsafe { find_session(src_dev, sess_id)?.GetProcessId().map_err(es)? };
    route_pid(pid, target)
}

/// Route every stream of process `pid` to the endpoint `target` (raw endpoint id).
pub fn route_pid(pid: u32, target: &str) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::{GUID, HRESULT, HSTRING};
    use windows::Win32::System::WinRT::RoGetActivationFactory;

    // vtable slot 25 = SetPersistedDefaultAudioEndpoint(pid, flow, role, HSTRING)
    type SetFn = unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut c_void) -> HRESULT;
    const IID_FACTORY_21H2: GUID = GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324);
    const RENDER_IFACE: &str = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";

    init_com();
    unsafe {
        if pid == 0 {
            return Err("System sounds can't be moved to another device".into());
        }
        let path = HSTRING::from(format!(r"\\?\SWD#MMDEVAPI#{target}#{RENDER_IFACE}"));
        let unsupported = |e: windows::core::Error| {
            format!("Per-app routing needs Windows 11 / 10 21H2 or newer ({e})")
        };
        let cls = HSTRING::from("Windows.Media.Internal.AudioPolicyConfig");
        let base: windows::core::IInspectable = RoGetActivationFactory(&cls).map_err(unsupported)?;
        let mut raw: *mut c_void = std::ptr::null_mut();
        base.query(&IID_FACTORY_21H2, &mut raw).ok().map_err(unsupported)?;
        let obj = windows::core::IUnknown::from_raw(raw); // releases on drop
        let vtbl = *(raw as *const *const usize);
        let set: SetFn = std::mem::transmute(*vtbl.add(25));
        let hs: *mut c_void = std::mem::transmute_copy(&path);
        let mut failed: Option<windows::core::Error> = None;
        let mut codes = Vec::new();
        for role in [eMultimedia.0, eConsole.0, eCommunications.0] {
            let hr = set(raw, pid, eRender.0, role, hs);
            codes.push(format!("role{}=0x{:08X}", role, hr.0 as u32));
            if hr.is_err() && failed.is_none() {
                failed = Some(windows::core::Error::from(hr));
            }
        }
        crate::files::log_debug(&format!("route pid={pid} -> {target}: {}", codes.join(" ")));
        drop(obj);
        if let Some(e) = failed {
            return Err(es(e));
        }
    }
    Ok(())
}

/// The output Windows has stored for `pid` (what route_pid wrote), as a raw endpoint id.
/// None when the app follows the default device or the call is unavailable. An app whose stream
/// is idle keeps showing up on the default device, so this is what tells us where it will play.
fn persisted_device(pid: u32) -> Option<String> {
    use std::ffi::c_void;
    use windows::core::{GUID, HRESULT, HSTRING};
    use windows::Win32::System::WinRT::RoGetActivationFactory;
    type GetFn = unsafe extern "system" fn(*mut c_void, u32, i32, i32, *mut *mut c_void) -> HRESULT;
    const IID_FACTORY_21H2: GUID = GUID::from_u128(0xab3d4648_e242_459f_b02f_541c70306324);
    if pid == 0 {
        return None;
    }
    unsafe {
        let cls = HSTRING::from("Windows.Media.Internal.AudioPolicyConfig");
        let base: windows::core::IInspectable = RoGetActivationFactory(&cls).ok()?;
        let mut raw: *mut c_void = std::ptr::null_mut();
        base.query(&IID_FACTORY_21H2, &mut raw).ok().ok()?;
        let obj = windows::core::IUnknown::from_raw(raw);
        let vtbl = *(raw as *const *const usize);
        let get: GetFn = std::mem::transmute(*vtbl.add(26)); // GetPersistedDefaultAudioEndpoint
        let mut out: *mut c_void = std::ptr::null_mut();
        let hr = get(raw, pid, eRender.0, eMultimedia.0, &mut out);
        let hs: HSTRING = std::mem::transmute_copy(&out);
        drop(obj);
        if hr.is_err() {
            return None;
        }
        let s = hs.to_string();
        let a = s.find("MMDEVAPI#")? + 9;
        let b = s[a..].rfind('#')? + a;
        let id = &s[a..b];
        if id.is_empty() { None } else { Some(id.to_string()) }
    }
}

/// Make `device_id` the default output (all roles) through the undocumented IPolicyConfig.
pub fn set_default_device(device_id: &str) -> Result<(), String> {
    use std::ffi::c_void;
    use windows::core::{GUID, HRESULT, HSTRING, IUnknown};

    // vtable slot 13 = SetDefaultEndpoint(PCWSTR deviceId, ERole role)
    type SetFn = unsafe extern "system" fn(*mut c_void, PCWSTR, i32) -> HRESULT;
    const CLSID_POLICY_CONFIG: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID_POLICY_CONFIG: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);

    let raw_id = device_id.strip_prefix("dev|").ok_or("bad device id")?;
    init_com();
    unsafe {
        let unk: IUnknown = CoCreateInstance(&CLSID_POLICY_CONFIG, None, CLSCTX_ALL).map_err(es)?;
        let mut raw: *mut c_void = std::ptr::null_mut();
        unk.query(&IID_POLICY_CONFIG, &mut raw).ok().map_err(es)?;
        let pc = IUnknown::from_raw(raw); // releases on drop
        let vtbl = *(raw as *const *const usize);
        let set: SetFn = std::mem::transmute(*vtbl.add(13));
        let id = HSTRING::from(raw_id);
        for role in [eConsole.0, eMultimedia.0, eCommunications.0] {
            set(raw, PCWSTR(id.as_ptr()), role).ok().map_err(es)?;
        }
        drop(pc);
    }
    Ok(())
}

/// Make `app_id` play a copy of its audio on exactly these extra devices.
pub fn set_mirrors(pid: u32, mirrors: &[MirrorReq]) -> Result<(), String> {
    init_com();
    if pid == 0 {
        return Err("System sounds can't be mirrored".into());
    }
    let wanted: Vec<mirror::MirrorCfg> = mirrors
        .iter()
        .filter_map(|m| {
            let id = m.device_id.strip_prefix("dev|")?;
            Some(mirror::MirrorCfg {
                device_id: id.to_string(),
                volume: m.volume,
                delay_ms: m.delay_ms,
            })
        })
        .collect();
    mirror::apply(pid, &wanted);
    Ok(())
}

// ---------------------------------------------------------------------------
// Equaliser + take-over
// ---------------------------------------------------------------------------

pub fn set_eq(pid: u32, enabled: bool, preamp: f32, gains: &[f32]) -> Result<(), String> {
    if pid == 0 {
        return Err("System sounds can't be equalised".into());
    }
    mirror::eq_set(pid, enabled, preamp, gains);
    Ok(())
}

pub fn set_dynamics(pid: u32, cfg: &Dyn) -> Result<(), String> {
    if pid == 0 {
        return Err("System sounds can't be processed".into());
    }
    mirror::dyn_set(pid, cfg);
    Ok(())
}

struct Take {
    /// "dev|<id>" the app played on before the take-over (now an EQ'd mirror)
    orig: String,
    /// "dev|<id>" silent output the app is parked on
    park: String,
    park_was_muted: bool,
}

static TAKE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, Take>>> =
    std::sync::OnceLock::new();

fn take() -> std::sync::MutexGuard<'static, std::collections::HashMap<u32, Take>> {
    TAKE.get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn endpoint_muted(dev_id: &str) -> bool {
    unsafe {
        device_by_id(dev_id)
            .and_then(|d| d.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None))
            .and_then(|ev| ev.GetMute())
            .map(|b| b.as_bool())
            .unwrap_or(false)
    }
}

/// Take over an app: park it on a silent output and play an EQ'd copy on its
/// original output. Process loopback is captured before the endpoint, so muting
/// the park endpoint silences only the app's native path.
pub fn set_takeover(pid: u32, app_id: &str, park: &str, enable: bool) -> Result<(), String> {
    init_com();
    if pid == 0 {
        return Err("System sounds can't be taken over".into());
    }
    if enable {
        if take().contains_key(&pid) {
            return Ok(());
        }
        let rest = app_id.strip_prefix("app|").ok_or("bad app id")?;
        let (src_dev, _) = rest.split_once('|').ok_or("bad app id")?;
        let park_raw = park.strip_prefix("dev|").ok_or("bad park device")?;
        if park_raw == src_dev {
            return Err("Pick a different output as the silent output".into());
        }
        if mirror::list(pid).iter().any(|m| m.device_id == park_raw) {
            return Err("The silent output is also used as a mirror of this app".into());
        }
        let park_was_muted = endpoint_muted(park_raw);
        if !park_was_muted {
            set_mute(park, true)?;
        }
        if let Err(e) = route_pid(pid, park_raw) {
            if !park_was_muted {
                let _ = set_mute(park, false);
            }
            return Err(e);
        }
        let mut wanted: Vec<mirror::MirrorCfg> = mirror::list(pid);
        wanted.push(mirror::MirrorCfg { device_id: src_dev.to_string(), volume: 1.0, delay_ms: 0 });
        mirror::apply(pid, &wanted);
        take().insert(pid, Take { orig: format!("dev|{src_dev}"), park: park.to_string(), park_was_muted });
        Ok(())
    } else {
        release_takeover(pid)
    }
}

fn release_takeover(pid: u32) -> Result<(), String> {
    let Some(t) = take().remove(&pid) else { return Ok(()) };
    let orig_raw = t.orig.strip_prefix("dev|").unwrap_or(&t.orig).to_string();
    let _ = route_pid(pid, &orig_raw);
    let rest: Vec<mirror::MirrorCfg> = mirror::list(pid).into_iter().filter(|m| m.device_id != orig_raw).collect();
    mirror::apply(pid, &rest);
    // un-mute the park device unless another take-over still uses it
    if !t.park_was_muted && !take().values().any(|o| o.park == t.park) {
        let _ = set_mute(&t.park, false);
    }
    Ok(())
}

/// Undo every take-over (called when the app quits) so nothing stays parked/muted.
pub fn restore_all() {
    init_com();
    let pids: Vec<u32> = take().keys().copied().collect();
    for pid in pids {
        let _ = release_takeover(pid);
    }
}
