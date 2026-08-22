import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_SIGNAL_SECONDS,
  MAX_SUBTITLE_SECONDS,
  SAMPLE_RATE,
  cuesToSpeech,
  isMetadataCue,
  preprocessCues,
  preprocessedIndices,
  roundHalfToEven,
  scaleCues,
  speechFrameCount,
} from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";

const cue = (start: number, end: number, text = "hello there"): SubtitleCue => ({ start, end, text });

/** Where the signal is non-zero, and how much of it there is. */
const describe = (samples: Float64Array) => {
  let first = -1;
  let last = -1;
  let count = 0;
  const values = new Set<number>();
  for (let i = 0; i < samples.length; i += 1) {
    values.add(samples[i]);
    if (samples[i] > 0) {
      if (first === -1) first = i;
      last = i;
      count += 1;
    }
  }
  return { first, last, count, length: samples.length, values: [...values].sort((a, b) => a - b) };
};

test("roundHalfToEven", async (t) => {
  await t.test("matches Python's round, not Math.round", () => {
    assert.equal(roundHalfToEven(312.5), 312);
    assert.equal(roundHalfToEven(313.5), 314);
    assert.equal(roundHalfToEven(0.5), 0);
    assert.equal(roundHalfToEven(1.5), 2);
    assert.equal(roundHalfToEven(2.5), 2);
    assert.equal(roundHalfToEven(-312.5), -312);
    assert.equal(roundHalfToEven(-313.5), -314);
  });

  await t.test("is ordinary rounding away from a tie", () => {
    assert.equal(roundHalfToEven(312.49), 312);
    assert.equal(roundHalfToEven(312.51), 313);
    assert.equal(roundHalfToEven(-0.6), -1);
    assert.equal(roundHalfToEven(7), 7);
  });
});

test("isMetadataCue", async (t) => {
  // Every case below was checked against ffsubsync's own `_is_metadata`.
  await t.test("rejects bracketed sound descriptions", () => {
    for (const text of ["[music]", "(applause)", "{laughter}", "（音乐）", "【掌声】", "「効果音」"]) {
      assert.equal(isMetadataCue(text, false), true, text);
    }
  });

  await t.test("rejects music-symbol-only cues, including astral ones", () => {
    for (const text of ["♪", "♪♪", "♪ ♫ ♬", "🎵", "🎵🎶"]) {
      assert.equal(isMetadataCue(text, false), true, text);
    }
  });

  await t.test("strips markup before deciding", () => {
    // This is why "<" is not one of the bracket pairs: stripping tags first is
    // what lets a wrapped sound cue be caught while wrapped dialogue survives.
    assert.equal(isMetadataCue("<i>[music]</i>", false), true);
    assert.equal(isMetadataCue('<font color="#fff">(applause)</font>', false), true);
    assert.equal(isMetadataCue("<i></i>", false), true);
    assert.equal(isMetadataCue("<i>Hello?</i>", false), false);
  });

  await t.test("rejects empty and whitespace-only cues", () => {
    assert.equal(isMetadataCue("", false), true);
    assert.equal(isMetadataCue("   ", false), true);
  });

  await t.test("keeps dialogue that merely contains a symbol or bracket", () => {
    assert.equal(isMetadataCue("John: hello there", false), false);
    assert.equal(isMetadataCue("♪ We are the champions ♪", false), false);
    assert.equal(isMetadataCue("[door creaks] and he walks in", false), false);
    assert.equal(isMetadataCue("(5 > 3) is true", false), false);
    assert.equal(isMetadataCue("🎵 sing 🎶", false), false);
  });

  await t.test("applies the credit-line heuristics only at the ends", () => {
    // A cue's classification depends on the length of the list it sits in —
    // surprising, and upstream's behaviour, so it is pinned here rather than
    // quietly improved.
    assert.equal(isMetadataCue("this is in english", false), false);
    assert.equal(isMetadataCue("this is in english", true), true);
    assert.equal(isMetadataCue("Bob - Alice", false), false);
    assert.equal(isMetadataCue("Bob - Alice", true), true);
  });
});

test("preprocessCues", async (t) => {
  await t.test("clamps a long cue's END, never its start", () => {
    const [clamped] = preprocessCues([cue(10, 40)]);
    assert.equal(clamped.start, 10);
    assert.equal(clamped.end, 10 + MAX_SUBTITLE_SECONDS);
  });

  await t.test("leaves ordinary cues alone", () => {
    assert.deepEqual(preprocessCues([cue(1, 3)]), [cue(1, 3)]);
  });

  await t.test("DROPS a cue starting before startSeconds rather than clipping it", () => {
    // Upstream drops it outright, even when it straddles the boundary. Clipping
    // instead would leave a partial cue contributing partial speech.
    const kept = preprocessCues([cue(1, 3), cue(4, 6), cue(9, 11)], { startSeconds: 5 });
    assert.deepEqual(kept, [cue(9, 11)]);
  });

  await t.test("skips cues with unusable timings instead of throwing", () => {
    const kept = preprocessCues([
      { start: Number.NaN, end: 2, text: "a" },
      { start: 1, end: Number.POSITIVE_INFINITY, text: "b" },
      cue(3, 4),
    ]);
    assert.deepEqual(kept, [cue(3, 4)]);
  });
});

test("preprocessedIndices", async (t) => {
  await t.test("reports exactly the input indices preprocessCues keeps", () => {
    const cues = [
      { start: Number.NaN, end: 2, text: "a" },
      cue(1, 3),
      { start: 4, end: Number.POSITIVE_INFINITY, text: "c" },
      cue(9, 11),
      cue(20, 22),
    ];
    const kept = preprocessedIndices(cues, { startSeconds: 5 });
    assert.deepEqual(kept, [3, 4]);
    // And they line up with what preprocessCues actually returned — which is
    // the whole point: the piecewise aligner produces one offset per PREPARED
    // cue and the caller applies them to the original list.
    const prepared = preprocessCues(cues, { startSeconds: 5 });
    assert.equal(kept.length, prepared.length);
    kept.forEach((source, index) => assert.equal(cues[source].start, prepared[index].start));
  });

  await t.test("is the identity when nothing is dropped", () => {
    const cues = [cue(1, 2), cue(3, 4)];
    assert.deepEqual(preprocessedIndices(cues), [0, 1]);
  });
});

test("scaleCues", async (t) => {
  await t.test("scales ABSOLUTE times, so the error grows with the timestamp", () => {
    const scaled = scaleCues([cue(0, 1), cue(100, 101)], 1.1);
    assert.equal(scaled[0].start, 0);
    assert.ok(Math.abs(scaled[1].start - 110) < 1e-9);
    // Anchoring anywhere but zero would model a constant delay, which is what
    // the OFFSET is for — the scale exists to model drift.
    assert.ok(Math.abs(scaled[1].end - 111.1) < 1e-9);
  });

  await t.test("returns a copy at ratio 1", () => {
    const input = [cue(1, 2)];
    const output = scaleCues(input, 1);
    assert.deepEqual(output, input);
    assert.notEqual(output, input);
  });
});

test("cuesToSpeech", async (t) => {
  // The numbers below come from running ffsubsync's own
  // SubtitleSpeechTransformer on the same cues.
  await t.test("rasterizes cues onto the 100 Hz grid", () => {
    const speech = cuesToSpeech([cue(1, 2), cue(3.5, 4.25), cue(10, 10.333)]);
    const shape = describe(speech.samples);
    assert.equal(shape.length, 1035);
    assert.equal(shape.count, 208);
    assert.equal(shape.first, 100);
    assert.equal(shape.last, 1032);
    assert.deepEqual(shape.values, [0, 1]);
    assert.equal(speech.maxTime, 10.333);
    assert.equal(speech.numFrames, 932);
    assert.equal(speech.speechSamples, 208);
  });

  await t.test("lowers the amplitude by the framerate ratio", () => {
    // min(1/ratio, 1). Without it the unnormalized score would reward a stretch
    // purely for painting MORE speech, and the search would pick the largest
    // ratio on offer every time regardless of fit.
    const cues = [cue(1, 2), cue(3.5, 4.25)];
    const unscaledMass = describe(cuesToSpeech(cues).samples).count; // 175

    const stretched = cuesToSpeech(scaleCues(cues, 25 / 24), { framerateRatio: 25 / 24 });
    const stretchedShape = describe(stretched.samples);
    assert.deepEqual(stretchedShape.values, [0, 0.96]);
    assert.equal(stretchedShape.count, 182);
    // 182 samples at 0.96 is 174.7 — the stretch is paid for almost exactly.
    assert.ok(Math.abs(stretchedShape.count * 0.96 - unscaledMass) < 1, "stretch not compensated");

    // Below 1 the amplitude is CAPPED at 1 rather than raised above it, so a
    // squeeze is not compensated the same way. Upstream's asymmetry, kept.
    const squeezed = cuesToSpeech(scaleCues(cues, 0.96), { framerateRatio: 0.96 });
    const squeezedShape = describe(squeezed.samples);
    assert.deepEqual(squeezedShape.values, [0, 1]);
    assert.equal(squeezedShape.count, 168);
  });

  await t.test("derives the frame span from the SAMPLES, not the cue loop", () => {
    // A cue pushed before zero by startSeconds writes nothing, so it must not
    // move the span either. Upstream tracks both and then throws the loop's
    // version away; getting this wrong reports 600 where ffsubsync reports 349.
    const speech = cuesToSpeech([cue(1, 2), cue(3.5, 4.25), cue(6, 7)], { startSeconds: 2 });
    assert.equal(speech.numFrames, 349);
    assert.equal(describe(speech.samples).first, 150);
    assert.equal(describe(speech.samples).last, 499);
    assert.equal(speech.maxTime, 5);
  });

  await t.test("honours a non-default sample rate", () => {
    const coarse = cuesToSpeech([cue(1, 2), cue(3.5, 4.25)], { sampleRate: 20 });
    assert.equal(describe(coarse.samples).length, 87);
    assert.equal(describe(coarse.samples).count, 35);
    assert.equal(coarse.numFrames, 64);

    const fine = cuesToSpeech([cue(0.017, 0.4), cue(1.2345, 2.6789)], { sampleRate: 300 });
    assert.equal(describe(fine.samples).length, 805);
    assert.equal(describe(fine.samples).count, 548);
    assert.equal(fine.numFrames, 797);
  });

  await t.test("breaks rounding ties toward even, as ffsubsync does", () => {
    // 3.125s and 3.135s are exactly 312.5 and 313.5 samples. Python rounds the
    // first DOWN (to even) and the second UP; Math.round would take both up,
    // adding a sample to every such cue. Total verified against ffsubsync: 1466.
    const speech = cuesToSpeech([
      cue(1, 4.125), cue(10, 13.135), cue(20, 22.005),
      cue(30, 33.125), cue(40, 41.045), cue(50, 52.235),
    ]);
    assert.equal(describe(speech.samples).count, 1466);
    // The two genuine ties, isolated.
    assert.equal(describe(cuesToSpeech([cue(1, 4.125)]).samples).count, 312);
    assert.equal(describe(cuesToSpeech([cue(10, 13.135)]).samples).count, 314);
  });

  await t.test("zeroes metadata cues without removing them", () => {
    const speech = cuesToSpeech([cue(1, 2, "[music]"), cue(3, 4, "Real dialogue here"), cue(5, 6, "♪♪")]);
    const shape = describe(speech.samples);
    assert.equal(shape.count, 100);
    assert.equal(shape.first, 300);
    assert.equal(shape.last, 399);
    // maxTime still covers the metadata cue: it is silent, not absent.
    assert.equal(speech.maxTime, 6);
  });

  await t.test("refuses to size the signal off one absurd timestamp", () => {
    // A stray "99:59:59" in an otherwise ordinary file would allocate off that
    // cue alone. Bounded at a day — longer than any media, short enough not to
    // be a way to exhaust memory.
    const speech = cuesToSpeech([cue(1, 2), cue(5, 6), { start: 1e12, end: 1e12 + 1, text: "junk" }]);
    assert.ok(speech.samples.length <= MAX_SIGNAL_SECONDS * SAMPLE_RATE + 2);
    assert.equal(describe(speech.samples).count, 200, "the real cues still rasterize");
  });

  await t.test("computes maxTime from the raw cue ends", () => {
    assert.equal(cuesToSpeech([cue(0, 3.3062)]).maxTime, 3.3062);
    assert.equal(describe(cuesToSpeech([cue(0, 3.3062)]).samples).length, 332);
  });
});

test("speechFrameCount", async (t) => {
  await t.test("spans the first and last sample above the half threshold", () => {
    const samples = new Float64Array(100);
    samples.fill(1, 20, 30);
    samples.fill(1, 70, 80);
    assert.equal(speechFrameCount(samples), 79 - 20);
  });

  await t.test("ignores a 'not sure' label below the threshold", () => {
    // Some VADs label non-speech with a small positive number rather than zero.
    const samples = new Float64Array(50).fill(0.25);
    assert.equal(speechFrameCount(samples), null);
  });

  await t.test("is null for a silent signal", () => {
    assert.equal(speechFrameCount(new Float64Array(10)), null);
  });
});

test("SAMPLE_RATE is one sample per 10 ms", () => {
  assert.equal(SAMPLE_RATE, 100);
});
