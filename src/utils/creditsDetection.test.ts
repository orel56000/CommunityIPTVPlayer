/**
 * Unit tests for the credits-detection scoring engine.
 *
 * Run with `npm test` — Node's built-in test runner strips the TypeScript
 * types, so this needs no test framework and no extra dependencies.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  CreditsSampleInput,
  CreditsSignals,
  CreditsSourceAvailability,
} from "../types/credits.ts";
import {
  DEFAULT_CREDITS_CONFIG,
  NO_SIGNALS,
  analysisWindowStart,
  canAnalyzeDuration,
  coefficientOfVariation,
  createAnalyzerState,
  dialogueStats,
  evaluateSignals,
  frameMetrics,
  isMusicMarkerCue,
  isWithinScanWindow,
  median,
  pushSample,
  resetDetection,
  resolveCreditsConfig,
  resolveMarkerCreditsStart,
  scoreSignals,
  type CreditsAnalyzerState,
} from "./creditsDetection.ts";

const config = DEFAULT_CREDITS_CONFIG;

const ALL_SOURCES: CreditsSourceAvailability = { visual: true, subtitles: true, audio: true };
const VISUAL_ONLY: CreditsSourceAvailability = { visual: true, subtitles: false, audio: false };
const NO_SOURCES: CreditsSourceAvailability = { visual: false, subtitles: false, audio: false };

const signals = (active: Partial<CreditsSignals>): CreditsSignals => ({ ...NO_SIGNALS, ...active });

/** Solid-colour RGBA frame at the given 0-255 grey level. */
const greyFrame = (level: number, pixels = 400): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let index = 0; index < pixels; index += 1) {
    data[index * 4] = level;
    data[index * 4 + 1] = level;
    data[index * 4 + 2] = level;
    data[index * 4 + 3] = 255;
  }
  return data;
};

const sampleInput = (overrides: Partial<CreditsSampleInput> = {}): CreditsSampleInput => ({
  mediaTime: 2500,
  duration: 2700,
  luma: 0.05,
  darkFraction: 0.9,
  motion: 0.005,
  audioLevel: 0.2,
  secondsSinceDialogue: 60,
  recentDialogueDensity: 0,
  priorDialogueDensity: 12,
  ...overrides,
});

describe("analysis window", () => {
  it("opens at the last scanLastPercent for a short episode", () => {
    // 22 min: 20% = 264s, well under the 900s cap.
    assert.equal(analysisWindowStart(1320, config), 1320 - 264);
  });

  it("never opens more than maximumRemainingSeconds before the end", () => {
    // 3 h: 20% would be 2160s, so the 900s cap applies.
    assert.equal(analysisWindowStart(10800, config), 10800 - 900);
  });

  it("closes again once minimumRemainingSeconds is left", () => {
    assert.equal(isWithinScanWindow(2695, 2700, config), false);
    assert.equal(isWithinScanWindow(2600, 2700, config), true);
    assert.equal(isWithinScanWindow(1000, 2700, config), false);
  });

  it("refuses live streams, missing durations and very short videos", () => {
    assert.equal(canAnalyzeDuration(2700, true, config), false);
    assert.equal(canAnalyzeDuration(Number.NaN, false, config), false);
    assert.equal(canAnalyzeDuration(Number.POSITIVE_INFINITY, false, config), false);
    assert.equal(canAnalyzeDuration(0, false, config), false);
    assert.equal(canAnalyzeDuration(120, false, config), false, "a 2-minute trailer is not analysed");
    assert.equal(canAnalyzeDuration(2700, false, config), true);
  });
});

describe("scoreSignals", () => {
  it("scores against the full weight set when every source is available", () => {
    const all = scoreSignals(
      signals({
        nearEnd: true,
        subtitleSilence: true,
        dialogueDrop: true,
        darkFrame: true,
        lowMotion: true,
        audioTransition: true,
        fadeToBlack: true,
      }),
      ALL_SOURCES,
      config,
    );
    assert.equal(all.score, 100);
    assert.equal(all.availableWeight, 100);
    assert.equal(all.usable, true);
  });

  it("normalises over available signals so a subtitle-less stream can still fire", () => {
    // This is the case that matters for IPTV: no subtitle track, no audio tap.
    // Against a fixed /100 denominator this would score 50 and never trigger.
    const breakdown = scoreSignals(
      signals({ nearEnd: true, darkFrame: true, lowMotion: true }),
      VISUAL_ONLY,
      config,
    );
    assert.equal(breakdown.availableWeight, 60, "nearEnd 20 + dark 15 + motion 15 + fade 10");
    assert.equal(breakdown.earnedWeight, 50);
    assert.equal(breakdown.score, 83);
    assert.ok(breakdown.score >= config.triggerScore);
    assert.equal(breakdown.usable, true);
  });

  it("ignores signals whose source is unavailable, even if they are set", () => {
    const breakdown = scoreSignals(
      signals({ nearEnd: true, subtitleSilence: true, dialogueDrop: true }),
      VISUAL_ONLY,
      config,
    );
    assert.equal(breakdown.earnedWeight, 20, "only nearEnd counts");
    assert.equal(breakdown.score, 33);
  });

  it("marks position-only measurement as unusable instead of scoring 100", () => {
    const breakdown = scoreSignals(signals({ nearEnd: true }), NO_SOURCES, config);
    assert.equal(breakdown.score, 100, "the raw ratio really is 100...");
    assert.equal(breakdown.usable, false, "...which is exactly why it must not be trusted");
  });

  it("treats a lone audio tap as too little to go on", () => {
    const audioOnly: CreditsSourceAvailability = { visual: false, subtitles: false, audio: true };
    // 20 + 10 = 30, below minimumAvailableWeight (45).
    assert.equal(scoreSignals(signals({ nearEnd: true }), audioOnly, config).usable, false);
  });
});

describe("frameMetrics", () => {
  it("reads mean luma and the dark-pixel fraction of a flat frame", () => {
    const metrics = frameMetrics(greyFrame(0), null, config.darkPixelLuma);
    assert.ok(metrics.luma < 0.001);
    assert.equal(metrics.darkFraction, 1);
    assert.equal(metrics.motion, null, "no previous frame means no motion score");
  });

  it("scores a bright frame as neither dark nor black", () => {
    const metrics = frameMetrics(greyFrame(230), null, config.darkPixelLuma);
    assert.ok(metrics.luma > 0.85);
    assert.equal(metrics.darkFraction, 0);
  });

  it("reports zero motion between identical frames and high motion between opposites", () => {
    const first = frameMetrics(greyFrame(120), null, config.darkPixelLuma);
    const still = frameMetrics(greyFrame(120), first.lumaMap, config.darkPixelLuma);
    // Float32 storage leaves a rounding crumb, orders below any real motion.
    assert.ok((still.motion ?? 1) < 1e-6);

    const cut = frameMetrics(greyFrame(255), first.lumaMap, config.darkPixelLuma);
    assert.ok((cut.motion ?? 0) > 0.5);
  });
});

describe("subtitle handling", () => {
  it("recognises sound-description cues as non-dialogue", () => {
    ["[music]", "[THEME MUSIC]", "(credits music)", "♪♪", "♪ la la la ♪", "  ", "[Music Playing]"].forEach((text) =>
      assert.equal(isMusicMarkerCue(text), true, text),
    );
  });

  it("keeps real dialogue, including bracketed speaker labels", () => {
    ["Hello there.", "[Mary] Get down!", "(whispering) run", "No."].forEach((text) =>
      assert.equal(isMusicMarkerCue(text), false, text),
    );
  });

  it("measures silence since the last dialogue cue and the density drop", () => {
    // Chatty until 2400s, then nothing.
    const starts = [2200, 2210, 2260, 2300, 2350, 2400];
    const stats = dialogueStats(starts, 2500, config);
    assert.equal(stats.secondsSinceDialogue, 100);
    assert.equal(stats.recentDensity, 0, "no cues in the last 60s");
    assert.ok((stats.priorDensity ?? 0) > 0);
  });

  it("returns nulls before the first cue, so the signal stays unavailable", () => {
    assert.deepEqual(dialogueStats([3000], 100, config), {
      secondsSinceDialogue: null,
      recentDensity: null,
      priorDensity: null,
    });
    assert.deepEqual(dialogueStats([], 100, config), {
      secondsSinceDialogue: null,
      recentDensity: null,
      priorDensity: null,
    });
  });
});

describe("evaluateSignals", () => {
  const withBaselines = (luma: number[], motion: number[]): CreditsAnalyzerState => ({
    ...createAnalyzerState(),
    baselineLumaSamples: luma,
    baselineMotionSamples: motion,
  });

  it("calls a frame dark when it drops far below this title's own baseline", () => {
    // 0.30 is not dark in absolute terms, but it is against a 0.8 baseline.
    const state = withBaselines([0.8, 0.8, 0.82, 0.78], []);
    const result = evaluateSignals(
      sampleInput({ luma: 0.3, darkFraction: 0.1, motion: null }),
      state,
      VISUAL_ONLY,
      config,
    );
    assert.equal(result.darkFrame, true);
  });

  it("does not call the same frame dark in a dimly graded title", () => {
    const state = withBaselines([0.34, 0.36, 0.33, 0.35], []);
    const result = evaluateSignals(
      sampleInput({ luma: 0.3, darkFraction: 0.1, motion: null }),
      state,
      VISUAL_ONLY,
      config,
    );
    assert.equal(result.darkFrame, false, "a dark drama's normal scene is not credits");
  });

  it("calls motion low relative to the title's baseline", () => {
    const state = withBaselines([], [0.2, 0.22, 0.19, 0.21]);
    assert.equal(
      evaluateSignals(sampleInput({ luma: null, motion: 0.08 }), state, VISUAL_ONLY, config).lowMotion,
      true,
    );
    assert.equal(
      evaluateSignals(sampleInput({ luma: null, motion: 0.18 }), state, VISUAL_ONLY, config).lowMotion,
      false,
    );
  });

  it("detects a fade to black from the recent luma history", () => {
    const state: CreditsAnalyzerState = { ...createAnalyzerState(), lumaHistory: [0.5, 0.4, 0.3, 0.2] };
    assert.equal(
      evaluateSignals(sampleInput({ luma: 0.06, darkFraction: 0.2, motion: null }), state, VISUAL_ONLY, config)
        .fadeToBlack,
      true,
    );
    // Already dark three samples ago — a dark scene, not a fade.
    const alreadyDark: CreditsAnalyzerState = { ...createAnalyzerState(), lumaHistory: [0.08, 0.07, 0.08, 0.07] };
    assert.equal(
      evaluateSignals(sampleInput({ luma: 0.06, darkFraction: 0.2, motion: null }), alreadyDark, VISUAL_ONLY, config)
        .fadeToBlack,
      false,
    );
  });

  it("reads a steady level as a music bed and a spiky one as speech", () => {
    const audioOnly: CreditsSourceAvailability = { visual: false, subtitles: false, audio: true };
    const steady: CreditsAnalyzerState = { ...createAnalyzerState(), audioHistory: [0.2, 0.21, 0.2, 0.19, 0.2] };
    assert.equal(evaluateSignals(sampleInput(), steady, audioOnly, config).audioTransition, true);

    const speech: CreditsAnalyzerState = { ...createAnalyzerState(), audioHistory: [0.02, 0.4, 0.05, 0.5, 0.01] };
    assert.equal(evaluateSignals(sampleInput(), speech, audioOnly, config).audioTransition, false);

    const silence: CreditsAnalyzerState = { ...createAnalyzerState(), audioHistory: [0.001, 0.001, 0.001, 0.001] };
    assert.equal(
      evaluateSignals(sampleInput({ audioLevel: 0.001 }), silence, audioOnly, config).audioTransition,
      false,
      "silence is not a music bed",
    );
  });

  it("leaves signals off when their source is unavailable", () => {
    const result = evaluateSignals(sampleInput(), createAnalyzerState(), NO_SOURCES, config);
    assert.equal(result.darkFrame, false);
    assert.equal(result.subtitleSilence, false);
    assert.equal(result.audioTransition, false);
    assert.equal(result.nearEnd, true, "position is always measurable");
  });
});

describe("pushSample state machine", () => {
  const run = (
    inputs: CreditsSampleInput[],
    availability: CreditsSourceAvailability = VISUAL_ONLY,
    startState: CreditsAnalyzerState = createAnalyzerState(),
  ) => {
    let state = startState;
    const outcomes = inputs.map((input) => {
      const outcome = pushSample(state, input, availability, config);
      state = outcome.state;
      return outcome;
    });
    return { state, outcomes };
  };

  const creditsSample = (mediaTime: number): CreditsSampleInput =>
    sampleInput({ mediaTime, luma: 0.04, darkFraction: 0.95, motion: 0.004 });

  const contentSample = (mediaTime: number): CreditsSampleInput =>
    sampleInput({ mediaTime, luma: 0.6, darkFraction: 0.05, motion: 0.25 });

  it("needs requiredConsecutiveSamples before firing", () => {
    const times = [2400, 2401.5, 2403, 2404.5];
    const { outcomes, state } = run(times.map(creditsSample));
    assert.deepEqual(
      outcomes.map((outcome) => outcome.fired),
      [false, false, false, true],
    );
    assert.equal(state.detectedAt, 2400, "reports the start of the run, not the confirming sample");
    assert.ok(state.confidence >= config.triggerScore);
  });

  it("reports the credits start, not the moment of confirmation", () => {
    const { state } = run([2400, 2401.5, 2403, 2404.5, 2406].map(creditsSample));
    assert.equal(state.detectedAt, 2400);
  });

  it("resets the streak when a sample falls short", () => {
    const { state, outcomes } = run([
      creditsSample(2400),
      creditsSample(2401.5),
      contentSample(2403),
      creditsSample(2404.5),
      creditsSample(2406),
    ]);
    assert.equal(
      outcomes.every((outcome) => !outcome.fired),
      true,
      "the interruption prevented a 4-sample run",
    );
    assert.equal(state.detectedAt, null);
    assert.equal(state.consecutive, 2);
  });

  it("does not fire from position alone when nothing else is measurable", () => {
    const { state } = run(
      [2400, 2401.5, 2403, 2404.5, 2406, 2407.5].map((time) =>
        sampleInput({ mediaTime: time, luma: null, darkFraction: null, motion: null, audioLevel: null }),
      ),
      NO_SOURCES,
    );
    assert.equal(state.detectedAt, null, "the fallback threshold is the caller's job, not a fake detection");
  });

  it("does not fire when too little of the video is left to be credits", () => {
    const nearlyOver = [2690, 2691.5, 2693, 2694.5].map((time) => ({
      ...creditsSample(time),
      duration: 2700,
    }));
    assert.equal(run(nearlyOver).state.detectedAt, null);
  });

  it("withdraws the suggestion when real content comes back (post-credit scene)", () => {
    const detected = run([2300, 2301.5, 2303, 2304.5].map(creditsSample));
    assert.equal(detected.state.detectedAt, 2300);

    const resumed = run([2400, 2401.5, 2403, 2404.5].map(contentSample), VISUAL_ONLY, detected.state);
    assert.equal(resumed.outcomes.at(-1)?.cleared, true);
    assert.equal(resumed.state.detectedAt, null);
    assert.equal(resumed.state.reason, "content-resumed");
  });

  it("only fires once for an uninterrupted run of credits", () => {
    const { outcomes } = run([2400, 2401.5, 2403, 2404.5, 2406, 2407.5, 2409].map(creditsSample));
    assert.equal(outcomes.filter((outcome) => outcome.fired).length, 1);
  });

  it("builds baselines from at most baselineSamples frames", () => {
    const many = Array.from({ length: 30 }, (_, index) => contentSample(2200 + index));
    const { state } = run(many);
    assert.equal(state.baselineLumaSamples.length, config.baselineSamples);
  });

  it("keeps baselines but clears the detection on reset", () => {
    const { state } = run([2400, 2401.5, 2403, 2404.5].map(creditsSample));
    const reset = resetDetection(state);
    assert.equal(reset.detectedAt, null);
    assert.equal(reset.consecutive, 0);
    assert.deepEqual(reset.baselineLumaSamples, state.baselineLumaSamples, "a seek does not invalidate the baseline");
  });
});

describe("marker priority", () => {
  const duration = 2700;

  it("prefers manual over backend over learned", () => {
    assert.deepEqual(
      resolveMarkerCreditsStart(
        { manual: { creditsStart: 2400 }, backend: { creditsStart: 2450 }, learned: { creditsStart: 2500 } },
        duration,
      ),
      { at: 2400, source: "manual" },
    );
    assert.deepEqual(
      resolveMarkerCreditsStart({ backend: { creditsStart: 2450 }, learned: { creditsStart: 2500 } }, duration),
      { at: 2450, source: "backend" },
    );
    assert.deepEqual(resolveMarkerCreditsStart({ learned: { creditsStart: 2500 } }, duration), {
      at: 2500,
      source: "learned",
    });
  });

  it("falls through to the heuristic when there is no marker", () => {
    assert.equal(resolveMarkerCreditsStart({}, duration), null);
    assert.equal(resolveMarkerCreditsStart({ manual: null, backend: undefined }, duration), null);
    assert.equal(resolveMarkerCreditsStart({ manual: { introEnd: 90 } }, duration), null);
  });

  it("rejects markers that cannot be credits", () => {
    assert.equal(resolveMarkerCreditsStart({ manual: { creditsStart: 0 } }, duration), null);
    assert.equal(resolveMarkerCreditsStart({ manual: { creditsStart: -5 } }, duration), null);
    assert.equal(resolveMarkerCreditsStart({ manual: { creditsStart: 3000 } }, duration), null, "past the end");
    assert.equal(resolveMarkerCreditsStart({ manual: { creditsStart: 600 } }, duration), null, "first half");
    assert.equal(resolveMarkerCreditsStart({ manual: { creditsStart: 2400 } }, 0), null, "unknown duration");
  });

  it("skips an invalid higher-priority marker in favour of a valid lower one", () => {
    assert.deepEqual(
      resolveMarkerCreditsStart({ manual: { creditsStart: 10 }, backend: { creditsStart: 2450 } }, duration),
      { at: 2450, source: "backend" },
    );
  });
});

describe("helpers", () => {
  it("takes a median that ignores outliers", () => {
    assert.equal(median([0.5, 0.5, 0.5, 9]), 0.5);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([]), null);
  });

  it("computes a scale-free variation, and refuses to on too little data", () => {
    assert.equal(coefficientOfVariation([1, 1]), null);
    assert.equal(coefficientOfVariation([0, 0, 0]), null);
    const steady = coefficientOfVariation([0.2, 0.2, 0.21, 0.2]) ?? 1;
    const spiky = coefficientOfVariation([0.02, 0.5, 0.03, 0.6]) ?? 0;
    assert.ok(steady < 0.1);
    assert.ok(spiky > 0.5);
  });

  it("merges partial config overrides onto the defaults", () => {
    const merged = resolveCreditsConfig({ triggerScore: 55 });
    assert.equal(merged.triggerScore, 55);
    assert.equal(merged.sampleIntervalMs, DEFAULT_CREDITS_CONFIG.sampleIntervalMs);
    assert.deepEqual(resolveCreditsConfig(null), DEFAULT_CREDITS_CONFIG);
  });
});
