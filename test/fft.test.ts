/**
 * Unit tests for the radix-2 FFT and the FFT-based autocorrelation. The FFT is
 * checked against a known spectrum and by round trip; the autocorrelation
 * against a naive O(N^2) sum on random signals, which is the oracle the pitch
 * tracker's speed-up has to match.
 */
import { describe, expect, it } from 'vitest';
import { autocorrelation, fft, ifft, nextPow2 } from '../src/analysis/fft';

/** Small seeded generator so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform noise in [-1, 1). */
function noise(n: number, seed: number): Float32Array {
  const next = rng(seed);
  return Float32Array.from({ length: n }, () => next() * 2 - 1);
}

/** Direct O(N^2) autocorrelation in double precision. */
function naiveAutocorrelation(x: Float32Array): Float64Array {
  const out = new Float64Array(x.length);
  for (let lag = 0; lag < x.length; lag++) {
    let sum = 0;
    for (let j = 0; j + lag < x.length; j++) sum += x[j] * x[j + lag];
    out[lag] = sum;
  }
  return out;
}

describe('nextPow2', () => {
  it('rounds up to a power of two and leaves powers alone', () => {
    expect(nextPow2(1)).toBe(1);
    expect(nextPow2(2)).toBe(2);
    expect(nextPow2(3)).toBe(4);
    expect(nextPow2(2048)).toBe(2048);
    expect(nextPow2(2049)).toBe(4096);
    expect(nextPow2(4096)).toBe(4096);
  });

  it('gives 1 for zero and negatives rather than looping', () => {
    expect(nextPow2(0)).toBe(1);
    expect(nextPow2(-5)).toBe(1);
  });
});

describe('fft', () => {
  it('puts a bin-aligned cosine in exactly its two bins', () => {
    const n = 64;
    const bin = 5;
    const re = Float32Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * bin * i) / n));
    const im = new Float32Array(n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
      const mag = Math.hypot(re[k], im[k]);
      expect(mag).toBeCloseTo(k === bin || k === n - bin ? n / 2 : 0, 4);
    }
  });

  it('transforms an impulse into a flat spectrum', () => {
    const re = new Float32Array(16);
    const im = new Float32Array(16);
    re[0] = 1;
    fft(re, im);
    for (let k = 0; k < 16; k++) {
      expect(re[k]).toBeCloseTo(1, 6);
      expect(im[k]).toBeCloseTo(0, 6);
    }
  });

  it('round-trips random complex data through ifft', () => {
    const n = 2048;
    const re0 = noise(n, 1);
    const im0 = noise(n, 2);
    const re = re0.slice();
    const im = im0.slice();
    fft(re, im);
    ifft(re, im);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(re0[i], 5);
      expect(im[i]).toBeCloseTo(im0[i], 5);
    }
  });

  it('conserves energy (Parseval)', () => {
    const n = 512;
    const re = noise(n, 3);
    const im = new Float32Array(n);
    let timeEnergy = 0;
    for (let i = 0; i < n; i++) timeEnergy += re[i] * re[i];
    fft(re, im);
    let freqEnergy = 0;
    for (let k = 0; k < n; k++) freqEnergy += re[k] * re[k] + im[k] * im[k];
    expect(freqEnergy / n / timeEnergy).toBeCloseTo(1, 4);
  });

  it('rejects lengths that are not a power of two or do not match', () => {
    expect(() => fft(new Float32Array(12), new Float32Array(12))).toThrow(/power of two/);
    expect(() => fft(new Float32Array(8), new Float32Array(16))).toThrow(/equal length/);
  });

  it('accepts length 1 as a no-op', () => {
    const re = Float32Array.of(3);
    const im = Float32Array.of(-2);
    fft(re, im);
    expect([re[0], im[0]]).toEqual([3, -2]);
  });
});

describe('autocorrelation', () => {
  it('matches the naive version on random signals, N = 2048', () => {
    for (const seed of [11, 12, 13]) {
      const x = noise(2048, seed);
      const fast = autocorrelation(x);
      const slow = naiveAutocorrelation(x);
      expect(fast).toHaveLength(2048);
      // Error is judged against the larger of the true value and a small
      // slice of r[0]: the tail lags sum only a few random terms, so their own
      // magnitude is near zero and a pure per-lag ratio would test rounding.
      for (let lag = 0; lag < 2048; lag++) {
        const scale = Math.max(Math.abs(slow[lag]), 1e-3 * slow[0]);
        expect(Math.abs(fast[lag] - slow[lag]) / scale).toBeLessThan(1e-4);
      }
    }
  });

  it('is accurate to 1e-4 relative at every lag with a nonzero sum', () => {
    const x = noise(2048, 21).map((v) => v * 0.5 + 1);
    const fast = autocorrelation(x);
    const slow = naiveAutocorrelation(x);
    for (let lag = 0; lag < 2048; lag++) {
      expect(Math.abs(fast[lag] - slow[lag]) / Math.abs(slow[lag])).toBeLessThan(1e-4);
    }
  });

  it('is linear, not circular: the last lag is a single product', () => {
    const x = Float32Array.of(1, 2, 3, 4, 5);
    const r = autocorrelation(x);
    expect(r[4]).toBeCloseTo(5, 5);
    expect(r[0]).toBeCloseTo(55, 4);
    expect(r[1]).toBeCloseTo(2 + 6 + 12 + 20, 4);
  });

  it('handles lengths that are not a power of two and the empty signal', () => {
    const x = noise(1000, 5);
    const fast = autocorrelation(x);
    const slow = naiveAutocorrelation(x);
    expect(fast).toHaveLength(1000);
    expect(Math.abs(fast[7] - slow[7]) / Math.abs(slow[7])).toBeLessThan(1e-4);
    expect(autocorrelation(new Float32Array(0))).toHaveLength(0);
  });

  it('does not disturb its input', () => {
    const x = noise(256, 9);
    const copy = x.slice();
    autocorrelation(x);
    expect(Array.from(x)).toEqual(Array.from(copy));
  });
});
