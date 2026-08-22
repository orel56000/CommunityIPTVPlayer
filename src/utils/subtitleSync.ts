/**
 * Picking, and running, a subtitle-sync engine.
 *
 * Two engines answer the same interface:
 *
 *   NativeSubtitleSyncEngine — asks the local helper app. It has a real ffmpeg
 *     and possibly a real ffsubsync, and it can pull a provider stream over the
 *     network without a byte of it passing through this tab.
 *
 *   WebSubtitleSyncEngine — does everything here: ffmpeg.wasm for the audio, a
 *     worker for the detection and the correlation.
 *
 * The choice reuses the app's existing backend-connected signal
 * (`getRelayStatus()` from relayDiscovery.ts, the same one `useBackendConnection`
 * exposes to React) — there is no second health check anywhere in this file.
 *
 * ─── The reference ladder ───────────────────────────────────────────────────
 * Before either engine touches audio, both try what ffsubsync's own default
 * (`subs_then_webrtc`) tries first: ANOTHER SUBTITLE TRACK. If the video
 * carries a correctly-timed track — an HLS rendition, an in-band track, a
 * second file the user dropped — aligning against it is exact, instant, and
 * decodes nothing. Audio is the fallback, not the first move.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { getRelayBase } from "./secureUrl";
import { getRelayStatus } from "./relayDiscovery";
import { EXTRACT_SAMPLE_RATE, extractReferenceAudio } from "./subsyncAudio";
import { runAlignment } from "./subsyncEngine";
import { cuesToSpeech, preprocessCues } from "./subsyncSpeech";
import { SpeechAccumulator } from "./subsyncVad";
import type { SubsyncRequest, SubsyncResponse } from "./subsyncWorkerProtocol";
import {
  BackendUnavailableError,
  type SubtitleSyncEngine,
  type SubtitleSyncInput,
  type SubtitleSyncResult,
} from "../types/subtitleSync";

/** `/api/subsync` on whichever backend is connected. Mirrors backupUrl(). */
const subsyncUrl = (path = ""): string => `${getRelayBase()}/api/subsync${path}`;

/** True when the app's own backend probe says a helper is answering. */
export const backendConnected = (): boolean => getRelayStatus() === "available";

/**
 * The provider URL behind a relay URL.
 *
 * The player hands both engines the same relay-routed address (that is the only
 * one the BROWSER can fetch), but the backend has no business proxying through
 * itself — and `parse_proxy_target` would refuse a loopback target anyway. So
 * the native side unwraps `…/api/stream?url=…` back to what it wraps.
 */
export const unwrapRelayUrl = (url: string): string => {
  try {
    const parsed = new URL(url, typeof location === "undefined" ? undefined : location.href);
    if (!parsed.pathname.endsWith("/api/stream")) return url;
    return parsed.searchParams.get("url") ?? url;
  } catch {
    return url;
  }
};

/** ffmpeg can only be pointed at a real network URL, never a blob: or data:. */
const isFetchableByBackend = (url?: string): boolean =>
  /^https?:\/\//i.test(unwrapRelayUrl(url ?? ""));

/**
 * True when the connected backend is on THIS machine.
 *
 * A sync request carries the whole subtitle file and the stream URL — which for
 * an Xtream provider embeds the user's username and password. Same-origin (the
 * bundled window, or the deployed site's own relay) and loopback are the only
 * places that is theirs to begin with. A backend the user pointed at some other
 * host is a third party, and gets the browser engine instead: it would refuse
 * the job anyway, since both routes are loopback-only.
 */
const backendIsLocal = (): boolean => {
  const base = getRelayBase();
  if (!base) return true;
  try {
    const { hostname } = new URL(base);
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost";
  } catch {
    return false;
  }
};

/**
 * How much of the reference to analyse by default, in seconds.
 *
 * A global offset really wants the whole file — the framerate search in
 * particular is only meaningful over a long baseline. But pulling two hours of
 * a provider stream is a full download, and this relay has a whole apparatus
 * (see RATE_LIMIT_COOLDOWN in relay.rs) built around the fact that panels
 * throttle exactly that. null analyses everything; the UI can offer it for the
 * drift case.
 */
export const DEFAULT_MAX_REFERENCE_SECONDS: number | null = null;

/* ------------------------------------------------------------------------ */
/* Worker plumbing                                                           */
/* ------------------------------------------------------------------------ */

let runSequence = 0;

/**
 * A worker, and the promise for the run currently on it.
 *
 * Spawning is attempted once and cached. If it FAILS — an old WebView, a
 * locked-down CSP — `runInWorker` falls back to running the very same functions
 * on this thread. That costs responsiveness during the correlation and nothing
 * else, which is a far better outcome than a feature that simply does not
 * appear on some devices. This is the first worker in the codebase, so the
 * escape hatch is worth having.
 */
let workerInstance: Worker | null | undefined;

const getWorker = (): Worker | null => {
  if (workerInstance !== undefined) return workerInstance;
  try {
    workerInstance = new Worker(new URL("../workers/subsync.worker.ts", import.meta.url), {
      type: "module",
    });
  } catch {
    workerInstance = null;
  }
  return workerInstance;
};

/** Drop the worker so a wedged one cannot poison every later run. */
const discardWorker = (): void => {
  try {
    workerInstance?.terminate();
  } catch {
    /* already gone */
  }
  workerInstance = undefined;
};

interface WorkerRun {
  post: (message: SubsyncRequest, transfer?: Transferable[]) => void;
  done: Promise<SubtitleSyncResult>;
  cancel: () => void;
}

/**
 * Start a run on the worker, or on this thread when there is no worker.
 *
 * The main-thread path deliberately imports the SAME modules the worker does,
 * so the two cannot disagree about anything but where they ran.
 */
const startRun = (runId: number, signal?: AbortSignal): WorkerRun => {
  const worker = getWorker();

  if (!worker) {
    // No worker: buffer the audio through the same accumulator the worker uses
    // and align when `finish` arrives.
    let begin: Extract<SubsyncRequest, { type: "begin" }> | null = null;
    const accumulator = new SpeechAccumulator();
    let resolve!: (value: SubtitleSyncResult) => void;
    let reject!: (reason: unknown) => void;
    const done = new Promise<SubtitleSyncResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      post: (message) => {
        try {
          if (message.type === "begin") begin = message;
          else if (message.type === "pcm") {
            accumulator.push(new Int16Array(message.buffer), {
              frameRate: message.frameRate,
              startSeconds: message.startSeconds,
            });
          } else if (message.type === "finish" && begin) {
            const reference = begin.referenceSpeech ?? accumulator.finish();
            if (reference.length === 0) {
              reject(new Error("No speech was detected in this video."));
              return;
            }
            resolve(
              runAlignment(reference, begin.cues, begin.reference, begin.processingMode, begin.engine, {
                ...begin.options,
                referenceNumFrames: begin.referenceNumFrames ?? null,
              }),
            );
          }
        } catch (error) {
          reject(error);
        }
      },
      done,
      cancel: () => reject(new DOMException("Subtitle sync was cancelled", "AbortError")),
    };
  }

  let settle!: (value: SubtitleSyncResult) => void;
  let fail!: (reason: unknown) => void;
  const done = new Promise<SubtitleSyncResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const onMessage = (event: MessageEvent<SubsyncResponse>) => {
    const message = event.data;
    // A reply from a run we have already abandoned.
    if (message.runId !== runId) return;
    if (message.type === "result") {
      cleanup();
      settle(message.result);
    } else if (message.type === "error") {
      cleanup();
      fail(new Error(message.message));
    }
  };
  const onError = (event: ErrorEvent) => {
    cleanup();
    // A worker that threw at module scope will do it again — start fresh.
    discardWorker();
    fail(new Error(event.message || "The subtitle sync worker stopped."));
  };
  const onAbort = () => {
    worker.postMessage({ type: "cancel", runId } satisfies SubsyncRequest);
    cleanup();
    fail(new DOMException("Subtitle sync was cancelled", "AbortError"));
  };

  const cleanup = () => {
    worker.removeEventListener("message", onMessage as EventListener);
    worker.removeEventListener("error", onError as EventListener);
    signal?.removeEventListener("abort", onAbort);
  };

  worker.addEventListener("message", onMessage as EventListener);
  worker.addEventListener("error", onError as EventListener);
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    done,
    cancel: onAbort,
  };
};

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------ */

const alignOptionsFrom = (input: SubtitleSyncInput) => ({
  startSeconds: input.startSeconds ?? 0,
  maxOffsetSeconds: input.maxOffsetSeconds,
  noFixFramerate: input.noFixFramerate,
  gss: input.gss,
  splitPenaltySeconds: input.splitPenaltySeconds ?? null,
});

/**
 * Build the reference from another subtitle track.
 *
 * This is the exact path — no decoding, no VAD, no approximation of anything —
 * and it is ffsubsync's own first choice. `numFrames` is passed along because
 * a subtitle-derived reference is the ONLY case where upstream infers a
 * framerate ratio from signal length; a VAD's span means something else
 * entirely and inferring from it would invent a correction.
 */
const referenceFromCues = (cues: readonly import("./subtitles").SubtitleCue[], startSeconds: number) => {
  const speech = cuesToSpeech(preprocessCues(cues, { startSeconds }), { startSeconds });
  return { samples: speech.samples, numFrames: speech.numFrames };
};

/* ------------------------------------------------------------------------ */
/* Web engine                                                                */
/* ------------------------------------------------------------------------ */

export const webSubtitleSyncEngine: SubtitleSyncEngine = {
  processingMode: "web",

  canSync: (input) =>
    (input.referenceCues?.length ?? 0) > 0 ||
    Boolean(input.media.file) ||
    isFetchableByBackend(input.media.url),

  async sync(input: SubtitleSyncInput): Promise<SubtitleSyncResult> {
    const runId = (runSequence += 1);
    const run = startRun(runId, input.signal);
    const startSeconds = input.startSeconds ?? 0;

    if (input.referenceCues?.length) {
      input.onProgress?.({ phase: "detecting-speech", detail: "Reading the other subtitle track" });
      const reference = referenceFromCues(input.referenceCues, startSeconds);
      run.post({
        type: "begin",
        runId,
        cues: input.cues,
        referenceSpeech: reference.samples,
        referenceNumFrames: reference.numFrames,
        reference: "subtitle-track",
        processingMode: "web",
        engine: "web",
        options: alignOptionsFrom(input),
      });
      input.onProgress?.({ phase: "finding-alignment" });
      run.post({ type: "finish", runId });
      return run.done;
    }

    run.post({
      type: "begin",
      runId,
      cues: input.cues,
      reference: "audio-vad",
      processingMode: "web",
      engine: "web",
      options: alignOptionsFrom(input),
    });

    input.onProgress?.({ phase: "preparing-audio" });
    try {
      await extractReferenceAudio({
        file: input.media.file,
        url: input.media.file ? undefined : input.media.url,
        startSeconds,
        maxDurationSeconds: input.maxDurationSeconds ?? DEFAULT_MAX_REFERENCE_SECONDS,
        durationSec: input.media.durationSec,
        signal: input.signal,
        sampleRate: EXTRACT_SAMPLE_RATE,
        onWindow: (pcm, windowStartSeconds) => {
          // Copy out of the wasm heap and TRANSFER the copy, so the audio
          // exists in exactly one place and is freed the moment the worker is
          // done detecting it. The start time rides along so the worker can
          // PLACE the block rather than append it — see SpeechAccumulator.
          const copy = new Int16Array(pcm);
          run.post(
            {
              type: "pcm",
              runId,
              buffer: copy.buffer,
              frameRate: EXTRACT_SAMPLE_RATE,
              // Relative to the analysed span, which is where the subtitle
              // timeline starts too.
              startSeconds: windowStartSeconds - startSeconds,
            },
            [copy.buffer],
          );
        },
        onProgress: ({ processedSeconds, totalSeconds, loadingDecoder }) => {
          if (loadingDecoder !== undefined) {
            input.onProgress?.({
              phase: "preparing-audio",
              fraction: loadingDecoder,
              detail: "Fetching the audio decoder",
            });
            return;
          }
          input.onProgress?.({
            phase: "detecting-speech",
            fraction: totalSeconds ? Math.min(1, processedSeconds / totalSeconds) : undefined,
          });
        },
      });
    } catch (error) {
      // `cancel()` rejects the run's promise, and nothing is awaiting it once
      // we rethrow — so it is claimed here to keep the rejection from reaching
      // the window as an unhandled one.
      run.done.catch(() => undefined);
      run.cancel();
      throw error;
    }

    input.onProgress?.({ phase: "finding-alignment" });
    run.post({ type: "finish", runId });
    return run.done;
  },
};

/* ------------------------------------------------------------------------ */
/* Native engine                                                             */
/* ------------------------------------------------------------------------ */

/** Anything that means "the helper went away", as opposed to "it said no". */
const looksLikeDisconnect = (error: unknown): boolean =>
  error instanceof TypeError || // fetch's own network failure
  (error instanceof DOMException && error.name === "TimeoutError") ||
  (error instanceof Error && /Failed to fetch|NetworkError|Load failed/i.test(error.message));

/**
 * A sync run can take many minutes — it downloads and decodes a film's audio —
 * so it gets its own timeout rather than the ~2s the app uses for its little
 * JSON calls.
 */
const SUBSYNC_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The caller's signal AND a deadline, rather than one or the other.
 *
 * `signal ?? AbortSignal.timeout(...)` reads like a default but is not: the
 * caller always passes a signal, so the timeout never applied and a wedged
 * provider could hold the request open forever. `AbortSignal.any` is available
 * in every engine this app targets, but is guarded anyway — an older WebView
 * should lose the deadline, not the feature.
 */
const withDeadline = (signal: AbortSignal | undefined, ms: number): AbortSignal => {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([signal, deadline]) : signal;
};

export const nativeSubtitleSyncEngine: SubtitleSyncEngine = {
  processingMode: "native",

  canSync: (input) =>
    (input.referenceCues?.length ?? 0) > 0 || isFetchableByBackend(input.media.url),

  async sync(input: SubtitleSyncInput): Promise<SubtitleSyncResult> {
    const startSeconds = input.startSeconds ?? 0;

    // A second subtitle track beats anything the backend can do: exact, and it
    // needs no network at all. Run it here rather than shipping cues to the
    // relay only to have it do the same arithmetic.
    if (input.referenceCues?.length) {
      const runId = (runSequence += 1);
      const run = startRun(runId, input.signal);
      const reference = referenceFromCues(input.referenceCues, startSeconds);
      run.post({
        type: "begin",
        runId,
        cues: input.cues,
        referenceSpeech: reference.samples,
        referenceNumFrames: reference.numFrames,
        reference: "subtitle-track",
        // This ran here, in the browser, against another subtitle track — the
        // backend was never asked. Labelling it "native" because a helper
        // happens to be connected would put the wrong provenance in the status
        // line and in the debug log.
        processingMode: "web",
        engine: "web",
        options: alignOptionsFrom(input),
      });
      input.onProgress?.({ phase: "finding-alignment" });
      run.post({ type: "finish", runId });
      return run.done;
    }

    const url = input.media.url ? unwrapRelayUrl(input.media.url) : undefined;
    if (!isFetchableByBackend(url)) {
      throw new BackendUnavailableError("The backend cannot reach this video.");
    }

    /* ---- 1. Try the real ffsubsync ---- */
    input.onProgress?.({ phase: "preparing-audio", detail: "Asking the helper app" });
    let response: Response;
    try {
      response = await fetch(subsyncUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        signal: withDeadline(input.signal, SUBSYNC_TIMEOUT_MS),
        body: JSON.stringify({
          url,
          cues: input.cues,
          startSeconds,
          maxOffsetSeconds: input.maxOffsetSeconds,
          maxDurationSeconds: input.maxDurationSeconds ?? DEFAULT_MAX_REFERENCE_SECONDS,
          noFixFramerate: input.noFixFramerate,
          gss: input.gss,
          splitPenaltySeconds: input.splitPenaltySeconds ?? null,
        }),
      });
    } catch (error) {
      if (looksLikeDisconnect(error)) {
        throw new BackendUnavailableError("The helper app is no longer answering.", { cause: error });
      }
      throw error;
    }

    if (response.ok) {
      const body = (await response.json()) as {
        cues: { start: number; end: number; text: string }[];
        offsetSeconds: number;
        framerateScaleFactor: number;
        score: number | null;
        tool: string;
      };
      input.onProgress?.({ phase: "applying" });
      return {
        subtitles: body.cues,
        offsetMs: body.offsetSeconds * 1000,
        // ffsubsync reports a raw, length-dependent correlation peak and no
        // normalized figure, so there is honestly nothing to put here. Leaving
        // it undefined is better than inventing a number that would not mean
        // the same thing as the web engine's.
        confidence: undefined,
        processingMode: "native",
        engine: "native-ffsubsync",
        reference: "audio-vad",
        framerateScaleFactor: body.framerateScaleFactor,
        score: body.score ?? 0,
        perCueOffsetsMs: null,
        qualityReasons: [],
        applied: true,
      };
    }

    // 403 is the loopback gate: this page is talking to a relay on ANOTHER
    // machine (a TV or phone that opened the LAN address), which will not run
    // ffmpeg on its behalf. That is not a synchronization failure — it is the
    // backend declining the job — so it falls through to the browser engine
    // exactly as a disconnect does.
    if (response.status === 403) {
      throw new BackendUnavailableError(
        "This helper app only syncs for the machine it runs on.",
      );
    }

    // 501 is the relay saying "no ffsubsync here" — the one non-error status.
    if (response.status !== 501) {
      const detail = (await response.text().catch(() => "")).trim();
      throw new Error(
        detail || `The helper app could not synchronize these subtitles (HTTP ${response.status}).`,
      );
    }

    /* ---- 2. Fall back: the backend decodes, we align ---- */
    input.onProgress?.({ phase: "detecting-speech", detail: "Listening to the video" });
    const params = new URLSearchParams({ url: url as string });
    if (startSeconds > 0) params.set("start", String(startSeconds));
    const maxDuration = input.maxDurationSeconds ?? DEFAULT_MAX_REFERENCE_SECONDS;
    if (maxDuration) params.set("max", String(maxDuration));

    let referenceResponse: Response;
    try {
      referenceResponse = await fetch(`${subsyncUrl("/reference")}?${params.toString()}`, {
        cache: "no-store",
        signal: withDeadline(input.signal, SUBSYNC_TIMEOUT_MS),
      });
    } catch (error) {
      if (looksLikeDisconnect(error)) {
        throw new BackendUnavailableError("The helper app is no longer answering.", { cause: error });
      }
      throw error;
    }
    if (!referenceResponse.ok) {
      if (referenceResponse.status === 403) {
        throw new BackendUnavailableError(
          "This helper app only syncs for the machine it runs on.",
        );
      }
      const detail = (await referenceResponse.text().catch(() => "")).trim();
      throw new Error(detail || `The helper app could not read this video's audio.`);
    }

    // One byte per 10 ms — about 1 MB for a three-hour film, against the many
    // gigabytes the browser would have had to pull to do this itself.
    const bytes = new Uint8Array(await referenceResponse.arrayBuffer());
    const reference = new Float64Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) reference[i] = bytes[i] > 0 ? 1 : 0;

    const runId = (runSequence += 1);
    const run = startRun(runId, input.signal);
    run.post({
      type: "begin",
      runId,
      cues: input.cues,
      referenceSpeech: reference,
      // Audio-derived: no length-inferred framerate ratio (see referenceFromCues).
      referenceNumFrames: null,
      reference: "audio-vad",
      processingMode: "native",
      engine: "native-ffmpeg",
      options: alignOptionsFrom(input),
    });
    input.onProgress?.({ phase: "finding-alignment" });
    run.post({ type: "finish", runId });
    return run.done;
  },
};

/* ------------------------------------------------------------------------ */
/* Selection                                                                 */
/* ------------------------------------------------------------------------ */

/**
 * The engine to use right now.
 *
 * Native whenever the helper is connected AND it can actually reach the media.
 * A file the user dropped is a blob: URL that exists only in this tab, so those
 * always run in the browser — which is also where the File is, so nothing is
 * uploaded anywhere.
 */
export const selectSubtitleSyncEngine = (
  input: Pick<SubtitleSyncInput, "media" | "referenceCues">,
): SubtitleSyncEngine =>
  backendConnected() && backendIsLocal() && !input.media.file && isFetchableByBackend(input.media.url)
    ? nativeSubtitleSyncEngine
    : webSubtitleSyncEngine;

/**
 * Run a sync, falling back to the browser only for a DISCONNECT.
 *
 * The distinction matters. If the helper app quit mid-run, the browser can and
 * should finish the job. If ffsubsync ran and reported that it could not align
 * these subtitles, that is an answer, not an outage — re-running the same data
 * through a second implementation would produce the same failure with a
 * different message and hide the real one. So only BackendUnavailableError
 * falls through, and everything else is surfaced.
 */
export const syncSubtitles = async (input: SubtitleSyncInput): Promise<SubtitleSyncResult> => {
  const engine = selectSubtitleSyncEngine(input);
  try {
    return await engine.sync(input);
  } catch (error) {
    if (engine.processingMode === "native" && error instanceof BackendUnavailableError) {
      if (!webSubtitleSyncEngine.canSync(input)) throw error;
      input.onProgress?.({
        phase: "preparing-audio",
        detail: "The helper app went away — finishing in the browser",
      });
      return webSubtitleSyncEngine.sync(input);
    }
    throw error;
  }
};

/** Whether to offer the action at all, for the current item. */
export const canSyncSubtitles = (
  input: Pick<SubtitleSyncInput, "media" | "referenceCues">,
): boolean => selectSubtitleSyncEngine(input).canSync(input);
