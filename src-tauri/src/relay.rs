//! Local HTTP relay for the Community IPTV Player native app.
//!
//! Runs inside the Tauri process, bound to 127.0.0.1. It fetches the Xtream
//! provider from the user's own (home) IP, adds CORS, and follows redirects —
//! the three things the browser/cloud can't do. Exposes the SAME endpoints the
//! web UI already calls (`/api/stream`, `/api/restream/...`), so the frontend is
//! unchanged when it points at this server.
//!
//! - `/health`                        discovery probe
//! - `/api/stream?url=`               byte relay for VOD / direct play
//! - `/api/restream/index.m3u8?url=`  spawn bundled ffmpeg, return HLS manifest
//! - `/api/restream/<session>/<seg>`  serve an HLS segment file
//!
//! The restream logic is a direct port of `api/restreamManager.ts`.

use axum::{
    body::Body,
    extract::{Path as AxumPath, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

/// User-Agent that makes Xtream providers serve the real stream (not a debug page).
const PLAYER_UA: &str = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 ExoPlayerLib/2.18.1";

/// Idle sessions older than this (no manifest/segment fetch) are reaped.
const SESSION_TTL: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct RelayState {
    /// reqwest client reused across VOD requests (redirects, connection pool).
    http: reqwest::Client,
    /// Path to the ffmpeg binary (bundled sidecar, or `ffmpeg` on PATH).
    ffmpeg: Arc<PathBuf>,
    /// Active restream sessions, keyed by session id (hash of source url).
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    /// Per-session-id async locks, to serialize "start ffmpeg" for one URL
    /// without blocking other sessions or segment reads.
    starting: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    /// NVENC (NVIDIA GPU H.264 encode) availability, probed once: 0=unknown,
    /// 1=available, 2=unavailable. Lets heavy (4K/HEVC) transcodes run on the
    /// GPU in real time instead of choking libx264 on the CPU.
    nvenc: Arc<AtomicU8>,
}

impl RelayState {
    fn new(ffmpeg: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("failed to build reqwest client");
        Self {
            http,
            ffmpeg: Arc::new(ffmpeg),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            starting: Arc::new(Mutex::new(HashMap::new())),
            nvenc: Arc::new(AtomicU8::new(0)),
        }
    }
}

struct Session {
    output_dir: PathBuf,
    child: Mutex<Child>,
    last_access: AtomicI64,
}

impl Session {
    fn manifest_path(&self) -> PathBuf {
        self.output_dir.join("index.m3u8")
    }
    fn touch(&self) {
        self.last_access.store(now_ms(), Ordering::Relaxed);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Build the relay router. `web_dir` is the built frontend (dist) so the Tauri
/// window can load http://127.0.0.1:PORT and the app's *relative* /api calls are
/// same-origin (mode A: server + UI). Pass `None` for headless mode B.
/// `ffmpeg` is the path to the ffmpeg binary used for the live restream.
pub fn router(web_dir: Option<PathBuf>, ffmpeg: PathBuf) -> Router {
    let state = RelayState::new(ffmpeg);

    // Spawn the idle-session reaper (mirrors restreamManager's setInterval).
    {
        let sessions = state.sessions.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                reap_idle(&sessions).await;
            }
        });
    }

    let mut app = Router::new()
        .route("/health", get(health))
        .route("/api/server-info", get(server_info))
        .route("/api/stream", get(stream))
        .route("/api/restream/index.m3u8", get(restream_manifest))
        .route("/api/restream/:session/:file", get(restream_segment))
        .with_state(state);

    if let Some(dir) = web_dir {
        // Serve the SPA; unknown paths fall back to index.html for client routing.
        let index = dir.join("index.html");
        app = app.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)));
    }

    // Permissive CORS so the deployed HTTPS site can call this loopback relay
    // cross-origin, including preflight (OPTIONS) for Range requests. Loopback
    // is exempt from mixed-content blocking, so https://site → http://127.0.0.1
    // is allowed. This handles preflight; handlers no longer set ACAO manually.
    app.layer(CorsLayer::permissive())
}

// ---------------------------------------------------------------------------
// /health
// ---------------------------------------------------------------------------

async fn health() -> Response {
    let body = format!(
        r#"{{"app":"ctv-relay","version":"{}"}}"#,
        env!("CARGO_PKG_VERSION")
    );
    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
}

#[derive(Serialize)]
struct ServerInfo {
    app: &'static str,
    version: &'static str,
    port: u16,
    origins: Vec<String>,
}

async fn server_info() -> Response {
    let port = std::env::var("CTV_RELAY_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(11471);
    let mut origins = vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ];

    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                if addr.ip().is_ipv4() && !addr.ip().is_loopback() {
                    let origin = format!("http://{}:{port}", addr.ip());
                    if !origins.contains(&origin) {
                        origins.push(origin);
                    }
                }
            }
        }
    }

    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&ServerInfo {
            app: "ctv-relay",
            version: env!("CARGO_PKG_VERSION"),
            port,
            origins,
        })
        .unwrap_or_else(|_| "{}".to_string()),
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// /api/stream — byte relay (VOD / direct play)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct UrlQuery {
    url: Option<String>,
}

async fn stream(
    State(state): State<RelayState>,
    headers: HeaderMap,
    Query(q): Query<UrlQuery>,
) -> Response {
    let target = match parse_proxy_target(q.url.as_deref()) {
        Ok(t) => t,
        Err((status, msg)) => return cors_text(status, msg),
    };

    let referer = format!(
        "{}://{}/",
        target.scheme(),
        target.host_str().unwrap_or_default()
    );
    let mut req = state
        .http
        .get(target.clone())
        .header(header::USER_AGENT, PLAYER_UA)
        .header(header::ACCEPT, "*/*")
        .header(header::REFERER, referer);
    if let Some(range) = headers.get(header::RANGE) {
        req = req.header(header::RANGE, range);
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return cors_text(
                StatusCode::BAD_GATEWAY,
                format!("Relay could not reach the provider: {e}"),
            )
        }
    };

    let status = upstream.status();
    let mut builder = Response::builder().status(status);
    for name in [
        header::CONTENT_TYPE,
        header::CONTENT_LENGTH,
        header::ACCEPT_RANGES,
        header::CONTENT_RANGE,
        header::CACHE_CONTROL,
    ] {
        if let Some(v) = upstream.headers().get(&name) {
            builder = builder.header(name, v);
        }
    }

    match builder.body(Body::from_stream(upstream.bytes_stream())) {
        Ok(resp) => resp,
        Err(e) => cors_text(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// /api/restream — live TV via ffmpeg → HLS
// ---------------------------------------------------------------------------

async fn restream_manifest(State(state): State<RelayState>, Query(q): Query<UrlQuery>) -> Response {
    let target = match parse_proxy_target(q.url.as_deref()) {
        Ok(t) => t,
        Err((status, msg)) => return cors_text(status, msg),
    };
    // Live source must be an Xtream MPEG-TS (.ts) URL; never re-introduce .m3u8.
    let path = target.path().to_lowercase();
    if !path.ends_with(".ts") {
        return cors_text(
            StatusCode::BAD_REQUEST,
            "Restream source must be an Xtream MPEG-TS (.ts) URL".to_string(),
        );
    }
    let source = target.to_string();

    // Try once; on failure invalidate and retry (mirrors restreamHandler.ts).
    let mut last_err = String::from("Restream manifest failed");
    for attempt in 0..2u8 {
        match get_or_start(&state, &source, attempt > 0).await {
            Ok(session) => match read_manifest(&session).await {
                Ok(manifest) => {
                    session.touch();
                    let rewritten = rewrite_manifest(&manifest, &session_id(&source));
                    return (
                        StatusCode::OK,
                        [
                            (header::CONTENT_TYPE, "application/vnd.apple.mpegurl"),
                            (header::CACHE_CONTROL, "no-store"),
                        ],
                        rewritten,
                    )
                        .into_response();
                }
                Err(e) => {
                    last_err = e;
                    invalidate(&state, &session_id(&source)).await;
                }
            },
            Err(e) => {
                last_err = e;
                invalidate(&state, &session_id(&source)).await;
            }
        }
    }
    cors_text(StatusCode::BAD_GATEWAY, last_err)
}

async fn restream_segment(
    State(state): State<RelayState>,
    AxumPath((session_id, file)): AxumPath<(String, String)>,
) -> Response {
    let session = {
        let sessions = state.sessions.lock().await;
        match sessions.get(&session_id) {
            Some(s) => s.clone(),
            None => {
                return cors_text(
                    StatusCode::NOT_FOUND,
                    "Restream session not found or expired".to_string(),
                )
            }
        }
    };
    // Reject if ffmpeg already exited.
    if session
        .child
        .lock()
        .await
        .try_wait()
        .ok()
        .flatten()
        .is_some()
    {
        return cors_text(
            StatusCode::NOT_FOUND,
            "Restream session not found or expired".to_string(),
        );
    }
    session.touch();

    match read_segment(&session, &file).await {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, "video/mp2t"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => cors_text(StatusCode::BAD_GATEWAY, e),
    }
}

// ---------------------------------------------------------------------------
// ffmpeg session management (port of restreamManager.ts)
// ---------------------------------------------------------------------------

fn session_id(source_url: &str) -> String {
    let mut h = DefaultHasher::new();
    source_url.hash(&mut h);
    format!("{:016x}", h.finish())
}

fn output_dir_for(id: &str) -> PathBuf {
    std::env::temp_dir().join("iptv-restream").join(id)
}

/// What ffmpeg should do with each stream. Copying is cheap but only works when
/// the codec is already browser-decodable (H.264 video / AAC|MP3 audio). HEVC,
/// MPEG-2, AC-3, etc. must be transcoded to play in a WebView/MSE.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EncodeMode {
    video_copy: bool,
    audio_copy: bool,
}

impl EncodeMode {
    const COPY: Self = Self { video_copy: true, audio_copy: true };
    const TRANSCODE: Self = Self { video_copy: false, audio_copy: false };
}

/// Outcome of starting ffmpeg: a healthy session, a request to restart with a
/// corrected encode mode (the source codec wasn't browser-native), or a failure.
enum StartError {
    Restart(EncodeMode),
    Failed(String),
}

fn start_error_message(err: StartError) -> String {
    match err {
        StartError::Failed(msg) => msg,
        StartError::Restart(_) => "ffmpeg restart requested".to_string(),
    }
}

#[derive(Clone, Default)]
struct DetectedCodecs {
    video: Option<String>,
    audio: Option<String>,
}

/// Browsers (MSE) decode H.264 reliably; HEVC/H.265, MPEG-2, VP9, AV1 do not.
fn video_browser_friendly(codec: &str) -> bool {
    codec.eq_ignore_ascii_case("h264")
}

/// AAC and MP3 are broadly decodable in MSE; AC-3/E-AC-3/MP2/DTS are not.
fn audio_browser_friendly(codec: &str) -> bool {
    matches!(codec.to_ascii_lowercase().as_str(), "aac" | "mp3")
}

/// Pull the codec name from an ffmpeg input-dump line, e.g.
/// `Stream #0:0: Video: hevc (Main 10) ...` -> (is_video=true, "hevc").
fn parse_stream_codec(line: &str) -> Option<(bool, String)> {
    for (is_video, marker) in [(true, "Video: "), (false, "Audio: ")] {
        if let Some(i) = line.find(marker) {
            let codec = line[i + marker.len()..]
                .split([' ', ',', '('])
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
            if !codec.is_empty() {
                return Some((is_video, codec));
            }
        }
    }
    None
}

fn build_ffmpeg_args(
    source_url: &str,
    output_dir: &PathBuf,
    mode: EncodeMode,
    use_nvenc: bool,
) -> Vec<String> {
    let manifest = output_dir.join("index.m3u8");
    let segment_pattern = output_dir.join("seg_%03d.ts");
    let referer = match url::Url::parse(source_url) {
        Ok(u) => format!("{}://{}/", u.scheme(), u.host_str().unwrap_or_default()),
        Err(_) => String::new(),
    };

    // `-loglevel info` so ffmpeg prints the input stream dump (the "Video: hevc"
    // line) we parse to decide copy-vs-transcode — no separate probe connection.
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "info".into(),
        "-user_agent".into(),
        PLAYER_UA.into(),
        "-headers".into(),
        format!("Referer: {}\r\n", referer),
        "-reconnect".into(),
        "1".into(),
        "-reconnect_streamed".into(),
        "1".into(),
        "-reconnect_delay_max".into(),
        "5".into(),
        "-fflags".into(),
        "+genpts+igndts".into(),
        "-i".into(),
        source_url.into(),
    ];

    // Common to both encoders: force an IDR keyframe every 2s (aligned with
    // hls_time) so EVERY HLS segment starts on a keyframe. Without this the
    // source GOP (often 5–10s) leaves most segments starting mid-GOP, which
    // decodes as gray macroblock garbage until the next keyframe (the periodic
    // glitch). Convert to 8-bit yuv420p so 10-bit HEVC (Main10) sources don't
    // yield output the browser can't decode (and which H.264 NVENC can't make).
    if mode.video_copy {
        args.extend(["-c:v", "copy"].iter().map(|s| s.to_string()));
    } else if use_nvenc {
        // GPU (NVENC): cap at 1080p; ~2x real-time even for 4K/50fps HEVC, where
        // libx264 falls behind (~0.7x) and the stream buffers.
        args.extend(
            [
                "-vf",
                "scale=min(1920\\,iw):-2,format=yuv420p",
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-tune",
                "ll",
                "-b:v",
                "6M",
                "-maxrate",
                "8M",
                "-bufsize",
                "12M",
                "-forced-idr",
                "1",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    } else {
        // CPU (libx264): cap at 720p so software encode can keep up in real time.
        args.extend(
            [
                "-vf",
                "scale=min(1280\\,iw):-2,format=yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-tune",
                "zerolatency",
                "-force_key_frames",
                "expr:gte(t,n_forced*2)",
                "-sc_threshold",
                "0",
            ]
            .iter()
            .map(|s| s.to_string()),
        );
    }

    if mode.audio_copy {
        args.extend(["-c:a", "copy"].iter().map(|s| s.to_string()));
    } else {
        args.extend(
            ["-c:a", "aac", "-b:a", "128k", "-ac", "2"]
                .iter()
                .map(|s| s.to_string()),
        );
    }

    args.extend(
        [
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_list_size",
            "15",
            "-hls_flags",
            "append_list+omit_endlist+program_date_time",
            "-hls_segment_filename",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    args.push(segment_pattern.to_string_lossy().replace('\\', "/"));
    args.push(manifest.to_string_lossy().replace('\\', "/"));

    args
}

/// NVENC availability, probed once and cached. Lets heavy 4K/HEVC transcodes run
/// on the GPU in real time (libx264 on CPU can't keep up with 4K/50fps).
async fn nvenc_available(state: &RelayState) -> bool {
    match state.nvenc.load(Ordering::Relaxed) {
        1 => return true,
        2 => return false,
        _ => {}
    }
    let ok = probe_nvenc(state.ffmpeg.as_ref()).await;
    state.nvenc.store(if ok { 1 } else { 2 }, Ordering::Relaxed);
    if ok {
        log::info!("[Restream] NVENC available — GPU transcode for heavy sources");
    } else {
        log::info!("[Restream] NVENC unavailable — using libx264 (CPU) transcode");
    }
    ok
}

/// Encode one tiny frame with h264_nvenc to confirm the GPU encoder initializes.
async fn probe_nvenc(ffmpeg: &PathBuf) -> bool {
    let mut cmd = Command::new(ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "nullsrc=s=320x240",
        "-frames:v",
        "1",
        "-c:v",
        "h264_nvenc",
        "-f",
        "null",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    matches!(cmd.status().await, Ok(s) if s.success())
}

/// Get a healthy session for the source url, or start ffmpeg (copy, then
/// transcode fallback). Serialized per session id so concurrent manifest hits
/// for the same URL don't spawn duplicate ffmpeg processes.
async fn get_or_start(
    state: &RelayState,
    source_url: &str,
    force_restart: bool,
) -> Result<Arc<Session>, String> {
    let id = session_id(source_url);

    let id_lock = {
        let mut starting = state.starting.lock().await;
        starting.entry(id.clone()).or_default().clone()
    };
    let _guard = id_lock.lock().await;

    if force_restart {
        invalidate(state, &id).await;
    }

    // Reuse a healthy existing session.
    {
        let existing = {
            let sessions = state.sessions.lock().await;
            sessions.get(&id).cloned()
        };
        if let Some(existing) = existing {
            if is_healthy(&existing).await {
                existing.touch();
                // Switching back to a still-running channel: drop the others.
                stop_other_sessions(state, &id).await;
                return Ok(existing);
            }
        }
    }
    // Drop any unhealthy session before starting fresh.
    invalidate(state, &id).await;

    // First attempt: copy (cheap) while detecting the source codecs from
    // ffmpeg's input dump. If the source isn't browser-native (e.g. HEVC video),
    // restart with the right transcode mode. If copy fails outright, fall back to
    // a full transcode.
    let session = match run_ffmpeg_session(state, source_url, &id, EncodeMode::COPY, true).await {
        Ok(s) => s,
        Err(StartError::Restart(mode)) => {
            log::info!("[Restream] source not browser-native; re-encoding ({mode:?})");
            run_ffmpeg_session(state, source_url, &id, mode, false)
                .await
                .map_err(start_error_message)?
        }
        Err(StartError::Failed(copy_err)) => {
            log::warn!("[Restream] stream copy failed, retrying with transcode: {copy_err}");
            run_ffmpeg_session(state, source_url, &id, EncodeMode::TRANSCODE, false)
                .await
                .map_err(start_error_message)?
        }
    };
    // The player shows one stream at a time, so a new live channel means the
    // previous one is no longer watched — stop its ffmpeg now instead of waiting
    // for the idle reaper (also frees the provider's connection slot).
    stop_other_sessions(state, &id).await;
    Ok(session)
}

/// Kill and remove every restream session except `keep_id` (single active live
/// stream). Called when a channel starts/switches.
async fn stop_other_sessions(state: &RelayState, keep_id: &str) {
    let others: Vec<String> = {
        let sessions = state.sessions.lock().await;
        sessions.keys().filter(|k| *k != keep_id).cloned().collect()
    };
    for id in others {
        invalidate(state, &id).await;
    }
}

async fn run_ffmpeg_session(
    state: &RelayState,
    source_url: &str,
    id: &str,
    mode: EncodeMode,
    detect: bool,
) -> Result<Arc<Session>, StartError> {
    let output_dir = output_dir_for(id);
    let _ = tokio::fs::remove_dir_all(&output_dir).await;
    tokio::fs::create_dir_all(&output_dir)
        .await
        .map_err(|e| StartError::Failed(format!("could not create restream dir: {e}")))?;

    // Use the GPU (NVENC) for video transcodes when available — essential for
    // 4K/HEVC sources that overwhelm libx264 on the CPU.
    let use_nvenc = if mode.video_copy {
        false
    } else {
        nvenc_available(state).await
    };
    let args = build_ffmpeg_args(source_url, &output_dir, mode, use_nvenc);
    let mut cmd = Command::new(state.ffmpeg.as_ref());
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Kill ffmpeg if the Session (and its Child) is dropped without an
        // explicit kill — e.g. on app shutdown — so no orphan keeps streaming.
        .kill_on_drop(true);
    // Windows: don't pop up a console window for the ffmpeg child process.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| {
        StartError::Failed(format!("could not start ffmpeg ({}): {e}", state.ffmpeg.display()))
    })?;

    // Drain stderr: keep a tail for error messages AND parse the input dump to
    // learn the source codecs (for the copy-vs-transcode decision).
    let stderr_tail = Arc::new(Mutex::new(String::new()));
    let codecs = Arc::new(Mutex::new(DetectedCodecs::default()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        let codecs = codecs.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some((is_video, codec)) = parse_stream_codec(&line) {
                    let mut c = codecs.lock().await;
                    if is_video {
                        if c.video.is_none() {
                            c.video = Some(codec);
                        }
                    } else if c.audio.is_none() {
                        c.audio = Some(codec);
                    }
                }
                let mut t = tail.lock().await;
                t.push_str(&line);
                t.push('\n');
                if t.len() > 4000 {
                    let cut = t.len() - 4000;
                    *t = t.split_off(cut);
                }
            }
        });
    }

    let manifest_path = output_dir.join("index.m3u8");
    let timeout = if !mode.video_copy {
        Duration::from_millis(25_000)
    } else if !mode.audio_copy {
        Duration::from_millis(20_000)
    } else {
        Duration::from_millis(15_000)
    };
    let deadline = tokio::time::Instant::now() + timeout;
    let mut video_seen_at: Option<tokio::time::Instant> = None;

    loop {
        // ffmpeg exited before producing a manifest → real failure.
        if let Ok(Some(_)) = child.try_wait() {
            let _ = tokio::fs::remove_dir_all(&output_dir).await;
            let tail = stderr_tail.lock().await.trim().to_string();
            let msg = if tail.is_empty() {
                "ffmpeg exited before producing an HLS manifest".to_string()
            } else {
                tail
            };
            return Err(StartError::Failed(msg));
        }

        // On the initial copy/detect attempt, decide copy-vs-transcode from the
        // codecs ffmpeg reported. Only accept the copy output once the codecs are
        // confirmed browser-native.
        let mut codecs_ok = !detect;
        if detect {
            let detected = codecs.lock().await.clone();
            if let Some(video) = detected.video.as_deref() {
                if video_seen_at.is_none() {
                    video_seen_at = Some(tokio::time::Instant::now());
                }
                if !video_browser_friendly(video) {
                    // Video must be re-encoded; copy audio only if it's friendly.
                    let audio_copy = detected
                        .audio
                        .as_deref()
                        .map(audio_browser_friendly)
                        .unwrap_or(false);
                    let _ = child.start_kill();
                    let _ = tokio::fs::remove_dir_all(&output_dir).await;
                    return Err(StartError::Restart(EncodeMode { video_copy: false, audio_copy }));
                }
                if let Some(audio) = detected.audio.as_deref() {
                    if !audio_browser_friendly(audio) {
                        // Video is fine; only the audio needs re-encoding.
                        let _ = child.start_kill();
                        let _ = tokio::fs::remove_dir_all(&output_dir).await;
                        return Err(StartError::Restart(EncodeMode {
                            video_copy: true,
                            audio_copy: false,
                        }));
                    }
                }
                // Video friendly; treat audio as decided once it's reported, or
                // after a short settle (covers audio-less channels).
                let audio_decided = detected.audio.is_some()
                    || video_seen_at
                        .map(|t| t.elapsed() > Duration::from_millis(800))
                        .unwrap_or(false);
                codecs_ok = audio_decided;
            }
        }

        if codecs_ok {
            if let Ok(content) = tokio::fs::read_to_string(&manifest_path).await {
                if content.contains("#EXTM3U") {
                    let session = Arc::new(Session {
                        output_dir,
                        child: Mutex::new(child),
                        last_access: AtomicI64::new(now_ms()),
                    });
                    state
                        .sessions
                        .lock()
                        .await
                        .insert(id.to_string(), session.clone());
                    return Ok(session);
                }
            }
        }

        if tokio::time::Instant::now() >= deadline {
            let _ = child.start_kill();
            let _ = tokio::fs::remove_dir_all(&output_dir).await;
            let tail = stderr_tail.lock().await.trim().to_string();
            let msg = if tail.is_empty() {
                "Timed out waiting for ffmpeg HLS manifest".to_string()
            } else {
                tail
            };
            return Err(StartError::Failed(msg));
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

async fn is_healthy(session: &Arc<Session>) -> bool {
    let exited = session
        .child
        .lock()
        .await
        .try_wait()
        .ok()
        .flatten()
        .is_some();
    !exited
        && tokio::fs::try_exists(session.manifest_path())
            .await
            .unwrap_or(false)
}

async fn invalidate(state: &RelayState, id: &str) {
    let removed = state.sessions.lock().await.remove(id);
    if let Some(session) = removed {
        let _ = session.child.lock().await.start_kill();
        let _ = tokio::fs::remove_dir_all(&session.output_dir).await;
    }
}

async fn read_manifest(session: &Arc<Session>) -> Result<String, String> {
    let path = session.manifest_path();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(5_000);
    loop {
        if session
            .child
            .lock()
            .await
            .try_wait()
            .ok()
            .flatten()
            .is_some()
        {
            return Err("ffmpeg restream stopped unexpectedly".to_string());
        }
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            if content.contains("#EXTM3U") {
                return Ok(content);
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Restream manifest not ready".to_string());
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

async fn read_segment(session: &Arc<Session>, file_name: &str) -> Result<Vec<u8>, String> {
    // Only allow a bare file name within the session's output dir.
    let safe = std::path::Path::new(file_name)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "Invalid segment path".to_string())?;
    let segment_path = session.output_dir.join(&safe);

    let deadline = tokio::time::Instant::now() + Duration::from_millis(8_000);
    loop {
        if session
            .child
            .lock()
            .await
            .try_wait()
            .ok()
            .flatten()
            .is_some()
        {
            return Err("ffmpeg restream stopped unexpectedly".to_string());
        }
        match tokio::fs::read(&segment_path).await {
            Ok(bytes) => return Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("Restream segment not ready: {safe}"));
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
}

/// Rewrite bare segment file names in the HLS manifest to relay URLs:
/// `seg_000.ts` -> `/api/restream/<sessionId>/seg_000.ts`.
fn rewrite_manifest(content: &str, session_id: &str) -> String {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.contains("://") {
                line.to_string()
            } else {
                let file_name = trimmed.split('?').next().unwrap_or(trimmed);
                format!("/api/restream/{session_id}/{file_name}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn reap_idle(sessions: &Arc<Mutex<HashMap<String, Arc<Session>>>>) {
    let now = now_ms();
    let mut to_remove: Vec<String> = Vec::new();
    {
        let map = sessions.lock().await;
        for (id, session) in map.iter() {
            if now - session.last_access.load(Ordering::Relaxed) > SESSION_TTL.as_millis() as i64 {
                to_remove.push(id.clone());
            }
        }
    }
    for id in to_remove {
        let removed = sessions.lock().await.remove(&id);
        if let Some(session) = removed {
            let _ = session.child.lock().await.start_kill();
            let _ = tokio::fs::remove_dir_all(&session.output_dir).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn cors_text(status: StatusCode, body: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        body,
    )
        .into_response()
}

/// Parse + validate the `url` query param (port of proxyShared.ts parseProxyTarget).
fn parse_proxy_target(raw: Option<&str>) -> Result<url::Url, (StatusCode, String)> {
    let raw = match raw {
        Some(r) if !r.is_empty() => r,
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "Missing url query parameter".to_string(),
            ))
        }
    };
    let target = url::Url::parse(raw)
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid target url".to_string()))?;
    if !matches!(target.scheme(), "http" | "https") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Unsupported target protocol".to_string(),
        ));
    }
    if is_blocked_host(target.host_str()) {
        return Err((StatusCode::FORBIDDEN, "Target host is blocked".to_string()));
    }
    Ok(target)
}

/// Block loopback / private / link-local hosts so the relay can't be aimed at
/// the machine itself or the LAN (port of proxyShared.ts isBlockedHost).
fn is_blocked_host(host: Option<&str>) -> bool {
    let Some(host) = host else { return true };
    let h = host.to_lowercase();
    let h = h.trim_start_matches('[').trim_end_matches(']');
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") {
        return true;
    }
    if h == "::1" {
        return true;
    }
    if h.starts_with("fc") || h.starts_with("fd") {
        return true;
    }
    let octets: Vec<u8> = h.split('.').filter_map(|p| p.parse::<u8>().ok()).collect();
    if octets.len() == 4 && h.split('.').count() == 4 {
        let (a, b) = (octets[0], octets[1]);
        if a == 10 || a == 127 || a == 0 {
            return true;
        }
        if a == 169 && b == 254 {
            return true;
        }
        if a == 172 && (16..=31).contains(&b) {
            return true;
        }
        if a == 192 && b == 168 {
            return true;
        }
        if a >= 224 {
            return true;
        }
    }
    false
}
