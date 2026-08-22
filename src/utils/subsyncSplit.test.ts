import test from "node:test";
import assert from "node:assert/strict";
import { computeSplitOffsets, medianOffset, splitSegments } from "./subsyncSplit.ts";
import { SAMPLE_RATE } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";

const cue = (start: number, end: number, text = "hello there"): SubtitleCue => ({ start, end, text });

/** A 0/1 reference at 100 Hz, with speech over the given second-ranges. */
const reference = (lengthSamples: number, spans: [number, number][]): Float64Array => {
  const out = new Float64Array(lengthSamples);
  for (const [from, to] of spans) {
    out.fill(1, Math.trunc(from * SAMPLE_RATE), Math.trunc(to * SAMPLE_RATE));
  }
  return out;
};

// Every expected value below was produced by running ffsubsync's own
// compute_split_offsets on the same inputs.
test("computeSplitOffsets", async (t) => {
  await t.test("finds a mid-file break", () => {
    // The first two cues are already right; the last two are six seconds early,
    // as if the encode kept an ad break the subtitles do not know about.
    const result = computeSplitOffsets(
      reference(2500, [[1.0, 1.4], [3.0, 3.9], [17.0, 17.6], [19.0, 20.0]]),
      [cue(1.0, 1.4), cue(3.0, 3.9), cue(11.0, 11.6), cue(13.0, 14.0)],
      { splitPenalty: 0.5 * SAMPLE_RATE, maxOffsetSamples: 1000 },
    );
    assert.deepEqual(result.offsets, [0, 0, 600, 600]);
    assert.equal(result.score, 240);
    assert.equal(result.segments.length, 2, "exactly one split");
    assert.deepEqual(result.segments, [
      { cueCount: 2, offsetSamples: 0 },
      { cueCount: 2, offsetSamples: 600 },
    ]);
  });

  await t.test("collapses to one global offset under a large penalty", () => {
    // This is the property that makes piecewise a GENERALIZATION of the default
    // rather than a different algorithm.
    const result = computeSplitOffsets(
      reference(2500, [[6.0, 6.4], [8.0, 8.9], [16.0, 16.6], [18.0, 19.0]]),
      [cue(1.0, 1.4), cue(3.0, 3.9), cue(11.0, 11.6), cue(13.0, 14.0)],
      { splitPenalty: 1e9, maxOffsetSamples: 1000 },
    );
    assert.deepEqual(result.offsets, [500, 500, 500, 500]);
    assert.equal(result.score, 290);
    assert.equal(result.segments.length, 1);
  });

  await t.test("leaves an already-aligned subtitle alone", () => {
    const result = computeSplitOffsets(
      reference(600, [[1.0, 1.4], [3.0, 3.9]]),
      [cue(1.0, 1.4), cue(3.0, 3.9)],
      { splitPenalty: 5 * SAMPLE_RATE, maxOffsetSamples: 600 },
    );
    assert.deepEqual(result.offsets, [0, 0]);
    assert.equal(result.score, 130);
  });

  await t.test("uses the edge term to localize a cue inside a long block", () => {
    // The reference has a 10s block (3-13s) and a same-sized 1s block (16-17s).
    // Pure overlap is FLAT anywhere inside the long block, so it settles on the
    // first offset that fits — 200. Charging the speech just outside the cue's
    // edges makes the same-sized block win instead.
    const longBlock = reference(3000, [[3.0, 13.0], [16.0, 17.0]]);
    const cues = [cue(1.0, 2.0)];
    const options = { splitPenalty: 5 * SAMPLE_RATE, maxOffsetSamples: 1500 };

    const pureOverlap = computeSplitOffsets(longBlock, cues, { ...options, lengthPenalty: 0 });
    assert.deepEqual(pureOverlap.offsets, [200]);

    const withEdges = computeSplitOffsets(longBlock, cues, { ...options, lengthPenalty: 0.25 });
    assert.deepEqual(withEdges.offsets, [1500]);
    assert.equal(withEdges.score, 100);
  });

  await t.test("reaches a sub-sample offset when the grid is refined", () => {
    // The cue is off-grid by half a sample, so a whole-sample grid can only
    // capture 99.5 of the 100 available overlap. This is exact, not an
    // approximation: the reference is a step function, so interpolating its
    // prefix sum gives the true continuous overlap.
    const sub = reference(1500, [[6.0, 7.0]]);
    const cues = [cue(1.005, 2.005)];
    const options = { splitPenalty: 5 * SAMPLE_RATE, maxOffsetSamples: 800 };

    const whole = computeSplitOffsets(sub, cues, { ...options, offsetStepSamples: 1 });
    assert.deepEqual(whole.offsets, [499]);
    assert.ok(Math.abs(whole.score - 99.5) < 1e-9, `score ${whole.score}`);

    const fine = computeSplitOffsets(sub, cues, { ...options, offsetStepSamples: 0.1 });
    assert.ok(Math.abs(fine.offsets[0] - 499.5) < 1e-9, `offset ${fine.offsets[0]}`);
    assert.ok(Math.abs(fine.score - 100) < 1e-9, `score ${fine.score}`);
    assert.ok(fine.score > whole.score);
  });

  await t.test("lets a metadata cue ride its neighbours' offset for free", () => {
    // The "[music]" cue is nowhere near any reference speech. If it were
    // scored, the DP would be tempted to split around it; because it is gated
    // out it contributes nothing and the run stays whole.
    const result = computeSplitOffsets(
      reference(1200, [[2.0, 2.5], [6.0, 6.5]]),
      [cue(1.0, 1.5), cue(30.0, 30.6, "[music]"), cue(5.0, 5.5)],
      { splitPenalty: 5 * SAMPLE_RATE, maxOffsetSamples: 400, lengthPenalty: 0.25 },
    );
    assert.deepEqual(result.offsets, [100, 100, 100]);
    assert.equal(result.segments.length, 1);
  });

  await t.test("shifts the cue timeline by startSeconds", () => {
    const result = computeSplitOffsets(
      reference(900, [[1.0, 1.5], [3.0, 3.6]]),
      [cue(3.0, 3.5), cue(5.0, 5.6)],
      { splitPenalty: 500, maxOffsetSamples: 300, startSeconds: 2 },
    );
    assert.deepEqual(result.offsets, [0, 0]);
    assert.equal(result.score, 110);
  });

  await t.test("returns nothing for no cues", () => {
    const result = computeSplitOffsets(reference(300, [[1, 2]]), [], {
      splitPenalty: 500,
      maxOffsetSamples: 100,
    });
    assert.deepEqual(result.offsets, []);
    assert.equal(result.score, 0);
    assert.deepEqual(result.segments, []);
  });

  await t.test("treats a non-positive step as one whole sample", () => {
    const result = computeSplitOffsets(
      reference(600, [[1.0, 1.4]]),
      [cue(1.0, 1.4)],
      { splitPenalty: 500, maxOffsetSamples: 100, offsetStepSamples: 0 },
    );
    assert.deepEqual(result.offsets, [0]);
  });
});

test("splitSegments", async (t) => {
  await t.test("groups runs of equal offsets", () => {
    assert.deepEqual(splitSegments([0, 0, 600, 600, 600, -50]), [
      { cueCount: 2, offsetSamples: 0 },
      { cueCount: 3, offsetSamples: 600 },
      { cueCount: 1, offsetSamples: -50 },
    ]);
  });

  await t.test("is empty for no offsets", () => {
    assert.deepEqual(splitSegments([]), []);
  });
});

test("medianOffset", async (t) => {
  await t.test("is the middle value, or the mean of the middle pair", () => {
    assert.equal(medianOffset([5, 1, 3]), 3);
    assert.equal(medianOffset([1, 3, 5, 7]), 4);
    assert.equal(medianOffset([]), 0);
  });

  await t.test("does not disturb its input", () => {
    const offsets = [5, 1, 3];
    medianOffset(offsets);
    assert.deepEqual(offsets, [5, 1, 3]);
  });
});
