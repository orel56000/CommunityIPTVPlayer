//! Automatic subtitle synchronization, native side.
//!
//! The browser can do this on its own (see `src/utils/subsync*.ts`), but only
//! by shipping a WebAssembly FFmpeg and doing the arithmetic in JavaScript.
//! When this app is running there is a real FFmpeg one process away, and quite
//! possibly a real ffsubsync too — so the relay offers two things the browser
//! cannot:
//!
//! * `POST /api/subsync` — hand the whole job to an installed **ffsubsync**.
//!   That is the original implementation rather than our port of it, so where
//!   it is available it is authoritative: its WebRTC VAD, its embedded-subtitle
//!   fast path, its scoring.
//!
//! * `GET  /api/subsync/reference` — when ffsubsync is *not* installed, decode
//!   the reference audio with the bundled ffmpeg and return just the 100 Hz
//!   speech signal (one byte per 10 ms — about 1 MB for a three-hour film).
//!   The frontend then finishes with the same TypeScript aligner the web-only
//!   mode uses, so the two paths cannot drift apart. What the backend
//!   contributes here is what only it can: decoding a multi-gigabyte remote
//!   stream without any of it passing through the browser.
//!
//! Both are loopback-only. They spawn ffmpeg against a provider URL and can run
//! for minutes; a LAN peer that reaches this relay gets the in-browser engine.
//!
//! Everything spawned here is spawned with an argument ARRAY. No part of a URL,
//! a path or a subtitle line is ever pasted into a shell string.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::OnceCell;

/// User-Agent that makes Xtream providers serve the real stream. Kept in step
/// with `relay.rs`'s constant of the same name — the two are separate because
/// this module spawns its own ffmpeg rather than going through the proxy.
const PLAYER_UA: &str =
    "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 ExoPlayerLib/2.18.1";

/// Replace a provider URL with its host wherever it appears in a message.
///
/// Both ffmpeg and ffsubsync quote the input back in their errors, and an
/// Xtream URL is `http://host/USERNAME/PASSWORD/12345.ts`. These messages are
/// shown to the user and written to the debug log, so the credentials come out
/// before either happens. The host is kept — it is what makes the message
/// useful — and the query string goes too, since tokens live there as well.
fn redact_url(text: &str, url: &str) -> String {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_string()))
        .unwrap_or_else(|| "the provider".to_string());
    let replacement = format!("<{host}>");
    // Match on the scheme+host PREFIX and run to the next whitespace or quote,
    // rather than looking for the exact string we sent. Both tools reformat
    // what they echo — percent-encoding, a trimmed slash, an appended query —
    // and an exact match would strip the path while leaving `?token=...`
    // sitting in the message.
    let mut out = text.to_string();
    if let Ok(parsed) = url::Url::parse(url) {
        if let Some(host_str) = parsed.host_str() {
            let prefix = format!("{}://{}", parsed.scheme(), host_str);
            while let Some(at) = out.find(&prefix) {
                let rest = &out[at..];
                let end = rest
                    .find(|c: char| c.is_whitespace() || c == '\'' || c == '"')
                    .unwrap_or(rest.len());
                out.replace_range(at..at + end, &replacement);
            }
        }
    } else {
        out = out.replace(url, &replacement);
    }
    out
}

/// True for an input ffmpeg will open with its HTTP protocol.
fn is_http_url(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// `scheme://host/` for a target, which is the Referer the relay sends.
fn referer_for(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    Some(format!("{}://{}/", parsed.scheme(), parsed.host_str()?))
}

/// Samples per second of the speech signal. Mirrors `SAMPLE_RATE` in
/// `src/utils/subsyncSpeech.ts` and ffsubsync's `constants.SAMPLE_RATE`.
pub const SAMPLE_RATE: usize = 100;

/// Audio rate asked of ffmpeg. Mirrors `EXTRACT_SAMPLE_RATE` in
/// `src/utils/subsyncAudio.ts` so the native and browser paths detect speech
/// from identically-sampled audio.
const AUDIO_RATE: usize = 16000;

/// auditok's energy gate, in dB over int16 units. See `subsyncVad.ts`.
const ENERGY_THRESHOLD_DB: f64 = 50.0;
const SILENT_WINDOW_DB: f64 = -200.0;

/// Tokenizer bounds in 10 ms windows — 0.2 s / 5 s / 0.25 s at 100 Hz.
const MIN_TOKEN_WINDOWS: usize = 20;
const MAX_TOKEN_WINDOWS: usize = 500;
const MAX_CONTINUOUS_SILENCE_WINDOWS: usize = 25;

/// How much audio to detect in one go, in BYTES. Mirrors ffsubsync's read loop
/// (its `frames_per_window * windows_per_buffer`) and is an exact multiple of
/// the 10 ms window, so a window never straddles two blocks and gets judged as
/// two half-silences.
const READ_WINDOW_BYTES: usize = (AUDIO_RATE / SAMPLE_RATE) * 2 * 10_000; // 100 s

/// Give up on a reference that will not finish. A three-hour remote stream
/// decodes well inside this; anything slower is a stalled provider.
const EXTRACT_TIMEOUT_SECS: u64 = 30 * 60;

/// ffsubsync itself is bounded more tightly: it downloads the reference too,
/// and a run that has not finished by now is not going to.
const FFSUBSYNC_TIMEOUT_SECS: u64 = 45 * 60;

// ---------------------------------------------------------------------------
// Wire types (mirrored by hand in src/types/subtitleSync.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct WireCue {
    /// Seconds from the start of the media.
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    /// The reference media. Validated by the caller with `parse_proxy_target`.
    pub url: String,
    pub cues: Vec<WireCue>,
    #[serde(default)]
    pub start_seconds: Option<f64>,
    #[serde(default)]
    pub max_offset_seconds: Option<f64>,
    #[serde(default)]
    pub max_duration_seconds: Option<f64>,
    #[serde(default)]
    pub no_fix_framerate: Option<bool>,
    #[serde(default)]
    pub gss: Option<bool>,
    /// Seconds of overlap charged per mid-file offset change; None = one offset.
    #[serde(default)]
    pub split_penalty_seconds: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireOutCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    /// Always true here; the "not installed" case is a 501 with `available`.
    pub available: bool,
    pub cues: Vec<WireOutCue>,
    pub offset_seconds: f64,
    pub framerate_scale_factor: f64,
    /// ffsubsync's raw correlation peak, when it logged one.
    pub score: Option<f64>,
    /// The ffsubsync build that produced this, for the debug log.
    pub tool: String,
}

#[derive(Debug)]
pub enum SyncError {
    /// No usable ffsubsync on this machine. The caller falls back.
    NotInstalled,
    /// ffsubsync ran and failed on the merits. NEVER silently fallen back from.
    Failed(String),
    /// Something went wrong on our side (temp files, ffmpeg, timeouts).
    Internal(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::NotInstalled => write!(f, "ffsubsync is not installed"),
            SyncError::Failed(message) => write!(f, "{message}"),
            SyncError::Internal(message) => write!(f, "{message}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Locating ffsubsync
// ---------------------------------------------------------------------------

/// The argv prefix that runs ffsubsync, e.g. `["ffsubsync"]` or
/// `["python3", "-m", "ffsubsync"]`.
type Launcher = Vec<String>;

static FFSUBSYNC: OnceCell<Option<Launcher>> = OnceCell::const_new();

fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

async fn probe(launcher: &[String]) -> Option<String> {
    let (program, rest) = launcher.split_first()?;
    let mut cmd = Command::new(program);
    cmd.args(rest)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);
    // A cold ffsubsync imports numpy, which is slow but not minutes-slow.
    let output = tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // argparse prints `--version` to stdout on py3; be forgiving anyway.
    let text = if output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr)
    } else {
        String::from_utf8_lossy(&output.stdout)
    };
    let version = text.trim().to_string();
    if version.to_lowercase().contains("ffsubsync") {
        Some(version)
    } else {
        None
    }
}

/// Find a runnable ffsubsync, once per process.
///
/// Probing is deliberately cached even when it FAILS: the probe costs a process
/// spawn and a numpy import, and re-paying that on every sync attempt on a
/// machine without Python would be a visible stall before the fallback path
/// even starts. Restarting the app re-probes, which is the right granularity
/// for "I just installed it".
pub async fn ffsubsync_launcher() -> Option<&'static Launcher> {
    FFSUBSYNC
        .get_or_init(|| async {
            let mut candidates: Vec<Launcher> = Vec::new();
            if let Ok(explicit) = std::env::var("CTV_FFSUBSYNC") {
                if !explicit.trim().is_empty() {
                    candidates.push(vec![explicit]);
                }
            }
            // The three console scripts setup.py installs, then the module
            // form. Note the module path: the package has no `__main__.py`, so
            // `python -m ffsubsync` fails with "cannot be directly executed" —
            // it is `ffsubsync.ffsubsync` that carries the entry point.
            for name in ["ffsubsync", "subsync", "ffs"] {
                candidates.push(vec![name.to_string()]);
            }
            for python in ["python3", "python"] {
                candidates.push(vec![
                    python.to_string(),
                    "-m".to_string(),
                    "ffsubsync.ffsubsync".to_string(),
                ]);
            }

            for candidate in candidates {
                if let Some(version) = probe(&candidate).await {
                    log::info!("[subsync] using {} ({version})", candidate.join(" "));
                    return Some(candidate);
                }
            }
            log::info!(
                "[subsync] no ffsubsync found — the frontend will align with its own port"
            );
            None
        })
        .await
        .as_ref()
}

// ---------------------------------------------------------------------------
// SRT in / out
// ---------------------------------------------------------------------------

fn srt_timestamp(seconds: f64) -> String {
    let clamped = if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        0.0
    };
    let total_ms = (clamped * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_s = total_ms / 1000;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        total_s / 3600,
        (total_s % 3600) / 60,
        total_s % 60,
        ms
    )
}

/// Serialize cues as SRT for ffsubsync to read.
///
/// A blank line inside a cue would end the block early and shift every later
/// cue's index, so embedded blank lines are collapsed rather than passed
/// through — the text is only ever used to decide "is this dialogue", so the
/// exact whitespace does not matter to the alignment.
pub fn compose_srt(cues: &[WireCue]) -> String {
    let mut out = String::new();
    for (index, cue) in cues.iter().enumerate() {
        let text = cue
            .text
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .lines()
            .map(str::trim_end)
            .filter(|line| !line.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        out.push_str(&format!("{}\n", index + 1));
        out.push_str(&format!(
            "{} --> {}\n",
            srt_timestamp(cue.start),
            srt_timestamp(cue.end)
        ));
        out.push_str(if text.is_empty() { " " } else { &text });
        out.push_str("\n\n");
    }
    out
}

fn parse_srt_timestamp(raw: &str) -> Option<f64> {
    let value = raw.trim();
    let (hms, frac) = match value.split_once(',').or_else(|| value.split_once('.')) {
        Some((a, b)) => (a, Some(b)),
        None => (value, None),
    };
    let parts: Vec<&str> = hms.split(':').collect();
    let (h, m, s) = match parts.as_slice() {
        [h, m, s] => (h.parse::<f64>().ok()?, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        [m, s] => (0.0, m.parse::<f64>().ok()?, s.parse::<f64>().ok()?),
        _ => return None,
    };
    let fraction = match frac {
        Some(digits) => format!("0.{}", digits.trim()).parse::<f64>().ok()?,
        None => 0.0,
    };
    Some(h * 3600.0 + m * 60.0 + s + fraction)
}

/// One cue read back out of ffsubsync's output.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Read back what ffsubsync wrote.
///
/// The text is needed as well as the timings, and not for display: ffsubsync
/// can emit FEWER cues than it was given (its SRT writer drops any cue whose
/// start went below zero) and renumbers what remains, so pairing input to
/// output by index would silently attach one line's timings to another line's
/// words. Matching on the text is what makes the mapping trustworthy.
pub fn parse_srt(input: &str) -> Vec<ParsedCue> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<ParsedCue> = Vec::new();
    let mut pending: Option<(f64, f64)> = None;
    let mut body: Vec<&str> = Vec::new();
    // A bare-number line whose role is not yet known. See the loop below.
    let mut held: Option<&str> = None;

    let flush = |out: &mut Vec<ParsedCue>, pending: &mut Option<(f64, f64)>, body: &mut Vec<&str>| {
        if let Some((start, end)) = pending.take() {
            out.push(ParsedCue {
                start,
                end,
                text: body.join("\n").trim().to_string(),
            });
        }
        body.clear();
    };

    for line in normalized.lines() {
        if let Some((left, right)) = line.split_once("-->") {
            // A timing line proves the held number was this block's index.
            held = None;
            // It also ends the previous cue.
            flush(&mut out, &mut pending, &mut body);
            let start = parse_srt_timestamp(left);
            // Cue settings can follow the end timestamp; take the first token.
            let end = right
                .trim()
                .split_whitespace()
                .next()
                .and_then(parse_srt_timestamp);
            if let (Some(start), Some(end)) = (start, end) {
                pending = Some((start, end));
            }
            continue;
        }
        if pending.is_some() {
            // Blank lines separate blocks and are never part of the text — but
            // a number held from the line before is now settled: nothing
            // followed it inside the block, so it was dialogue, not an index.
            if line.trim().is_empty() {
                if let Some(number) = held.take() {
                    body.push(number);
                }
                continue;
            }
            // A bare number is AMBIGUOUS: it is usually the index of the next
            // block, but it is also a perfectly ordinary subtitle line ("1999",
            // "42"). Hold it back rather than deciding now — if a timing line
            // follows it really was an index and is dropped; if anything else
            // follows, it was dialogue and is restored. Guessing here would
            // corrupt the text that the cue matching depends on.
            if line.trim().parse::<u32>().is_ok() {
                held = Some(line);
                continue;
            }
            if let Some(number) = held.take() {
                body.push(number);
            }
            body.push(line);
        }
    }
    // A trailing bare number with nothing after it was the last cue's text.
    if let Some(number) = held.take() {
        body.push(number);
    }
    flush(&mut out, &mut pending, &mut body);
    out
}

/// Collapse a cue's text the way `compose_srt` does, so the two can be compared.
fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Map ffsubsync's output cues back onto the cues we sent it.
///
/// A forward-only walk over both lists, matching on text. Forward-only is what
/// makes repeated lines ("Yes.", "What?") map correctly — each output cue takes
/// the next input cue that says the same thing, never an earlier one. Input
/// cues with no match were dropped by ffsubsync for going below zero, and come
/// back as `None`.
fn match_output_to_input(input: &[WireCue], output: &[ParsedCue]) -> Vec<Option<(f64, f64)>> {
    let mut mapped: Vec<Option<(f64, f64)>> = vec![None; input.len()];
    let mut cursor = 0usize;
    for cue in output {
        let wanted = normalize_text(&cue.text);
        while cursor < input.len() {
            let candidate = normalize_text(&input[cursor].text);
            cursor += 1;
            // compose_srt writes a lone space for an empty cue; treat that as
            // the empty text it stands for.
            if candidate == wanted || (candidate.is_empty() && wanted.is_empty()) {
                mapped[cursor - 1] = Some((cue.start, cue.end));
                break;
            }
        }
    }
    mapped
}

// ---------------------------------------------------------------------------
// Running the real ffsubsync
// ---------------------------------------------------------------------------

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A private directory for this process's subtitle temp files.
///
/// The system temp directory is shared and world-writable, so a predictable
/// name there can be pre-created as a symlink by another local user and made to
/// point wherever they like. A per-process directory created with 0700 (and
/// created exclusively, so an existing one is a hard error rather than someone
/// else's) keeps the SRT we write, and the one ffsubsync writes back, out of
/// reach.
fn temp_dir() -> std::io::Result<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("ctv-subsync-{}-{nanos:x}", std::process::id()));
    match std::fs::create_dir(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(dir)
}

fn temp_path(dir: &Path, suffix: &str) -> PathBuf {
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!("subs-{seq}{suffix}"))
}

/// Pull the numbers ffsubsync logs, so the UI can report a score and a
/// framerate correction rather than only a shift.
///
/// Best-effort by design: the timings in the output file are the real answer,
/// and the offset is re-derived from them below when a log line is missing or
/// its format has moved.
fn parse_ffsubsync_log(stderr: &str) -> (Option<f64>, Option<f64>, Option<f64>) {
    let mut score = None;
    let mut offset = None;
    let mut scale = None;
    for line in stderr.lines() {
        let lower = line.to_lowercase();
        // Slices `lower`, never `line`: lowercasing is not length-preserving
        // for every Unicode scalar, so a byte offset found in one is not a
        // valid boundary in the other — and slicing a String on a non-boundary
        // PANICS. The captured text is a float either way.
        let value = |prefix: &str| -> Option<f64> {
            let at = lower.find(prefix)?;
            lower[at + prefix.len()..]
                .trim()
                .split_whitespace()
                .next()?
                .parse::<f64>()
                .ok()
        };
        if score.is_none() {
            score = value("score: ");
        }
        if offset.is_none() {
            offset = value("offset seconds: ");
        }
        if scale.is_none() {
            scale = value("framerate scale factor: ");
        }
    }
    (score, offset, scale)
}

/// Least-squares fit of `synced = original * scale + offset`.
///
/// Used when ffsubsync's log lines could not be read. With two or more cues
/// this recovers both numbers exactly for a linear correction, and degrades to
/// "offset only" for a single cue. Piecewise output is not linear, so the
/// result is then an average — which is all a single reported number can be.
fn fit_linear(pairs: &[(f64, f64)]) -> (f64, f64) {
    let n = pairs.len() as f64;
    if pairs.is_empty() {
        return (1.0, 0.0);
    }
    if pairs.len() == 1 {
        return (1.0, pairs[0].1 - pairs[0].0);
    }
    let mean_x = pairs.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_y = pairs.iter().map(|p| p.1).sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (x, y) in pairs {
        num += (x - mean_x) * (y - mean_y);
        den += (x - mean_x) * (x - mean_x);
    }
    let scale = if den.abs() < 1e-9 { 1.0 } else { num / den };
    (scale, mean_y - scale * mean_x)
}

/// Hand the whole job to an installed ffsubsync.
pub async fn run_ffsubsync(
    ffmpeg: &Path,
    url: &str,
    request: &SyncRequest,
) -> Result<SyncResponse, SyncError> {
    let Some(launcher) = ffsubsync_launcher().await else {
        return Err(SyncError::NotInstalled);
    };
    if request.cues.is_empty() {
        return Err(SyncError::Failed("These subtitles have no lines.".into()));
    }

    let dir = temp_dir()
        .map_err(|e| SyncError::Internal(format!("could not create a temp directory: {e}")))?;
    let input = TempFile(temp_path(&dir, ".srt"));
    let output = TempFile(temp_path(&dir, ".synced.srt"));
    std::fs::write(&input.0, compose_srt(&request.cues))
        .map_err(|e| SyncError::Internal(format!("could not write the subtitles: {e}")))?;

    let (program, rest) = launcher
        .split_first()
        .ok_or_else(|| SyncError::Internal("empty ffsubsync launcher".into()))?;

    // Argument ARRAY throughout: `url` comes from the network and must never be
    // able to become anything but a single argv entry.
    let mut args: Vec<String> = rest.to_vec();
    args.push(url.to_string());
    args.push("-i".into());
    args.push(input.0.to_string_lossy().into_owned());
    args.push("-o".into());
    args.push(output.0.to_string_lossy().into_owned());
    // Point ffsubsync at OUR ffmpeg (it wants the containing directory), so it
    // uses the bundled sidecar rather than whatever is on PATH — or nothing.
    if let Some(dir) = ffmpeg.parent() {
        if !dir.as_os_str().is_empty() {
            args.push("--ffmpeg-path".into());
            args.push(dir.to_string_lossy().into_owned());
        }
    }
    args.push("--output-encoding".into());
    args.push("utf-8".into());
    if let Some(start) = request.start_seconds.filter(|v| *v > 0.0) {
        args.push("--start-seconds".into());
        args.push(format!("{}", start.round() as i64));
    }
    if let Some(max_offset) = request.max_offset_seconds.filter(|v| *v > 0.0) {
        args.push("--max-offset-seconds".into());
        args.push(format!("{max_offset}"));
    }
    if let Some(max_duration) = request.max_duration_seconds.filter(|v| *v > 0.0) {
        args.push("--max-duration-seconds".into());
        args.push(format!("{}", max_duration.round() as i64));
    }
    if request.no_fix_framerate.unwrap_or(false) {
        args.push("--no-fix-framerate".into());
    }
    if request.gss.unwrap_or(false) {
        args.push("--gss".into());
    }
    if let Some(penalty) = request.split_penalty_seconds.filter(|v| *v > 0.0) {
        args.push("--split-penalty".into());
        args.push(format!("{penalty}"));
    }

    let mut cmd = Command::new(program);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);

    log::info!("[subsync] running {} on {url}", launcher.join(" "));
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(FFSUBSYNC_TIMEOUT_SECS),
        cmd.output(),
    )
    .await;

    let output_result = match result {
        Ok(Ok(value)) => value,
        Ok(Err(e)) => return Err(SyncError::Internal(format!("could not run ffsubsync: {e}"))),
        Err(_) => {
            return Err(SyncError::Failed(
                "ffsubsync did not finish in time.".to_string(),
            ))
        }
    };

    let stderr = String::from_utf8_lossy(&output_result.stderr).to_string();
    if !output_result.status.success() {
        // ffsubsync echoes the reference it was given, and for an Xtream
        // provider that URL carries the user's username and password in its
        // path. The tail below goes straight to the player's status line, so
        // the URL is stripped out of it first.
        // A real synchronization failure. Surfaced as-is: falling back to the
        // browser engine here would re-run the same data through a second
        // implementation and hide the actual reason behind a second one.
        let tail: String = stderr
            .lines()
            .filter(|line| !line.trim().is_empty())
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|line| redact_url(line, url))
            .collect::<Vec<_>>()
            .join("\n");
        return Err(SyncError::Failed(if tail.is_empty() {
            "ffsubsync could not synchronize these subtitles.".to_string()
        } else {
            tail
        }));
    }

    let synced = std::fs::read_to_string(&output.0)
        .map_err(|e| SyncError::Internal(format!("could not read ffsubsync's output: {e}")))?;
    let parsed = parse_srt(&synced);
    if parsed.is_empty() {
        return Err(SyncError::Failed(
            "ffsubsync produced no subtitles.".to_string(),
        ));
    }

    // Matched by TEXT, never by index: ffsubsync's writer silently drops cues
    // whose start went below zero and renumbers the rest, so index pairing
    // would hand one line's timings to another line's words.
    let mapped = match_output_to_input(&request.cues, &parsed);
    let matched = mapped.iter().filter(|slot| slot.is_some()).count();
    if matched == 0 {
        return Err(SyncError::Failed(
            "ffsubsync's output could not be matched to the subtitles that were sent."
                .to_string(),
        ));
    }
    if matched < request.cues.len() {
        log::info!(
            "[subsync] ffsubsync returned {matched} of {} cues; the rest were pushed before zero",
            request.cues.len()
        );
    }

    let (score, logged_offset, logged_scale) = parse_ffsubsync_log(&stderr);
    // The log is best-effort — rich's formatting, or a future rename, could
    // move those lines — so the transform is also recovered from the cue pairs.
    let pairs: Vec<(f64, f64)> = request
        .cues
        .iter()
        .zip(mapped.iter())
        .filter_map(|(cue, slot)| slot.map(|(start, _)| (cue.start, start)))
        .collect();
    let (fitted_scale, fitted_offset) = fit_linear(&pairs);

    let cues = request
        .cues
        .iter()
        .zip(mapped.iter())
        .filter_map(|(cue, slot)| {
            slot.map(|(start, end)| WireOutCue {
                start,
                end,
                // The text comes from the REQUEST, not from the file we read
                // back, so an encoding round-trip through ffsubsync cannot
                // mangle it.
                text: cue.text.clone(),
            })
        })
        .collect();

    Ok(SyncResponse {
        available: true,
        cues,
        offset_seconds: logged_offset.unwrap_or(fitted_offset),
        framerate_scale_factor: logged_scale.unwrap_or(fitted_scale),
        score,
        tool: launcher.join(" "),
    })
}

// ---------------------------------------------------------------------------
// Reference speech extraction (the fallback path)
// ---------------------------------------------------------------------------

/// `10 * log10(mean(x^2))` over one window of int16 samples — auditok's
/// `AudioEnergyValidator`. Accumulated in f64: 160 samples of full-scale int16
/// square to ~1.7e11, well past i32.
fn window_energy_db(pcm: &[i16]) -> f64 {
    if pcm.is_empty() {
        return SILENT_WINDOW_DB;
    }
    let mut sum = 0.0f64;
    for sample in pcm {
        let value = *sample as f64;
        sum += value * value;
    }
    let energy = sum / pcm.len() as f64;
    if energy <= 0.0 {
        SILENT_WINDOW_DB
    } else {
        10.0 * energy.log10()
    }
}

/// auditok's `StreamTokenizer` in the shape ffsubsync configures it
/// (`init_min = 0`, `init_max_silence = 0`, `mode = 0`).
///
/// Line-for-line the same state machine as `tokenize` in
/// `src/utils/subsyncVad.ts`; the two are verified against the same vectors so
/// a native-extracted reference and a browser-extracted one agree.
// The bookkeeping the macro below writes on the LAST call is genuinely never
// read again — the loop has ended. Keeping the macro uniform is worth more
// than pruning those four stores, because it is what makes this state machine
// line up with auditok's (and with subsyncVad.ts) statement for statement.
#[allow(unused_assignments)]
fn tokenize(valid: &[bool]) -> Vec<(usize, usize)> {
    const SILENCE: u8 = 0;
    const NOISE: u8 = 1;
    const POSSIBLE_SILENCE: u8 = 2;

    let mut tokens: Vec<(usize, usize)> = Vec::new();
    let mut state = SILENCE;
    let mut data_length: usize = 0;
    let mut silence_length: usize = 0;
    let mut start_window: usize = 0;
    let mut contiguous = false;
    let mut current: usize = 0;

    macro_rules! end_of_detection {
        ($truncated:expr) => {{
            if data_length >= MIN_TOKEN_WINDOWS || (data_length > 0 && contiguous) {
                tokens.push((start_window, start_window + data_length - 1));
                if $truncated {
                    start_window = current + 1;
                    contiguous = true;
                } else {
                    contiguous = false;
                }
            } else {
                contiguous = false;
            }
            data_length = 0;
        }};
    }

    for (index, is_valid) in valid.iter().copied().enumerate() {
        current = index;
        if state == SILENCE {
            if is_valid {
                silence_length = 0;
                start_window = current;
                data_length = 1;
                state = NOISE;
                if data_length >= MAX_TOKEN_WINDOWS {
                    end_of_detection!(true);
                }
            }
        } else if state == NOISE {
            if is_valid {
                data_length += 1;
                if data_length >= MAX_TOKEN_WINDOWS {
                    end_of_detection!(true);
                }
            } else {
                silence_length = 1;
                data_length += 1;
                state = POSSIBLE_SILENCE;
                if data_length == MAX_TOKEN_WINDOWS {
                    end_of_detection!(true);
                }
            }
        } else if is_valid {
            data_length += 1;
            silence_length = 0;
            state = NOISE;
            if data_length >= MAX_TOKEN_WINDOWS {
                end_of_detection!(true);
            }
        } else if silence_length >= MAX_CONTINUOUS_SILENCE_WINDOWS {
            if silence_length < data_length {
                end_of_detection!(false);
            } else {
                data_length = 0;
            }
            state = SILENCE;
            silence_length = 0;
        } else {
            data_length += 1;
            silence_length += 1;
            if data_length >= MAX_TOKEN_WINDOWS {
                end_of_detection!(true);
            }
        }
    }

    if (state == NOISE || state == POSSIBLE_SILENCE) && data_length > 0 && data_length > silence_length
    {
        current = valid.len().saturating_sub(1);
        end_of_detection!(false);
    }
    tokens
}

/// Detect speech in one block of mono int16 PCM, returning one byte (0 or 1)
/// per 10 ms.
///
/// Blocks must be cut on a whole number of windows or the seam is judged as two
/// half-silences; `READ_WINDOW_SAMPLES` guarantees that for every read but the
/// last.
pub fn detect_speech(pcm: &[i16], audio_rate: usize) -> Vec<u8> {
    let samples_per_window = (audio_rate / SAMPLE_RATE).max(1);
    let window_count = pcm.len().div_ceil(samples_per_window);
    let mut valid = vec![false; window_count];
    for (index, slot) in valid.iter_mut().enumerate() {
        let from = index * samples_per_window;
        let to = (from + samples_per_window).min(pcm.len());
        *slot = window_energy_db(&pcm[from..to]) >= ENERGY_THRESHOLD_DB;
    }

    // Difference array then a running sum, as upstream does — but accumulating
    // the terminator rather than assigning it. See the long note in
    // subsyncVad.ts: assignment lets a token truncated at the five-second cap
    // erase the previous token's terminator, after which everything to the end
    // of the block reads as speech.
    let mut deltas = vec![0i32; window_count + 1];
    for (start, end) in tokenize(&valid) {
        deltas[start] += 1;
        if end + 1 < deltas.len() {
            deltas[end + 1] -= 1;
        }
    }
    let mut out = vec![0u8; window_count];
    let mut running = 0i32;
    for (index, slot) in out.iter_mut().enumerate() {
        running += deltas[index];
        *slot = if running > 0 { 1 } else { 0 };
    }
    out
}

fn timestamp(seconds: f64) -> String {
    let whole = seconds.max(0.0).floor() as u64;
    format!(
        "{}:{:02}:{:02}",
        whole / 3600,
        (whole % 3600) / 60,
        whole % 60
    )
}

/// The ffmpeg argv for reference audio, mirroring ffsubsync's
/// `VideoSpeechTransformer._build_ffmpeg_args`.
///
/// `-af aresample=async=1` is not optional: without it a stream with dropped or
/// duplicated samples lets byte position drift away from wall-clock, and since
/// the whole method is "which 10 ms window was this", the drift becomes error
/// in the answer. `-vn` keeps ffmpeg from ever decoding a video frame.
pub fn build_audio_args(
    url: &str,
    start_seconds: f64,
    max_duration_seconds: Option<f64>,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    if start_seconds > 0.0 {
        args.push("-ss".into());
        args.push(timestamp(start_seconds));
    }
    if let Some(max) = max_duration_seconds.filter(|v| *v > 0.0) {
        args.push("-t".into());
        args.push(timestamp(max));
    }
    args.push("-loglevel".into());
    args.push("error".into());
    args.push("-nostdin".into());
    // The same identity the rest of the relay presents. An Xtream panel served
    // a default User-Agent hands back a debug page rather than the stream, so
    // without these the extraction "succeeds" against HTML and finds no audio.
    //
    // ONLY for an http(s) input. These are options of ffmpeg's HTTP protocol,
    // and passing them alongside a local path fails the whole invocation with
    // "Option user_agent not found" before a single sample is decoded.
    if is_http_url(url) {
        args.push("-user_agent".into());
        args.push(PLAYER_UA.to_string());
        if let Some(referer) = referer_for(url) {
            args.push("-headers".into());
            args.push(format!("Referer: {referer}\r\n"));
        }
    }
    args.push("-i".into());
    args.push(url.to_string());
    args.push("-vn".into());
    args.push("-f".into());
    args.push("s16le".into());
    args.push("-ac".into());
    args.push("1".into());
    args.push("-acodec".into());
    args.push("pcm_s16le".into());
    args.push("-af".into());
    args.push("aresample=async=1".into());
    args.push("-ar".into());
    args.push(AUDIO_RATE.to_string());
    args.push("-".into());
    args
}

pub struct ReferenceSpeech {
    /// One byte per 10 ms: 1 for speech, 0 for not.
    pub samples: Vec<u8>,
}

/// Decode the reference and reduce it to the 100 Hz speech signal.
///
/// Audio is consumed as it arrives and folded straight into the signal, so the
/// relay holds one 100-second read (3.2 MB) at a time regardless of how long
/// the film is. What comes back is ~1 MB for three hours.
pub async fn extract_reference_speech(
    ffmpeg: &Path,
    url: &str,
    start_seconds: f64,
    max_duration_seconds: Option<f64>,
) -> Result<ReferenceSpeech, SyncError> {
    let args = build_audio_args(url, start_seconds, max_duration_seconds);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        SyncError::Internal(format!("could not start ffmpeg ({}): {e}", ffmpeg.display()))
    })?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| SyncError::Internal("ffmpeg produced no output pipe".into()))?;

    // Keep a short tail of stderr so a failure can say why.
    let stderr_tail = std::sync::Arc::new(tokio::sync::Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buffer = tail.lock().await;
                buffer.push_str(&line);
                buffer.push('\n');
                if buffer.len() > 2000 {
                    // Trim on a CHARACTER boundary. `split_off` at a raw byte
                    // offset panics the moment ffmpeg says anything non-ASCII
                    // — a filename, a localized message — and that panic would
                    // take the stderr drain down with it.
                    let cut = buffer
                        .char_indices()
                        .map(|(index, _)| index)
                        .find(|index| *index >= buffer.len() - 2000)
                        .unwrap_or(0);
                    *buffer = buffer.split_off(cut);
                }
            }
        });
    }

    let mut samples: Vec<u8> = Vec::new();
    let mut carry: Vec<u8> = Vec::with_capacity(READ_WINDOW_BYTES);
    let mut buffer = vec![0u8; 256 * 1024];

    let detect_block = |carry: &mut Vec<u8>, samples: &mut Vec<u8>, flush: bool| {
        // Only whole 10 ms windows, or a window would be split across two
        // detections and each half judged as near-silence. On the final flush
        // the last partial window is kept — it is real audio.
        let bytes_per_window = (AUDIO_RATE / SAMPLE_RATE) * 2;
        let usable = if flush {
            carry.len() - (carry.len() % 2)
        } else {
            // Exactly one block, never "whatever whole windows happen to be
            // buffered". The detector has no state between calls, so block
            // BOUNDARIES decide where a run of speech gets cut in two — and if
            // those followed pipe scheduling, the same file would produce a
            // different reference signal on every run.
            READ_WINDOW_BYTES.min(carry.len() - (carry.len() % bytes_per_window))
        };
        if usable == 0 {
            return;
        }
        let pcm: Vec<i16> = carry[..usable]
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        samples.extend_from_slice(&detect_speech(&pcm, AUDIO_RATE));
        carry.drain(..usable);
    };

    let pump = async {
        loop {
            let read = stdout
                .read(&mut buffer)
                .await
                .map_err(|e| SyncError::Internal(format!("reading ffmpeg output failed: {e}")))?;
            if read == 0 {
                break;
            }
            carry.extend_from_slice(&buffer[..read]);
            // Detect only once a FULL block has arrived, never per pipe read.
            //
            // A read off a pipe returns whatever happens to be buffered, which
            // is routinely a few kilobytes — well under a second of audio. The
            // tokenizer has no state between calls, so detecting per read means
            // every run of speech is chopped into fragments shorter than its
            // own 0.2s minimum length and thrown away: a whole film comes back
            // silent. Blocking up to ~100 seconds, as ffsubsync's own read loop
            // does, is what makes the detector see runs at all.
            while carry.len() >= READ_WINDOW_BYTES {
                detect_block(&mut carry, &mut samples, false);
            }
        }
        detect_block(&mut carry, &mut samples, true);
        Ok::<(), SyncError>(())
    };

    match tokio::time::timeout(std::time::Duration::from_secs(EXTRACT_TIMEOUT_SECS), pump).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(e);
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(SyncError::Failed(
                "Reading the video's audio took too long.".to_string(),
            ));
        }
    }

    let status = child.wait().await.ok();
    if samples.is_empty() {
        let tail = redact_url(&stderr_tail.lock().await.clone(), url);
        return Err(SyncError::Failed(format!(
            "Could not read any audio from this video.{}",
            if tail.trim().is_empty() {
                String::new()
            } else {
                format!(" ffmpeg said: {}", tail.trim())
            }
        )));
    }
    if let Some(status) = status {
        if !status.success() {
            // Partial audio is still usable — a provider that drops the tail of
            // a stream is routine here, and an offset from the first 80 minutes
            // is a great deal better than an error message.
            log::warn!(
                "[subsync] ffmpeg exited {status} after {} seconds of audio; using what arrived",
                samples.len() / SAMPLE_RATE
            );
        }
    }

    Ok(ReferenceSpeech { samples })
}

/// Query parameters for `GET /api/subsync/reference`.
#[derive(Debug, Deserialize)]
pub struct ReferenceQuery {
    pub url: String,
    #[serde(default)]
    pub start: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

/// Headers describing a reference-speech body, so the client does not have to
/// guess the rate it is looking at.
pub fn reference_headers(speech: &ReferenceSpeech) -> HashMap<&'static str, String> {
    let mut headers = HashMap::new();
    headers.insert("X-Subsync-Sample-Rate", SAMPLE_RATE.to_string());
    headers.insert(
        "X-Subsync-Seconds",
        format!("{:.3}", speech.samples.len() as f64 / SAMPLE_RATE as f64),
    );
    headers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_round_trip_preserves_timings_and_text() {
        let cues = vec![
            WireCue { start: 1.0, end: 2.5, text: "Hello".into() },
            WireCue { start: 3.25, end: 4.0, text: "Line one\n\nLine two".into() },
            WireCue { start: 3599.999, end: 3601.5, text: " ".into() },
        ];
        let parsed = parse_srt(&compose_srt(&cues));
        assert_eq!(parsed.len(), 3);
        for (cue, got) in cues.iter().zip(parsed.iter()) {
            assert!((cue.start - got.start).abs() < 0.001, "{} vs {}", cue.start, got.start);
            assert!((cue.end - got.end).abs() < 0.001, "{} vs {}", cue.end, got.end);
        }
        assert_eq!(parsed[0].text, "Hello");
        assert_eq!(parsed[1].text, "Line one\nLine two");
    }

    #[test]
    fn output_is_matched_by_text_when_ffsubsync_drops_cues() {
        // Exactly what a real run produces when the offset pushes the opening
        // lines below zero: fewer cues, renumbered from 1. Pairing by index
        // would put "Line 3"'s timings on "Line 1"'s words.
        let input = vec![
            WireCue { start: 1.5, end: 5.5, text: "Line 1 of dialogue".into() },
            WireCue { start: 14.5, end: 20.5, text: "Line 2 of dialogue".into() },
            WireCue { start: 29.5, end: 34.5, text: "Line 3 of dialogue".into() },
            WireCue { start: 42.5, end: 48.5, text: "Line 4 of dialogue".into() },
        ];
        let written = "\
1
00:00:05,010 --> 00:00:10,005
Line 3 of dialogue

2
00:00:17,997 --> 00:00:23,991
Line 4 of dialogue
";
        let mapped = match_output_to_input(&input, &parse_srt(written));
        assert_eq!(mapped[0], None, "dropped");
        assert_eq!(mapped[1], None, "dropped");
        assert_eq!(mapped[2].map(|(s, _)| (s * 1000.0).round()), Some(5010.0));
        assert_eq!(mapped[3].map(|(s, _)| (s * 1000.0).round()), Some(17997.0));
    }

    #[test]
    fn a_bare_number_is_kept_as_dialogue() {
        // "1999" is a perfectly ordinary subtitle line. Treating every bare
        // number as a block index would drop it, and the text match that maps
        // ffsubsync's output back onto our cues would then fail.
        let written = "\
1
00:00:01,000 --> 00:00:02,000
1999

2
00:00:03,000 --> 00:00:04,000
42
Was the answer

3
00:00:05,000 --> 00:00:06,000
Ordinary line
";
        let parsed = parse_srt(written);
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].text, "1999");
        assert_eq!(parsed[1].text, "42\nWas the answer");
        assert_eq!(parsed[2].text, "Ordinary line");
    }

    #[test]
    fn a_trailing_bare_number_survives_to_the_end_of_the_file() {
        let parsed = parse_srt("1\n00:00:01,000 --> 00:00:02,000\n2024\n");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "2024");
    }

    #[test]
    fn a_numeric_cue_round_trips_through_compose_and_match() {
        let input = vec![
            WireCue { start: 1.0, end: 2.0, text: "1999".into() },
            WireCue { start: 3.0, end: 4.0, text: "Ordinary".into() },
        ];
        let mapped = match_output_to_input(&input, &parse_srt(&compose_srt(&input)));
        assert_eq!(mapped[0].map(|(s, _)| s), Some(1.0));
        assert_eq!(mapped[1].map(|(s, _)| s), Some(3.0));
    }

    #[test]
    fn log_parsing_survives_non_ascii_output() {
        // Slicing the original line with an offset found in a lowercased copy
        // panics as soon as lowercasing changes the byte length.
        let stderr = "INFO İSTANBUL ÅNGSTRÖM ЖУРНАЛ\nINFO offset seconds: -2.370\nINFO score: 12.5\n";
        let (score, offset, _) = parse_ffsubsync_log(stderr);
        assert_eq!(offset, Some(-2.370));
        assert_eq!(score, Some(12.5));
    }

    #[test]
    fn provider_credentials_are_stripped_from_messages() {
        let url = "http://panel.example.test:8080/johndoe/s3cr3t/12345.ts";
        let message = format!("ffmpeg: {url}: Server returned 403 Forbidden");
        let safe = redact_url(&message, url);
        assert!(!safe.contains("s3cr3t"), "{safe}");
        assert!(!safe.contains("johndoe"), "{safe}");
        assert!(safe.contains("panel.example.test"), "{safe}");

        // A reformatted echo of the same URL is caught by the host prefix.
        let reformatted = redact_url(
            "could not open 'http://panel.example.test:8080/johndoe/s3cr3t/12345.ts?token=abc' — retrying",
            url,
        );
        assert!(!reformatted.contains("s3cr3t"), "{reformatted}");
        assert!(!reformatted.contains("token=abc"), "{reformatted}");
    }

    #[test]
    fn audio_args_carry_the_player_identity_for_a_url() {
        // Without these an Xtream panel serves a debug page, and the
        // extraction "succeeds" against HTML with no audio in it.
        let args = build_audio_args("http://panel.example.test/a/b/1.ts", 0.0, None);
        let ua = args.iter().position(|a| a == "-user_agent").expect("-user_agent");
        assert!(args[ua + 1].contains("ExoPlayerLib"));
        let referer = args.iter().position(|a| a == "-headers").expect("-headers");
        assert_eq!(args[referer + 1], "Referer: http://panel.example.test/\r\n");
        // Still before -i, or ffmpeg applies them to the output.
        assert!(ua < args.iter().position(|a| a == "-i").unwrap());
    }

    #[test]
    fn audio_args_omit_http_options_for_a_local_path() {
        // -user_agent belongs to ffmpeg's HTTP protocol. Passed alongside a
        // local path it fails the whole invocation with "Option user_agent not
        // found" before a sample is decoded.
        let args = build_audio_args("/Users/someone/Movies/film.mkv", 0.0, None);
        assert!(!args.iter().any(|a| a == "-user_agent"), "{args:?}");
        assert!(!args.iter().any(|a| a == "-headers"), "{args:?}");
        assert!(args.iter().any(|a| a == "-vn"));
    }

    #[test]
    fn repeated_lines_match_forward_only() {
        // "Yes." three times must map 1:1 in order, never all onto the first.
        let input = vec![
            WireCue { start: 1.0, end: 2.0, text: "Yes.".into() },
            WireCue { start: 5.0, end: 6.0, text: "Yes.".into() },
            WireCue { start: 9.0, end: 10.0, text: "Yes.".into() },
        ];
        let written = "\
1
00:00:03,000 --> 00:00:04,000
Yes.

2
00:00:07,000 --> 00:00:08,000
Yes.

3
00:00:11,000 --> 00:00:12,000
Yes.
";
        let mapped = match_output_to_input(&input, &parse_srt(written));
        let starts: Vec<Option<f64>> = mapped.iter().map(|slot| slot.map(|(s, _)| s)).collect();
        assert_eq!(starts, vec![Some(3.0), Some(7.0), Some(11.0)]);
    }

    #[test]
    fn matching_tolerates_whitespace_differences() {
        let input = vec![WireCue { start: 1.0, end: 2.0, text: "  Hello   \n\n world ".into() }];
        let written = "1\n00:00:03,000 --> 00:00:04,000\nHello\nworld\n";
        let mapped = match_output_to_input(&input, &parse_srt(written));
        assert_eq!(mapped[0].map(|(s, _)| s), Some(3.0));
    }

    #[test]
    fn srt_never_emits_a_blank_body_line() {
        // A blank line inside a cue would terminate the block and renumber
        // everything after it, so ffsubsync would see the wrong cue count.
        let srt = compose_srt(&[WireCue { start: 0.0, end: 1.0, text: "a\n\n\nb".into() }]);
        assert!(srt.contains("a\nb\n"), "{srt}");
        let parsed = parse_srt(&srt);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].text, "a\nb");
    }

    #[test]
    fn negative_and_nonfinite_timestamps_clamp_to_zero() {
        assert_eq!(srt_timestamp(-5.0), "00:00:00,000");
        assert_eq!(srt_timestamp(f64::NAN), "00:00:00,000");
        assert_eq!(srt_timestamp(3661.5), "01:01:01,500");
    }

    #[test]
    fn log_parsing_reads_the_three_numbers() {
        let stderr = "\
INFO:ffsubsync.ffsubsync:computing alignments...
INFO:ffsubsync.ffsubsync:score: 12345.678
INFO:ffsubsync.ffsubsync:offset seconds: -2.370
INFO:ffsubsync.ffsubsync:framerate scale factor: 1.042
";
        let (score, offset, scale) = parse_ffsubsync_log(stderr);
        assert_eq!(score, Some(12345.678));
        assert_eq!(offset, Some(-2.370));
        assert_eq!(scale, Some(1.042));
    }

    #[test]
    fn linear_fit_recovers_scale_and_offset() {
        let pairs: Vec<(f64, f64)> = (0..50)
            .map(|i| {
                let x = i as f64 * 7.5;
                (x, x * 1.042 + 3.0)
            })
            .collect();
        let (scale, offset) = fit_linear(&pairs);
        assert!((scale - 1.042).abs() < 1e-6, "scale {scale}");
        assert!((offset - 3.0).abs() < 1e-6, "offset {offset}");
    }

    #[test]
    fn linear_fit_handles_one_cue_and_none() {
        assert_eq!(fit_linear(&[]), (1.0, 0.0));
        let (scale, offset) = fit_linear(&[(10.0, 15.0)]);
        assert_eq!(scale, 1.0);
        assert!((offset - 5.0).abs() < 1e-9);
    }

    #[test]
    fn audio_args_are_ffsubsyncs_shape() {
        let args = build_audio_args("http://example.test/a.mkv", 0.0, None);
        assert_eq!(args[0], "-loglevel");
        assert!(args.contains(&"-vn".to_string()));
        assert!(args.contains(&"aresample=async=1".to_string()));
        assert_eq!(args[args.len() - 1], "-");
        let windowed = build_audio_args("http://example.test/a.mkv", 90.0, Some(3600.0));
        assert_eq!(&windowed[0..4], &["-ss", "0:01:30", "-t", "1:00:00"]);
    }

    /// Synthetic PCM: `spans` are 10 ms window ranges that should read as speech.
    fn synth(spans: &[(usize, usize)], windows: usize) -> Vec<i16> {
        let per = AUDIO_RATE / SAMPLE_RATE;
        let mut pcm = vec![0i16; windows * per];
        for (lo, hi) in spans {
            for index in (lo * per)..(hi * per).min(pcm.len()) {
                // Alternating full-ish amplitude: mean square well over the
                // 1e5 the 50 dB gate needs.
                pcm[index] = if index % 2 == 0 { 6000 } else { -6000 };
            }
        }
        pcm
    }

    #[test]
    fn vad_finds_runs_longer_than_the_minimum() {
        let speech = detect_speech(&synth(&[(30, 90), (140, 260)], 320), AUDIO_RATE);
        assert_eq!(speech.len(), 320);
        assert_eq!(speech[10], 0);
        assert_eq!(speech[50], 1);
        assert_eq!(speech[200], 1);
        assert_eq!(speech[300], 0);
    }

    #[test]
    fn vad_counts_tolerated_silence_toward_the_minimum_length() {
        // 18 valid windows is under the 20-window (0.2 s) floor — but the token
        // stays open through the 25 windows of tolerated silence that follow,
        // so it closes at 43 and clears the floor after all. Surprising, and
        // exactly what auditok does (verified against auditok 0.1.5), so the
        // browser and native detectors must agree on it.
        let speech = detect_speech(&synth(&[(40, 58)], 120), AUDIO_RATE);
        let ones: usize = speech.iter().filter(|v| **v == 1).count();
        assert_eq!(ones, 43);
        assert_eq!(speech[39], 0);
        assert_eq!(speech[40], 1);
        assert_eq!(speech[82], 1);
        assert_eq!(speech[83], 0);
    }

    #[test]
    fn vad_keeps_a_pause_shorter_than_the_silence_tolerance() {
        // A 15-window gap is inside the 25-window tolerance, so the two runs
        // stay one token and the gap reads as speech.
        let speech = detect_speech(&synth(&[(20, 60), (75, 130)], 200), AUDIO_RATE);
        assert_eq!(speech[65], 1);
    }

    #[test]
    fn vad_splits_on_a_pause_longer_than_the_tolerance() {
        let speech = detect_speech(&synth(&[(20, 60), (110, 170)], 240), AUDIO_RATE);
        assert_eq!(speech[85], 0);
        assert_eq!(speech[30], 1);
        assert_eq!(speech[150], 1);
    }

    #[test]
    fn vad_does_not_leak_past_a_max_length_truncation() {
        // 600 windows of continuous speech exceeds the 500-window cap, so the
        // token is truncated and a second one continues. Upstream's assignment
        // of the terminator would leave everything after this reading as
        // speech; ours must come back down. See the note in detect_speech.
        let speech = detect_speech(&synth(&[(10, 610)], 700), AUDIO_RATE);
        assert_eq!(speech[300], 1);
        assert_eq!(speech[600], 1);
        assert_eq!(speech[680], 0, "speech must end when the audio does");
    }

    #[test]
    fn vad_handles_silence_and_full_speech() {
        assert!(detect_speech(&synth(&[], 150), AUDIO_RATE).iter().all(|v| *v == 0));
        let loud = detect_speech(&synth(&[(0, 150)], 150), AUDIO_RATE);
        assert!(loud.iter().all(|v| *v == 1));
    }
}
