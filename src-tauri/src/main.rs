#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod files;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, Rect, WindowEvent};

/// When the popup last lost focus; used to stop the tray click that caused the
/// blur from immediately re-opening it.
static POPUP_HIDDEN_AT: AtomicU64 = AtomicU64::new(0);

/// Whether the main window's close button hides to the tray (true) or quits.
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn get_state() -> audio::State {
    audio::state()
}

#[tauri::command]
fn app_icon(pid: u32) -> Option<String> {
    audio::app_icon(pid)
}

#[tauri::command]
fn save_ini(text: String) -> Result<(), String> {
    files::write_ini(&text)
}

#[tauri::command]
fn log_crash(kind: String, message: String) {
    files::log_crash(&kind, &message);
}

#[tauri::command]
fn set_default_device(id: String) -> Result<(), String> {
    audio::set_default_device(&id)
}

#[tauri::command]
fn set_volume(id: String, volume: f32) -> Result<(), String> {
    audio::set_volume(&id, volume.clamp(0.0, 1.0))
}

#[tauri::command]
fn set_mute(id: String, muted: bool) -> Result<(), String> {
    audio::set_mute(&id, muted)
}

#[tauri::command]
fn set_route(app_id: String, device_id: String) -> Result<(), String> {
    audio::set_route(&app_id, &device_id)
}

fn show_main(app: &AppHandle) {
    if let Some(p) = app.get_webview_window("popup") {
        let _ = p.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn set_mirrors(pid: u32, mirrors: Vec<audio::MirrorReq>) -> Result<(), String> {
    audio::set_mirrors(pid, &mirrors)
}

#[tauri::command]
fn set_close_to_tray(enabled: bool) {
    CLOSE_TO_TRAY.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn set_eq(pid: u32, enabled: bool, preamp: f32, gains: Vec<f32>) -> Result<(), String> {
    audio::set_eq(pid, enabled, preamp, &gains)
}

/// Version, platform and data-folder info for the About page.
#[tauri::command]
fn about_info() -> serde_json::Value {
    serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "tauri": tauri::VERSION,
        "dir": files::app_dir().to_string_lossy(),
    })
}

/// Open the folder that holds the .ini and log files in the file manager.
#[tauri::command]
fn open_data_folder() -> Result<(), String> {
    let dir = files::app_dir();
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let prog = "xdg-open";
    std::process::Command::new(prog).arg(&dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Open a project link (GitHub page or release) in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/SailHighSea/") {
        return Err("Link not allowed".into());
    }
    #[cfg(target_os = "windows")]
    let prog = "explorer";
    #[cfg(target_os = "macos")]
    let prog = "open";
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let prog = "xdg-open";
    std::process::Command::new(prog).arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_dynamics(pid: u32, cfg: audio::Dyn) -> Result<(), String> {
    audio::set_dynamics(pid, &cfg)
}

#[tauri::command]
fn set_takeover(pid: u32, app_id: String, park: String, enable: bool) -> Result<(), String> {
    audio::set_takeover(pid, &app_id, &park, enable)
}

#[tauri::command]
fn open_main(app: AppHandle) {
    show_main(&app);
}

fn toggle_popup(app: &AppHandle, icon: Rect) {
    let Some(w) = app.get_webview_window("popup") else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    if now_ms().saturating_sub(POPUP_HIDDEN_AT.load(Ordering::Relaxed)) < 250 {
        return;
    }
    let scale = w.scale_factor().unwrap_or(1.0);
    let pos = icon.position.to_physical::<f64>(scale);
    let isz = icon.size.to_physical::<f64>(scale);
    let size = w.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((360.0, 440.0));

    let mut x = pos.x + isz.width / 2.0 - size.0 / 2.0;
    let mut y = pos.y - size.1 - 8.0;
    if y < 0.0 {
        y = pos.y + isz.height + 8.0; // taskbar / menu bar at the top
    }
    if let Ok(Some(m)) = w.current_monitor().or_else(|_| w.primary_monitor()) {
        let (mx, mw) = (m.position().x as f64, m.size().width as f64);
        x = x.min(mx + mw - size.0 - 8.0).max(mx + 8.0);
    }
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.show();
    let _ = w.set_focus();
}

/// True when the Windows taskbar uses the light theme (so the tray glyph must be dark).
fn taskbar_is_light() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if let Ok(o) = std::process::Command::new("reg")
            .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "/v", "SystemUsesLightTheme"])
            .creation_flags(0x0800_0000)
            .output()
        {
            return String::from_utf8_lossy(&o.stdout).contains("0x1");
        }
    }
    false
}

static TRAY_TILE: AtomicBool = AtomicBool::new(true);

fn tray_icon(light_taskbar: bool) -> tauri::image::Image<'static> {
    let bytes: &[u8] = match (TRAY_TILE.load(Ordering::Relaxed), light_taskbar) {
        (false, true) => include_bytes!("../icons/tray-black.png"),
        (false, false) => include_bytes!("../icons/tray-white.png"),
        (true, true) => include_bytes!("../icons/tray-tile-black.png"),
        (true, false) => include_bytes!("../icons/tray-tile-white.png"),
    };
    tauri::image::Image::from_bytes(bytes).expect("tray icon")
}

/// Choose the tray glyph: "faders" or "tile" (bars in a tile).
#[tauri::command]
fn set_tray_style(app: tauri::AppHandle, style: String) {
    TRAY_TILE.store(style == "tile", Ordering::Relaxed);
    if let Some(t) = app.tray_by_id("tray") {
        let _ = t.set_icon(Some(tray_icon(taskbar_is_light())));
    }
}

fn main() {
    files::install_panic_hook();
    let ini_script = format!("window.__SVM_INI__ = {};", files::read_ini_json());
    tauri::Builder::default()
        .plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("svm-ini").js_init_script(ini_script).build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![
            get_state, app_icon, save_ini, log_crash, set_default_device, set_volume, set_mute, set_route, set_mirrors, open_main,
            set_close_to_tray, quit_app, set_eq, set_dynamics, set_tray_style, set_takeover, about_info, open_data_folder, open_url
        ])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Open mixer", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("tray")
                .icon(tray_icon(taskbar_is_light()))
                .tooltip("SailHighSea VM")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = ev
                    {
                        toggle_popup(tray.app_handle(), rect);
                    }
                })
                .build(app)?;

            // The mono tray glyph is white on a dark taskbar and black on a light one; follow the Windows setting.
            #[cfg(target_os = "windows")]
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    let mut last = taskbar_is_light();
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        let now = taskbar_is_light();
                        if now != last {
                            last = now;
                            if let Some(t) = handle.tray_by_id("tray") {
                                let _ = t.set_icon(Some(tray_icon(now)));
                            }
                        }
                    }
                });
            }

            // Show the window unless we were launched at login (--minimized): then stay in the tray.
            if !std::env::args().any(|a| a == "--minimized") {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|w, ev| match ev {
            // Closing the main window keeps the app alive in the tray.
            WindowEvent::CloseRequested { api, .. } if w.label() == "main" => {
                if CLOSE_TO_TRAY.load(Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                } else {
                    w.app_handle().exit(0);
                }
            }
            WindowEvent::Focused(false) if w.label() == "popup" => {
                POPUP_HIDDEN_AT.store(now_ms(), Ordering::Relaxed);
                let _ = w.hide();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building SailHighSea VM")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                audio::restore_all();
            }
        });
}
