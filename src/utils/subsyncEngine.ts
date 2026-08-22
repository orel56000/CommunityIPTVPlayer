/**
 * The part of the sync that both engines share.
 *
 * Given a reference speech signal at 100 Hz and the subtitle cues, this runs
 * ffsubsync's framerate search, its optional piecewise pass, and the quality
 * gate, then applies the answer to the cues. It knows nothing about ffmpeg,
 * workers or the relay — which is the point: the browser engine and the native
 * engine's fallback path run THIS code, so the two cannot drift apart.
 *
 * (The one case that does not come through here is a real ffsubsync install on
 * the native side. That is the original implementation rather than a port, so
 * it is authoritative by definition — see subtitleSync.ts.)
 *
 * Pure and DOM-free; unit-tested in subsyncEngine.test.ts.
 */

import {
  FailedToFindAlignmentError,
  assessAlignmentQuality,
  confidenceFromCoverage,
  searchFramerate,
  speechCoverage,
  type QualityThresholds,
} from "./subsyncAlign.ts";
import {
  SAMPLE_RATE,
  cuesToSpeech,
  preprocessCues,
  preprocessedIndices,
} from "./subsyncSpeech.ts";
import { computeSplitOffsets, medianOffset } from "./subsyncSplit.ts";
import type { SubtitleCue } from "./subtitles.ts";
import type { SubtitleSyncReference, SubtitleSyncResult } from "../types/subtitleSync.ts";

export interface AlignOptions {
  startSeconds?: number;
  maxOffsetSeconds?: number;
  noFixFramerate?: boolean;
  gss?: boolean;
  splitPenaltySeconds?: number | null;
  splitLengthPenalty?: number;
  splitSubsample?: number;
  /** Set when the reference is itself a subtitle track; enables ffsubsync's
   *  length-inferred framerate ratio, which is meaningless for a VAD signal. */
  referenceNumFrames?: number | null;
  quality?: QualityThresholds;
}

/**
 * Apply a framerate scale and a shift to cues, in that order.
 *
 * The order is not cosmetic: `t * scale + offset` and `(t + offset) * scale`
 * differ everywhere except t = 0, so shifting first silently ruins every
 * result where a framerate candidate other than 1.0 won.
 *
 * ffsubsync writes cues with negative timestamps straight into the file, where
 * they become malformed SRT. We can't — our sink is a VTTCue, which rejects
 * them — so cues pushed entirely before zero are dropped and a straddling cue
 * is clamped, matching what this app's own `shiftCues` has always done.
 */
export const applySync = (
  cues: readonly SubtitleCue[],
  scaleFactor: number,
  offsetSeconds: number,
  perCueOffsetsSeconds?: readonly number[] | null,
): SubtitleCue[] => {
  const out: SubtitleCue[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const shift = perCueOffsetsSeconds ? (perCueOffsetsSeconds[i] ?? offsetSeconds) : offsetSeconds;
    const start = cue.start * scaleFactor + shift;
    const end = cue.end * scaleFactor + shift;
    // A cue with an unusable timestamp was already excluded from the alignment
    // (see preprocessCues) and must not be shipped with an invented one. NaN
    // fails every comparison, so it has to be tested for rather than fall out
    // of the `end <= 0` check below — and a VTTCue built from one throws.
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= 0) continue;
    out.push({ ...cue, start: Math.max(0, start), end });
  }
  return out;
};

export interface AlignmentOutcome {
  scaleFactor: number;
  offsetSeconds: number;
  score: number;
  confidence: number;
  perCueOffsetsSeconds: number[] | null;
  segments: { cueCount: number; offsetSeconds: number }[] | null;
  qualityReasons: string[];
}

/**
 * ffsubsync's `try_sync`, minus the file I/O.
 *
 * The piecewise pass, when asked for, deliberately re-scores EVERY framerate
 * candidate under its own objective rather than inheriting the one the global
 * search picked — upstream does the same, because the two objectives can
 * legitimately disagree about which scale fits best.
 */
export const alignCues = (
  referenceSpeech: ArrayLike<number>,
  cues: readonly SubtitleCue[],
  options: AlignOptions = {},
): AlignmentOutcome => {
  const startSeconds = options.startSeconds ?? 0;
  const prepared = preprocessCues(cues, { startSeconds });
  if (prepared.length === 0) {
    throw new FailedToFindAlignmentError("These subtitles have no lines to align.");
  }
  // Which input cue each prepared cue came from. `preprocessCues` drops cues
  // (anything starting before `startSeconds`, or with unusable timings), so the
  // two lists are NOT parallel — and the piecewise pass produces one offset per
  // PREPARED cue while the caller applies them to the original list. Without
  // this mapping every cue after a dropped one silently takes its neighbour's
  // offset. Upstream cannot hit this: it shifts the same preprocessed list it
  // aligned, and raises on a length mismatch.
  const preparedFrom = preprocessedIndices(cues, { startSeconds });

  const search = searchFramerate(referenceSpeech, prepared, {
    startSeconds,
    maxOffsetSeconds: options.maxOffsetSeconds,
    noFixFramerate: options.noFixFramerate,
    gss: options.gss,
    referenceNumFrames: options.referenceNumFrames,
  });

  let scaleFactor = search.scaleFactor;
  let offsetSeconds = search.offsetSamples / SAMPLE_RATE;
  let perCueOffsetsSeconds: number[] | null = null;
  let segments: { cueCount: number; offsetSeconds: number }[] | null = null;

  const splitPenaltySeconds = options.splitPenaltySeconds;
  if (splitPenaltySeconds !== null && splitPenaltySeconds !== undefined) {
    const maxOffsetSamples = Math.abs(
      Math.trunc((options.maxOffsetSeconds ?? 60) * SAMPLE_RATE),
    );
    const subsample = Math.max(1, Math.trunc(options.splitSubsample ?? 1));
    let best: { score: number; offsets: number[]; scaleFactor: number; segments: ReturnType<typeof computeSplitOffsets>["segments"] } | null = null;

    // Every candidate the global search already rasterized is re-scored here.
    for (const candidate of search.candidates) {
      if (!candidate.inRange) continue;
      const scaled =
        candidate.scaleFactor === search.scaleFactor
          ? search.bestCues
          : prepared.map((cue) => ({
              ...cue,
              start: cue.start * candidate.scaleFactor,
              end: cue.end * candidate.scaleFactor,
            }));
      const result = computeSplitOffsets(referenceSpeech, scaled, {
        startSeconds,
        splitPenalty: splitPenaltySeconds * SAMPLE_RATE,
        lengthPenalty: options.splitLengthPenalty ?? 0.25,
        offsetStepSamples: 1 / subsample,
        maxOffsetSamples,
      });
      if (!best || result.score > best.score) {
        best = {
          score: result.score,
          offsets: result.offsets,
          scaleFactor: candidate.scaleFactor,
          segments: result.segments,
        };
      }
    }

    if (best) {
      scaleFactor = best.scaleFactor;
      const preparedOffsets = best.offsets.map((samples) => samples / SAMPLE_RATE);
      // Reported only. A piecewise sync has no single applicable shift, so this
      // number exists to put something honest on the status line.
      offsetSeconds = medianOffset(preparedOffsets);
      // Scatter back into the caller's index space. A cue that preprocessing
      // dropped never got an offset of its own; the median is the least-wrong
      // thing to give it, and it is what the caller would have used anyway.
      const scattered = new Array<number>(cues.length).fill(offsetSeconds);
      preparedFrom.forEach((source, index) => {
        scattered[source] = preparedOffsets[index];
      });
      perCueOffsetsSeconds = scattered;
      segments = best.segments.map((segment) => ({
        cueCount: segment.cueCount,
        offsetSeconds: segment.offsetSamples / SAMPLE_RATE,
      }));
    }
  }

  // Confidence is measured on the FINAL cues rather than on the correlation, so
  // the piecewise and single-offset paths are judged the same way and the
  // number answers the question a person would actually ask: after applying
  // this, do the lines land where people are speaking?
  //
  // Measured on the cues that will actually SHIP — the caller's list with the
  // caller's offsets — not on the prepared copy. Scoring one placement and
  // shipping another is how a corrupted result comes back with a confidence
  // of 1.
  const finalCues = applySync(cues, scaleFactor, offsetSeconds, perCueOffsetsSeconds);
  const finalSpeech = cuesToSpeech(finalCues, { startSeconds });
  const { coverage, density } = speechCoverage(referenceSpeech, finalSpeech.samples);
  const confidence = confidenceFromCoverage(coverage, density);
  const qualityReasons = assessAlignmentQuality(
    {
      score: search.score,
      confidence,
      offsetSeconds,
      scaleFactor,
      candidates: search.candidates,
      // Where competing framerate hypotheses diverge most.
      spanSeconds: prepared.length > 0 ? prepared[prepared.length - 1].end : 0,
      // The framerate ambiguity check compares candidates from the SINGLE-offset
      // search, so it must be told which scale that search picked. After a
      // piecewise pass `scaleFactor` may be a different one, and comparing the
      // winner against itself under a different label reports a phantom tie.
      searchScaleFactor: search.scaleFactor,
      searchOffsetSeconds: search.offsetSamples / SAMPLE_RATE,
      piecewise: perCueOffsetsSeconds !== null,
    },
    options.quality,
  );

  return {
    scaleFactor,
    offsetSeconds,
    score: search.score,
    confidence,
    perCueOffsetsSeconds,
    segments,
    qualityReasons,
  };
};

/**
 * Run the alignment and package it the way the player expects.
 *
 * A rejected alignment still returns a result — with `applied: false`, the
 * ORIGINAL cues, and the reasons — rather than throwing. The UI needs to say
 * "couldn't find a confident match, here is why" without a try/catch, and the
 * distinction between "we looked and weren't convinced" and "something broke"
 * is worth keeping in the type rather than in an exception message.
 */
export const runAlignment = (
  referenceSpeech: ArrayLike<number>,
  cues: readonly SubtitleCue[],
  reference: SubtitleSyncReference,
  processingMode: "native" | "web",
  engine: SubtitleSyncResult["engine"],
  options: AlignOptions = {},
): SubtitleSyncResult => {
  const outcome = alignCues(referenceSpeech, cues, options);
  const rejected = outcome.qualityReasons.length > 0;
  return {
    subtitles: rejected
      ? cues.slice()
      : applySync(cues, outcome.scaleFactor, outcome.offsetSeconds, outcome.perCueOffsetsSeconds),
    offsetMs: outcome.offsetSeconds * 1000,
    confidence: outcome.confidence,
    processingMode,
    engine,
    reference,
    framerateScaleFactor: outcome.scaleFactor,
    score: outcome.score,
    perCueOffsetsMs: outcome.perCueOffsetsSeconds?.map((seconds) => seconds * 1000) ?? null,
    segments: outcome.segments?.map((segment) => ({
      cueCount: segment.cueCount,
      offsetMs: segment.offsetSeconds * 1000,
    })),
    qualityReasons: outcome.qualityReasons,
    applied: !rejected,
  };
};
