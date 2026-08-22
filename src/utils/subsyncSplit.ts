/**
 * Piecewise ("split-penalty") alignment — ffsubsync's `split_aligner.py`.
 *
 * The FFT aligner in subsyncAlign.ts emits ONE offset for the whole file. That
 * cannot fix a subtitle whose required offset CHANGES partway through: an ad
 * break the encode kept and the subtitles didn't, an inserted scene, two discs
 * concatenated. This is ffsubsync's port of the idea from alass — let every cue
 * choose its own offset, but charge a penalty each time two neighbours choose
 * differently:
 *
 *     maximize  Σ rating(cue_i @ offset_i)  −  splitPenalty × (number of splits)
 *
 * With a large penalty the optimum collapses back to a single global offset, so
 * this generalizes the default rather than replacing it.
 *
 * The subtitle is never pre-chunked. Segments EMERGE as runs of cues that
 * happened to pick the same offset, which is why a break can land anywhere
 * rather than on a boundary someone guessed in advance.
 *
 * Pure and DOM-free — see subsyncSplit.test.ts.
 */

import { isMetadataCue, roundHalfToEven, SAMPLE_RATE } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";

/** Cost of one split, in seconds of overlap (ffsubsync DEFAULT_SPLIT_PENALTY). */
export const DEFAULT_SPLIT_PENALTY_SECONDS = 5;

/** Weight of the edge/length term (ffsubsync DEFAULT_SPLIT_LENGTH_PENALTY). */
export const DEFAULT_SPLIT_LENGTH_PENALTY = 0.25;

/**
 * Ceiling on the guard band, in samples (2s at 100 Hz).
 *
 * The guard is normally the cue's own duration — a scale-free "is this block
 * about my size?" probe — but a very long cue would otherwise reach across the
 * neighbouring dialogue and penalize a perfectly good placement.
 */
const MAX_GUARD_SAMPLES = 200;

export interface SplitOptions {
  sampleRate?: number;
  startSeconds?: number;
  /** Cost of a split, already in SAMPLES (seconds × sampleRate). */
  splitPenalty: number;
  /** Half-width of the candidate offset grid, in samples. */
  maxOffsetSamples: number;
  /** 0 disables the edge term and scores pure overlap. */
  lengthPenalty?: number;
  /** Grid spacing in samples; < 1 gives sub-sample precision. */
  offsetStepSamples?: number;
}

export interface SplitResult {
  /** One offset per cue, in samples, parallel to the input. */
  offsets: number[];
  /** The maximized objective — comparable only between runs on the same cues. */
  score: number;
  /** Runs of equal offset, for logging and for the UI's "N segments" line. */
  segments: { cueCount: number; offsetSamples: number }[];
}

/**
 * Group the per-cue offsets into the runs a human would call segments.
 * Exported because the UI reports "3 segments" and the debug log wants the same
 * breakdown ffsubsync prints.
 */
export const splitSegments = (offsets: readonly number[]): { cueCount: number; offsetSamples: number }[] => {
  const segments: { cueCount: number; offsetSamples: number }[] = [];
  for (const offset of offsets) {
    const last = segments[segments.length - 1];
    if (last && last.offsetSamples === offset) last.cueCount += 1;
    else segments.push({ cueCount: 1, offsetSamples: offset });
  }
  return segments;
};

/**
 * The DP.
 *
 * The rating of a cue at an offset is the amount of reference speech it covers
 * there, which — given a prefix sum of the reference — is one subtraction. Two
 * refinements on top of plain overlap, both from upstream and both still O(1):
 *
 *  - **Edge/length term.** Pure overlap is FLAT wherever a short cue sits
 *    entirely inside a longer block of speech, so it cannot tell where in that
 *    block the cue belongs, and the argmax falls to whichever offset came
 *    first. Charging a fraction of the speech just OUTSIDE the cue's edges
 *    makes a same-sized block beat a longer one.
 *
 *  - **Sub-sample offsets.** The reference is a 0/1 step function, so linear
 *    interpolation of its prefix sum is the EXACT integral at a fractional
 *    position — not an approximation. A grid finer than one sample therefore
 *    gives genuinely sub-10ms precision.
 *
 * Why this is O(cues × offsets) rather than O(cues × offsets²): the penalty is
 * a flat constant, independent of how far the offset jumps, so the best place
 * to jump FROM is always the previous row's single global maximum. One argmax
 * per cue collapses the whole transition matrix. That is exact — and it stops
 * being exact the moment anyone makes the penalty depend on jump distance.
 */
export const computeSplitOffsets = (
  reference: ArrayLike<number>,
  cues: readonly SubtitleCue[],
  options: SplitOptions,
): SplitResult => {
  const n = cues.length;
  if (n === 0) return { offsets: [], score: 0, segments: [] };

  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const startSeconds = options.startSeconds ?? 0;
  const lengthPenalty = options.lengthPenalty ?? 0;
  const maxOffsetSamples = options.maxOffsetSamples;
  const step = (options.offsetStepSamples ?? 1) > 0 ? (options.offsetStepSamples ?? 1) : 1;

  // Bounds stay FLOAT — never rounded to whole samples — so the sub-sample grid
  // can exploit the cues' true millisecond timing.
  const starts = new Float64Array(n);
  const ends = new Float64Array(n);
  const guards = new Float64Array(n);
  const isSpeech = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const cue = cues[i];
    const start = (cue.start - startSeconds) * sampleRate;
    const duration = (cue.end - cue.start) * sampleRate;
    starts[i] = start;
    ends[i] = start + duration;
    guards[i] = Math.min(duration, MAX_GUARD_SAMPLES);
    // Same gate as the rasterizer, so a "[music]" cue contributes no rating and
    // the DP leaves it on a neighbour's offset for free.
    isSpeech[i] = isMetadataCue(cue.text, i === 0 || i + 1 === n) ? 0 : 1;
  }

  // numpy's round, like Python's, breaks a .5 tie toward even — see
  // roundHalfToEven. It only bites on an odd grid, but the two implementations
  // must agree on the number of candidate offsets or nothing downstream lines up.
  const offsetCount = roundHalfToEven((2 * maxOffsetSamples) / step) + 1;
  const offsets = new Float64Array(offsetCount);
  for (let j = 0; j < offsetCount; j += 1) offsets[j] = -maxOffsetSamples + step * j;

  // Prefix sum of the HARD-binarized reference (a weighted VAD's 0.6 counts the
  // same as a 1.0 here — the DP measures coverage, not confidence), padded at
  // both ends so every shifted or guard-extended lookup lands in a flat region:
  // silence on the left, the total on the right.
  const refLength = reference.length;
  const cumsum = new Float64Array(refLength + 1);
  for (let i = 0; i < refLength; i += 1) cumsum[i + 1] = cumsum[i] + (reference[i] > 0 ? 1 : 0);
  const pad = maxOffsetSamples + MAX_GUARD_SAMPLES + 2;
  const padded = new Float64Array(cumsum.length + 2 * pad);
  padded.set(cumsum, pad);
  const total = cumsum[cumsum.length - 1];
  for (let i = pad + cumsum.length; i < padded.length; i += 1) padded[i] = total;
  const maxPos = padded.length - 1;

  const interp = (pos: number): number => {
    const clamped = pos < 0 ? 0 : pos > maxPos ? maxPos : pos;
    let lo = Math.floor(clamped);
    if (lo < 0) lo = 0;
    else if (lo > maxPos - 1) lo = maxPos - 1;
    const frac = clamped - lo;
    return padded[lo] * (1 - frac) + padded[lo + 1] * frac;
  };

  const row = new Float64Array(offsetCount);
  const fillRatingRow = (i: number): void => {
    if (!isSpeech[i]) {
      row.fill(0);
      return;
    }
    const start = starts[i] + pad;
    const end = ends[i] + pad;
    const guard = guards[i];
    const useGuard = lengthPenalty !== 0 && guard > 0;
    for (let j = 0; j < offsetCount; j += 1) {
      const offset = offsets[j];
      const cs = interp(start + offset);
      const ce = interp(end + offset);
      let rating = ce - cs;
      if (useGuard) {
        const gl = cs - interp(start + offset - guard);
        const gr = interp(end + offset + guard) - ce;
        rating -= lengthPenalty * (gl + gr);
      }
      row[j] = rating;
    }
  };

  // Forward pass.
  //
  // The backtrack table is ONE BIT per (cue, offset), not one Int32. Every
  // entry in a row is either "kept the previous cue's offset" or "jumped to
  // that row's single best offset" — and that best offset is the same for the
  // whole row, so it needs storing once per cue rather than once per cell.
  // The full table for a 2000-cue subtitle at the default grid is 24 million
  // entries: 96 MB as Int32s, 3 MB as bits.
  const dp = new Float64Array(offsetCount);
  fillRatingRow(0);
  dp.set(row);
  const bitsPerRow = (offsetCount + 31) >> 5;
  const jumpedBits = new Uint32Array(n * bitsPerRow);
  const jumpTarget = new Int32Array(n).fill(-1);

  for (let i = 1; i < n; i += 1) {
    let bestPrevIdx = 0;
    let bestPrev = dp[0];
    for (let j = 1; j < offsetCount; j += 1) {
      if (dp[j] > bestPrev) {
        bestPrev = dp[j];
        bestPrevIdx = j;
      }
    }
    const jumpValue = bestPrev - options.splitPenalty;
    fillRatingRow(i);
    jumpTarget[i] = bestPrevIdx;
    const bitBase = i * bitsPerRow;
    for (let j = 0; j < offsetCount; j += 1) {
      if (jumpValue > dp[j]) {
        dp[j] = row[j] + jumpValue;
        jumpedBits[bitBase + (j >> 5)] |= 1 << (j & 31);
      } else {
        dp[j] = row[j] + dp[j];
      }
    }
  }

  let bestIdx = 0;
  let bestTotal = dp[0];
  for (let j = 1; j < offsetCount; j += 1) {
    if (dp[j] > bestTotal) {
      bestTotal = dp[j];
      bestIdx = j;
    }
  }

  const result = new Array<number>(n);
  let cursor = bestIdx;
  for (let i = n - 1; i >= 0; i -= 1) {
    result[i] = offsets[cursor];
    if (i > 0) {
      const jumped = (jumpedBits[i * bitsPerRow + (cursor >> 5)] >>> (cursor & 31)) & 1;
      if (jumped) cursor = jumpTarget[i];
    }
  }

  return { offsets: result, score: bestTotal, segments: splitSegments(result) };
};

/** The single number to REPORT for a piecewise sync. Never applicable as a shift. */
export const medianOffset = (offsets: readonly number[]): number => {
  if (offsets.length === 0) return 0;
  const sorted = [...offsets].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
