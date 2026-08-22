import test from "node:test";
import assert from "node:assert/strict";
import { fftInPlace, fftReal, nextPowerOfTwo, releaseFftCache } from "./subsyncFft.ts";

/** The O(n^2) definition, to check the fast one against. */
const naiveDft = (input: number[]): { re: number[]; im: number[] } => {
  const n = input.length;
  const re = new Array<number>(n).fill(0);
  const im = new Array<number>(n).fill(0);
  for (let k = 0; k < n; k += 1) {
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      re[k] += input[t] * Math.cos(angle);
      im[k] += input[t] * Math.sin(angle);
    }
  }
  return { re, im };
};

test("nextPowerOfTwo", async (t) => {
  await t.test("rounds up, and leaves exact powers alone", () => {
    assert.equal(nextPowerOfTwo(1), 1);
    assert.equal(nextPowerOfTwo(2), 2);
    assert.equal(nextPowerOfTwo(3), 4);
    assert.equal(nextPowerOfTwo(1024), 1024);
    assert.equal(nextPowerOfTwo(1025), 2048);
  });

  await t.test("is exact where the logarithm form is not", () => {
    // 2 ** Math.ceil(Math.log2(n)) can overshoot on large exact powers; the
    // doubling form cannot. Only a performance difference, but a real one.
    for (const exponent of [20, 21, 22, 23, 24, 25, 26, 27, 28, 29]) {
      assert.equal(nextPowerOfTwo(2 ** exponent), 2 ** exponent, `2^${exponent}`);
    }
  });
});

test("fftInPlace", async (t) => {
  await t.test("agrees with the naive DFT", () => {
    const input = Array.from({ length: 64 }, (_, i) => Math.sin(i / 3) + (i % 7) / 5);
    const expected = naiveDft(input);
    const { re, im } = fftReal(input);
    for (let k = 0; k < input.length; k += 1) {
      assert.ok(Math.abs(re[k] - expected.re[k]) < 1e-9, `re[${k}] ${re[k]} vs ${expected.re[k]}`);
      assert.ok(Math.abs(im[k] - expected.im[k]) < 1e-9, `im[${k}] ${im[k]} vs ${expected.im[k]}`);
    }
  });

  await t.test("round-trips through the inverse", () => {
    const n = 256;
    const original = Float64Array.from({ length: n }, (_, i) => Math.cos(i / 5) * (1 + (i % 3)));
    const re = Float64Array.from(original);
    const im = new Float64Array(n);
    fftInPlace(re, im, false);
    fftInPlace(re, im, true);
    for (let i = 0; i < n; i += 1) {
      assert.ok(Math.abs(re[i] - original[i]) < 1e-9, `sample ${i}`);
      assert.ok(Math.abs(im[i]) < 1e-9, `imaginary residue at ${i}`);
    }
  });

  await t.test("normalizes only the inverse, as numpy does", () => {
    // A constant signal transforms to [n, 0, 0, ...] forward, and back to the
    // constant. If the 1/N landed on the forward transform instead, every
    // correlation score would be N times too small while the offsets still
    // looked right — which is exactly the kind of bug that hides.
    const n = 8;
    const re = new Float64Array(n).fill(1);
    const im = new Float64Array(n);
    fftInPlace(re, im, false);
    assert.ok(Math.abs(re[0] - n) < 1e-9, `DC bin ${re[0]}`);
    fftInPlace(re, im, true);
    assert.ok(Math.abs(re[3] - 1) < 1e-9);
  });

  await t.test("rejects a length that is not a power of two", () => {
    assert.throws(() => fftInPlace(new Float64Array(6), new Float64Array(6), false), /power of two/);
  });

  await t.test("survives the twiddle cache being dropped mid-flight", () => {
    const first = fftReal([1, 0, 1, 0, 1, 0, 1, 0]);
    releaseFftCache();
    const second = fftReal([1, 0, 1, 0, 1, 0, 1, 0]);
    for (let i = 0; i < first.re.length; i += 1) {
      assert.ok(Math.abs(first.re[i] - second.re[i]) < 1e-12);
    }
  });
});
