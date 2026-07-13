//! Native Google Cast support.
//!
//! The web Cast SDK (`chrome.cast`) only exists in Chromium, so the Windows
//! WebView2 window could cast but the macOS WKWebView window cannot. Instead,
//! the frontend drives these relay endpoints and the app speaks the Cast v2
//! protocol itself: mDNS discovery plus a per-session worker thread that owns
//! the (blocking) TLS connection, executes commands, keeps the connection
//! alive, and maintains a status snapshot for 1s polling from the UI.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent};
use rust_cast::channels::media::{GenericMediaMetadata, Media, Metadata, StatusEntry, StreamType};
use rust_cast::channels::receiver::CastDeviceApp;
use rust_cast::CastDevice;
use serde::Serialize;

const SERVICE: &str = "_googlecast._tcp.local.";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct CastDeviceInfo {
    pub name: String,
    pub host: String,
    pub port: u16,
}

/// Browse mDNS for Google Cast devices for `timeout` (blocking; call from
/// spawn_blocking). The friendly name lives in the `fn` TXT record.
pub fn discover(timeout: Duration) -> Vec<CastDeviceInfo> {
    let mut out: Vec<CastDeviceInfo> = Vec::new();
    let Ok(daemon) = ServiceDaemon::new() else {
        return out;
    };
    let Ok(events) = daemon.browse(SERVICE) else {
        return out;
    };
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match events.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let name = info
                    .get_property_val_str("fn")
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        info.get_fullname().split('.').next().unwrap_or("Chromecast").to_string()
                    });
                let Some(ip) = info.get_addresses().iter().find(|a| a.is_ipv4()) else {
                    continue;
                };
                let host = ip.to_string();
                if !out.iter().any(|d| d.host == host) {
                    out.push(CastDeviceInfo { name, host, port: info.get_port() });
                }
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }
    let _ = daemon.shutdown();
    out
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

pub enum CastCmd {
    Load { url: String, content_type: String, title: Option<String>, live: bool },
    Play,
    Pause,
    Seek(f32),
    Volume(f32),
    Mute(bool),
    /// Stop the app on the device and end the worker thread.
    Disconnect,
}

#[derive(Serialize, Clone, Default)]
pub struct CastSnapshot {
    pub active: bool,
    pub device_name: String,
    pub host: String,
    /// CONNECTING / CONNECTED / BUFFERING / PLAYING / PAUSED / IDLE / DISCONNECTED
    pub player_state: String,
    pub current_time: f64,
    pub duration: f64,
    pub volume_level: f64,
    pub muted: bool,
    pub error: Option<String>,
}

pub struct CastHandle {
    pub tx: mpsc::Sender<CastCmd>,
    pub snapshot: Arc<Mutex<CastSnapshot>>,
}

pub fn start_session(host: String, port: u16, device_name: String) -> CastHandle {
    let (tx, rx) = mpsc::channel::<CastCmd>();
    let snapshot = Arc::new(Mutex::new(CastSnapshot {
        active: true,
        device_name: device_name.clone(),
        host: host.clone(),
        player_state: "CONNECTING".to_string(),
        volume_level: 1.0,
        ..Default::default()
    }));
    let shared = snapshot.clone();
    thread::spawn(move || {
        let result = run_session(&host, port, rx, &shared);
        let mut snap = shared.lock().unwrap();
        if let Err(message) = result {
            log::warn!("[cast] session ended with error: {message}");
            snap.error = Some(message);
        } else {
            log::info!("[cast] session ended");
        }
        snap.active = false;
        snap.player_state = "DISCONNECTED".to_string();
    });
    CastHandle { tx, snapshot }
}

fn apply_entry(shared: &Arc<Mutex<CastSnapshot>>, entry: &StatusEntry) {
    let mut snap = shared.lock().unwrap();
    snap.player_state = format!("{:?}", entry.player_state).to_uppercase();
    if let Some(t) = entry.current_time {
        snap.current_time = f64::from(t);
    }
    if let Some(media) = &entry.media {
        if let Some(d) = media.duration {
            snap.duration = f64::from(d);
        }
    }
}

fn set_state(shared: &Arc<Mutex<CastSnapshot>>, state: &str) {
    shared.lock().unwrap().player_state = state.to_string();
}

fn run_session(
    host: &str,
    port: u16,
    rx: mpsc::Receiver<CastCmd>,
    shared: &Arc<Mutex<CastSnapshot>>,
) -> Result<(), String> {
    let err = |e: rust_cast::errors::Error| e.to_string();

    let device = CastDevice::connect_without_host_verification(host, port).map_err(err)?;
    device.connection.connect("receiver-0").map_err(err)?;
    device.heartbeat.ping().map_err(err)?;
    let app = device
        .receiver
        .launch_app(&CastDeviceApp::DefaultMediaReceiver)
        .map_err(err)?;
    device.connection.connect(app.transport_id.as_str()).map_err(err)?;
    set_state(shared, "CONNECTED");
    log::info!("[cast] connected to {host} (app session {})", app.session_id);

    let mut media_session_id: Option<i32> = None;
    let mut last_ping = Instant::now();
    let mut last_status = Instant::now();

    loop {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(CastCmd::Load { url, content_type, title, live }) => {
                let media = Media {
                    content_id: url,
                    stream_type: if live { StreamType::Live } else { StreamType::Buffered },
                    content_type,
                    metadata: title.map(|t| {
                        Metadata::Generic(GenericMediaMetadata {
                            title: Some(t),
                            subtitle: None,
                            images: vec![],
                            release_date: None,
                        })
                    }),
                    duration: None,
                };
                match device
                    .media
                    .load(app.transport_id.as_str(), app.session_id.as_str(), &media)
                {
                    Ok(status) => {
                        if let Some(entry) = status.entries.first() {
                            media_session_id = Some(entry.media_session_id);
                            apply_entry(shared, entry);
                        }
                    }
                    Err(e) => {
                        log::warn!("[cast] load failed: {e}");
                        shared.lock().unwrap().error = Some(format!("load failed: {e}"));
                    }
                }
            }
            Ok(CastCmd::Play) => {
                if let Some(id) = media_session_id {
                    if let Ok(entry) = device.media.play(app.transport_id.as_str(), id) {
                        apply_entry(shared, &entry);
                    }
                }
            }
            Ok(CastCmd::Pause) => {
                if let Some(id) = media_session_id {
                    if let Ok(entry) = device.media.pause(app.transport_id.as_str(), id) {
                        apply_entry(shared, &entry);
                    }
                }
            }
            Ok(CastCmd::Seek(t)) => {
                if let Some(id) = media_session_id {
                    if let Ok(entry) =
                        device.media.seek(app.transport_id.as_str(), id, Some(t), None)
                    {
                        apply_entry(shared, &entry);
                    }
                }
            }
            Ok(CastCmd::Volume(level)) => {
                if let Ok(volume) = device.receiver.set_volume(level.clamp(0.0, 1.0)) {
                    let mut snap = shared.lock().unwrap();
                    if let Some(l) = volume.level {
                        snap.volume_level = f64::from(l);
                    }
                    if let Some(m) = volume.muted {
                        snap.muted = m;
                    }
                }
            }
            Ok(CastCmd::Mute(muted)) => {
                if let Ok(volume) = device.receiver.set_volume(muted) {
                    let mut snap = shared.lock().unwrap();
                    if let Some(m) = volume.muted {
                        snap.muted = m;
                    }
                }
            }
            Ok(CastCmd::Disconnect) => {
                let _ = device.receiver.stop_app(app.session_id.as_str());
                return Ok(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // All senders dropped (app state replaced) — stop the device app.
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = device.receiver.stop_app(app.session_id.as_str());
                return Ok(());
            }
        }

        // Keepalive both directions: our PING proves we're alive; the
        // unconditional PONG answers any device PING that request/response
        // reads have buffered (unsolicited PONGs are ignored).
        if last_ping.elapsed() > Duration::from_secs(4) {
            device.heartbeat.ping().map_err(err)?;
            device.heartbeat.pong().map_err(err)?;
            last_ping = Instant::now();
        }
        if last_status.elapsed() > Duration::from_secs(1) {
            if let Ok(status) = device.media.get_status(app.transport_id.as_str(), None) {
                if let Some(entry) = status.entries.first() {
                    media_session_id = Some(entry.media_session_id);
                    apply_entry(shared, entry);
                }
            }
            last_status = Instant::now();
        }
    }
}
