import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAMERATE_RATIOS,
  FailedToFindAlignmentError,
  assessAlignmentQuality,
  confidenceFromCoverage,
  crossCorrelate,
  speechCoverage,
  framerateCandidates,
  goldenSectionSearch,
  searchFramerate,
} from "./subsyncAlign.ts";
import { SAMPLE_RATE } from "./subsyncSpeech.ts";
import type { SubtitleCue } from "./subtitles.ts";

const bits = (pattern: string): number[] => [...pattern].map(Number);

/** A signal with `spans` of speech (in samples) on a silent background. */
const signal = (length: number, spans: [number, number][], amplitude = 1): Float64Array => {
  const out = new Float64Array(length);
  for (const [from, to] of spans) out.fill(amplitude, from, to);
  return out;
};

const cue = (start: number, end: number, text = "hello there"): SubtitleCue => ({ start, end, text });

test("crossCorrelate", async (t) => {
  await t.test("reproduces ffsubsync's own alignment vectors", () => {
    // Straight from ffsubsync's tests/test_alignment.py. Note the argument
    // ORDER there: it calls fit_transform(s2, s1), so s2 is the reference.
    // Getting that backwards flips the sign of every result in this file.
    const cases: [string, string, number][] = [
      ["11001", "111001", -1],
      ["1001", "1001", 0],
      ["01001", "10010", 1],
    ];
    for (const [reference, subtitle, expected] of cases) {
      assert.equal(
        crossCorrelate(bits(reference), bits(subtitle)).offset,
        expected,
        `ref ${reference} / sub ${subtitle}`,
      );
    }
  });

  await t.test("a positive offset means the subtitles move LATER", () => {
    // The reference speaks at 30-40; the subtitle sits at 10-20. To line up,
    // the subtitle has to move 20 samples later, so the offset is +20.
    const late = crossCorrelate(signal(60, [[30, 40]]), signal(60, [[10, 20]]));
    assert.equal(late.offset, 20);

    const early = crossCorrelate(signal(60, [[10, 20]]), signal(60, [[30, 40]]));
    assert.equal(early.offset, -20);
  });

  await t.test("recovers an arbitrary shift of a speech-like signal", () => {
    const spans: [number, number][] = [
      [40, 95], [150, 205], [260, 300], [410, 470], [600, 640], [700, 780],
    ];
    for (const shift of [0, 3, -1, 37, -37, 250, -250]) {
      const reference = signal(1200, spans);
      const shifted = signal(
        1200,
        spans.map(([from, to]) => [from - shift, to - shift] as [number, number]),
      );
      assert.equal(crossCorrelate(reference, shifted, 6000).offset, shift, `shift ${shift}`);
    }
  });

  await t.test("refuses to invent an alignment for empty speech", () => {
    assert.throws(() => crossCorrelate([], [1, 0, 1]), FailedToFindAlignmentError);
    assert.throws(() => crossCorrelate([1, 0, 1], []), FailedToFindAlignmentError);
    // Both empty would reach log2(0) before any of that.
    assert.throws(() => crossCorrelate([], []), FailedToFindAlignmentError);
  });

  await t.test("keeps the peak out of range from winning", () => {
    const spans: [number, number][] = [
      [400, 900], [1500, 2000], [2600, 3000], [4100, 4700], [6000, 6400], [7000, 7800],
    ];
    const reference = signal(12_000, spans);
    const subtitle = signal(12_000, spans.map(([a, b]) => [a - 300, b - 300] as [number, number]));

    // Verified against ffsubsync itself: offset +300, score 11700.
    const found = crossCorrelate(reference, subtitle, 6000);
    assert.equal(found.offset, 300);
    assert.ok(Math.abs(found.score - 11_700) < 1e-6, `score ${found.score}`);

    // The window is inclusive of +maxOffset and exclusive of -maxOffset, so the
    // true answer survives at exactly 300 and is unreachable at 100.
    assert.equal(crossCorrelate(reference, subtitle, 300).offset, 300);
    assert.equal(crossCorrelate(reference, subtitle, 100).offset, 100);
    assert.equal(crossCorrelate(reference, subtitle, 299).offset, 299);
  });

  await t.test("scores agreement, not volume", () => {
    // A matched pair must beat a mismatched one carrying the same speech mass.
    // A tolerance of 1 pins both to the same near-zero lag so the comparison is
    // about fit and nothing else. (Zero would mask every lag — see below.)
    const reference = signal(4000, [[1000, 1400], [2000, 2600]]);
    const aligned = crossCorrelate(reference, signal(4000, [[1000, 1400], [2000, 2600]]), 1);
    const wrong = crossCorrelate(reference, signal(4000, [[1500, 1900], [3000, 3600]]), 1);
    assert.ok(aligned.score > wrong.score, `${aligned.score} vs ${wrong.score}`);
  });

  await t.test("a zero tolerance masks every lag, as upstream leaves it", () => {
    // Degenerate input: ffsubsync's own masking makes the two -inf ranges meet,
    // so nothing survives the argmax. Reproduced rather than special-cased —
    // the caller's range filter rejects the nonsense offset that comes back,
    // which is the right outcome by a slightly roundabout route.
    const result = crossCorrelate(signal(400, [[100, 200]]), signal(400, [[100, 200]]), 0);
    assert.equal(result.score, Number.NEGATIVE_INFINITY);
  });

  await t.test("silence agrees with silence, which is why offsets stay small", () => {
    // Worth pinning, because it looks like a bug the first time it is met.
    // Both signals are mapped to ±1, so the SILENT stretches agree too, and a
    // shift is charged for the non-overlapping tails it creates. A shift
    // comparable to the length of the file therefore SCORES WORSE than leaving
    // things alone, even when it lines the speech up perfectly.
    //
    // That is fine — a real subtitle is out by seconds against a file that runs
    // for hours — but it is exactly why the reference has to cover the whole
    // timeline rather than a sampled slice of it.
    const reference = signal(2000, [[1500, 1560], [1700, 1760]]);
    const subtitle = signal(2000, [[100, 160], [300, 360]]);
    const perfectButFarAway = 2000 - 2 * 120; // every "1" matched, 1400 samples of tail lost
    const found = crossCorrelate(reference, subtitle, 6000);
    assert.ok(found.score > perfectButFarAway - 1400, `score ${found.score}`);
    assert.ok(Math.abs(found.offset) < 1400, `offset ${found.offset} chased the speech`);
  });
});

test("framerateCandidates", async (t) => {
  await t.test("is 1.0 plus each ratio and its reciprocal", () => {
    const candidates = framerateCandidates(false);
    assert.equal(candidates.length, 1 + FRAMERATE_RATIOS.length * 2);
    assert.equal(candidates[0], 1);
    assert.deepEqual(candidates.slice(1, 4), FRAMERATE_RATIOS);
    // 24/23.976, 25/23.976, 25/24 — computed, never hard-coded, so the float
    // values match ffsubsync's bit for bit.
    assert.ok(Math.abs(FRAMERATE_RATIOS[0] - 24 / 23.976) < 1e-15);
    assert.ok(Math.abs(candidates[6] - 24 / 25) < 1e-15);
  });

  await t.test("collapses to just 1.0 when framerate fixing is off", () => {
    assert.deepEqual(framerateCandidates(true), [1]);
  });
});

test("searchFramerate", async (t) => {
  await t.test("finds a plain shift with no framerate correction", () => {
    // Cues every 10s, and a reference where each lands 4.2s later.
    const cues = Array.from({ length: 24 }, (_, i) => cue(10 + i * 10, 12.5 + i * 10));
    const reference = new Float64Array(4000);
    for (const c of cues) {
      reference.fill(1, Math.round((c.start + 4.2) * SAMPLE_RATE), Math.round((c.end + 4.2) * SAMPLE_RATE));
    }
    const result = searchFramerate(reference, cues);
    assert.equal(result.scaleFactor, 1);
    assert.equal(result.offsetSamples / SAMPLE_RATE, 4.2);
  });

  await t.test("recovers a framerate stretch", () => {
    // A 25 fps subtitle against a 24 fps encode: the error grows with the
    // timestamp, so no single shift can fix it. The reference must span the
    // SCALED cues (to 1255s here) — truncate it and the search happily picks
    // the right ratio with a wildly wrong offset.
    //
    // Scores verified against ffsubsync itself: 121709.68 at ratio 25/24,
    // offset 0, against 116954.4 for the next-best ratio.
    const ratio = 25 / 24;
    const cues = Array.from({ length: 40 }, (_, i) => cue(5 + i * 30, 8 + i * 30));
    const reference = new Float64Array(130_000);
    for (const c of cues) {
      reference.fill(1, Math.round(c.start * ratio * SAMPLE_RATE), Math.round(c.end * ratio * SAMPLE_RATE));
    }
    const result = searchFramerate(reference, cues);
    assert.ok(Math.abs(result.scaleFactor - ratio) < 1e-9, `scale ${result.scaleFactor}`);
    assert.equal(result.offsetSamples, 0);
    assert.ok(Math.abs(result.score - 121_709.68) < 0.01, `score ${result.score}`);
  });

  await t.test("discards out-of-range candidates rather than scoring them down", () => {
    const cues = Array.from({ length: 12 }, (_, i) => cue(5 + i * 20, 7 + i * 20));
    // Long enough to hold the cues AT their true position (+120s), or the
    // search is aligning against a signal that stops halfway through.
    const reference = new Float64Array(60_000);
    for (const c of cues) {
      reference.fill(1, Math.round((c.start + 120) * SAMPLE_RATE), Math.round((c.end + 120) * SAMPLE_RATE));
    }
    // The real answer is +120s, outside a 30s tolerance. Upstream filters, so
    // this must not come back as a clamped 30s — it must fail or find another
    // in-range alignment, never a wrong one dressed up as in-range.
    let offsetSeconds: number | null = null;
    try {
      offsetSeconds = searchFramerate(reference, cues, { maxOffsetSeconds: 30 }).offsetSamples / SAMPLE_RATE;
    } catch (error) {
      assert.ok(error instanceof FailedToFindAlignmentError);
    }
    if (offsetSeconds !== null) assert.ok(Math.abs(offsetSeconds) <= 30);

    // With room to reach it, the same data finds it exactly.
    const generous = searchFramerate(reference, cues, { maxOffsetSeconds: 200 });
    assert.equal(generous.offsetSamples / SAMPLE_RATE, 120);
  });

  await t.test("throws when nothing can be aligned", () => {
    assert.throws(
      () => searchFramerate(new Float64Array(500), [cue(1, 2)], { maxOffsetSeconds: 0 }),
      FailedToFindAlignmentError,
    );
  });
});

test("goldenSectionSearch", async (t) => {
  await t.test("brackets the minimum of a smooth function", () => {
    const [low, high] = goldenSectionSearch((x) => (x - 1.037) ** 2, 0.9, 1.1, 1e-5);
    assert.ok(low <= 1.037 && 1.037 <= high, `bracket ${low}..${high}`);
    assert.ok(high - low <= 1e-4);
  });

  await t.test("flags exactly the probes ffsubsync would keep", () => {
    // Upstream competes the LAST probe against the discrete ratios, not the
    // best one. Preserved deliberately, so the flag has to arrive on the final
    // evaluations and nowhere else.
    const flagged: number[] = [];
    let calls = 0;
    goldenSectionSearch(
      (x, isLast) => {
        calls += 1;
        if (isLast) flagged.push(x);
        return (x - 1) ** 2;
      },
      0.9,
      1.1,
    );
    assert.ok(calls > 10, `only ${calls} evaluations`);
    assert.ok(flagged.length >= 1 && flagged.length <= 2, `flagged ${flagged.length}`);
  });

  await t.test("returns the interval untouched when it is already inside tolerance", () => {
    assert.deepEqual(goldenSectionSearch(() => 0, 1, 1.00001, 1e-4), [1, 1.00001]);
  });
});

test("confidence and the quality gate", async (t) => {
  await t.test("coverage measures where the subtitle's speech lands", () => {
    const reference = signal(1000, [[100, 200], [500, 600]]);
    const onSpeech = signal(1000, [[100, 200]]);
    const onSilence = signal(1000, [[300, 400]]);
    const half = signal(1000, [[150, 250]]);

    assert.deepEqual(speechCoverage(reference, onSpeech), { coverage: 1, density: 0.2 });
    assert.deepEqual(speechCoverage(reference, onSilence), { coverage: 0, density: 0.2 });
    assert.equal(speechCoverage(reference, half).coverage, 0.5);
    // A silent subtitle divides by nothing.
    assert.equal(speechCoverage(reference, new Float64Array(10)).coverage, 0);
  });

  await t.test("confidence is a skill score against chance", () => {
    // Landing on speech at the reference's own speech density is exactly what
    // luck gives you, so that is the zero point — not "no overlap at all".
    assert.equal(confidenceFromCoverage(1, 0.4), 1);
    assert.equal(confidenceFromCoverage(0.4, 0.4), 0);
    assert.ok(confidenceFromCoverage(0.2, 0.4) < 0);
    assert.ok(Math.abs(confidenceFromCoverage(0.7, 0.4) - 0.5) < 1e-9);
    // A reference that is speech end to end can only be matched, never beaten.
    assert.equal(confidenceFromCoverage(1, 1), 1);
    assert.equal(confidenceFromCoverage(0.9, 1), 0);
  });

  await t.test("confidence does not exceed 1 on a sparse subtitle", () => {
    // The raw correlation score does — silence agreeing with silence inflates
    // it well past the subtitle's own speech mass, which is why it is not the
    // basis for this number.
    const reference = signal(6000, [[500, 900], [1800, 2400], [3300, 3800], [4600, 5200]]);
    const subtitle = signal(6000, [[500, 900], [1800, 2400], [3300, 3800], [4600, 5200]]);
    const { coverage, density } = speechCoverage(reference, subtitle);
    const confidence = confidenceFromCoverage(coverage, density);
    assert.equal(confidence, 1);
    assert.ok(crossCorrelate(reference, subtitle, 6000).score > 4000, "raw score is much larger");
  });

  const passing = {
    score: 5000,
    confidence: 0.8,
    offsetSeconds: 2.37,
    scaleFactor: 1,
    candidates: [
      { scaleFactor: 1, score: 5000, offset: 237, inRange: true },
      { scaleFactor: 25 / 24, score: 900, offset: 12, inRange: true },
    ],
  };

  await t.test("accepts a clean alignment", () => {
    assert.deepEqual(assessAlignmentQuality(passing), []);
  });

  await t.test("rejects an anti-correlated result", () => {
    assert.match(
      assessAlignmentQuality({ ...passing, score: -400, confidence: -0.4 })[0],
      /worse than they would by chance/,
    );
    // Either signal alone is enough: a positive raw peak can still sit below
    // chance once the reference's speech density is accounted for.
    assert.match(
      assessAlignmentQuality({ ...passing, confidence: -0.05 })[0],
      /worse than they would by chance/,
    );
  });

  await t.test("rejects a weak match", () => {
    const reasons = assessAlignmentQuality({ ...passing, confidence: 0.05 });
    assert.match(reasons[0], /weak/);
  });

  await t.test("rejects an implausible shift or framerate", () => {
    assert.match(assessAlignmentQuality({ ...passing, offsetSeconds: 55 })[0], /larger than/);
    assert.match(assessAlignmentQuality({ ...passing, scaleFactor: 1.5 })[0], /framerate/);
  });

  await t.test("rejects a near-tie that would land somewhere else", () => {
    // The runner-up scored within a hair AND puts the lines 8s earlier —
    // applying either would be a coin flip the user cannot see.
    const reasons = assessAlignmentQuality({
      ...passing,
      spanSeconds: 5400,
      candidates: [
        { scaleFactor: 1, score: 5000, offset: 237, inRange: true },
        { scaleFactor: 25 / 24, score: 4990, offset: -600, inRange: true },
      ],
    });
    assert.match(reasons[0], /equally well/);
  });

  await t.test("allows a near-tie that agrees on where the lines go", () => {
    // Two framerate hypotheses tie constantly on short subtitles, because over
    // a few minutes 24/23.976 and 1.0 differ by less than a cue's duration. But
    // when they tie they also AGREE, so there is nothing to reject: whichever
    // wins puts the lines in the same place.
    const ratio = 24 / 23.976;
    const spanSeconds = 300;
    const equivalentOffset = Math.round((237 / 100 + spanSeconds * (1 - ratio)) * 100);
    assert.deepEqual(
      assessAlignmentQuality({
        ...passing,
        spanSeconds,
        candidates: [
          { scaleFactor: 1, score: 5000, offset: 237, inRange: true },
          { scaleFactor: ratio, score: 4990, offset: equivalentOffset, inRange: true },
        ],
      }),
      [],
    );
  });

  await t.test("catches a framerate near-tie that only diverges at the end", () => {
    // Same offset at t=0, so a start-only comparison would call this fine —
    // but over three hours the two hypotheses drift 26s apart.
    const reasons = assessAlignmentQuality({
      ...passing,
      spanSeconds: 10_800,
      candidates: [
        { scaleFactor: 1, score: 5000, offset: 237, inRange: true },
        { scaleFactor: 25 / 24, score: 4995, offset: 237, inRange: true },
      ],
    });
    assert.match(reasons[0], /equally well/);
  });

  await t.test("does not apply the framerate tie test to a piecewise result", () => {
    // A subtitle that drifts partway through is precisely the case where a
    // steady stretch ties with the truth — and the piecewise pass has already
    // chosen between them under its own objective.
    const ambiguous = {
      ...passing,
      spanSeconds: 5400,
      candidates: [
        { scaleFactor: 1, score: 5000, offset: 237, inRange: true },
        { scaleFactor: 25 / 24, score: 4990, offset: -600, inRange: true },
      ],
    };
    assert.match(assessAlignmentQuality(ambiguous)[0], /equally well/);
    assert.deepEqual(assessAlignmentQuality({ ...ambiguous, piecewise: true }), []);
  });

  await t.test("still rejects a bad piecewise result on its own merits", () => {
    assert.match(
      assessAlignmentQuality({ ...passing, piecewise: true, confidence: 0.02 })[0],
      /weak/,
    );
    assert.match(
      assessAlignmentQuality({ ...passing, piecewise: true, scaleFactor: 1.5 })[0],
      /framerate/,
    );
  });

  await t.test("does not call a lone candidate ambiguous", () => {
    assert.deepEqual(
      assessAlignmentQuality({
        ...passing,
        candidates: [{ scaleFactor: 1, score: 5000, offset: 237, inRange: true }],
      }),
      [],
    );
  });
});
