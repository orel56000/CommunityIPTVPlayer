/**
 * Messages between the player and the subtitle-sync worker.
 *
 * In its own module so both sides can import the SHAPES without either
 * pulling in the other's code — a value import from the worker module would
 * drag the whole aligner into the main bundle, which is precisely what running
 * it in a worker is meant to avoid.
 *
 * Audio arrives as a stream of `pcm` messages rather than one big array: the
 * player decodes a window at a time (see subsyncAudio.ts) and transfers each
 * one over, so neither side ever holds more than a window of a film.
 */

import type { SubtitleCue } from "./subtitles";
import type { SubtitleSyncReference, SubtitleSyncResult } from "../types/subtitleSync";
import type { AlignOptions } from "./subsyncEngine";

export interface SubsyncBeginMessage {
  type: "begin";
  /** Correlates replies with a run, so a cancelled run's late reply is ignored. */
  runId: number;
  cues: SubtitleCue[];
  /**
   * A reference speech signal that is already built — from another subtitle
   * track, or from the native backend's own ffmpeg. When present no `pcm`
   * messages follow and `finish` can be sent straight away.
   */
  referenceSpeech?: Float64Array;
  /** Set when `referenceSpeech` came from cues; enables the length-inferred ratio. */
  referenceNumFrames?: number | null;
  reference: SubtitleSyncReference;
  processingMode: "native" | "web";
  engine: SubtitleSyncResult["engine"];
  options: AlignOptions;
}

export interface SubsyncPcmMessage {
  type: "pcm";
  runId: number;
  /** Mono signed 16-bit PCM. Transferred, so the sender must not reuse it. */
  buffer: ArrayBuffer;
  frameRate: number;
  /**
   * Where this block starts on the reference timeline, in seconds.
   *
   * Carried rather than inferred: each block is a separate ffmpeg invocation
   * and may come back slightly short or long, so appending them would let the
   * timeline drift. See SpeechAccumulator.
   */
  startSeconds: number;
}

export interface SubsyncFinishMessage {
  type: "finish";
  runId: number;
}

export interface SubsyncCancelMessage {
  type: "cancel";
  runId: number;
}

export type SubsyncRequest =
  | SubsyncBeginMessage
  | SubsyncPcmMessage
  | SubsyncFinishMessage
  | SubsyncCancelMessage;

export interface SubsyncProgressMessage {
  type: "progress";
  runId: number;
  phase: "detecting-speech" | "finding-alignment";
  fraction?: number;
}

export interface SubsyncResultMessage {
  type: "result";
  runId: number;
  result: SubtitleSyncResult;
}

export interface SubsyncErrorMessage {
  type: "error";
  runId: number;
  message: string;
}

export type SubsyncResponse = SubsyncProgressMessage | SubsyncResultMessage | SubsyncErrorMessage;
