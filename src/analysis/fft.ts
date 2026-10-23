/**
 * Radix-2 FFT and the autocorrelation built on it. The pitch tracker needs the
 * autocorrelation of every 2048-sample window 100 times a second; computing it
 * directly is O(N^2) and would not fit the audio thread's budget, so it goes
 * through the frequency domain instead. Pure functions, no DOM, no allocation
 * beyond cached per-size scratch, so the same code runs in the worklet, on the
 * main thread and under test.
 */

/** Anything the transform can run on; Float64 is used for internal scratch. */
type FloatArray = Float32Array | Float64Array;

/** Twiddle factors and bit-reversal permutation for one transform size. */
interface Plan {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const plans = new Map<number, Plan>();

/** Scratch pair for autocorrelation, kept per size so repeat calls are free. */
const scratch = new Map<number, { re: Float64Array; im: Float64Array }>();

/** Smallest power of two that is at least `n` (1 for anything below 1). */
export function nextPow2(n: number): number {
  if (!(n > 1)) return 1;
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** True for 1, 2, 4, 8 and so on. */
function isPow2(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** Builds (or fetches) the tables for transforms of length `n`. */
function planFor(n: number): Plan {
  let plan = plans.get(n);
  if (plan) return plan;
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = -Math.sin((2 * Math.PI * i) / n);
  }
  const rev = new Uint32Array(n);
  const bits = Math.round(Math.log2(n));
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  plan = { cos, sin, rev };
  plans.set(n, plan);
  return plan;
}

/** In-place forward transform on any float array pair of equal pow2 length. */
function transform(re: FloatArray, im: FloatArray): void {
  const n = re.length;
  if (im.length !== n) throw new Error('fft: re and im must have equal length');
  if (!isPow2(n)) throw new Error(`fft: length ${n} is not a power of two`);
  if (n === 1) return;
  const { cos, sin, rev } = planFor(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, w = 0; k < half; k++, w += step) {
        const a = start + k;
        const b = a + half;
        const wr = cos[w];
        const wi = sin[w];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Forward FFT in place; both arrays must share a power-of-two length. */
export function fft(re: Float32Array, im: Float32Array): void {
  transform(re, im);
}

/** Inverse FFT in place, scaled by 1/N so ifft(fft(x)) returns x. */
export function ifft(re: Float32Array, im: Float32Array): void {
  // Conjugating in and out turns the forward transform into the inverse.
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  transform(re, im);
  const scale = 1 / re.length;
  for (let i = 0; i < re.length; i++) {
    re[i] *= scale;
    im[i] = -im[i] * scale;
  }
}

/**
 * Linear (not circular) autocorrelation r[lag] = sum x[j] * x[j + lag] for lags
 * 0..N-1, via a zero-padded 2N transform. Intermediate maths is Float64 so the
 * tail lags, which sum only a few terms, keep their relative accuracy.
 */
export function autocorrelation(x: Float32Array): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const size = nextPow2(2 * n);
  let s = scratch.get(size);
  if (!s) {
    s = { re: new Float64Array(size), im: new Float64Array(size) };
    scratch.set(size, s);
  }
  const { re, im } = s;
  re.fill(0);
  im.fill(0);
  re.set(x);
  transform(re, im);
  // The power spectrum is real and even, so its inverse transform is real.
  for (let i = 0; i < size; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  transform(re, im);
  // The forward transform of an even real sequence equals N times its inverse.
  const scale = 1 / size;
  for (let i = 0; i < n; i++) out[i] = re[i] * scale;
  return out;
}
