/**
 * Pure scoring engine for end-credits detection.
 *
 * Nothing here touches the DOM: it takes plain numbers (brightness, motion,
 * audio level, subtitle timings) and returns signals, a score and a small state
 * machine. `useCreditsDetection` does the measuring; this file does the
 * deciding, which is why it is the part that has unit tests.
 *
 * Two deliberate departures from a naive weighted sum:
 *
 * 1. The score is normalised over the signals that are actually MEASURABLE for
 *    this stream. Most IPTV VOD has no subtitle track and no Web Audio tap, so
 *    a fixed /100 denominator could never reach the threshold and the detector
 *    would be dead code. See `scoreSignals`.
 * 2. Brightness and motion are compared against a per-title baseline taken from
 *    the start of the scan window, not against absolute constants. Credits are
 *    "much darker and stiller than THIS show", which survives a dark-graded
 *    drama and a bright sitcom alike.
 */

import type {
  CreditsDetectionConfig,
  CreditsDetectionSource,
  CreditsSampleInput,
  CreditsScoreBreakdown,
  CreditsSignalName,
  CreditsSignalWeights,
  CreditsSignals,
  CreditsSourceAvailability,
  VideoMarkers,
} from "../types/credits";

export const DEFAULT_CREDITS_WEIGHTS: CreditsSignalWeights = {
  nearEnd: 20,
  subtitleSilence: 20,
  dialogueDrop: 10,
  darkFrame: 15,
  lowMotion: 15,
  audioTransition: 10,
  fadeToBlack: 10,
};

/** Which measurement source each signal needs. */
const SIGNAL_SOURCE: Record<CreditsSignalName, keyof CreditsSourceAvailability | "always"> = {
  nearEnd: "always",
  subtitleSilence: "subtitles",
  dialogueDrop: "subtitles",
  darkFrame: "visual",
  lowMotion: "visual",
  audioTransition: "audio",
  fadeToBlack: "visual",
};

export const DEFAULT_CREDITS_CONFIG: CreditsDetectionConfig = {
  enabled: true,
  scanLastPercent: 0.2,
  minimumRemainingSeconds: 20,
  maximumRemainingSeconds: 900,
  minimumDurationSeconds: 600,
  triggerScore: 70,
  requiredConsecutiveSamples: 4,
  sampleIntervalMs: 1500,
  minimumCreditsDurationSeconds: 20,
  minimumAvailableWeight: 45,
  baselineSamples: 12,
  darkPixelLuma: 0.18,
  darkFrameFraction: 0.55,
  darkFrameBaselineRatio: 0.45,
  absoluteDarkLuma: 0.14,
  lowMotionAbsolute: 0.035,
  lowMotionBaselineRatio: 0.5,
  fadeLumaCeiling: 0.12,
  fadeDropRatio: 0.5,
  dialogueSilenceSeconds: 25,
  dialogueRecentWindowSeconds: 60,
  dialoguePriorWindowSeconds: 180,
  dialogueDropRatio: 0.35,
  audioSteadyVariation: 0.22,
  audioMinimumLevel: 0.02,
  clearSamplesToHide: 4,
  fallbackRemainingSeconds: 45,
  debug: false,
};

export const NO_SIGNALS: CreditsSignals = {
  nearEnd: false,
  subtitleSilence: false,
  dialogueDrop: false,
  darkFrame: false,
  lowMotion: false,
  audioTransition: false,
  fadeToBlack: false,
};

export const resolveCreditsConfig = (
  overrides?: Partial<CreditsDetectionConfig> | null,
): CreditsDetectionConfig => ({ ...DEFAULT_CREDITS_CONFIG, ...(overrides ?? {}) });

/* ------------------------------------------------------------------ math -- */

export const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/** Standard deviation divided by the mean — scale-free "how jumpy is this". */
export const coefficientOfVariation = (values: readonly number[]): number | null => {
  if (values.length < 3) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0.00001) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
};

/* ------------------------------------------------------- analysis window -- */

/**
 * Media time at which analysis may begin: the last `scanLastPercent` of the
 * video, but never more than `maximumRemainingSeconds` before the end.
 */
export const analysisWindowStart = (duration: number, config: CreditsDetectionConfig): number => {
  if (!Number.isFinite(duration) || duration <= 0) return Number.POSITIVE_INFINITY;
  const fromPercent = duration * config.scanLastPercent;
  return duration - Math.min(fromPercent, config.maximumRemainingSeconds);
};

/** True when the heuristic may run at all for this stream. */
export const canAnalyzeDuration = (duration: number, isLive: boolean, config: CreditsDetectionConfig): boolean => {
  if (isLive) return false;
  if (!Number.isFinite(duration) || duration <= 0) return false;
  return duration >= config.minimumDurationSeconds;
};

export const isWithinScanWindow = (
  mediaTime: number,
  duration: number,
  config: CreditsDetectionConfig,
): boolean => {
  if (!Number.isFinite(duration) || duration <= 0) return false;
  const remaining = duration - mediaTime;
  if (remaining < config.minimumRemainingSeconds) return false;
  return mediaTime >= analysisWindowStart(duration, config);
};

/* --------------------------------------------------------- frame metrics -- */

/**
 * Reduce one RGBA frame to mean luma, dark-pixel fraction, and (given the
 * previous frame's per-pixel luma) a motion score. Sub-sampling every 4th pixel
 * keeps a 160x90 frame at ~3.6k samples, which is plenty and costs nothing.
 */
export const frameMetrics = (
  pixels: Uint8ClampedArray,
  previousLuma: Float32Array | null,
  darkPixelLuma: number,
): { luma: number; darkFraction: number; motion: number | null; lumaMap: Float32Array } => {
  const step = 4 * 4; // every 4th pixel
  const count = Math.floor(pixels.length / step);
  const lumaMap = new Float32Array(count);
  let total = 0;
  let dark = 0;
  let motionTotal = 0;
  const canCompareMotion = previousLuma != null && previousLuma.length === count;

  for (let index = 0; index < count; index += 1) {
    const offset = index * step;
    // Rec. 601 luma, normalised to 0-1.
    const luma =
      (0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2]) / 255;
    lumaMap[index] = luma;
    total += luma;
    if (luma <= darkPixelLuma) dark += 1;
    if (canCompareMotion) motionTotal += Math.abs(luma - previousLuma[index]);
  }

  return {
    luma: count > 0 ? total / count : 0,
    darkFraction: count > 0 ? dark / count : 0,
    motion: canCompareMotion && count > 0 ? motionTotal / count : null,
    lumaMap,
  };
};

/* ------------------------------------------------------------- subtitles -- */

/**
 * Cues that are pure sound description ("[music]", "♪♪", "(theme music)") are
 * not dialogue. Treating them as silence is what lets a captioned stream detect
 * credits at all — the track keeps emitting cues, but nobody is talking.
 */
export const isMusicMarkerCue = (text: string): boolean => {
  const stripped = text
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return true;
  if (/^[♪♫\s.·-]+$/.test(stripped)) return true;
  const inner = stripped.replace(/^[[(]|[\])]$/g, "").trim();
  const bracketed = /^[[(].*[\])]$/.test(stripped);
  if (bracketed && /\b(music|theme|song|singing|instrumental|credits|score)\b/i.test(inner)) return true;
  return /^[♪♫]/.test(stripped) && /[♪♫]$/.test(stripped);
};

export interface DialogueCue {
  startTime: number;
  endTime: number;
  text: string;
}

export interface DialogueStats {
  secondsSinceDialogue: number | null;
  recentDensity: number | null;
  priorDensity: number | null;
}

/**
 * Dialogue activity around `mediaTime`, from an ascending list of cue start
 * times (music-only cues already filtered out by the caller).
 */
export const dialogueStats = (
  dialogueStartTimes: readonly number[],
  mediaTime: number,
  config: CreditsDetectionConfig,
): DialogueStats => {
  if (dialogueStartTimes.length === 0) {
    return { secondsSinceDialogue: null, recentDensity: null, priorDensity: null };
  }

  let lastBefore: number | null = null;
  let recent = 0;
  let prior = 0;
  const recentFrom = mediaTime - config.dialogueRecentWindowSeconds;
  const priorFrom = recentFrom - config.dialoguePriorWindowSeconds;

  for (const start of dialogueStartTimes) {
    if (start > mediaTime) break;
    lastBefore = start;
    if (start >= recentFrom) recent += 1;
    else if (start >= priorFrom) prior += 1;
  }

  // Before the first cue there is no "silence since" to speak of.
  if (lastBefore == null) return { secondsSinceDialogue: null, recentDensity: null, priorDensity: null };

  const priorSpan = Math.min(config.dialoguePriorWindowSeconds, Math.max(0, recentFrom - priorFrom));
  return {
    secondsSinceDialogue: Math.max(0, mediaTime - lastBefore),
    recentDensity: (recent / config.dialogueRecentWindowSeconds) * 60,
    priorDensity: priorSpan > 0 ? (prior / priorSpan) * 60 : null,
  };
};

/* ----------------------------------------------------------------- score -- */

/**
 * Normalise earned weight over AVAILABLE weight, so a stream with no subtitles
 * and no audio tap can still reach the trigger score on visual evidence alone.
 *
 * `usable` guards the degenerate case: if the only available signal is
 * `nearEnd`, the score would be a meaningless 100 the moment the scan window
 * opens. The caller falls back to a plain end-of-video threshold instead.
 */
export const scoreSignals = (
  signals: CreditsSignals,
  availability: CreditsSourceAvailability,
  config: CreditsDetectionConfig,
  weights: CreditsSignalWeights = DEFAULT_CREDITS_WEIGHTS,
): CreditsScoreBreakdown => {
  let availableWeight = 0;
  let earnedWeight = 0;

  (Object.keys(weights) as CreditsSignalName[]).forEach((name) => {
    const source = SIGNAL_SOURCE[name];
    const available = source === "always" || availability[source];
    if (!available) return;
    availableWeight += weights[name];
    if (signals[name]) earnedWeight += weights[name];
  });

  const hasEvidenceSource = availability.visual || availability.subtitles || availability.audio;
  return {
    score: availableWeight > 0 ? Math.round((earnedWeight / availableWeight) * 100) : 0,
    earnedWeight,
    availableWeight,
    usable: hasEvidenceSource && availableWeight >= config.minimumAvailableWeight,
  };
};

/* --------------------------------------------------------- state machine -- */

export interface CreditsAnalyzerState {
  /** Brightness/motion baselines collected at the start of the scan window. */
  baselineLumaSamples: number[];
  baselineMotionSamples: number[];
  lumaHistory: number[];
  audioHistory: number[];
  consecutive: number;
  /** Consecutive clearly-not-credits samples seen since a detection fired. */
  consecutiveClear: number;
  runStartTime: number | null;
  runScoreTotal: number;
  detectedAt: number | null;
  confidence: number;
  lastScore: number;
  lastSignals: CreditsSignals;
  reason: string | null;
}

const LUMA_HISTORY_LENGTH = 8;
const AUDIO_HISTORY_LENGTH = 10;
/** How far back `fadeToBlack` looks — 3 samples ≈ 4.5s at the default interval. */
const FADE_LOOKBACK = 3;

export const createAnalyzerState = (): CreditsAnalyzerState => ({
  baselineLumaSamples: [],
  baselineMotionSamples: [],
  lumaHistory: [],
  audioHistory: [],
  consecutive: 0,
  consecutiveClear: 0,
  runStartTime: null,
  runScoreTotal: 0,
  detectedAt: null,
  confidence: 0,
  lastScore: 0,
  lastSignals: { ...NO_SIGNALS },
  reason: null,
});

export const baselineLuma = (state: CreditsAnalyzerState, config: CreditsDetectionConfig): number | null =>
  state.baselineLumaSamples.length >= Math.min(4, config.baselineSamples)
    ? median(state.baselineLumaSamples)
    : null;

export const baselineMotion = (state: CreditsAnalyzerState, config: CreditsDetectionConfig): number | null =>
  state.baselineMotionSamples.length >= Math.min(4, config.baselineSamples)
    ? median(state.baselineMotionSamples)
    : null;

/** Derive the seven boolean signals for one sample. */
export const evaluateSignals = (
  input: CreditsSampleInput,
  state: CreditsAnalyzerState,
  availability: CreditsSourceAvailability,
  config: CreditsDetectionConfig,
): CreditsSignals => {
  const signals: CreditsSignals = { ...NO_SIGNALS };
  signals.nearEnd = isWithinScanWindow(input.mediaTime, input.duration, config);

  if (availability.visual) {
    const refLuma = baselineLuma(state, config);
    const refMotion = baselineMotion(state, config);

    if (input.luma != null) {
      const darkByFraction = (input.darkFraction ?? 0) >= config.darkFrameFraction;
      const darkByAbsolute = input.luma <= config.absoluteDarkLuma;
      const darkByBaseline = refLuma != null && input.luma <= refLuma * config.darkFrameBaselineRatio;
      signals.darkFrame = darkByFraction || darkByAbsolute || darkByBaseline;

      const past = state.lumaHistory[state.lumaHistory.length - FADE_LOOKBACK];
      signals.fadeToBlack =
        past != null && input.luma <= config.fadeLumaCeiling && input.luma <= past * config.fadeDropRatio;
    }

    if (input.motion != null) {
      signals.lowMotion =
        input.motion <= config.lowMotionAbsolute ||
        (refMotion != null && input.motion <= refMotion * config.lowMotionBaselineRatio);
    }
  }

  if (availability.subtitles) {
    signals.subtitleSilence =
      input.secondsSinceDialogue != null && input.secondsSinceDialogue >= config.dialogueSilenceSeconds;
    signals.dialogueDrop =
      input.recentDialogueDensity != null &&
      input.priorDialogueDensity != null &&
      input.priorDialogueDensity > 0 &&
      input.recentDialogueDensity <= input.priorDialogueDensity * config.dialogueDropRatio;
  }

  if (availability.audio && input.audioLevel != null) {
    const history = [...state.audioHistory, input.audioLevel].slice(-AUDIO_HISTORY_LENGTH);
    const variation = coefficientOfVariation(history);
    const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
    // Speech is spiky (pauses between words); a music bed sits at a steady level.
    signals.audioTransition =
      variation != null && variation <= config.audioSteadyVariation && mean >= config.audioMinimumLevel;
  }

  return signals;
};

export interface PushSampleOutcome {
  state: CreditsAnalyzerState;
  signals: CreditsSignals;
  breakdown: CreditsScoreBreakdown;
  /** True on the sample where detection fired. */
  fired: boolean;
  /** True on the sample where an active suggestion was withdrawn. */
  cleared: boolean;
}

/**
 * Feed one sample through the machine. Returns a fresh state — callers keep it
 * in a ref and never mutate it in place, so React renders stay honest.
 */
export const pushSample = (
  state: CreditsAnalyzerState,
  input: CreditsSampleInput,
  availability: CreditsSourceAvailability,
  config: CreditsDetectionConfig,
): PushSampleOutcome => {
  const next: CreditsAnalyzerState = { ...state };
  const signals = evaluateSignals(input, state, availability, config);
  const breakdown = scoreSignals(signals, availability, config);

  // Baselines come from the first samples of the scan window, before credits
  // can plausibly have started. Median, so one dark shot doesn't poison them.
  if (input.luma != null && next.baselineLumaSamples.length < config.baselineSamples) {
    next.baselineLumaSamples = [...next.baselineLumaSamples, input.luma];
  }
  if (input.motion != null && next.baselineMotionSamples.length < config.baselineSamples) {
    next.baselineMotionSamples = [...next.baselineMotionSamples, input.motion];
  }
  if (input.luma != null) {
    next.lumaHistory = [...next.lumaHistory, input.luma].slice(-LUMA_HISTORY_LENGTH);
  }
  if (input.audioLevel != null) {
    next.audioHistory = [...next.audioHistory, input.audioLevel].slice(-AUDIO_HISTORY_LENGTH);
  }

  next.lastScore = breakdown.score;
  next.lastSignals = signals;

  const remaining = input.duration - input.mediaTime;
  const qualifies =
    breakdown.usable &&
    breakdown.score >= config.triggerScore &&
    remaining >= config.minimumCreditsDurationSeconds;

  let fired = false;
  let cleared = false;

  if (qualifies) {
    next.consecutive = state.consecutive + 1;
    next.consecutiveClear = 0;
    next.runStartTime = state.consecutive === 0 ? input.mediaTime : state.runStartTime;
    next.runScoreTotal = (state.consecutive === 0 ? 0 : state.runScoreTotal) + breakdown.score;

    if (next.detectedAt == null && next.consecutive >= config.requiredConsecutiveSamples) {
      // Report the START of the qualifying run, not the sample that confirmed
      // it — that is where the credits actually began.
      next.detectedAt = next.runStartTime ?? input.mediaTime;
      next.confidence = Math.round(next.runScoreTotal / next.consecutive);
      next.reason = describeReason(signals, availability);
      fired = true;
    }
  } else {
    next.consecutive = 0;
    next.runStartTime = null;
    next.runScoreTotal = 0;
    // A firmly non-credits stretch after a detection means real content came
    // back — a post-credit scene, or an anime's next-episode preview.
    if (next.detectedAt != null && breakdown.usable && breakdown.score < config.triggerScore * 0.6) {
      next.consecutiveClear = state.consecutiveClear + 1;
      if (next.consecutiveClear >= config.clearSamplesToHide) {
        next.detectedAt = null;
        next.confidence = 0;
        next.consecutiveClear = 0;
        next.reason = "content-resumed";
        cleared = true;
      }
    }
  }

  return { state: next, signals, breakdown, fired, cleared };
};

const describeReason = (signals: CreditsSignals, availability: CreditsSourceAvailability): string => {
  const active = (Object.keys(signals) as CreditsSignalName[]).filter((name) => signals[name]);
  const sources = [
    availability.visual ? "visual" : null,
    availability.subtitles ? "subtitles" : null,
    availability.audio ? "audio" : null,
  ].filter(Boolean);
  return `${active.join("+") || "none"} via ${sources.join("/") || "position-only"}`;
};

/** Forget everything except the baselines, which stay valid across a seek. */
export const resetDetection = (state: CreditsAnalyzerState): CreditsAnalyzerState => ({
  ...state,
  lumaHistory: [],
  audioHistory: [],
  consecutive: 0,
  consecutiveClear: 0,
  runStartTime: null,
  runScoreTotal: 0,
  detectedAt: null,
  confidence: 0,
  reason: null,
});

/* --------------------------------------------------------------- markers -- */

export interface CreditsMarkerSources {
  /** Set by hand / by the user for this exact title. */
  manual?: VideoMarkers | null;
  /** Supplied by the playlist or a backend for this exact title. */
  backend?: VideoMarkers | null;
  /** Aggregated from this device's own past behaviour on the same series. */
  learned?: VideoMarkers | null;
}

const isUsableCreditsStart = (value: number | undefined, duration: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value > 0 &&
  Number.isFinite(duration) &&
  duration > 0 &&
  value < duration &&
  // A "credits start" in the first half of a title is a bad marker, not credits.
  value > duration * 0.5;

/**
 * Marker priority: manual > backend > learned > (caller's heuristic) >
 * (caller's fallback). A marker short-circuits the heuristic entirely — it is
 * the most reliable source there is, so nothing is gained by second-guessing it.
 */
export const resolveMarkerCreditsStart = (
  sources: CreditsMarkerSources,
  duration: number,
): { at: number; source: CreditsDetectionSource } | null => {
  const ordered: Array<[CreditsDetectionSource, VideoMarkers | null | undefined]> = [
    ["manual", sources.manual],
    ["backend", sources.backend],
    ["learned", sources.learned],
  ];
  for (const [source, markers] of ordered) {
    if (markers && isUsableCreditsStart(markers.creditsStart, duration)) {
      return { at: markers.creditsStart, source };
    }
  }
  return null;
};
