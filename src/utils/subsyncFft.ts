/**
 * Radix-2 complex FFT, hand-rolled.
 *
 * ffsubsync aligns subtitles by cross-correlating two speech signals through
 * `np.fft`. There is no numpy in a browser and no FFT crate in this project's
 * deliberately lean dependency set, so the transform lives here — the same
 * ~100 lines on both sides of the app, which turns any future native/web
 * divergence into a readable code diff rather than a library-version mystery.
 *
 * In-place, iterative Cooley-Tukey over separate real/imaginary Float64Arrays
 * (rather than interleaved pairs) because the caller feeds real signals: the
 * imaginary half starts as zeros and never has to be woven in.
 *
 * Sizes here are large — a 3-hour film at 100 Hz correlates at N = 2^21 — so
 * the recursive formulation would blow the stack and the allocation churn
 * would dominate. Everything below allocates once per transform.
 */

/**
 * Round up to a power of two, which is all the radix-2 butterfly accepts.
 *
 * By doubling rather than `2 ** ceil(log2(n))`: upstream uses the logarithm
 * form and at large n a float rounding of 29.000000000000004 silently doubles
 * the transform. Extra padding changes neither the offset nor the score (the
 * correlation is already zero-padded past any wraparound), so this is a
 * performance-only divergence — but it is one worth not having.
 */
export const nextPowerOfTwo = (n: number): number => {
  let size = 1;
  while (size < n) size *= 2;
  return size;
};

/**
 * Bit-reversal permutation.
 *
 * Computed with the incremental "add one to a reversed counter" trick rather
 * than reversing each index from scratch: at N = 2^21 the naive form is 21
 * shifts per element and shows up in a profile.
 */
const bitReverseInPlace = (re: Float64Array, im: Float64Array): void => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
};

/**
 * Twiddle factors for one transform length, shared by every stage.
 *
 * `exp(-2*pi*i*k/len)` for a stage of size `len` is `table[k * (n / len)]`, so a
 * single half-length table serves the whole transform. Built from real
 * `cos`/`sin` per entry rather than the usual incremental recurrence: the
 * recurrence drifts over the ~2^20 steps a feature-length file needs, and that
 * drift is enough to flip which of two EQUAL correlation peaks wins — a
 * one-sample difference in the answer, produced by nothing but arithmetic noise.
 *
 * Cached because the framerate search runs ~7 transforms at the same length.
 */
let twiddleCache: { n: number; re: Float64Array; im: Float64Array } | null = null;

const twiddles = (n: number): { re: Float64Array; im: Float64Array } => {
  if (twiddleCache && twiddleCache.n === n) return twiddleCache;
  const half = n >> 1;
  const re = new Float64Array(half);
  const im = new Float64Array(half);
  for (let k = 0; k < half; k += 1) {
    const angle = (-2 * Math.PI * k) / n;
    re[k] = Math.cos(angle);
    im[k] = Math.sin(angle);
  }
  twiddleCache = { n, re, im };
  return twiddleCache;
};

/** Drop the cached table — worth doing once a long alignment is finished. */
export const releaseFftCache = (): void => {
  twiddleCache = null;
};

/**
 * Forward (`inverse = false`) or inverse transform, in place.
 *
 * The inverse is the forward transform with the twiddle sign flipped and a
 * final 1/N scaling — matching numpy's convention, where `ifft` normalizes and
 * `fft` does not. Getting that scaling wrong would leave the correlation peak
 * in the right PLACE but at N times the value, which quietly breaks every
 * score comparison while the offsets still look correct.
 */
export const fftInPlace = (re: Float64Array, im: Float64Array, inverse: boolean): void => {
  const n = re.length;
  if (n !== im.length) throw new Error("fft: real and imaginary parts must be the same length");
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft: length ${n} is not a power of two`);

  bitReverseInPlace(re, im);
  const w = twiddles(n);
  const sign = inverse ? -1 : 1;

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k += 1) {
        const wRe = w.re[k * stride];
        const wIm = sign * w.im[k * stride];
        const a = i + k;
        const b = a + half;
        const vRe = re[b] * wRe - im[b] * wIm;
        const vIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - vRe;
        im[b] = im[a] - vIm;
        re[a] += vRe;
        im[a] += vIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
};

/** Convenience wrapper for tests and one-off transforms of a real signal. */
export const fftReal = (input: ArrayLike<number>): { re: Float64Array; im: Float64Array } => {
  const n = nextPowerOfTwo(input.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < input.length; i += 1) re[i] = input[i];
  fftInPlace(re, im, false);
  return { re, im };
};
