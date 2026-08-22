/**
 * Getting reference audio out of a movie, in a browser, without melting it.
 *
 * The browser cannot demux Matroska, MPEG-TS or AVI — the containers this app
 * spends its life on — so a real FFmpeg is needed even here. ffmpeg.wasm is
 * that FFmpeg, loaded ONLY when the user actually asks for an automatic sync;
 * nothing below is touched, and no wasm is fetched, until then.
 *
 * ─── Why this is not simply "decode the file" ───────────────────────────────
 * A 2-hour film is several GB, and the obvious approaches all fall over:
 *
 *   - `decodeAudioData` needs the whole compressed file in memory AND returns
 *     the whole decoded PCM — for a feature film that is well over a gigabyte
 *     of Float32, before any analysis starts.
 *   - `ffmpeg.writeFile` copies the entire file into the wasm heap, which is
 *     both a full read and a second copy of it.
 *
 * Instead:
 *
 *   1. The `File` is MOUNTED (WORKERFS), not copied. ffmpeg then reads it
 *      lazily through the browser's own file handle, so a seek to the 90-minute
 *      mark reads the bytes around the 90-minute mark and nothing else.
 *   2. Audio is pulled in fixed WINDOWS (`-ss T -t N`, input-side, so the seek
 *      is cheap), mono, at a VAD-suitable rate, with the video stream never
 *      touched — `-vn` — so no frame is ever decoded.
 *   3. Each window is handed to the caller and then deleted from the wasm FS
 *      immediately, so peak memory is one window (~10 MB) rather than a film.
 *
 * The caller turns each window into ~N×100 speech samples and drops the PCM;
 * see subsyncVad.ts. Net memory for a 3-hour film is about 8 MB of signal.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Browser-only by nature (Worker, WebAssembly, File) — there are no unit tests
 * for this module; the logic that IS testable lives in subsyncVad.ts and
 * subsyncAlign.ts.
 */

import type { FFmpeg } from "@ffmpeg/ffmpeg";

/**
 * Sample rate handed to the detector.
 *
 * ffsubsync asks ffmpeg for 48 kHz. We ask for 16 kHz, which is a third of the
 * bytes to move out of wasm for output that is identical: the detector reduces
 * every 10 ms window to a single mean-square number, and that number does not
 * care how finely the window was sampled. 16 kHz is also what every VAD worth
 * the name is designed around. The native engine uses the same rate, so the
 * two produce the same signal from the same audio.
 */
export const EXTRACT_SAMPLE_RATE = 16000;

/**
 * Seconds of audio per ffmpeg invocation.
 *
 * 100 s is ~3.2 MB of PCM — small enough to hold twice (wasm side and ours)
 * without strain, large enough that a 2-hour film costs ~72 invocations rather
 * than hundreds, each of which pays a container-open cost.
 *
 * The number is not free to change. The detector has no state between blocks,
 * so a run of speech crossing a boundary becomes two shorter runs, and one that
 * ends up under the 0.2 s minimum is discarded. Blocking at 100 s is what
 * ffsubsync's own read loop does, and what the native path does, so the same
 * audio produces the same signal whichever engine sees it.
 */
export const EXTRACT_WINDOW_SECONDS = 100;

/**
 * Hard cap on bytes pulled for a URL-based extraction.
 *
 * With a `File` there is no cap and no need for one — it is mounted and read
 * in place. A URL has to be fetched, and fetched bytes are held: there is no
 * lazy random access to a remote stream from inside wasm. So this path is for
 * getting a usable answer out of the FRONT of a film, not for analysing all of
 * it, and 192 MB is roughly fifteen minutes of a decent encode.
 */
export const URL_FETCH_BYTE_CAP = 192 * 1024 * 1024;

/**
 * Where the ~32 MB wasm core comes from.
 *
 * Self-hosted first: dropping the ESM build's `ffmpeg-core.js` /
 * `ffmpeg-core.wasm` into `public/ffmpeg/` makes this work offline and under a
 * strict CSP, with no change to any code. Otherwise the pinned CDN build,
 * fetched on first use. `VITE_FFMPEG_CORE_URL` overrides both.
 *
 * The version is pinned deliberately: ffmpeg.wasm's JS wrapper and its core
 * are a matched pair, and letting the core float would eventually load one the
 * wrapper cannot talk to.
 */
const CORE_VERSION = "0.12.9";
/**
 * The ESM core, NOT the UMD one the ffmpeg.wasm README shows.
 *
 * Vite bundles ffmpeg.wasm's own class worker as a MODULE worker, and a module
 * worker has no `importScripts` — which is the only way the UMD build can be
 * loaded. ffmpeg.wasm's fallback path handles this by dynamically importing the
 * core instead and reading its default export, which only the ESM build has.
 * Point this at `/umd/` and the load fails with a bare "failed to import
 * ffmpeg-core.js" that says nothing about why.
 */
const CDN_CORE_BASE = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const SELF_HOSTED_CORE_BASE = "/ffmpeg";

/**
 * SHA-256 of the pinned CDN build, checked before the code is run.
 *
 * The core is a script and a WebAssembly module fetched from a third party and
 * then EXECUTED. A pinned version number says which bytes were meant; it does
 * not say the bytes arrived. `<script integrity>` cannot help here — the core
 * is loaded from inside a worker, not from a tag — so the check is done by
 * hand, and a mismatch is fatal rather than a warning.
 *
 * Only the CDN is checked. A self-hosted core is served by the same origin as
 * the app, and `VITE_FFMPEG_CORE_URL` is a deliberate choice by whoever built
 * it; hashing either would just mean this list needed updating to use them.
 *
 * To move to a new core: bump CORE_VERSION and replace these with
 *   curl -sL <url> | openssl dgst -sha256 -binary | openssl base64 -A
 */
const CDN_CORE_HASHES: Record<string, string> = {
  "ffmpeg-core.js": "Z6SPEWRfhUOfP95PIRkELBazdLkQIGt6eiTzQuKNyuM=",
  "ffmpeg-core.wasm": "n1eUelvVMNjwDFs/LLKjSS+qfl2CMxU0LWqGVtCmt7c=",
};

const coreBaseUrl = (): string => {
  // Typed locally: `import.meta.env` comes from vite/client, and the test
  // project (tsconfig.test.json) compiles src/utils without it.
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  const override = env?.VITE_FFMPEG_CORE_URL;
  return typeof override === "string" && override ? override.replace(/\/+$/, "") : "";
};

export class AudioExtractionUnavailableError extends Error {
  /**
   * `cause` is folded into the message rather than passed to `Error`: this
   * project compiles against the ES2020 lib, where the two-argument Error
   * constructor does not exist. The detail is worth keeping — it is what
   * distinguishes "no network" from "this browser refused the mount" in the
   * debug log — so it rides along in the text.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    const detail =
      options?.cause instanceof Error
        ? options.cause.message
        : options?.cause === undefined
          ? ""
          : String(options.cause);
    super(detail ? `${message} (${detail})` : message);
    this.name = "AudioExtractionUnavailableError";
  }
}

let ffmpegPromise: Promise<FFmpeg> | null = null;

const toBase64 = (bytes: ArrayBuffer): string => {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
};

/**
 * Fetch one piece of the core, check it if it came from the CDN, and hand back
 * a blob URL.
 *
 * Falls back to the library's own `toBlobURL` where verification is not wanted
 * or `crypto.subtle` is unavailable (it needs a secure context — which
 * localhost and https both are, but a plain-http LAN address is not).
 */
const fetchCorePart = async (
  url: string,
  mimeType: string,
  verify: boolean,
  toBlobURL: (url: string, mimeType: string, progress?: boolean, cb?: (e: { received: number; total: number }) => void) => Promise<string>,
  onProgress: (fraction: number) => void,
): Promise<string> => {
  const expected = CDN_CORE_HASHES[url.slice(url.lastIndexOf("/") + 1)];
  if (!verify || !expected || !globalThis.crypto?.subtle) {
    return toBlobURL(url, mimeType, true, (event) => {
      if (event.total > 0) onProgress(Math.min(1, event.received / event.total));
    });
  }
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new AudioExtractionUnavailableError(
      `Could not download the audio decoder (HTTP ${response.status}).`,
    );
  }
  const bytes = await response.arrayBuffer();
  onProgress(1);
  const actual = toBase64(await crypto.subtle.digest("SHA-256", bytes));
  if (actual !== expected) {
    throw new AudioExtractionUnavailableError(
      "The audio decoder downloaded from the CDN did not match its expected checksum, so it was not run.",
    );
  }
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
};

/**
 * True when a self-hosted core is really present.
 *
 * A 200 is NOT enough to conclude that. This app is a single-page app behind a
 * catch-all fallback — the Vite dev server, the Cloudflare Worker's asset
 * handler and the Tauri relay all answer an unknown path with `index.html` and
 * a 200. Trusting the status alone therefore "finds" a core that is really the
 * app's own HTML, and ffmpeg.wasm fails at load with an opaque
 * `Unexpected token '<'`.
 *
 * The content type settles it: every host that serves a real .wasm labels it
 * `application/wasm`, and no fallback ever will.
 */
const selfHostedCoreAvailable = async (): Promise<boolean> => {
  try {
    const response = await fetch(`${SELF_HOSTED_CORE_BASE}/ffmpeg-core.wasm`, { method: "HEAD" });
    if (!response.ok) return false;
    return (response.headers.get("content-type") ?? "").toLowerCase().includes("wasm");
  } catch {
    return false;
  }
};

/**
 * Load ffmpeg.wasm once per page, and reuse it.
 *
 * The core is fetched into blob URLs rather than handed to the worker as
 * cross-origin URLs: the worker loads the core with `importScripts`, which
 * same-origin policy would otherwise refuse for a CDN address.
 */
export const loadBrowserFfmpeg = async (
  onProgress?: (fraction: number) => void,
): Promise<FFmpeg> => {
  if (ffmpegPromise) return ffmpegPromise;
  ffmpegPromise = (async () => {
    let FFmpegCtor: typeof FFmpeg;
    let toBlobURL: (url: string, mimeType: string, progress?: boolean, cb?: (event: { received: number; total: number }) => void) => Promise<string>;
    try {
      // Dynamic so the wrapper is a separate chunk the app never loads unless
      // an automatic sync is actually requested.
      const [ffmpegModule, utilModule] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/util"),
      ]);
      FFmpegCtor = ffmpegModule.FFmpeg;
      toBlobURL = utilModule.toBlobURL;
    } catch (error) {
      // Clear the cache: a failed import is almost always a transient chunk
      // fetch, and leaving the rejected promise in place would make every later
      // attempt fail instantly with the same stale error.
      ffmpegPromise = null;
      throw new AudioExtractionUnavailableError(
        "Could not load the in-browser audio decoder.",
        { cause: error },
      );
    }

    const override = coreBaseUrl();
    const base = override || ((await selfHostedCoreAvailable()) ? SELF_HOSTED_CORE_BASE : CDN_CORE_BASE);

    const ffmpeg = new FFmpegCtor();
    const verify = base === CDN_CORE_BASE;
    try {
      const [coreURL, wasmURL] = await Promise.all([
        fetchCorePart(`${base}/ffmpeg-core.js`, "text/javascript", verify, toBlobURL, (fraction) =>
          onProgress?.(fraction * 0.5),
        ),
        fetchCorePart(`${base}/ffmpeg-core.wasm`, "application/wasm", verify, toBlobURL, (fraction) =>
          onProgress?.(0.5 + fraction * 0.5),
        ),
      ]);
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (error) {
      // A failed load must not poison every later attempt — the usual cause is
      // a dropped network, which the next click may well not hit.
      ffmpegPromise = null;
      throw new AudioExtractionUnavailableError(
        base === CDN_CORE_BASE
          ? "Could not download the in-browser audio decoder. Check your connection, or connect the desktop app to sync without it."
          : "Could not start the in-browser audio decoder.",
        { cause: error },
      );
    }
    return ffmpeg;
  })();
  return ffmpegPromise;
};

/** Release the wasm instance and its heap. Safe to call when idle. */
export const releaseBrowserFfmpeg = async (): Promise<void> => {
  const pending = ffmpegPromise;
  ffmpegPromise = null;
  if (!pending) return;
  try {
    (await pending).terminate();
  } catch {
    /* already gone */
  }
};

export interface ExtractAudioOptions {
  /** The dropped file. Mounted, never copied. Preferred over `url`. */
  file?: File;
  /** A fetchable media URL. Downloaded in full, so only for modest sources. */
  url?: string;
  sampleRate?: number;
  windowSeconds?: number;
  /** Skip the media before this point. */
  startSeconds?: number;
  /** Stop after this much audio; undefined reads to the end. */
  maxDurationSeconds?: number | null;
  /** Total duration when known, so progress can be a fraction rather than a count. */
  durationSec?: number;
  /** Override the URL prefix cap. Ignored for a `file`, which has no cap. */
  urlByteCap?: number;
  signal?: AbortSignal;
  /** Called per window with mono 16-bit PCM. The buffer is reused — copy it. */
  onWindow: (pcm: Int16Array, windowStartSeconds: number) => void | Promise<void>;
  onProgress?: (info: {
    processedSeconds: number;
    totalSeconds?: number;
    /** 0..1 while the wasm core itself is downloading. */
    loadingDecoder?: number;
    /** Bytes pulled so far, on the URL path only. */
    downloadedBytes?: number;
  }) => void;
}

const INPUT_NAME = "subsync-input";
const OUTPUT_NAME = "subsync-window.pcm";
const MOUNT_POINT = "/subsync";

/**
 * There is one wasm instance, and it has one filesystem.
 *
 * Two extractions at once would mount over each other, read each other's
 * output file and leave the mount point in whatever state the loser unwound
 * to. The UI already serializes runs; this makes the module safe on its own
 * terms rather than by convention.
 */
let extractionInFlight = false;

/**
 * Fetch a bounded prefix of a URL.
 *
 * Range-requested first, and — because a server may ignore Range, and the app's
 * own relay streams rather than seeks — the body is also read incrementally and
 * ABORTED at the cap. Either way nothing larger than `cap` is ever held.
 */
const fetchBoundedPrefix = async (
  url: string,
  cap: number,
  signal: AbortSignal | undefined,
  onBytes?: (received: number) => void,
): Promise<Uint8Array> => {
  const controller = new AbortController();
  const stopOuter = () => controller.abort();
  signal?.addEventListener("abort", stopOuter, { once: true });
  try {
    const response = await fetch(url, {
      headers: { range: `bytes=0-${cap - 1}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok && response.status !== 206) {
      throw new AudioExtractionUnavailableError(
        `Could not read this video (HTTP ${response.status}).`,
      );
    }
    if (!response.body) return new Uint8Array(await response.arrayBuffer());

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      received += value.byteLength;
      onBytes?.(received);
      if (received >= cap) {
        // Stop the transfer rather than draining a multi-gigabyte body.
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    const out = new Uint8Array(Math.min(received, cap));
    let at = 0;
    for (const chunk of chunks) {
      if (at >= out.length) break;
      const take = Math.min(chunk.byteLength, out.length - at);
      out.set(chunk.subarray(0, take), at);
      at += take;
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", stopOuter);
  }
};

/** `-ss` wants a duration; ffsubsync writes them as H:MM:SS, so we do too. */
const asTimestamp = (seconds: number): string => {
  const whole = Math.max(0, Math.floor(seconds));
  const hh = Math.floor(whole / 3600);
  const mm = Math.floor((whole % 3600) / 60);
  const ss = whole % 60;
  const fraction = Math.max(0, seconds - whole);
  const base = `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return fraction > 0 ? `${base}.${Math.round(fraction * 1000).toString().padStart(3, "0")}` : base;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException("Subtitle sync was cancelled", "AbortError");
};

/**
 * Decode the reference audio, one window at a time.
 *
 * The ffmpeg arguments mirror ffsubsync's `_build_ffmpeg_args` — including
 * `-af aresample=async=1`, which is load-bearing rather than decorative: a
 * stream with dropped or duplicated samples would otherwise make byte position
 * drift away from wall-clock time, and since the entire method is "which
 * 10 ms window was this", every offset would come out wrong by that drift.
 */
export const extractReferenceAudio = async (options: ExtractAudioOptions): Promise<number> => {
  const sampleRate = options.sampleRate ?? EXTRACT_SAMPLE_RATE;
  const windowSeconds = options.windowSeconds ?? EXTRACT_WINDOW_SECONDS;
  const startSeconds = options.startSeconds ?? 0;
  const maxDurationSeconds = options.maxDurationSeconds ?? null;

  throwIfAborted(options.signal);
  if (extractionInFlight) {
    throw new AudioExtractionUnavailableError(
      "Another subtitle sync is already reading this video.",
    );
  }
  extractionInFlight = true;

  const ffmpeg = await loadBrowserFfmpeg((fraction) =>
    options.onProgress?.({ processedSeconds: 0, loadingDecoder: fraction }),
  ).catch((error) => {
    extractionInFlight = false;
    throw error;
  });

  let inputPath: string;
  let mounted = false;
  let wrote = false;

  try {
    throwIfAborted(options.signal);
  } catch (error) {
    extractionInFlight = false;
    throw error;
  }

  if (options.file) {
    // WORKERFS reads through the File handle, so the multi-GB body never
    // enters the wasm heap. If the runtime refuses the mount we do NOT fall
    // back to writeFile — that would quietly turn a memory-safe path into an
    // out-of-memory crash on exactly the large files this exists for.
    const { FFFSType } = await import("@ffmpeg/ffmpeg");
    try {
      await ffmpeg.createDir(MOUNT_POINT);
    } catch {
      /* already there from an earlier run */
    }
    try {
      await ffmpeg.mount(FFFSType.WORKERFS, { files: [options.file] }, MOUNT_POINT);
      mounted = true;
    } catch (error) {
      throw new AudioExtractionUnavailableError(
        "This browser cannot read the video file without loading all of it into memory, which is unsafe for a file this size.",
        { cause: error },
      );
    }
    inputPath = `${MOUNT_POINT}/${options.file.name}`;
  } else if (options.url) {
    // A BOUNDED prefix, never the whole thing: unlike a File, a URL cannot be
    // read lazily from inside wasm, so whatever is fetched is held. See
    // URL_FETCH_BYTE_CAP.
    const prefix = await fetchBoundedPrefix(
      options.url,
      options.urlByteCap ?? URL_FETCH_BYTE_CAP,
      options.signal,
      (received) =>
        options.onProgress?.({ processedSeconds: 0, downloadedBytes: received }),
    ).catch((error) => {
      extractionInFlight = false;
      throw error;
    });
    await ffmpeg.writeFile(INPUT_NAME, prefix);
    wrote = true;
    inputPath = INPUT_NAME;
  } else {
    extractionInFlight = false;
    throw new AudioExtractionUnavailableError("No video file or URL to read audio from.");
  }

  const totalSeconds =
    maxDurationSeconds !== null
      ? maxDurationSeconds
      : options.durationSec
        ? Math.max(0, options.durationSec - startSeconds)
        : undefined;

  let processedSeconds = 0;
  let windowsWithAudio = 0;

  try {
    for (let offset = 0; ; offset += windowSeconds) {
      throwIfAborted(options.signal);
      if (maxDurationSeconds !== null && offset >= maxDurationSeconds) break;
      if (totalSeconds !== undefined && offset >= totalSeconds) break;

      const remaining =
        maxDurationSeconds !== null ? Math.min(windowSeconds, maxDurationSeconds - offset) : windowSeconds;

      // `-ss` and `-t` BEFORE `-i` so the seek happens on the input and the
      // demuxer stops reading at the end of the window, rather than decoding
      // the whole file and discarding most of it.
      const args = [
        "-ss",
        asTimestamp(startSeconds + offset),
        "-t",
        asTimestamp(remaining),
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-vn",
        "-f",
        "s16le",
        "-ac",
        "1",
        "-acodec",
        "pcm_s16le",
        "-af",
        "aresample=async=1",
        "-ar",
        String(sampleRate),
        OUTPUT_NAME,
      ];

      const code = await ffmpeg.exec(args);
      throwIfAborted(options.signal);
      if (code !== 0) {
        if (windowsWithAudio === 0) {
          throw new AudioExtractionUnavailableError(
            "Could not read any audio from this video.",
          );
        }
        // A non-zero code at the tail is how ffmpeg reports "seek past the
        // end", which is exactly how we discover the duration when nobody
        // told us one.
        break;
      }

      let data: Uint8Array;
      try {
        data = (await ffmpeg.readFile(OUTPUT_NAME)) as Uint8Array;
      } finally {
        // Delete before doing anything with the bytes: the window's copy in
        // the wasm heap is dead weight from here on.
        await ffmpeg.deleteFile(OUTPUT_NAME).catch(() => undefined);
      }
      if (data.byteLength === 0) break;

      // Int16 view over the same bytes — no copy. `byteOffset` matters: the
      // emscripten heap hands back a subarray, not a fresh buffer.
      const usable = data.byteLength - (data.byteLength % 2);
      const pcm = new Int16Array(data.buffer, data.byteOffset, usable / 2);
      await options.onWindow(pcm, startSeconds + offset);
      windowsWithAudio += 1;

      const windowSecondsRead = pcm.length / sampleRate;
      processedSeconds += windowSecondsRead;
      options.onProgress?.({ processedSeconds, totalSeconds });

      // Short window = end of stream (or the end of a truncated prefix).
      // Compared against the request rather than the nominal window so a final
      // partial window still counts.
      if (windowSecondsRead < remaining - 0.5) break;
    }
  } finally {
    // Unmount and delete even on an abort: the next run mounts at the same
    // path and writes the same filename, so a stale mount is not recoverable
    // without this.
    if (mounted) await ffmpeg.unmount(MOUNT_POINT).catch(() => undefined);
    if (wrote) await ffmpeg.deleteFile(INPUT_NAME).catch(() => undefined);
    await ffmpeg.deleteFile(OUTPUT_NAME).catch(() => undefined);
    extractionInFlight = false;
  }

  if (windowsWithAudio === 0) {
    throw new AudioExtractionUnavailableError("This video has no audio track to listen to.");
  }
  return processedSeconds;
};
