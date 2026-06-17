mod relay;

use std::net::SocketAddr;
use std::path::PathBuf;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};

/// Fixed default port; clients (the bundled window AND the deployed Vercel site)
/// discover the relay at this address.
const RELAY_PORT: u16 = 11471;

/// True when launched headless (server/tray only, no window) — mode B.
fn is_headless() -> bool {
    std::env::var("CTV_HEADLESS").map(|v| v == "1").unwrap_or(false)
        || std::env::args().any(|a| a == "--headless")
}

/// Locate the ffmpeg binary: env override, bundled sidecar next to the exe,
/// then `ffmpeg` on PATH (dev machines / Linux).
fn resolve_ffmpeg() -> PathBuf {
    if let Ok(p) = std::env::var("CTV_FFMPEG") {
        let pb = PathBuf::from(&p);
        if pb.exists() {
            return pb;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
            let cand = dir.join(name);
            if cand.exists() {
                return cand;
            }
        }
    }
    PathBuf::from(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })
}

/// Locate the built frontend (dist) to serve from the relay (mode A).
fn resolve_web_dir(app: &tauri::App) -> Option<PathBuf> {
    // Bundled: dist is copied into the resource dir.
    if let Ok(res) = app.path().resource_dir() {
        let candidate = res.join("dist");
        if candidate.join("index.html").exists() {
            return Some(candidate);
        }
    }
    // Dev (`cargo run` / `tauri dev`): dist sits next to src-tauri.
    if let Ok(cwd) = std::env::current_dir() {
        for c in [cwd.join("dist"), cwd.join("../dist")] {
            if c.join("index.html").exists() {
                return Some(c);
            }
        }
    }
    None
}

fn build_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(
            format!("http://127.0.0.1:{RELAY_PORT}/")
                .parse()
                .expect("valid relay url"),
        ),
    )
    .title("Community IPTV Player")
    .inner_size(1280.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .resizable(true)
    .build()?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let web_dir = resolve_web_dir(app);
            let ffmpeg = resolve_ffmpeg();
            log::info!("[relay] ffmpeg: {}", ffmpeg.display());
            log::info!("[relay] web_dir: {:?}", web_dir);

            // Bind the listener synchronously so the socket is accepting before
            // the window navigates to it (avoids a connection-refused race).
            let addr = SocketAddr::from(([0, 0, 0, 0], RELAY_PORT));
            let std_listener = std::net::TcpListener::bind(addr)?;
            std_listener.set_nonblocking(true)?;

            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener)
                    .expect("convert std listener to tokio");
                let router = relay::router(web_dir, ffmpeg);
                if let Err(e) = axum::serve(listener, router).await {
                    log::error!("[relay] server error: {e}");
                }
            });

            // Tray icon (both modes) — gives headless mode a UI handle.
            let show = MenuItem::with_id(app, "show", "Open Player", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip("Community IPTV Player")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        } else {
                            let _ = build_window(app);
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            if !is_headless() {
                build_window(&app.handle())?;
            } else {
                log::info!("[relay] headless mode — relay only, no window");
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
