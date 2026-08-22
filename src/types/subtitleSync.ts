/**
 * The contract both subtitle-sync engines answer to.
 *
 * There are two of them — one that hands the job to the native backend (which
 * has real ffmpeg, and possibly a real ffsubsync install) and one that does
 * everything in the browser — and the player must not care which it got. The
 * shapes below are the whole of what it sees; see src/utils/subtitleSync.ts
 * for the selection rule and docs/subtitle-sync.md for the why.
 */

import type { SubtitleCue } from "../utils/subtitles";

/** Where the reference "this is where the speech is" signal came from. */
export type SubtitleSyncReference =
  /** Another subtitle track — exact, free, and ffsubsync's own first choice. */
  | "subtitle-track"
  /** A text subtitle stream inside the video container, pulled by ffmpeg. */
  | "embedded-subtitles"
  /** Voice activity detection over the decoded audio. */
  | "audio-vad";

/** How far along a run is. The UI shows these in order, as written. */
export type SubtitleSyncPhase =
  | "preparing-audio"
  | "detecting-speech"
  | "finding-alignment"
  | "applying"
  | "done";

export interface SubtitleSyncProgress {
  phase: SubtitleSyncPhase;
  /** 0..1 within the phase, when it is knowable. */
  fraction?: number;
  /** A short line for the UI, already phrased for a person. */
  detail?: string;
}

export interface SubtitleSyncInput {
  /** Cues at their ORIGINAL timings. Never pre-shifted. */
  cues: SubtitleCue[];

  /**
   * The media to align against.
   *
   * `file` is preferred when we have one — the browser can read it lazily, and
   * nothing is uploaded. `url` is what the native backend wants: it already
   * has network and ffmpeg, so it fetches the stream itself rather than having
   * the bytes pushed through the browser a second time.
   */
  media: {
    file?: File;
    url?: string;
    /** Duration in seconds when the player already knows it. */
    durationSec?: number;
  };

  /**
   * Cues from a DIFFERENT track to use as the reference instead of audio.
   *
   * This is ffsubsync's `subs_then_*` default in the form we can always do:
   * if the video carries a track that is already correctly timed, aligning
   * against it is exact and costs no decoding at all.
   */
  referenceCues?: SubtitleCue[];

  /** Ignore the media before this point (ffsubsync --start-seconds). */
  startSeconds?: number;
  /** Largest shift to consider (ffsubsync --max-offset-seconds). */
  maxOffsetSeconds?: number;
  /** Stop reading the reference after this much; null analyses all of it. */
  maxDurationSeconds?: number | null;
  /** Skip the framerate hypotheses (ffsubsync --no-fix-framerate). */
  noFixFramerate?: boolean;
  /** Add a golden-section-searched framerate (ffsubsync --gss). Slow. */
  gss?: boolean;
  /**
   * Let the offset CHANGE partway through the file, at the cost of this many
   * seconds of overlap per change (ffsubsync --split-penalty). Undefined keeps
   * the single global offset, which is the default everywhere.
   */
  splitPenaltySeconds?: number | null;

  onProgress?: (progress: SubtitleSyncProgress) => void;
  signal?: AbortSignal;
}

export interface SubtitleSyncResult {
  /** The cues, synced. Ready to hand straight to the player. */
  subtitles: SubtitleCue[];
  /** The shift applied, in milliseconds. Positive = subtitles moved later. */
  offsetMs: number;
  /**
   * Roughly "what fraction of the subtitle agrees with the reference": ~1 is a
   * clean match, ~0 an accidental one, negative means anti-correlated. Derived
   * from ffsubsync's raw score, which is not comparable between files.
   */
  confidence?: number;
  processingMode: "native" | "web";

  /* --- ffsubsync-derived detail, for the debug log and the status line --- */

  /** Which of the two engines, and how it actually did the work. */
  engine: "native-ffsubsync" | "native-ffmpeg" | "web";
  reference: SubtitleSyncReference;
  /** The framerate correction; 1 means none was needed. */
  framerateScaleFactor: number;
  /** ffsubsync's raw correlation peak. Never show this to a person. */
  score: number;
  /**
   * Per-cue shifts in ms when piecewise sync ran, else null. `offsetMs` is
   * then the MEDIAN of these and must not be treated as an applicable shift.
   */
  perCueOffsetsMs: number[] | null;
  /** Runs of equal offset, when piecewise sync ran. */
  segments?: { cueCount: number; offsetMs: number }[];
  /** Non-empty when the result was judged untrustworthy and NOT applied. */
  qualityReasons: string[];
  /** True when `subtitles` differ from the input — i.e. worth applying. */
  applied: boolean;
}

export interface SubtitleSyncEngine {
  readonly processingMode: "native" | "web";
  /** Cheap check the UI uses to decide whether to offer the action at all. */
  canSync(input: Pick<SubtitleSyncInput, "media" | "referenceCues">): boolean;
  sync(input: SubtitleSyncInput): Promise<SubtitleSyncResult>;
}

/**
 * Raised when the native backend went away mid-run.
 *
 * Distinct from every other failure on purpose: this one — and ONLY this one —
 * is safe to retry in the browser. A genuine synchronization error from
 * ffsubsync means the alignment failed on its merits, and re-running the same
 * data through a second engine would only produce the same failure with a
 * different accent, so it is surfaced as-is.
 */
export class BackendUnavailableError extends Error {
  /**
   * `cause` is folded into the message rather than passed to `Error`: this
   * project compiles against the ES2020 lib, where the two-argument Error
   * constructor does not exist. The detail is worth keeping — it is what
   * distinguishes "no network" from "this browser refused the mount" in the
   * debug log — so it rides along in the text.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    const detail =
      options?.cause instanceof Error
        ? options.cause.message
        : options?.cause === undefined
          ? ""
          : String(options.cause);
    super(detail ? `${message} (${detail})` : message);
    this.name = "BackendUnavailableError";
  }
}
