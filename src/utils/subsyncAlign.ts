/**
 * The alignment core: ffsubsync's FFT cross-correlation and framerate search.
 *
 * Direct port of `ffsubsync/aligners.py` (FFTAligner, MaxScoreAligner) and the
 * candidate loop in `try_sync` (ffsubsync/ffsubsync.py), plus the golden-section
 * search from `golden_section_search.py`.
 *
 * ─── SIGN CONVENTION ────────────────────────────────────────────────────────
 * `offsetSeconds` is the number ADDED to every subtitle timestamp. POSITIVE
 * moves the subtitles LATER (they were early); NEGATIVE moves them EARLIER.
 * That is the same convention as this app's own `shiftCues`, and the same as
 * ffsubsync's `SubtitleShifter`, so the number can be handed straight to
 * either. Getting it backwards is silent and total, hence the three ported
 * unit vectors in subsyncAlign.test.ts.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A note on the score, because it is the most commonly misread number here: it
 * is the RAW peak of a ±1/±1 correlation, in units of "agreeing samples minus
 * disagreeing samples". It is not normalized, not a probability, and scales
 * with the length of the file — a feature-length film scores in the tens of
 * thousands where an episode scores in the low thousands. Only its SIGN is
 * comparable across files. `confidenceFromScore` below derives something that
 * IS comparable, and is ours rather than upstream's.
 */

// Explicit .ts extensions on these intra-module imports: unlike the rest of
// src/utils these files are exercised by `node --test` directly (they hold the
// whole algorithm), and Node resolves no extension of its own. Vite and tsc
// both accept the explicit form — see allowImportingTsExtensions in
// tsconfig.app.json.
import { fftInPlace, nextPowerOfTwo, releaseFftCache } from "./subsyncFft.ts";
import { SAMPLE_RATE, cuesToSpeech, scaleCues, type SpeechSignal } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";

/**
 * The three framerate mismatches that actually happen: NTSC film pulled to 24,
 * PAL sped up from film, and PAL vs NTSC-film. Their reciprocals are searched
 * too, so a subtitle timed for either side of each pair is covered.
 */
export const FRAMERATE_RATIOS = [24 / 23.976, 25 / 23.976, 25 / 24];

/** How far the correlation is allowed to shift things, in seconds. */
export const MAX_OFFSET_SECONDS = 60;

/** Golden-section search bounds; upstream MIN/MAX_FRAMERATE_RATIO. */
export const MIN_FRAMERATE_RATIO = 0.9;
export const MAX_FRAMERATE_RATIO = 1.1;
const GSS_TOLERANCE = 1e-4;

/** Thrown when there is nothing alignable, rather than returning a bogus 0. */
export class FailedToFindAlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FailedToFindAlignmentError";
  }
}

export interface AlignResult {
  /** Raw correlation peak — see the header. Sign is meaningful, size is not. */
  score: number;
  /** Best lag, in 100 Hz samples. Positive = subtitles move later. */
  offset: number;
}

/**
 * The reference transform depends only on the reference and the transform
 * length, so it is reused across framerate candidates.
 *
 * The candidates differ in subtitle length by a few percent, which almost
 * never crosses a power-of-two boundary — so in practice this turns 7 pairs of
 * forward transforms into 7 + 1. It is an exact reuse, not an approximation:
 * see the derivation of `b` in `crossCorrelate`.
 */
interface ReferenceTransform {
  n: number;
  re: Float64Array;
  im: Float64Array;
}

const buildReferenceTransform = (ref: ArrayLike<number>, n: number): ReferenceTransform => {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const r = ref.length;
  // b = flip(concat(map(ref), zeros(n - r))) — note the ±1 mapping happens
  // BEFORE the padding upstream, so the pad stays a true 0 and not a -1. That
  // asymmetry is deliberate: the pad must contribute nothing to the sum, which
  // a -1 would not.
  //
  // The time reversal IS the complex conjugation that turns a convolution into
  // a correlation, which is why there is no conj() anywhere in this file (or in
  // upstream's).
  for (let i = 0; i < r; i += 1) re[n - 1 - i] = 2 * ref[i] - 1;
  fftInPlace(re, im, false);
  return { n, re, im };
};

/**
 * ffsubsync's `FFTAligner.fit`.
 *
 * Both signals are mapped to ±1 first, so agreement contributes +1 and
 * disagreement -1 — that is what makes the peak a "how much do these two agree"
 * number rather than a "how much speech is there" number.
 *
 * The index arithmetic is the part worth checking against the derivation:
 * subtitle sample `s` sits at padded index `(N-S)+s`, the flipped reference
 * contributes reference sample `r` at index `N-1-r`, so the circular
 * convolution bin is `m = N-S-1+(s-r)`. Defining the offset as "subtitle sample
 * `s` lines up with reference sample `s+o`" gives `o = N-1-m-S`.
 */
export const crossCorrelate = (
  ref: ArrayLike<number>,
  sub: ArrayLike<number>,
  maxOffsetSamples?: number,
  cache?: { transform?: ReferenceTransform },
): AlignResult => {
  const r = ref.length;
  const s = sub.length;
  if (r === 0 || s === 0) {
    throw new FailedToFindAlignmentError(
      `cannot align empty speech data (reference length=${r}, subtitle length=${s}); ` +
        "the reference or subtitles may contain no detectable speech",
    );
  }

  const n = nextPowerOfTwo(s + r);

  let refT = cache?.transform;
  if (!refT || refT.n !== n) {
    refT = buildReferenceTransform(ref, n);
    if (cache) cache.transform = refT;
  }

  // a = concat(zeros(extra + r), map(sub)) — the subtitle right-justified in N,
  // its pad a true 0 for the same reason as the reference's.
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const subStart = n - s;
  for (let i = 0; i < s; i += 1) re[subStart + i] = 2 * sub[i] - 1;
  fftInPlace(re, im, false);

  // Pointwise product, then a single inverse transform.
  for (let i = 0; i < n; i += 1) {
    const pr = re[i] * refT.re[i] - im[i] * refT.im[i];
    const pi = re[i] * refT.im[i] + im[i] * refT.re[i];
    re[i] = pr;
    im[i] = pi;
  }
  fftInPlace(re, im, true);

  // Mask lags beyond the caller's tolerance BEFORE the argmax, so a spurious
  // far-away peak cannot win.
  //
  // The low bound is CLAMPED at zero, which is a deliberate divergence.
  // Upstream writes `convolve[: n-1-max-S] = -inf`, and a negative stop in a
  // Python slice is resolved against the end of the array — so when the
  // reference is shorter than the tolerance (a 60-second clip against the
  // 60-second default), that bound goes negative and masks a huge PREFIX of
  // the correlation instead of nothing, hiding legitimate lags. Clamping masks
  // nothing there, which is what the line plainly means to do.
  //
  // Where the bound is positive — every full-length reference — the two are
  // identical, which is why the ported vectors agree exactly.
  let lo = 0;
  let hi = n;
  if (maxOffsetSamples !== undefined && maxOffsetSamples !== null) {
    lo = Math.min(Math.max(n - 1 - maxOffsetSamples - s, 0), n);
    hi = Math.min(Math.max(n - 1 + maxOffsetSamples - s, 0), n);
  }

  let bestIdx = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    // Strictly greater, so ties resolve to the first index — numpy's argmax.
    if (i < lo || i >= hi) continue;
    if (re[i] > bestScore) {
      bestScore = re[i];
      bestIdx = i;
    }
  }
  // A zero tolerance masks the whole array. Upstream leaves that alone — the
  // -Infinity score and the nonsense offset it produces are then rejected by
  // the caller's range filter, which is the correct outcome by a slightly
  // roundabout route. Reproduced rather than "fixed", so the two
  // implementations cannot disagree.
  return { score: bestScore, offset: n - 1 - bestIdx - s };
};

export interface FramerateCandidate {
  /** The framerate hypothesis these cues were scaled by. */
  scaleFactor: number;
  score: number;
  /** Lag in 100 Hz samples. */
  offset: number;
  /** True once the range filter has kept it. */
  inRange: boolean;
}

export interface FramerateSearchOptions {
  sampleRate?: number;
  startSeconds?: number;
  maxOffsetSeconds?: number;
  /** Skip the framerate hypotheses entirely (upstream's --no-fix-framerate). */
  noFixFramerate?: boolean;
  /** Add a golden-section-searched ratio to the candidates (upstream's --gss). */
  gss?: boolean;
  /**
   * Reference speech-frame span, when the reference came from SUBTITLES rather
   * than audio. Upstream only infers a ratio from length in that case, because
   * a VAD's span is the span of detected speech and not of the media.
   */
  referenceNumFrames?: number | null;
}

export interface FramerateSearchResult {
  scaleFactor: number;
  /** Lag in 100 Hz samples, before `applyOffsetSeconds`. */
  offsetSamples: number;
  score: number;
  /** Speech mass of the winning candidate — the confidence denominator. */
  speechSamples: number;
  /** Every candidate tried, in order, for logging and margin computation. */
  candidates: FramerateCandidate[];
  /** The winning candidate's rasterized cues, reused by the piecewise pass. */
  bestSpeech: SpeechSignal;
  bestCues: SubtitleCue[];
}

/** The candidate ratios, in upstream's order (order only breaks ties). */
export const framerateCandidates = (noFixFramerate: boolean): number[] =>
  noFixFramerate ? [1] : [1, ...FRAMERATE_RATIOS, ...FRAMERATE_RATIOS.map((r) => 1 / r)];

/**
 * ffsubsync's `golden_section_search.gss`, minimizing `f` on `[a, b]`.
 *
 * Two upstream quirks are preserved deliberately, because they change which
 * ratio is proposed: the returned bracket is discarded by the caller, and the
 * candidate that goes on to compete is whichever probe was flagged as the last
 * iteration — the LAST probe, not the BEST one.
 */
export const goldenSectionSearch = (
  f: (x: number, isLastIteration: boolean) => number,
  lower: number,
  upper: number,
  tolerance = GSS_TOLERANCE,
): [number, number] => {
  let a = Math.min(lower, upper);
  let b = Math.max(lower, upper);
  let h = b - a;
  if (h <= tolerance) return [a, b];

  const invphi = (Math.sqrt(5) - 1) / 2;
  const invphi2 = (3 - Math.sqrt(5)) / 2;
  const n = Math.ceil(Math.log(tolerance / h) / Math.log(invphi));

  let c = a + invphi2 * h;
  let d = a + invphi * h;
  let yc = f(c, n === 1);
  let yd = f(d, n === 1);

  for (let k = 0; k < n - 1; k += 1) {
    if (yc < yd) {
      b = d;
      d = c;
      yd = yc;
      h = invphi * h;
      c = a + invphi2 * h;
      yc = f(c, k === n - 2);
    } else {
      a = c;
      c = d;
      yc = yd;
      h = invphi * h;
      d = a + invphi * h;
      yd = f(d, k === n - 2);
    }
  }
  return yc < yd ? [a, d] : [c, b];
};

/**
 * Try every framerate hypothesis against the reference and keep the best.
 *
 * Upstream's ordering is load-bearing and reproduced exactly: candidates whose
 * offset lands outside the tolerance are DISCARDED, not penalized, and only
 * then is the argmax taken. Penalizing instead would let a wildly wrong but
 * high-scoring candidate drag the winner around.
 */
export const searchFramerate = (
  referenceSpeech: ArrayLike<number>,
  cues: readonly SubtitleCue[],
  options: FramerateSearchOptions = {},
): FramerateSearchResult => {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const startSeconds = options.startSeconds ?? 0;
  const maxOffsetSeconds = options.maxOffsetSeconds ?? MAX_OFFSET_SECONDS;
  const maxOffsetSamples = Math.abs(Math.trunc(maxOffsetSeconds * sampleRate));

  const cache: { transform?: ReferenceTransform } = {};
  const evaluated = new Map<number, { candidate: FramerateCandidate; speech: SpeechSignal; cues: SubtitleCue[] }>();

  const evaluate = (ratio: number) => {
    const existing = evaluated.get(ratio);
    if (existing) return existing;
    const scaled = scaleCues(cues, ratio);
    const speech = cuesToSpeech(scaled, { sampleRate, startSeconds, framerateRatio: ratio });
    const { score, offset } = crossCorrelate(referenceSpeech, speech.samples, maxOffsetSamples, cache);
    const entry = {
      candidate: {
        scaleFactor: ratio,
        score,
        offset,
        inRange: Math.abs(offset) <= maxOffsetSamples,
      },
      speech,
      cues: scaled,
    };
    evaluated.set(ratio, entry);
    return entry;
  };

  const ratios = framerateCandidates(options.noFixFramerate ?? false);

  // Upstream only infers a ratio from signal length when the reference came
  // from subtitles — a VAD reference has no meaningful "number of frames".
  if (
    !options.noFixFramerate &&
    options.referenceNumFrames !== null &&
    options.referenceNumFrames !== undefined
  ) {
    const base = evaluate(1);
    if (base.speech.numFrames && base.speech.numFrames > 0) {
      const inferred = options.referenceNumFrames / base.speech.numFrames;
      if (Number.isFinite(inferred) && inferred > 0) ratios.push(inferred);
    }
  }

  if (options.gss && !options.noFixFramerate) {
    const gssCandidates: number[] = [];
    goldenSectionSearch(
      (ratio, isLastIteration) => {
        const entry = evaluate(ratio);
        if (isLastIteration) gssCandidates.push(ratio);
        return -entry.candidate.score;
      },
      MIN_FRAMERATE_RATIO,
      MAX_FRAMERATE_RATIO,
    );
    ratios.push(...gssCandidates);
  }

  const candidates: FramerateCandidate[] = [];
  for (const ratio of ratios) candidates.push(evaluate(ratio).candidate);

  // The twiddle table for a feature-length transform is ~16 MB, and the search
  // is the only thing that needs it. Hand it back before returning rather than
  // holding it for the life of the page on the chance of a second sync.
  releaseFftCache();

  const surviving = candidates.filter((c) => c.inRange);
  if (surviving.length === 0) {
    throw new FailedToFindAlignmentError(
      `Synchronization failed; no alignment was found within ${maxOffsetSeconds}s. ` +
        "Try allowing a larger offset.",
    );
  }

  let best = surviving[0];
  for (const candidate of surviving) {
    if (candidate.score > best.score) best = candidate;
  }
  const winner = evaluated.get(best.scaleFactor);
  if (!winner) throw new FailedToFindAlignmentError("Synchronization failed; no candidate survived.");

  return {
    scaleFactor: best.scaleFactor,
    offsetSamples: best.offset,
    score: best.score,
    speechSamples: winner.speech.speechSamples,
    candidates,
    bestSpeech: winner.speech,
    bestCues: winner.cues,
  };
};

/**
 * How much of a subtitle's speech lands on the reference's speech, and how much
 * of the reference is speech at all.
 *
 * Both arrays are at the same rate and already carry any framerate scaling and
 * offset, so this is a straight elementwise question.
 */
export const speechCoverage = (
  reference: ArrayLike<number>,
  subtitle: ArrayLike<number>,
): { coverage: number; density: number } => {
  let subtitleSpeech = 0;
  let covered = 0;
  const limit = Math.min(reference.length, subtitle.length);
  for (let i = 0; i < subtitle.length; i += 1) {
    if (subtitle[i] <= 0) continue;
    subtitleSpeech += 1;
    if (i < limit && reference[i] > 0) covered += 1;
  }
  let referenceSpeech = 0;
  for (let i = 0; i < reference.length; i += 1) if (reference[i] > 0) referenceSpeech += 1;
  return {
    coverage: subtitleSpeech === 0 ? 0 : covered / subtitleSpeech,
    density: reference.length === 0 ? 0 : referenceSpeech / reference.length,
  };
};

/**
 * A confidence figure that means the same thing on every file.
 *
 * ffsubsync reports the raw correlation peak, which is not comparable between
 * files: it grows with length, and because the correlation maps silence to -1
 * as well, most of it is silence agreeing with silence. Dividing it by anything
 * simple does not fix that — a sparse subtitle over a long film can score
 * several times its own speech mass.
 *
 * So this asks a different question, of the FINAL alignment rather than the
 * correlation: what fraction of the subtitle's speech lands on the reference's
 * speech, measured against what you would get by luck? Landing on speech at the
 * reference's own speech density is exactly chance, so:
 *
 *     (coverage - density) / (1 - density)
 *
 * is 1 for a perfect alignment, 0 for one no better than guessing, and negative
 * for one that is actively avoiding the speech. That is a skill score, and it
 * is comparable across a 20-minute episode and a 3-hour film.
 */
export const confidenceFromCoverage = (coverage: number, density: number): number => {
  if (density >= 1) return coverage >= 1 ? 1 : 0;
  return (coverage - density) / (1 - density);
};

export interface QualityThresholds {
  /** Reject a correlation this weak. See the caveat in the module header. */
  minConfidence?: number;
  /** Two candidates within this relative score are "tied" (see below). */
  minRunnerUpMargin?: number;
  /** How far apart two tied candidates must place a cue to count as ambiguous. */
  ambiguousDriftSeconds?: number;
  maxOffsetSeconds?: number;
  maxFramerateDeviation?: number;
}

export interface QualityInput {
  score: number;
  confidence: number;
  offsetSeconds: number;
  scaleFactor: number;
  candidates: FramerateCandidate[];
  /** Last cue end, in seconds — where two framerate hypotheses diverge most. */
  spanSeconds?: number;
  /**
   * The scale and offset the SINGLE-OFFSET search settled on.
   *
   * The ambiguity check below compares the winner against the other candidates
   * from that search, so it has to be told which of them won. After a piecewise
   * pass `scaleFactor` and `offsetSeconds` describe a different, per-cue result
   * — comparing those against the candidate list finds phantom ties (and misses
   * real ones). Defaults to `scaleFactor` / `offsetSeconds` when there was no
   * piecewise pass, which is the same thing.
   */
  searchScaleFactor?: number;
  searchOffsetSeconds?: number;
  /**
   * True when a piecewise pass produced the result.
   *
   * The framerate-ambiguity check below is then skipped, and only then. It asks
   * "could the single-offset search tell these two hypotheses apart?", and a
   * subtitle whose required offset CHANGES partway through is exactly the case
   * where it cannot: a steady stretch approximates a mid-file jump well enough
   * to tie with it. That tie is not evidence the answer is unsafe — the
   * piecewise pass re-scored every hypothesis under its own objective, chose
   * one, and the per-cue offsets are what actually ship. The remaining checks
   * (sign, confidence, magnitude, plausibility of the scale) still apply, and
   * confidence is measured on the shipped placement, so a genuinely bad
   * piecewise result is still caught.
   */
  piecewise?: boolean;
}

/**
 * ffsubsync's `assess_alignment_quality`, tightened.
 *
 * Upstream's gate is opt-in (`--skip-sync-on-low-quality`) and, because its
 * `min_score` default is 0.0 against an unnormalized score, is effectively a
 * SIGN TEST — it catches anti-correlated garbage and nothing else. A weak but
 * positive match still gets written out.
 *
 * Here the gate is always on and adds normalized checks, because a confidently
 * wrong sync is worse than no sync: the user would have to notice it, and then
 * undo it. The thresholds below are judgement calls, not upstream constants.
 * `minConfidence` is on the skill-score scale (see confidenceFromCoverage), so
 * 0.15 means "at least 15% of the way from pure luck to a perfect match" — a
 * deliberately permissive floor aimed at obvious noise, since a genuinely
 * correct sync scores far higher. These are the first things to revisit if real
 * content starts being refused.
 */
export const assessAlignmentQuality = (
  input: QualityInput,
  thresholds: QualityThresholds = {},
): string[] => {
  const minConfidence = thresholds.minConfidence ?? 0.15;
  const minRunnerUpMargin = thresholds.minRunnerUpMargin ?? 0.05;
  const ambiguousDriftSeconds = thresholds.ambiguousDriftSeconds ?? 0.5;
  const maxOffsetSeconds = thresholds.maxOffsetSeconds ?? 30;
  const maxFramerateDeviation = thresholds.maxFramerateDeviation ?? 0.1;

  const reasons: string[] = [];
  if (input.score < 0 || input.confidence < 0) {
    reasons.push("the subtitles line up worse than they would by chance");
  } else if (input.confidence < minConfidence) {
    reasons.push(
      `the match is weak (only ${(input.confidence * 100).toFixed(0)}% better than guessing)`,
    );
  }
  if (Math.abs(input.offsetSeconds) > maxOffsetSeconds) {
    reasons.push(
      `the shift of ${input.offsetSeconds.toFixed(1)}s is larger than the ${maxOffsetSeconds}s we trust`,
    );
  }
  if (Math.abs(input.scaleFactor - 1) > maxFramerateDeviation) {
    reasons.push(`the framerate correction of ${input.scaleFactor.toFixed(3)}x is implausible`);
  }

  // An ambiguous peak: a different framerate hypothesis scored nearly as well
  // AND would put the subtitles somewhere else.
  //
  // The second half of that is what makes the check worth having. Two ratios
  // routinely tie — over a short subtitle, 24/23.976 and 1.0 differ by less
  // than a cue's own duration, so nothing can separate them — but when they
  // tie they also AGREE, and applying either is fine. What must be caught is a
  // near-tie between candidates that disagree about where a line belongs.
  //
  // Divergence is measured at both ends of the subtitle, because a framerate
  // difference is invisible at t=0 and largest at the last cue.
  const span = input.spanSeconds ?? 0;
  const winnerScale = input.searchScaleFactor ?? input.scaleFactor;
  const winnerOffset = input.searchOffsetSeconds ?? input.offsetSeconds;
  if (input.score > 0 && !input.piecewise) {
    for (const other of input.candidates) {
      if (!other.inRange || other.scaleFactor === winnerScale) continue;
      const margin = (input.score - other.score) / Math.max(Math.abs(input.score), 1);
      if (margin >= minRunnerUpMargin) continue;
      const otherOffset = other.offset / SAMPLE_RATE;
      const driftAtStart = Math.abs(winnerOffset - otherOffset);
      const driftAtEnd = Math.abs(
        span * winnerScale + winnerOffset - (span * other.scaleFactor + otherOffset),
      );
      if (Math.max(driftAtStart, driftAtEnd) > ambiguousDriftSeconds) {
        reasons.push("two different framerates fit about equally well, but disagree by seconds");
        break;
      }
    }
  }

  return reasons;
};
