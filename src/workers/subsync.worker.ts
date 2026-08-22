/// <reference lib="webworker" />
/**
 * The subtitle-sync worker.
 *
 * Everything expensive lives here: voice activity detection over the decoded
 * audio, and the FFT cross-correlation that can run to 2^21 points seven times
 * over. On the main thread that is seconds of frozen UI in the middle of
 * playback; here the video keeps playing.
 *
 * Deliberately thin — it owns no algorithm of its own. Every line of the
 * actual work is in src/utils/subsync*.ts, which is what lets `node --test`
 * exercise all of it without a DOM, and what lets the native engine's fallback
 * path reuse it unchanged.
 *
 * Audio is streamed in as windows and detected as it arrives, so the worker
 * holds one window of PCM plus the 100 Hz signal (~8 MB for a 3-hour film)
 * and never the film.
 */

import { runAlignment } from "../utils/subsyncEngine.ts";
import { SpeechAccumulator } from "../utils/subsyncVad.ts";
import type {
  SubsyncBeginMessage,
  SubsyncRequest,
  SubsyncResponse,
} from "../utils/subsyncWorkerProtocol.ts";

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface ActiveRun {
  begin: SubsyncBeginMessage;
  accumulator: SpeechAccumulator;
  frameRate: number;
}

let active: ActiveRun | null = null;

const post = (message: SubsyncResponse): void => scope.postMessage(message);

const finish = (run: ActiveRun): void => {
  const { begin } = run;
  post({ type: "progress", runId: begin.runId, phase: "finding-alignment" });

  const reference = begin.referenceSpeech ?? run.accumulator.finish();
  if (reference.length === 0) {
    post({
      type: "error",
      runId: begin.runId,
      message: "No speech was detected in this video, so there is nothing to line the subtitles up with.",
    });
    return;
  }

  const result = runAlignment(
    reference,
    begin.cues,
    begin.reference,
    begin.processingMode,
    begin.engine,
    { ...begin.options, referenceNumFrames: begin.referenceNumFrames ?? null },
  );
  post({ type: "result", runId: begin.runId, result });
};

scope.onmessage = (event: MessageEvent<SubsyncRequest>) => {
  const message = event.data;
  try {
    if (message.type === "begin") {
      // A run already in flight is superseded, not ignored. Its caller is
      // awaiting a reply that would otherwise never come, and its message
      // listeners would sit on the worker for the life of the page.
      if (active) {
        post({
          type: "error",
          runId: active.begin.runId,
          message: "Superseded by a newer subtitle sync.",
        });
      }
      active = {
        begin: message,
        accumulator: new SpeechAccumulator(),
        frameRate: 0,
      };
      return;
    }

    // A message from a run the player has moved on from. Dropping it silently
    // is the point of the runId: cancelling mid-extraction otherwise leaves
    // windows in flight that would be folded into the NEXT run's reference.
    if (!active || active.begin.runId !== message.runId) return;

    if (message.type === "cancel") {
      active = null;
      return;
    }

    if (message.type === "pcm") {
      active.frameRate = message.frameRate;
      active.accumulator.push(new Int16Array(message.buffer), {
        frameRate: message.frameRate,
        startSeconds: message.startSeconds,
      });
      post({
        type: "progress",
        runId: message.runId,
        phase: "detecting-speech",
      });
      return;
    }

    if (message.type === "finish") {
      const run = active;
      active = null;
      finish(run);
    }
  } catch (error) {
    const runId = message.type === "begin" ? message.runId : (active?.begin.runId ?? message.runId);
    active = null;
    post({
      type: "error",
      runId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
