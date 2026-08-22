import test from "node:test";
import assert from "node:assert/strict";
import { AUDIO_FRAME_RATE, SpeechAccumulator, detectSpeech } from "./subsyncVad.ts";
import { SAMPLE_RATE } from "./subsyncSpeech.ts";

const SAMPLES_PER_WINDOW = AUDIO_FRAME_RATE / SAMPLE_RATE;

/**
 * Synthetic PCM: loud inside the given 10 ms window ranges, silent elsewhere.
 * Amplitude 6000 puts the window's mean square far above the 1e5 the 50 dB
 * gate needs; 0 puts it at the floor.
 */
const pcm = (spans: [number, number][], windows: number, frameRate = AUDIO_FRAME_RATE): Int16Array => {
  const perWindow = frameRate / SAMPLE_RATE;
  const out = new Int16Array(windows * perWindow);
  for (const [from, to] of spans) {
    for (let i = from * perWindow; i < Math.min(to * perWindow, out.length); i += 1) {
      out[i] = i % 2 === 0 ? 6000 : -6000;
    }
  }
  return out;
};

const ones = (signal: Float64Array): number => [...signal].filter((v) => v > 0.5).length;

// The expectations below were produced by running ffsubsync's `--vad auditok`
// detector (auditok 0.1.5) over the same PCM.
test("detectSpeech", async (t) => {
  await t.test("emits one sample per 10 ms", () => {
    assert.equal(detectSpeech(pcm([[30, 90]], 320)).length, 320);
    // A partial trailing window still gets a sample of its own.
    const ragged = new Int16Array(SAMPLES_PER_WINDOW * 10 + 7);
    assert.equal(detectSpeech(ragged).length, 11);
  });

  await t.test("finds runs of speech", () => {
    const speech = detectSpeech(pcm([[30, 90], [140, 260]], 320));
    assert.equal(speech[10], 0);
    assert.equal(speech[50], 1);
    assert.equal(speech[200], 1);
    assert.equal(speech[300], 0);
  });

  await t.test("counts tolerated silence toward the minimum length", () => {
    // 18 valid windows is under the 20-window (0.2 s) floor — but the token
    // stays open through the 25 windows of silence it is allowed to absorb, so
    // it closes at 43 and clears the floor after all. Surprising, and exactly
    // what auditok does, so both engines must agree on it.
    const speech = detectSpeech(pcm([[40, 58]], 120));
    assert.equal(ones(speech), 43);
    assert.equal(speech[39], 0);
    assert.equal(speech[40], 1);
    assert.equal(speech[82], 1);
    assert.equal(speech[83], 0);
  });

  await t.test("keeps a pause shorter than the silence tolerance inside one run", () => {
    // A 15-window gap is within the 25-window tolerance, so the two bursts stay
    // a single token and the pause between them reads as speech. That is what
    // makes the signal look like "someone is talking here" rather than a comb.
    const speech = detectSpeech(pcm([[20, 60], [75, 130]], 200));
    assert.equal(speech[65], 1);
    assert.equal(ones(speech), 135);
  });

  await t.test("splits on a pause longer than the tolerance", () => {
    const speech = detectSpeech(pcm([[20, 60], [110, 170]], 240));
    assert.equal(speech[30], 1);
    assert.equal(speech[85], 0);
    assert.equal(speech[150], 1);
  });

  await t.test("does not leak past a max-length truncation", () => {
    // 600 windows of continuous speech exceeds the 500-window (5 s) cap, so the
    // token is truncated and a second one continues from the next window.
    //
    // ffsubsync ASSIGNS its end marker, which the next token's start marker
    // then overwrites — after which its running sum never comes back down and
    // the rest of the block reads as speech. We accumulate instead, which is
    // the single place this port knowingly departs from upstream. See the note
    // in subsyncVad.ts.
    const speech = detectSpeech(pcm([[10, 610]], 700));
    assert.equal(speech[300], 1);
    assert.equal(speech[600], 1);
    assert.equal(speech[680], 0, "speech must end when the audio does");
  });

  await t.test("handles all-silent and all-loud audio", () => {
    assert.equal(ones(detectSpeech(pcm([], 150))), 0);
    assert.equal(ones(detectSpeech(pcm([[0, 150]], 150))), 150);
  });

  await t.test("works at any audio rate", () => {
    // The gate is a mean square over a 10 ms window, so it does not care how
    // finely that window was sampled — which is what lets the browser extract
    // at 16 kHz while ffsubsync's own default is 48 kHz.
    const at16k = detectSpeech(pcm([[20, 70], [120, 190]], 250, 16000), { frameRate: 16000 });
    const at48k = detectSpeech(pcm([[20, 70], [120, 190]], 250, 48000));
    assert.equal(at16k.length, at48k.length);
    assert.deepEqual([...at16k], [...at48k]);
  });

  await t.test("honours a non-zero non-speech label", () => {
    // Upstream's "not sure" label for detectors with poor recall.
    const speech = detectSpeech(pcm([[20, 70]], 150), { nonSpeechLabel: 0.25 });
    assert.equal(speech[100], 0.25);
    assert.equal(speech[40], 1);
  });

  await t.test("rejects an audio rate below the window rate", () => {
    assert.throws(() => detectSpeech(new Int16Array(10), { frameRate: 50 }), /at least/);
  });
});

test("SpeechAccumulator", async (t) => {
  await t.test("concatenates streamed blocks into one signal", () => {
    // Blocks are cut on whole windows, which is what lets a film be detected a
    // window at a time without ever holding its audio.
    const accumulator = new SpeechAccumulator();
    accumulator.push(pcm([[10, 90]], 100));
    accumulator.push(pcm([[0, 50]], 100));
    assert.equal(accumulator.processedSeconds, 2);
    const signal = accumulator.finish();
    assert.equal(signal.length, 200);
    assert.equal(signal[50], 1);
    assert.equal(signal[120], 1);
    assert.equal(signal[190], 0);
  });

  await t.test("matches a single pass over the same audio", () => {
    const whole = pcm([[10, 90], [140, 260]], 300);
    const accumulator = new SpeechAccumulator();
    accumulator.push(whole);
    assert.deepEqual([...accumulator.finish()], [...detectSpeech(whole)]);
  });

  await t.test("PLACES a block at its start time rather than appending", () => {
    // Each block is a separate ffmpeg invocation and may come back short. Under
    // concatenation every short block shifts everything after it, and the
    // shifts accumulate — so a long film ends up with a reference whose late
    // scenes are seconds from where they really are.
    const accumulator = new SpeechAccumulator();
    // A deliberately SHORT first block: 60 windows where 100 were asked for.
    accumulator.push(pcm([[10, 50]], 60), { startSeconds: 0 });
    accumulator.push(pcm([[10, 90]], 100), { startSeconds: 1 });
    const signal = accumulator.finish();
    assert.equal(signal.length, 200, "the timeline runs to the last block's end");
    // The second block's speech starts 10 windows into it, i.e. at 1.10s.
    assert.equal(signal[109], 0);
    assert.equal(signal[110], 1);
    // Appending would have put it at 60 + 10 = 70.
    assert.equal(signal[70], 0, "block 2 was appended instead of placed");
  });

  await t.test("does not drift over many ragged blocks", () => {
    const accumulator = new SpeechAccumulator();
    // 20 blocks, each one window shorter than the 100 it claims.
    for (let i = 0; i < 20; i += 1) {
      accumulator.push(pcm([[10, 60]], 99), { startSeconds: i });
    }
    const signal = accumulator.finish();
    // The last block's speech must still begin at 19s + 0.10s, not 19s minus
    // the 19 windows that concatenation would have lost.
    assert.equal(signal[1900 + 10], 1);
    assert.equal(signal[1900 + 9], 0);
  });

  await t.test("still appends when no start time is given", () => {
    const accumulator = new SpeechAccumulator();
    accumulator.push(pcm([[0, 50]], 60));
    accumulator.push(pcm([[0, 50]], 60));
    assert.equal(accumulator.finish().length, 120);
  });

  await t.test("resets after finishing", () => {
    const accumulator = new SpeechAccumulator();
    accumulator.push(pcm([[0, 50]], 100));
    accumulator.finish();
    assert.equal(accumulator.processedSeconds, 0);
    assert.equal(accumulator.finish().length, 0);
  });
});
