/**
 * React binding for the end-credits detector.
 *
 * This hook does the *measuring* — sampling frames onto a small canvas, reading
 * the Web Audio tap, walking subtitle cues — and hands plain numbers to the
 * pure engine in `utils/creditsDetection.ts`, which does the *deciding*. The
 * player UI consumes only the result, so none of the heuristics leak into it.
 *
 * Cost is deliberately tiny: nothing runs until the final stretch of the video,
 * and then it is one 160x90 `drawImage` + `getImageData` every 1.5s.
 *
 * Every signal degrades on its own:
 *   - cross-origin stream, tainted canvas -> visual signals off
 *   - no subtitle track (the common IPTV case) -> subtitle signals off
 *   - no Web Audio tap -> audio signal off
 *   - nothing measurable at all -> plain "almost at the end" fallback
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CreditsDetectionConfig,
  CreditsDetectionResult,
  CreditsSourceAvailability,
} from "../types/credits";
import {
  NO_SIGNALS,
  analysisWindowStart,
  canAnalyzeDuration,
  coefficientOfVariation,
  createAnalyzerState,
  baselineLuma as computeBaselineLuma,
  baselineMotion as computeBaselineMotion,
  dialogueStats,
  frameMetrics,
  isMusicMarkerCue,
  isWithinScanWindow,
  pushSample,
  resetDetection,
  resolveCreditsConfig,
  resolveMarkerCreditsStart,
  type CreditsMarkerSources,
} from "../utils/creditsDetection";

const SAMPLE_WIDTH = 160;
const SAMPLE_HEIGHT = 90;
/** Seeking back this far behind the detection withdraws the suggestion. */
const SEEK_BACK_TOLERANCE_SEC = 5;

const IDLE_RESULT: CreditsDetectionResult = {
  isAnalyzing: false,
  creditsDetected: false,
  detectedAt: null,
  confidence: 0,
  source: null,
  signals: { ...NO_SIGNALS },
  debug: null,
};

export interface UseCreditsDetectionOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Optional tap on the player's existing Web Audio graph. Never created here. */
  analyserRef?: React.RefObject<AnalyserNode | null>;
  duration: number;
  isLive: boolean;
  enabled: boolean;
  /** Changing this resets the detector — one detection per item, per session. */
  contentKey: string | null;
  markers?: CreditsMarkerSources | null;
  config?: Partial<CreditsDetectionConfig> | null;
}

export interface UseCreditsDetectionReturn extends CreditsDetectionResult {
  /** User closed the suggestion — stays closed until the item or seek changes. */
  dismissed: boolean;
  dismiss: () => void;
  /**
   * The player's "mark credits start" button calls this with the current
   * playback time. Takes absolute priority over everything else — even an
   * exact marker — for the rest of this item: a deliberate, in-the-moment
   * click is the most trustworthy signal there is.
   */
  markDetected: (at: number) => void;
}

interface DialogueTrackState {
  starts: number[];
  cueCount: number;
  available: boolean;
}

const readDialogueStarts = (video: HTMLVideoElement, previous: DialogueTrackState): DialogueTrackState => {
  const tracks = video.textTracks;
  if (!tracks || tracks.length === 0) return { starts: [], cueCount: 0, available: false };

  let totalCues = 0;
  const candidates: TextTrack[] = [];
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (track.kind !== "subtitles" && track.kind !== "captions") continue;
    // Cues are only populated for a non-disabled track. "hidden" loads them
    // without rendering anything, so this stays invisible to the user.
    if (track.mode === "disabled") {
      try {
        track.mode = "hidden";
      } catch {
        // Some engines refuse; that track just stays unreadable.
      }
    }
    candidates.push(track);
    totalCues += track.cues?.length ?? 0;
  }

  if (candidates.length === 0) return { starts: [], cueCount: 0, available: false };
  // Cue lists only grow as segments load; skip the rebuild when nothing changed.
  if (totalCues === previous.cueCount && previous.starts.length > 0) return previous;

  const starts: number[] = [];
  candidates.forEach((track) => {
    const cues = track.cues;
    if (!cues) return;
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index] as TextTrackCue & { text?: string };
      const text = typeof cue.text === "string" ? cue.text : "";
      if (isMusicMarkerCue(text)) continue;
      starts.push(cue.startTime);
    }
  });
  starts.sort((a, b) => a - b);

  // Fewer than a handful of dialogue cues is not a subtitle track worth
  // reasoning about (a forced-narrative track, or one that failed to load).
  return { starts, cueCount: totalCues, available: starts.length >= 5 };
};

const readAudioLevel = (analyser: AnalyserNode, buffer: Uint8Array): number | null => {
  try {
    // @ts-expect-error - lib.dom types the arg as Uint8Array<ArrayBuffer>; a
    // plain Uint8Array is what every engine accepts here.
    analyser.getByteTimeDomainData(buffer);
  } catch {
    return null;
  }
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const centred = (buffer[index] - 128) / 128;
    sum += centred * centred;
  }
  return Math.sqrt(sum / buffer.length);
};

export const useCreditsDetection = ({
  videoRef,
  analyserRef,
  duration,
  isLive,
  enabled,
  contentKey,
  markers,
  config,
}: UseCreditsDetectionOptions): UseCreditsDetectionReturn => {
  const [result, setResult] = useState<CreditsDetectionResult>(IDLE_RESULT);
  const [dismissed, setDismissed] = useState(false);
  // Set by the "mark credits start" button; null means no manual override for
  // this item. Kept as media-time seconds, not a boolean, so a re-click can
  // correct an earlier mark.
  const [manualMark, setManualMark] = useState<number | null>(null);

  const resolvedConfig = useMemo(() => resolveCreditsConfig(config), [config]);
  const markerHit = useMemo(
    () => (markers ? resolveMarkerCreditsStart(markers, duration) : null),
    [markers, duration],
  );

  const dismiss = useCallback(() => setDismissed(true), []);
  const markDetected = useCallback((at: number) => {
    setDismissed(false);
    setManualMark(at);
  }, []);

  // New item: forget the previous detection, dismissal, and manual mark.
  useEffect(() => {
    setResult(IDLE_RESULT);
    setDismissed(false);
    setManualMark(null);
  }, [contentKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !enabled || !resolvedConfig.enabled) return;
    if (isLive || !Number.isFinite(duration) || duration <= 0) return;

    /* ---- manual mark: same shape as an exact marker, but wins outright --- */
    if (manualMark != null) {
      const onManualTimeUpdate = () => {
        const detected = video.currentTime >= manualMark;
        setResult((previous) => {
          // detectedAt must be part of the equality check, or re-marking at a
          // new time while already past it short-circuits here and the result
          // keeps the FIRST mark — silently defeating the correction the
          // comment above promises.
          if (
            previous.creditsDetected === detected &&
            previous.source === "manual" &&
            previous.detectedAt === (detected ? manualMark : null)
          ) {
            return previous;
          }
          return {
            isAnalyzing: false,
            creditsDetected: detected,
            detectedAt: detected ? manualMark : null,
            confidence: detected ? 100 : 0,
            source: "manual",
            signals: { ...NO_SIGNALS, nearEnd: detected },
            debug: resolvedConfig.debug
              ? {
                  mediaTime: video.currentTime,
                  remaining: duration - video.currentTime,
                  score: detected ? 100 : 0,
                  consecutive: 0,
                  availability: { visual: false, subtitles: false, audio: false },
                  availableWeight: 0,
                  luma: null,
                  baselineLuma: null,
                  darkFraction: null,
                  motion: null,
                  baselineMotion: null,
                  audioLevel: null,
                  audioVariation: null,
                  secondsSinceDialogue: null,
                  reason: "manual",
                }
              : null,
          };
        });
        // Seeking back before the mark un-dismisses, so the suggestion can
        // come back if the user rewinds past the point they marked.
        if (video.currentTime < manualMark - SEEK_BACK_TOLERANCE_SEC) setDismissed(false);
      };
      video.addEventListener("timeupdate", onManualTimeUpdate);
      // Fire once immediately: the button click already put us at-or-past the
      // mark, so the overlay should appear right away, not on the next tick.
      onManualTimeUpdate();
      return () => video.removeEventListener("timeupdate", onManualTimeUpdate);
    }

    /* ---- exact marker: no sampling needed, just watch the clock ---------- */
    if (markerHit) {
      const onTimeUpdate = () => {
        const detected = video.currentTime >= markerHit.at;
        setResult((previous) => {
          if (previous.creditsDetected === detected && previous.source === markerHit.source) return previous;
          return {
            isAnalyzing: false,
            creditsDetected: detected,
            detectedAt: detected ? markerHit.at : null,
            confidence: detected ? 100 : 0,
            source: markerHit.source,
            signals: { ...NO_SIGNALS, nearEnd: detected },
            debug: resolvedConfig.debug
              ? {
                  mediaTime: video.currentTime,
                  remaining: duration - video.currentTime,
                  score: detected ? 100 : 0,
                  consecutive: 0,
                  availability: { visual: false, subtitles: false, audio: false },
                  availableWeight: 0,
                  luma: null,
                  baselineLuma: null,
                  darkFraction: null,
                  motion: null,
                  baselineMotion: null,
                  audioLevel: null,
                  audioVariation: null,
                  secondsSinceDialogue: null,
                  reason: `marker:${markerHit.source}`,
                }
              : null,
          };
        });
        // Seeking back before the marker un-dismisses, so the suggestion can
        // come back if the user rewinds into the episode.
        if (video.currentTime < markerHit.at - SEEK_BACK_TOLERANCE_SEC) setDismissed(false);
      };
      video.addEventListener("timeupdate", onTimeUpdate);
      return () => video.removeEventListener("timeupdate", onTimeUpdate);
    }

    /* ---- heuristic ------------------------------------------------------- */
    if (!canAnalyzeDuration(duration, isLive, resolvedConfig)) return;

    let analyzer = createAnalyzerState();
    let dialogueTrack: DialogueTrackState = { starts: [], cueCount: 0, available: false };
    let previousLumaMap: Float32Array | null = null;
    let visualBlocked = false;
    let canvas: HTMLCanvasElement | null = null;
    let context: CanvasRenderingContext2D | null = null;
    let audioBuffer: Uint8Array | null = null;
    let announcedAnalyzing = false;

    const ensureCanvas = (): CanvasRenderingContext2D | null => {
      if (visualBlocked) return null;
      if (context) return context;
      try {
        canvas = document.createElement("canvas");
        canvas.width = SAMPLE_WIDTH;
        canvas.height = SAMPLE_HEIGHT;
        context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) visualBlocked = true;
        return context;
      } catch {
        visualBlocked = true;
        return null;
      }
    };

    const sample = () => {
      const currentTime = video.currentTime;
      // Skip anything that would produce a meaningless sample: paused, mid-seek,
      // or starved of data. Buffering pauses the run rather than resetting it.
      if (video.paused || video.seeking || video.readyState < 3) return;
      if (!isWithinScanWindow(currentTime, duration, resolvedConfig)) return;

      if (!announcedAnalyzing) {
        announcedAnalyzing = true;
        setResult((previous) => (previous.isAnalyzing ? previous : { ...previous, isAnalyzing: true }));
      }

      /* visual */
      let luma: number | null = null;
      let darkFraction: number | null = null;
      let motion: number | null = null;
      const ctx = video.videoWidth > 0 ? ensureCanvas() : null;
      if (ctx) {
        try {
          ctx.drawImage(video, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
          const data = ctx.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data;
          const metrics = frameMetrics(data, previousLumaMap, resolvedConfig.darkPixelLuma);
          luma = metrics.luma;
          darkFraction = metrics.darkFraction;
          motion = metrics.motion;
          previousLumaMap = metrics.lumaMap;
        } catch {
          // SecurityError on a cross-origin frame, or a decoder that refuses to
          // paint. Either way: drop visual analysis for the rest of this item.
          visualBlocked = true;
          previousLumaMap = null;
        }
      }

      /* audio — only ever a tap on a graph the player already built */
      let audioLevel: number | null = null;
      const analyser = analyserRef?.current ?? null;
      if (analyser) {
        if (!audioBuffer || audioBuffer.length !== analyser.fftSize) {
          audioBuffer = new Uint8Array(analyser.fftSize);
        }
        audioLevel = readAudioLevel(analyser, audioBuffer);
      }

      /* subtitles */
      dialogueTrack = readDialogueStarts(video, dialogueTrack);
      const dialogue = dialogueTrack.available
        ? dialogueStats(dialogueTrack.starts, currentTime, resolvedConfig)
        : { secondsSinceDialogue: null, recentDensity: null, priorDensity: null };

      const availability: CreditsSourceAvailability = {
        visual: !visualBlocked && luma != null,
        subtitles: dialogueTrack.available && dialogue.secondsSinceDialogue != null,
        audio: audioLevel != null,
      };

      const outcome = pushSample(
        analyzer,
        {
          mediaTime: currentTime,
          duration,
          luma,
          darkFraction,
          motion,
          audioLevel,
          secondsSinceDialogue: dialogue.secondsSinceDialogue,
          recentDialogueDensity: dialogue.recentDensity,
          priorDialogueDensity: dialogue.priorDensity,
        },
        availability,
        resolvedConfig,
      );
      analyzer = outcome.state;

      // Last resort: nothing measurable this whole time, so fall back to the
      // plain "almost at the end" threshold rather than never suggesting.
      const fallbackFired =
        !outcome.breakdown.usable &&
        analyzer.detectedAt == null &&
        duration - currentTime <= resolvedConfig.fallbackRemainingSeconds &&
        duration - currentTime >= resolvedConfig.minimumRemainingSeconds;

      const detectedAt = analyzer.detectedAt ?? (fallbackFired ? currentTime : null);
      const source = analyzer.detectedAt != null ? "heuristic" : fallbackFired ? "fallback" : null;

      const debug = resolvedConfig.debug
        ? {
            mediaTime: currentTime,
            remaining: duration - currentTime,
            score: outcome.breakdown.score,
            consecutive: analyzer.consecutive,
            availability,
            availableWeight: outcome.breakdown.availableWeight,
            luma,
            baselineLuma: computeBaselineLuma(analyzer, resolvedConfig),
            darkFraction,
            motion,
            baselineMotion: computeBaselineMotion(analyzer, resolvedConfig),
            audioLevel,
            audioVariation: coefficientOfVariation(analyzer.audioHistory),
            secondsSinceDialogue: dialogue.secondsSinceDialogue,
            reason: analyzer.reason ?? (outcome.breakdown.usable ? null : "insufficient-signals"),
          }
        : null;

      setResult((previous) => {
        const unchanged =
          previous.creditsDetected === (detectedAt != null) &&
          previous.detectedAt === detectedAt &&
          previous.confidence === analyzer.confidence &&
          previous.isAnalyzing &&
          !resolvedConfig.debug;
        if (unchanged) return previous;
        return {
          isAnalyzing: true,
          creditsDetected: detectedAt != null,
          detectedAt,
          confidence: analyzer.detectedAt != null ? analyzer.confidence : fallbackFired ? 50 : 0,
          source,
          signals: outcome.signals,
          debug,
        };
      });
    };

    const onSeeked = () => {
      previousLumaMap = null;
      const detectedAt = analyzer.detectedAt;
      if (detectedAt != null && video.currentTime < detectedAt - SEEK_BACK_TOLERANCE_SEC) {
        analyzer = resetDetection(analyzer);
        setDismissed(false);
        setResult((previous) => ({
          ...previous,
          creditsDetected: false,
          detectedAt: null,
          confidence: 0,
          source: null,
        }));
      }
    };

    const timer = window.setInterval(sample, resolvedConfig.sampleIntervalMs);
    video.addEventListener("seeked", onSeeked);

    return () => {
      window.clearInterval(timer);
      video.removeEventListener("seeked", onSeeked);
      previousLumaMap = null;
      audioBuffer = null;
      context = null;
      if (canvas) {
        // Shrink before dropping the reference so the backing store is freed
        // promptly on engines that keep it alive with the element.
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    };
  }, [analyserRef, contentKey, duration, enabled, isLive, manualMark, markerHit, resolvedConfig, videoRef]);

  return { ...result, dismissed, dismiss, markDetected };
};

/** Media time analysis would begin at — exported for the debug overlay. */
export const creditsWindowStart = analysisWindowStart;
