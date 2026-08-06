/**
 * Types for the non-AI end-credits detector.
 *
 * The detector combines cheap deterministic signals (playback position, frame
 * brightness/motion, subtitle activity, audio steadiness) into a 0-100 score.
 * No machine learning, no OCR, no server-side video processing — everything is
 * computed locally from the already-playing <video> element.
 */

/** Explicit chapter timestamps for one title, in seconds of media time. */
export interface VideoMarkers {
  introStart?: number;
  introEnd?: number;
  creditsStart?: number;
  creditsEnd?: number;
}

export type CreditsSignalName =
  | "nearEnd"
  | "subtitleSilence"
  | "dialogueDrop"
  | "darkFrame"
  | "lowMotion"
  | "audioTransition"
  | "fadeToBlack";

export type CreditsSignals = Record<CreditsSignalName, boolean>;

export type CreditsSignalWeights = Record<CreditsSignalName, number>;

/**
 * Which measurement sources this playback session actually has. A source is
 * unavailable when the browser blocks it (tainted canvas on a cross-origin
 * stream), when the stream carries no subtitles, or when the Web Audio tap is
 * not attached. Unavailable sources are excluded from the score denominator —
 * see `scoreSignals`.
 */
export interface CreditsSourceAvailability {
  visual: boolean;
  subtitles: boolean;
  audio: boolean;
}

/** Where a detected credits timestamp came from, in priority order. */
export type CreditsDetectionSource = "manual" | "backend" | "learned" | "heuristic" | "fallback";

export interface CreditsDetectionConfig {
  enabled: boolean;
  /** Analyse only the final slice of the video (0.2 = last 20%). */
  scanLastPercent: number;
  /** Never suggest anything once fewer than this many seconds remain. */
  minimumRemainingSeconds: number;
  /** Never start analysing earlier than this many seconds before the end. */
  maximumRemainingSeconds: number;
  /** Videos shorter than this get markers only — no heuristics (clips, trailers). */
  minimumDurationSeconds: number;
  /** Score (0-100) a sample must reach to count towards a detection. */
  triggerScore: number;
  /** Consecutive qualifying samples required before firing. */
  requiredConsecutiveSamples: number;
  sampleIntervalMs: number;
  /** Credits shorter than this are not worth an overlay. */
  minimumCreditsDurationSeconds: number;
  /**
   * Minimum total weight of available signals. Below this the heuristic is not
   * trusted at all (e.g. only `nearEnd` is measurable), and the detector falls
   * back to the plain "almost at the end" threshold.
   */
  minimumAvailableWeight: number;
  /** In-window samples used to build the per-title brightness/motion baseline. */
  baselineSamples: number;
  /** Luma (0-1) below which a pixel counts as "very dark". */
  darkPixelLuma: number;
  /** Fraction of very dark pixels that makes a frame count as dark. */
  darkFrameFraction: number;
  /** Frame is dark when its luma drops to this ratio of the content baseline. */
  darkFrameBaselineRatio: number;
  /** Frame is dark outright below this luma, baseline or not. */
  absoluteDarkLuma: number;
  /** Motion score below which a frame counts as static regardless of baseline. */
  lowMotionAbsolute: number;
  /** Motion counts as low at this ratio of the content baseline. */
  lowMotionBaselineRatio: number;
  /** A fade only counts when the frame ends up below this luma. */
  fadeLumaCeiling: number;
  /** ...and has dropped to this ratio of the luma a few samples ago. */
  fadeDropRatio: number;
  /** Seconds without a dialogue cue that count as subtitle silence. */
  dialogueSilenceSeconds: number;
  dialogueRecentWindowSeconds: number;
  dialoguePriorWindowSeconds: number;
  /** Recent dialogue density at/below this ratio of the prior window = drop. */
  dialogueDropRatio: number;
  /** Coefficient of variation below which audio reads as a steady music bed. */
  audioSteadyVariation: number;
  /** Below this RMS the audio is silence, not music — signal stays off. */
  audioMinimumLevel: number;
  /** Consecutive clearly-not-credits samples that hide an active suggestion. */
  clearSamplesToHide: number;
  /**
   * Last-resort fallback: with no usable signals, suggest the next episode once
   * this many seconds remain.
   */
  fallbackRemainingSeconds: number;
  debug: boolean;
}

/** Raw per-sample measurements handed to the pure scoring engine. */
export interface CreditsSampleInput {
  mediaTime: number;
  duration: number;
  /** Mean frame luma 0-1, or null when visual analysis is unavailable. */
  luma: number | null;
  /** Fraction of very dark pixels 0-1. */
  darkFraction: number | null;
  /** Mean absolute luma delta against the previous sampled frame, 0-1. */
  motion: number | null;
  /** RMS audio level 0-1, or null when the Web Audio tap is unavailable. */
  audioLevel: number | null;
  /** Seconds of media time since the last non-music subtitle cue. */
  secondsSinceDialogue: number | null;
  /** Dialogue cues per minute over the recent window. */
  recentDialogueDensity: number | null;
  /** Dialogue cues per minute over the preceding, longer window. */
  priorDialogueDensity: number | null;
}

export interface CreditsScoreBreakdown {
  score: number;
  earnedWeight: number;
  availableWeight: number;
  /** False when too few sources are available for the score to mean anything. */
  usable: boolean;
}

/** Everything the debug overlay shows. */
export interface CreditsDebugInfo {
  mediaTime: number;
  remaining: number;
  score: number;
  consecutive: number;
  availability: CreditsSourceAvailability;
  availableWeight: number;
  luma: number | null;
  baselineLuma: number | null;
  darkFraction: number | null;
  motion: number | null;
  baselineMotion: number | null;
  audioLevel: number | null;
  audioVariation: number | null;
  secondsSinceDialogue: number | null;
  reason: string | null;
}

export interface CreditsDetectionResult {
  isAnalyzing: boolean;
  creditsDetected: boolean;
  /** Media time the credits are believed to start at. */
  detectedAt: number | null;
  confidence: number;
  source: CreditsDetectionSource | null;
  signals: CreditsSignals;
  debug: CreditsDebugInfo | null;
}

/** Anonymous, local-only feedback used to firm up a series' credits marker. */
export interface CreditsFeedbackRecord {
  /** Per-episode identity. */
  contentId: string;
  /** Series-level identity — aggregation happens here. */
  groupId: string;
  durationSec: number;
  detectedCreditsStart: number | null;
  /** Explicit "this is where credits start" click — the strongest signal there is. */
  userMarkedAt: number | null;
  userSkippedAt: number | null;
  userDismissed: boolean;
  reachedVideoEnd: boolean;
  updatedAt: number;
}
