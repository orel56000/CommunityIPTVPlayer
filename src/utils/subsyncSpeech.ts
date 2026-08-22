/**
 * Turning subtitle cues into the 100 Hz "speech" signal ffsubsync aligns on.
 *
 * This is a direct port of ffsubsync's subtitle pipeline — `_preprocess_subs`
 * (subtitle_parser.py), `SubtitleScaler` (subtitle_transformers.py) and
 * `SubtitleSpeechTransformer` (speech_transformers.py) — kept in one place
 * because the three stages only make sense in order: parse-time filtering,
 * then framerate scaling, then rasterization.
 *
 * The signal is one float per 10 ms (SAMPLE_RATE = 100), so index `i` is
 * centisecond `i`. Everything downstream — the FFT correlation, the piecewise
 * DP — assumes that rate on BOTH sides, which is the whole reason the video
 * side is decimated to 100 Hz too rather than aligning on raw audio.
 *
 * Pure and DOM-free so it runs identically on the main thread, inside the
 * worker, and under `node --test` — see subsyncSpeech.test.ts.
 */

import type { SubtitleCue } from "./subtitles.ts";

/** Samples per second of the speech signal. ffsubsync's constants.SAMPLE_RATE. */
export const SAMPLE_RATE = 100;

/** Longest signal a single cue's timestamp may demand, in seconds (24 hours). */
export const MAX_SIGNAL_SECONDS = 24 * 60 * 60;

/**
 * Per-cue duration clamp, in seconds (ffsubsync DEFAULT_MAX_SUBTITLE_SECONDS).
 *
 * A cue left on screen for a minute is a sign card or a translator's note, not
 * a minute of dialogue; letting it paint a minute of "speech" would drown the
 * correlation in a single block. The END is clamped, never the start.
 */
export const MAX_SUBTITLE_SECONDS = 10;

/**
 * Bracket pairs that mark a whole cue as a sound description rather than
 * dialogue: "[door creaks]", "(applause)", "（音乐）".
 *
 * "<" is deliberately absent. Markup is stripped BEFORE this test, so
 * "<i>[music]</i>" reduces to "[music]" and is rejected, while "<i>Hello?</i>"
 * reduces to "Hello?" and is kept — which would be impossible if "<" nested.
 */
const PAIRED_NESTER: Record<string, string> = {
  "(": ")",
  "{": "}",
  "[": "]",
  "（": "）",
  "【": "】",
  "「": "」",
};

/** A cue made only of these is a music cue, not a line of speech. */
const NON_DIALOGUE_SYMBOLS = new Set(["♪", "♫", "♬", "♩", "🎵", "🎶"]);

const MARKUP_TAG = /<[^>]+>/g;

/**
 * ffsubsync's `_is_metadata`: cues that carry no speech and must contribute
 * nothing to the signal.
 *
 * `isBeginningOrEnd` unlocks two extra heuristics aimed at the release-group
 * credit lines that bookend most subtitle files ("Subtitles by ...", "English -
 * SDH"). They are applied ONLY to the first and last cue, which means a cue's
 * classification depends on the length of the list it is in — surprising, but
 * it is the upstream behavior and changing it would move offsets.
 *
 * Note this only zeroes the cue in the SIGNAL. It is never dropped from the
 * output: a "[music]" line still gets shifted along with everything else.
 */
export const isMetadataCue = (content: string, isBeginningOrEnd: boolean): boolean => {
  const text = content.replace(MARKUP_TAG, "").trim();
  if (text.length === 0) return true;
  const closer = PAIRED_NESTER[text[0]];
  if (closer !== undefined && text[text.length - 1] === closer) return true;
  // Array.from so an astral-plane symbol (🎵 is a surrogate pair) is one item.
  if (Array.from(text).every((ch) => /\s/.test(ch) || NON_DIALOGUE_SYMBOLS.has(ch))) return true;
  if (isBeginningOrEnd) {
    if (text.toLowerCase().includes("english")) return true;
    if (text.includes(" - ")) return true;
  }
  return false;
};

/**
 * Python's `round`, which is NOT JavaScript's.
 *
 * Python rounds a .5 tie to the nearest EVEN integer; `Math.round` rounds it
 * up. That sounds academic until you notice SRT carries millisecond timings and
 * this signal is sampled at centiseconds — so any duration whose millisecond
 * part is an odd multiple of 5 (1.235s, 3.125s, …) lands exactly on a tie, and
 * those are ordinary, not rare. Each one that rounds the other way moves a cue
 * edge by a sample and changes the correlation score.
 *
 * ffsubsync rounds with Python, so we round with Python.
 */
export const roundHalfToEven = (value: number): number => {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  // Exactly halfway: keep whichever neighbour is even. `%` on a negative floor
  // yields a negative remainder, so compare against 0 rather than testing === 1.
  return floor % 2 === 0 ? floor : floor + 1;
};

export interface PreprocessOptions {
  /** Ignore everything before this point on the reference's timeline. */
  startSeconds?: number;
  /** Per-cue duration clamp; see MAX_SUBTITLE_SECONDS. */
  maxSubtitleSeconds?: number;
}

/**
 * ffsubsync's `_preprocess_subs`. Two rules, in this order:
 *
 *  1. a cue starting before `startSeconds` is DROPPED, not clipped — even if it
 *     straddles the boundary;
 *  2. the end is pulled back to at most `maxSubtitleSeconds` after the start.
 *
 * Cues are returned in input order; sorting is the caller's business (the
 * app's own parser already sorts).
 */
export const preprocessCues = (
  cues: readonly SubtitleCue[],
  options: PreprocessOptions = {},
): SubtitleCue[] => {
  const startSeconds = options.startSeconds ?? 0;
  const maxSubtitleSeconds = options.maxSubtitleSeconds ?? MAX_SUBTITLE_SECONDS;
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    if (!survivesPreprocess(cue, startSeconds)) continue;
    const end = maxSubtitleSeconds > 0 ? Math.min(cue.end, cue.start + maxSubtitleSeconds) : cue.end;
    out.push({ ...cue, end });
  }
  return out;
};

/**
 * ffsubsync's `SubtitleScaler`: a framerate hypothesis multiplies ABSOLUTE
 * times, not durations.
 *
 * That distinction is the whole point — a 25 fps encode played at 23.976
 * drifts further out of sync the longer it runs, so the correction has to grow
 * with the timestamp. Anchoring the scale anywhere other than t=0 would model
 * the wrong thing.
 */
export const scaleCues = (cues: readonly SubtitleCue[], ratio: number): SubtitleCue[] =>
  ratio === 1
    ? cues.slice()
    : cues.map((cue) => ({ ...cue, start: cue.start * ratio, end: cue.end * ratio }));

/**
 * ffsubsync's `ComputeSpeechFrameBoundariesMixin.fit_boundaries`, for signals
 * that did not come from cues (a VAD run, or a deserialized array).
 *
 * The `> 0.5` threshold matters for VADs whose "not sure" label is a small
 * positive number rather than zero.
 */
export const speechFrameCount = (samples: ArrayLike<number>): number | null => {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i += 1) {
    if (samples[i] > 0.5) {
      if (first === -1) first = i;
      last = i;
    }
  }
  return first === -1 ? null : last - first;
};

/** True when `preprocessCues` would keep this cue. The single rule, once. */
const survivesPreprocess = (cue: SubtitleCue, startSeconds: number): boolean =>
  Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.start >= startSeconds;

/**
 * The input indices `preprocessCues` keeps, in order.
 *
 * Anything that produces one value per PREPARED cue — the piecewise aligner's
 * per-cue offsets — has to be mapped back through this before it can be applied
 * to the caller's list, or every cue after a dropped one takes its neighbour's
 * value.
 */
export const preprocessedIndices = (
  cues: readonly SubtitleCue[],
  options: PreprocessOptions = {},
): number[] => {
  const startSeconds = options.startSeconds ?? 0;
  const out: number[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    if (survivesPreprocess(cues[i], startSeconds)) out.push(i);
  }
  return out;
};

export interface SpeechSignal {
  /** One sample per 10 ms; `amplitude` inside a cue, 0 outside. */
  samples: Float64Array;
  /** Last cue end, in seconds, after scaling. */
  maxTime: number;
  /** Distance between the first and last speech sample, or null if silent. */
  numFrames: number | null;
  /** How many samples are speech — the denominator for our confidence figure. */
  speechSamples: number;
}

export interface CuesToSpeechOptions {
  sampleRate?: number;
  startSeconds?: number;
  /** The framerate hypothesis these cues were already scaled by. */
  framerateRatio?: number;
}

/**
 * ffsubsync's `SubtitleSpeechTransformer.fit`: rasterize cues to the signal.
 *
 * Two details that look like noise and are not:
 *
 *  - The amplitude is `min(1 / ratio, 1)`, NOT 1. Stretching the cues by a
 *    ratio > 1 also stretches the total "speech mass", and because the
 *    correlation score is unnormalized (see subsyncAlign.ts) that extra mass
 *    would make every stretched hypothesis outscore the unstretched one on
 *    volume alone. Lowering the amplitude by the same factor cancels it, so
 *    the candidates compete on FIT rather than on size.
 *
 *  - The end sample is `start + round(duration * rate)`, not
 *    `round(end * rate)`. The two differ by a sample whenever both endpoints
 *    round the same way, and matching upstream here is what keeps the ported
 *    tests' exact sample counts reproducible.
 */
export const cuesToSpeech = (
  cues: readonly SubtitleCue[],
  options: CuesToSpeechOptions = {},
): SpeechSignal => {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const startSeconds = options.startSeconds ?? 0;
  const framerateRatio = options.framerateRatio ?? 1;

  let maxTime = 0;
  for (const cue of cues) maxTime = Math.max(maxTime, cue.end);
  // A single malformed timestamp — a stray "99:59:59" in an otherwise fine
  // file — would otherwise size the array off that one cue. Upstream allocates
  // unbounded; here the cap is a day, which is longer than any media this
  // player will ever see and short enough not to be a way to exhaust memory.
  maxTime = Math.min(Math.max(maxTime, 0), MAX_SIGNAL_SECONDS);

  // The +2 is upstream's slack: `end` can round one past `maxTime * rate`, and
  // a bounds check per write in the hot loop is not worth saving two floats.
  const samples = new Float64Array(Math.trunc(maxTime * sampleRate) + 2);
  const amplitude = Math.min(1 / framerateRatio, 1);

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (isMetadataCue(cue.text, i === 0 || i + 1 === cues.length)) continue;
    const start = roundHalfToEven((cue.start - startSeconds) * sampleRate);
    const end = start + roundHalfToEven((cue.end - cue.start) * sampleRate);
    // A cue pushed before zero by `startSeconds` has its leading part clipped
    // rather than being skipped entirely. numpy would resolve the negative
    // start against the END of the array and write nothing at all — a quirk of
    // slice semantics rather than an intent, and one `preprocessCues` makes
    // unreachable from `alignCues` anyway, since it drops those cues first.
    for (let s = Math.max(0, start); s < Math.min(end, samples.length); s += 1) {
      samples[s] = amplitude;
    }
  }

  // Boundaries come from the RASTERIZED signal, not from the loop above.
  // Upstream tracks start/end frames in the loop and then throws them away in
  // favour of exactly this scan — which matters, because a cue clipped away by
  // `startSeconds` still moves the loop's variables while contributing no
  // samples. Deriving them here is the difference between 349 and 600.
  let speechSamples = 0;
  for (let i = 0; i < samples.length; i += 1) if (samples[i] > 0) speechSamples += 1;

  return {
    samples,
    maxTime: maxTime - startSeconds,
    numFrames: speechFrameCount(samples),
    speechSamples,
  };
};
