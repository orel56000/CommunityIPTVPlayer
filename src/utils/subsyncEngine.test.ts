import test from "node:test";
import assert from "node:assert/strict";
import { alignCues, applySync, runAlignment } from "./subsyncEngine.ts";
import { FailedToFindAlignmentError } from "./subsyncAlign.ts";
import { SAMPLE_RATE } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";

const cue = (start: number, end: number, text = "hello there"): SubtitleCue => ({ start, end, text });

/** A reference where every cue lands `shift` seconds later, optionally stretched. */
const referenceFor = (
  cues: readonly SubtitleCue[],
  shift: number,
  scale = 1,
  lengthSeconds = 4000,
): Float64Array => {
  const out = new Float64Array(lengthSeconds * SAMPLE_RATE);
  for (const c of cues) {
    out.fill(
      1,
      Math.round((c.start * scale + shift) * SAMPLE_RATE),
      Math.round((c.end * scale + shift) * SAMPLE_RATE),
    );
  }
  return out;
};

const dialogue = (count: number, spacing = 30): SubtitleCue[] =>
  Array.from({ length: count }, (_, i) => cue(5 + i * spacing, 8 + i * spacing));

test("applySync", async (t) => {
  await t.test("scales first, then shifts", () => {
    // t * scale + offset, never (t + offset) * scale. The two agree only at
    // t = 0, so getting it backwards ruins every result where a framerate
    // candidate other than 1.0 won — while still looking right at the start.
    const [synced] = applySync([cue(10, 12)], 25 / 24, 3);
    assert.ok(Math.abs(synced.start - (10 * (25 / 24) + 3)) < 1e-9, `${synced.start}`);
    assert.ok(Math.abs(synced.end - (12 * (25 / 24) + 3)) < 1e-9);
  });

  await t.test("a positive offset moves subtitles LATER", () => {
    assert.equal(applySync([cue(10, 12)], 1, 5)[0].start, 15);
    assert.equal(applySync([cue(10, 12)], 1, -5)[0].start, 5);
  });

  await t.test("keeps the text and any other fields", () => {
    const [synced] = applySync([{ start: 1, end: 2, text: "<i>Hello?</i>" }], 1, 1);
    assert.equal(synced.text, "<i>Hello?</i>");
  });

  await t.test("applies a per-cue offset when piecewise sync ran", () => {
    const synced = applySync([cue(1, 2), cue(10, 11), cue(20, 21)], 1, 0, [0, 6, 6]);
    assert.deepEqual(synced.map((c) => c.start), [1, 16, 26]);
    // Durations are preserved — each cue moves, none stretches.
    assert.deepEqual(synced.map((c) => c.end - c.start), [1, 1, 1]);
  });

  await t.test("falls back to the global offset for a missing per-cue entry", () => {
    const synced = applySync([cue(1, 2), cue(10, 11)], 1, 4, [0]);
    assert.deepEqual(synced.map((c) => c.start), [1, 14]);
  });

  await t.test("drops a cue whose timestamps are unusable", () => {
    // These never took part in the alignment, so there is no offset that is
    // honestly theirs — and a VTTCue built from NaN throws outright.
    const synced = applySync(
      [
        { start: Number.NaN, end: 2, text: "a" },
        { start: 1, end: Number.POSITIVE_INFINITY, text: "b" },
        cue(10, 12),
      ],
      1,
      3,
    );
    assert.equal(synced.length, 1);
    assert.equal(synced[0].start, 13);
  });

  await t.test("drops cues pushed before zero, and clamps a straddling one", () => {
    // ffsubsync writes negative timestamps into the file, where they become
    // malformed SRT. Our sink is a VTTCue, which refuses them outright — so
    // this diverges deliberately, matching what shiftCues has always done.
    const synced = applySync([cue(1, 2), cue(3, 6), cue(20, 21)], 1, -4);
    assert.equal(synced.length, 2);
    assert.equal(synced[0].start, 0);
    assert.equal(synced[0].end, 2);
    assert.equal(synced[1].start, 16);
  });
});

test("alignCues", async (t) => {
  await t.test("recovers a plain delay", () => {
    const cues = dialogue(30);
    const outcome = alignCues(referenceFor(cues, 4.2), cues);
    assert.equal(outcome.scaleFactor, 1);
    assert.ok(Math.abs(outcome.offsetSeconds - 4.2) < 0.011, `offset ${outcome.offsetSeconds}`);
    assert.deepEqual(outcome.qualityReasons, []);
    assert.ok(outcome.confidence > 0.5, `confidence ${outcome.confidence}`);
    assert.equal(outcome.perCueOffsetsSeconds, null);
  });

  await t.test("recovers a framerate stretch", () => {
    const cues = dialogue(40);
    const ratio = 25 / 24;
    const outcome = alignCues(referenceFor(cues, 0, ratio), cues);
    assert.ok(Math.abs(outcome.scaleFactor - ratio) < 1e-9, `scale ${outcome.scaleFactor}`);
    assert.ok(Math.abs(outcome.offsetSeconds) < 0.02, `offset ${outcome.offsetSeconds}`);
  });

  await t.test("can be told not to look for a framerate correction", () => {
    const cues = dialogue(40);
    const outcome = alignCues(referenceFor(cues, 0, 25 / 24), cues, { noFixFramerate: true });
    assert.equal(outcome.scaleFactor, 1);
  });

  await t.test("finds a mid-file break when piecewise sync is enabled", () => {
    // Half the film is right; the second half is 8 s early. No single shift
    // can fix that, which is the whole reason the piecewise pass exists.
    const cues = dialogue(30);
    const reference = new Float64Array(4000 * SAMPLE_RATE);
    cues.forEach((c, index) => {
      const shift = index < 15 ? 0 : 8;
      reference.fill(1, Math.round((c.start + shift) * SAMPLE_RATE), Math.round((c.end + shift) * SAMPLE_RATE));
    });

    const single = alignCues(reference, cues);
    const piecewise = alignCues(reference, cues, { splitPenaltySeconds: 5 });

    assert.equal(single.perCueOffsetsSeconds, null);
    assert.ok(piecewise.perCueOffsetsSeconds, "expected per-cue offsets");
    assert.ok(Math.abs(piecewise.perCueOffsetsSeconds![0]) < 0.02, "first half should not move");
    assert.ok(Math.abs(piecewise.perCueOffsetsSeconds![29] - 8) < 0.02, "second half should move 8s");
    assert.ok((piecewise.segments?.length ?? 0) >= 2, "expected at least two segments");
  });

  await t.test("reports the MEDIAN as the offset in piecewise mode", () => {
    const cues = dialogue(30);
    const reference = new Float64Array(4000 * SAMPLE_RATE);
    cues.forEach((c, index) => {
      const shift = index < 15 ? 0 : 8;
      reference.fill(1, Math.round((c.start + shift) * SAMPLE_RATE), Math.round((c.end + shift) * SAMPLE_RATE));
    });
    const piecewise = alignCues(reference, cues, { splitPenaltySeconds: 5 });
    const sorted = [...piecewise.perCueOffsetsSeconds!].sort((a, b) => a - b);
    const median = (sorted[14] + sorted[15]) / 2;
    assert.ok(Math.abs(piecewise.offsetSeconds - median) < 1e-9);
  });

  await t.test("refuses a subtitle with nothing to align", () => {
    assert.throws(() => alignCues(new Float64Array(1000), []), FailedToFindAlignmentError);
    assert.throws(
      () => alignCues(new Float64Array(1000), [cue(1, 2)], { startSeconds: 500 }),
      FailedToFindAlignmentError,
    );
  });

  await t.test("flags an alignment against unrelated speech as untrustworthy", () => {
    // Subtitles from a different film: the correlation still returns a peak,
    // because it always does. The gate is what stops that peak being applied.
    const cues = dialogue(30);
    const unrelated = new Float64Array(4000 * SAMPLE_RATE);
    for (let start = 0; start < 3900; start += 7.3) {
      unrelated.fill(1, Math.round(start * SAMPLE_RATE), Math.round((start + 0.4) * SAMPLE_RATE));
    }
    const outcome = alignCues(unrelated, cues);
    assert.ok(outcome.qualityReasons.length > 0, `accepted a bogus alignment: ${outcome.confidence}`);
  });
});

test("the piecewise path against a cue list preprocessing prunes", async (t) => {
  /**
   * Build a subtitle whose second half is late, with junk cues at the front
   * that `preprocessCues` will drop. The per-cue offsets come back indexed
   * against the PREPARED list, and are applied to the caller's list — so if
   * the two are not mapped, every cue takes its neighbour's offset.
   */
  const build = () => {
    const good = Array.from({ length: 30 }, (_, i) =>
      cue(20 + i * 20, 23 + i * 20, `real line ${i}`),
    );
    const reference = new Float64Array(4000 * SAMPLE_RATE);
    good.forEach((c, index) => {
      const shift = index < 15 ? 0 : 9;
      reference.fill(1, Math.round((c.start + shift) * SAMPLE_RATE), Math.round((c.end + shift) * SAMPLE_RATE));
    });
    const junk: SubtitleCue[] = [
      { start: Number.NaN, end: 2, text: "unparseable" },
      { start: -5, end: -1, text: "before zero" },
    ];
    return { cues: [...junk, ...good], good, reference, dropped: junk.length };
  };

  await t.test("maps per-cue offsets back onto the caller's indices", () => {
    const { cues, good, reference, dropped } = build();
    const outcome = alignCues(reference, cues, { splitPenaltySeconds: 5, noFixFramerate: true });
    assert.ok(outcome.perCueOffsetsSeconds, "expected per-cue offsets");
    assert.equal(outcome.perCueOffsetsSeconds!.length, cues.length, "one offset per INPUT cue");

    // The break is between good[14] and good[15], which sit at cues[16]/[17].
    const offsets = outcome.perCueOffsetsSeconds!;
    assert.ok(Math.abs(offsets[dropped + 14] - 0) < 0.05, `cue 14 got ${offsets[dropped + 14]}`);
    assert.ok(Math.abs(offsets[dropped + 15] - 9) < 0.05, `cue 15 got ${offsets[dropped + 15]}`);
    assert.equal(offsets.length - dropped, good.length);
  });

  await t.test("ships cues that land where the reference speaks", () => {
    const { cues, reference, dropped } = build();
    const result = runAlignment(reference, cues, "audio-vad", "web", "web", {
      splitPenaltySeconds: 5,
      noFixFramerate: true,
    });
    assert.equal(result.applied, true, result.qualityReasons.join("; "));
    // Every cue that took part in the alignment must sit on reference speech.
    // An index slip shifts the segment boundary and leaves a couple of them
    // seconds out. The junk cues are excluded: they were never aligned, so
    // there is no position that would be right for them.
    const aligned = result.subtitles.filter((synced) => synced.text.startsWith("real line "));
    assert.equal(aligned.length, result.subtitles.length - 1, "expected one junk cue to survive");
    for (const synced of aligned) {
      const at = Math.round((synced.start + 0.05) * SAMPLE_RATE);
      assert.equal(reference[at], 1, `${synced.text} landed on silence at ${synced.start.toFixed(2)}s`);
    }
    assert.ok(dropped > 0);
  });

  await t.test("scores the cues it ships, not a different copy", () => {
    // The confidence pass must run on the caller's list too — otherwise a
    // corrupted result comes back with a confidence of 1.
    const { cues, reference } = build();
    const good = alignCues(reference, cues, { splitPenaltySeconds: 5, noFixFramerate: true });
    assert.ok(good.confidence > 0.9, `confidence ${good.confidence}`);

    // The same cues against unrelated speech must NOT score highly.
    const unrelated = new Float64Array(4000 * SAMPLE_RATE);
    for (let start = 0; start < 3900; start += 7.3) {
      unrelated.fill(1, Math.round(start * SAMPLE_RATE), Math.round((start + 0.4) * SAMPLE_RATE));
    }
    const bad = alignCues(unrelated, cues, { noFixFramerate: true });
    assert.ok(bad.confidence < good.confidence, `${bad.confidence} vs ${good.confidence}`);
  });
});

test("runAlignment", async (t) => {
  const cues = dialogue(30);

  await t.test("packages an accepted result for the player", () => {
    const result = runAlignment(referenceFor(cues, 2.37), cues, "audio-vad", "web", "web");
    assert.equal(result.applied, true);
    assert.equal(result.processingMode, "web");
    assert.equal(result.engine, "web");
    assert.equal(result.reference, "audio-vad");
    assert.ok(Math.abs(result.offsetMs - 2370) < 11, `offsetMs ${result.offsetMs}`);
    assert.equal(result.subtitles.length, cues.length);
    assert.ok(Math.abs(result.subtitles[0].start - (cues[0].start + 2.37)) < 0.011);
    assert.deepEqual(result.qualityReasons, []);
    assert.equal(result.perCueOffsetsMs, null);
  });

  await t.test("returns the ORIGINAL cues when the gate rejects the result", () => {
    // A rejected sync must not throw — the UI needs to explain itself — and
    // above all must not hand back cues it does not trust.
    const unrelated = new Float64Array(4000 * SAMPLE_RATE);
    for (let start = 0; start < 3900; start += 7.3) {
      unrelated.fill(1, Math.round(start * SAMPLE_RATE), Math.round((start + 0.4) * SAMPLE_RATE));
    }
    const result = runAlignment(unrelated, cues, "audio-vad", "web", "web");
    assert.equal(result.applied, false);
    assert.ok(result.qualityReasons.length > 0);
    assert.deepEqual(result.subtitles, cues);
  });

  await t.test("reports per-cue offsets in milliseconds", () => {
    const reference = new Float64Array(4000 * SAMPLE_RATE);
    cues.forEach((c, index) => {
      const shift = index < 15 ? 0 : 8;
      reference.fill(1, Math.round((c.start + shift) * SAMPLE_RATE), Math.round((c.end + shift) * SAMPLE_RATE));
    });
    const result = runAlignment(reference, cues, "audio-vad", "native", "native-ffmpeg", {
      splitPenaltySeconds: 5,
    });
    assert.equal(result.processingMode, "native");
    assert.ok(result.perCueOffsetsMs);
    assert.ok(Math.abs(result.perCueOffsetsMs![29] - 8000) < 20);
    assert.ok((result.segments?.length ?? 0) >= 2);
  });

  await t.test("produces the same answer whichever engine label it carries", () => {
    // Native-fallback and web-only run this exact code; the label is metadata,
    // not behaviour. If that ever stops being true, this catches it.
    const reference = referenceFor(cues, 3.5);
    const web = runAlignment(reference, cues, "audio-vad", "web", "web");
    const native = runAlignment(reference, cues, "audio-vad", "native", "native-ffmpeg");
    assert.equal(web.offsetMs, native.offsetMs);
    assert.equal(web.framerateScaleFactor, native.framerateScaleFactor);
    assert.equal(web.score, native.score);
    assert.deepEqual(web.subtitles, native.subtitles);
  });
});
