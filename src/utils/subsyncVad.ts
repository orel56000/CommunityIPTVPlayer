/**
 * Voice activity detection over raw PCM — the reference side of the sync.
 *
 * ffsubsync offers several detectors. Its default is `subs_then_webrtc`: try
 * the video's own embedded subtitle track first, and only fall back to
 * WebRTC's VAD if there isn't one. That first half we can do exactly (an
 * embedded track is just cues, and subsyncSpeech.ts turns cues into the signal
 * bit-for-bit). The second half we cannot: `webrtcvad` is a compiled GMM
 * classifier with no browser equivalent worth vendoring.
 *
 * So this is a port of ffsubsync's OTHER audio detector, `auditok` — the
 * energy gate. That is a deliberate choice rather than a shortcut:
 *
 *  - it is a real ffsubsync mode (`--vad auditok`), not an invention, and
 *    upstream's own README notes it "can sometimes work better in the case of
 *    low-quality audio than WebRTC's VAD" — which describes IPTV precisely;
 *  - it is exact. Every constant below is upstream's, and the state machine is
 *    auditok's `StreamTokenizer`, so this file reproduces `--vad auditok`
 *    sample for sample (verified against auditok 0.1.5 — see subsyncVad.test.ts).
 *
 * When the native backend has a real ffsubsync installed, that one runs with
 * its own default and this code is not used. See subtitleSync.ts.
 *
 * Output is one float per 10 ms — the same 100 Hz grid the subtitle side uses.
 */

import { SAMPLE_RATE } from "./subsyncSpeech.ts";

/**
 * Audio sample rate handed to the detector (ffsubsync DEFAULT_FRAME_RATE).
 *
 * 48 kHz is what upstream asks ffmpeg for, and is the default here so that
 * calling `detectSpeech` with no options reproduces upstream's window size of
 * 480 samples. Both engines in this app pass 16 kHz explicitly
 * (EXTRACT_SAMPLE_RATE in subsyncAudio.ts, AUDIO_RATE in subsync.rs): the gate
 * is a mean square over a 10 ms window and does not care how finely that
 * window was sampled, and 16 kHz is a third of the bytes to move.
 */
export const AUDIO_FRAME_RATE = 48000;

/**
 * auditok's `AudioEnergyValidator` threshold, in dB (ffsubsync passes 50).
 *
 * The measure is `10 * log10(mean(sample^2))` on int16 units, so 50 dB is a
 * mean square of 1e5 — an RMS of ~316/32768, about -40 dBFS. Loud enough to
 * skip room tone and encoder noise, quiet enough to keep ordinary dialogue.
 */
const ENERGY_THRESHOLD_DB = 50;

/** auditok's floor for a digitally-silent window; never NaN or -Infinity. */
const SILENT_WINDOW_DB = -200;

/** Tokenizer bounds, in 10 ms windows (0.2s / 5s / 0.25s at 100 Hz). */
const MIN_TOKEN_WINDOWS = 0.2 * SAMPLE_RATE;
const MAX_TOKEN_WINDOWS = Math.trunc(5 * SAMPLE_RATE);
const MAX_CONTINUOUS_SILENCE_WINDOWS = 0.25 * SAMPLE_RATE;

/** Value written where no speech was found (ffsubsync DEFAULT_NON_SPEECH_LABEL). */
export const NON_SPEECH_LABEL = 0;

export interface VadOptions {
  /** PCM sample rate. Must divide evenly into 10 ms windows. */
  frameRate?: number;
  /** Output rate; 100 = one sample per 10 ms. */
  sampleRate?: number;
  /** What to write for "no speech" — upstream's tunable non-speech label. */
  nonSpeechLabel?: number;
}

/**
 * `10 * log10(mean(x^2))` over one window of int16 samples.
 *
 * auditok computes the dot product in float64 before dividing; doing it in
 * int32 would overflow on a loud window (480 × 32768² is ~5e11).
 */
const windowEnergyDb = (pcm: Int16Array, from: number, to: number): number => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += pcm[i] * pcm[i];
  const count = to - from;
  if (count === 0) return SILENT_WINDOW_DB;
  const energy = sum / count;
  return energy <= 0 ? SILENT_WINDOW_DB : 10 * Math.log10(energy);
};

/** One detected run of speech, in window indices. `end` is INCLUSIVE. */
interface SpeechToken {
  start: number;
  end: number;
}

/**
 * auditok's `StreamTokenizer`, reduced to the configuration ffsubsync uses
 * (`init_min = 0`, `init_max_silence = 0`, `mode = 0`).
 *
 * With `init_min = 0` the POSSIBLE_NOISE state is unreachable — a single valid
 * window is enough to open a token — so only three states remain. `mode = 0`
 * also means trailing silence is KEPT inside a token and the minimum length is
 * not enforced on a token that was truncated by `maxLength` (the
 * `contiguousToken` flag below), both of which change where token edges land.
 */
const tokenize = (isValid: (index: number) => boolean, windowCount: number): SpeechToken[] => {
  const SILENCE = 0;
  const NOISE = 1;
  const POSSIBLE_SILENCE = 2;

  const tokens: SpeechToken[] = [];
  let state = SILENCE;
  let dataLength = 0;
  let silenceLength = 0;
  let startWindow = 0;
  let contiguousToken = false;
  let currentWindow = -1;

  const endOfDetection = (truncated: boolean): void => {
    if (dataLength >= MIN_TOKEN_WINDOWS || (dataLength > 0 && contiguousToken)) {
      tokens.push({ start: startWindow, end: startWindow + dataLength - 1 });
      if (truncated) {
        // The next token continues immediately after this one, and inherits
        // the right to be shorter than the minimum.
        startWindow = currentWindow + 1;
        contiguousToken = true;
      } else {
        contiguousToken = false;
      }
    } else {
      contiguousToken = false;
    }
    dataLength = 0;
  };

  for (let i = 0; i < windowCount; i += 1) {
    currentWindow = i;
    const valid = isValid(i);

    if (state === SILENCE) {
      if (valid) {
        silenceLength = 0;
        startWindow = currentWindow;
        dataLength = 1;
        state = NOISE;
        if (dataLength >= MAX_TOKEN_WINDOWS) endOfDetection(true);
      }
    } else if (state === NOISE) {
      if (valid) {
        dataLength += 1;
        if (dataLength >= MAX_TOKEN_WINDOWS) endOfDetection(true);
      } else {
        // The first silent window after speech is tolerated, and is kept in
        // the token — that is what makes a token cover a natural pause.
        silenceLength = 1;
        dataLength += 1;
        state = POSSIBLE_SILENCE;
        if (dataLength === MAX_TOKEN_WINDOWS) endOfDetection(true);
      }
    } else {
      // POSSIBLE_SILENCE
      if (valid) {
        dataLength += 1;
        silenceLength = 0;
        state = NOISE;
        if (dataLength >= MAX_TOKEN_WINDOWS) endOfDetection(true);
      } else if (silenceLength >= MAX_CONTINUOUS_SILENCE_WINDOWS) {
        // Emit only if the run was not silence end to end.
        if (silenceLength < dataLength) endOfDetection(false);
        else dataLength = 0;
        state = SILENCE;
        silenceLength = 0;
      } else {
        dataLength += 1;
        silenceLength += 1;
        if (dataLength >= MAX_TOKEN_WINDOWS) endOfDetection(true);
      }
    }
  }

  if ((state === NOISE || state === POSSIBLE_SILENCE) && dataLength > 0 && dataLength > silenceLength) {
    currentWindow = windowCount - 1;
    endOfDetection(false);
  }
  return tokens;
};

/**
 * Run the detector over one block of signed 16-bit mono PCM.
 *
 * Blocks are processed independently and their outputs concatenated, exactly
 * as ffsubsync does over its 100-second reads — so callers can stream a film
 * through this without ever holding more than a block of audio. The caller
 * MUST cut blocks on a whole number of windows (`frameRate / sampleRate`
 * samples) or a window will straddle the seam and the two halves will each be
 * judged as near-silence.
 */
export const detectSpeech = (pcm: Int16Array, options: VadOptions = {}): Float64Array => {
  const frameRate = options.frameRate ?? AUDIO_FRAME_RATE;
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const nonSpeechLabel = options.nonSpeechLabel ?? NON_SPEECH_LABEL;
  const samplesPerWindow = Math.trunc(frameRate / sampleRate);
  if (samplesPerWindow <= 0) throw new Error("vad: frameRate must be at least sampleRate");

  const windowCount = Math.ceil(pcm.length / samplesPerWindow);

  // Cache the per-window verdict: the tokenizer asks for each window once, but
  // keeping it explicit makes the state machine above readable as auditok's.
  const valid = new Uint8Array(windowCount);
  for (let w = 0; w < windowCount; w += 1) {
    const from = w * samplesPerWindow;
    const to = Math.min(from + samplesPerWindow, pcm.length);
    valid[w] = windowEnergyDb(pcm, from, to) >= ENERGY_THRESHOLD_DB ? 1 : 0;
  }

  const tokens = tokenize((i) => valid[i] === 1, windowCount);

  // Upstream builds the signal as a difference array and integrates it, which
  // costs one pass regardless of how many tokens there are. Same shape here,
  // with ONE deliberate divergence:
  //
  // ffsubsync writes the markers by ASSIGNMENT — `bstring[start] = 1` and
  // `bstring[end + 1] = label - 1`. A token truncated at the 5-second
  // `maxLength` is immediately followed by another starting at `end + 1`, so
  // that second token's +1 lands on, and erases, the first one's -1. The
  // running sum then never comes back down, and every remaining window in the
  // block reads as speech. On a 100-second read that means a single sustained
  // passage — music, an action scene — can paint a minute and a half of false
  // reference, which drags the correlation toward a wrong offset.
  //
  // Accumulating (`+=`) instead keeps the terminator, so adjacent tokens simply
  // join. It is the only place this port knowingly departs from upstream, and
  // it departs toward the behavior upstream's own comments describe.
  const deltas = new Float64Array(windowCount + 1);
  for (const token of tokens) {
    deltas[token.start] += 1;
    if (token.end + 1 < deltas.length) deltas[token.end + 1] += nonSpeechLabel - 1;
  }
  const out = new Float64Array(windowCount);
  let running = 0;
  for (let i = 0; i < windowCount; i += 1) {
    running += deltas[i];
    out[i] = running < 0 ? 0 : running > 1 ? 1 : running;
  }
  return out;
};

/**
 * Accumulate VAD output across streamed PCM blocks.
 *
 * The whole point of the browser path is never to hold a film's audio in
 * memory: each decoded block is detected, folded into this 100 Hz array (which
 * for a 3-hour film is ~1M floats, about 8 MB) and then released.
 *
 * Blocks are PLACED at their known start time, not appended.
 *
 * That distinction is the difference between a correct answer and a plausible
 * one. Each block comes from its own `ffmpeg -ss T -t N` invocation, and what
 * comes back is not guaranteed to be exactly N seconds: the last block is
 * short, a seek can land a few milliseconds off, a stream can have a gap. Under
 * concatenation every one of those discrepancies shifts EVERYTHING after it,
 * and the shifts accumulate — so a two-hour film can end up with a reference
 * whose late scenes are seconds away from where they really are, and the
 * correlation then confidently reports an offset that is wrong by that drift.
 * Placing each block against the timeline cannot drift, however ragged the
 * blocks are.
 */
export class SpeechAccumulator {
  private samples: Float64Array = new Float64Array(0);
  private length = 0;
  private detected = 0;

  private ensure(capacity: number): void {
    if (capacity <= this.samples.length) return;
    // Grow geometrically — a 3-hour film is ~108 samples per second of media
    // and would otherwise reallocate once per block.
    const next = new Float64Array(Math.max(capacity, this.samples.length * 2, 1 << 16));
    next.set(this.samples);
    this.samples = next;
  }

  /**
   * Detect one block and write it at `startSeconds` on the reference timeline.
   *
   * Omitting `startSeconds` appends, which is only correct when the caller
   * really is feeding one continuous stream (the tests do).
   */
  push(pcm: Int16Array, options?: VadOptions & { startSeconds?: number }): void {
    const block = detectSpeech(pcm, options);
    const sampleRate = options?.sampleRate ?? SAMPLE_RATE;
    const at =
      options?.startSeconds === undefined
        ? this.length
        : Math.max(0, Math.round(options.startSeconds * sampleRate));
    this.ensure(at + block.length);
    this.samples.set(block, at);
    this.length = Math.max(this.length, at + block.length);
    this.detected += block.length;
  }

  /** Hand the signal over and reset. Trimmed to the timeline actually covered. */
  finish(): Float64Array {
    const out = this.samples.slice(0, this.length);
    this.samples = new Float64Array(0);
    this.length = 0;
    this.detected = 0;
    return out;
  }

  /** Seconds of reference DETECTED so far, for progress reporting. */
  get processedSeconds(): number {
    return this.detected / SAMPLE_RATE;
  }
}
