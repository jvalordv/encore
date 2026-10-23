/**
 * Unit tests for latency calibration. The chirp, the GCC-PHAT delay estimate,
 * its confidence, the level helpers, the trial agreement rules, the median
 * and the storage helpers are checked against synthetic signals with known
 * answers, including a synthetic room (direct path, three reflections, white
 * noise, mains hum). measureLatency is then driven through a fake engine, mic
 * and capture whose "room" returns the chirp after a chosen latency, which
 * pins down the clock arithmetic (context time of the chirp, the take's start
 * stamp, the lag in samples) and each failure code without a browser.
 */
import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/app/storage';
import type { PcmCapture } from '../src/audio/capture';
import type { AudioEngine } from '../src/audio/engine';
import {
  CalibrationError,
  MIN_CONFIDENCE,
  MIN_HEARD_DB,
  agreeTrials,
  confidenceFromRatio,
  describeLatency,
  estimateDelay,
  isHeard,
  latencyKey,
  loadLatency,
  loudestWindowDb,
  makeChirp,
  measureLatency,
  median,
  rmsDb,
  saveLatency,
} from '../src/audio/latency';
import type { LatencyResult, TrialResult } from '../src/audio/latency';
import type { MicCapture } from '../src/audio/mic';

const RATE = 48000;

/** Small seeded generator (mulberry32) so noisy tests never flake. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gaussian white noise with the given RMS (Box-Muller). */
function whiteNoise(n: number, rmsLevel: number, seed: number): Float32Array {
  const rand = seeded(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.max(rand(), 1e-12);
    out[i] = rmsLevel * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  return out;
}

function rms(x: Float32Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / x.length);
}

/** Adds `gain * signal` into `into` starting at sample `at`. */
function mixIn(into: Float32Array, signal: Float32Array, gain: number, at: number): void {
  for (let i = 0; i < signal.length; i++) into[at + i] += gain * signal[i];
}

/** Positive-going zero crossings per second between two sample indices. */
function crossingRate(x: Float32Array, from: number, to: number): number {
  let count = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) count++;
  return count / ((to - from) / RATE);
}

/** A sine of `amplitude` at `hz`, `seconds` long. */
function sine(hz: number, seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

describe('makeChirp', () => {
  const chirp = makeChirp(RATE);

  it('is 0.4 s long by default and honours other rates and durations', () => {
    expect(chirp.length).toBe(19200);
    expect(makeChirp(44100).length).toBe(17640);
    expect(makeChirp(RATE, 0.25).length).toBe(12000);
  });

  it('peaks at exactly 0.8 and never above', () => {
    let peak = 0;
    for (const v of chirp) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.8, 6);
  });

  it('fades in and out over 10 ms', () => {
    expect(Math.abs(chirp[0])).toBe(0);
    expect(Math.abs(chirp[chirp.length - 1])).toBe(0);
    // 120 samples in (2.5 ms), the raised cosine is still under 15% of 0.8.
    for (let i = 0; i < 120; i++) {
      expect(Math.abs(chirp[i])).toBeLessThan(0.13);
      expect(Math.abs(chirp[chirp.length - 1 - i])).toBeLessThan(0.13);
    }
    // Past the fade the tone is at full strength somewhere in the next ms.
    let after = 0;
    for (let i = 480; i < 528; i++) after = Math.max(after, Math.abs(chirp[i]));
    expect(after).toBeGreaterThan(0.7);
  });

  it('sweeps linearly from 300 Hz up to 6 kHz', () => {
    // Mean frequency of a linear sweep over a window is its midpoint value:
    // 300 + 5700 * t / 0.4 s, so 0.04 to 0.08 s centres on 1155 Hz and 0.32
    // to 0.36 s on 5145 Hz.
    const early = crossingRate(chirp, 1920, 3840);
    const late = crossingRate(chirp, 15360, 17280);
    expect(early).toBeGreaterThan(1155 * 0.9);
    expect(early).toBeLessThan(1155 * 1.1);
    expect(late).toBeGreaterThan(5145 * 0.9);
    expect(late).toBeLessThan(5145 * 1.1);
  });

  it('rejects rates that cannot carry the sweep and bad durations', () => {
    expect(() => makeChirp(8000)).toThrow(RangeError);
    expect(() => makeChirp(12000)).toThrow(RangeError);
    expect(() => makeChirp(Number.NaN)).toThrow(RangeError);
    expect(() => makeChirp(RATE, 0)).toThrow(RangeError);
    expect(() => makeChirp(RATE, -1)).toThrow(RangeError);
  });
});

describe('confidenceFromRatio', () => {
  it('is 0 at chance, 1 at the cap, linear and monotonic in between', () => {
    expect(confidenceFromRatio(0)).toBe(0);
    expect(confidenceFromRatio(3)).toBe(0);
    expect(confidenceFromRatio(Number.NaN)).toBe(0);
    expect(confidenceFromRatio(15)).toBe(1);
    expect(confidenceFromRatio(1e6)).toBe(1);
    expect(confidenceFromRatio(9)).toBeCloseTo(0.5, 9);
    expect(confidenceFromRatio(10)).toBeGreaterThan(confidenceFromRatio(9));
  });

  it('puts the keep line just above what pure noise reaches', () => {
    // Noise-only correlations peaked at 3.9 times their background over 40
    // seeds; the 0.3 line sits at 6.6.
    expect(confidenceFromRatio(3.9)).toBeLessThan(0.1);
    expect(confidenceFromRatio(6.6)).toBeCloseTo(MIN_CONFIDENCE, 9);
  });
});

/** Where a synthetic room puts the chirp relative to the direct path. */
type Tap = [offsetMs: number, gain: number];

/** The room from the brief: a direct path and three reflections. */
const ROOM: Tap[] = [
  [0, 0.4],
  [3, 0.35],
  [7, 0.5],
  [14, 0.2],
];

describe('estimateDelay', () => {
  const chirp = makeChirp(RATE);
  const lead = Math.round(0.3 * RATE);
  const chirpRms = rms(chirp);

  /**
   * 0.3 s of silence, then the chirp once per tap (offsets from `delay`
   * samples after the lead), white noise at `noiseDb` against the direct
   * path's RMS and a 50 Hz hum at `humDb` against its amplitude.
   */
  function room(delay: number, taps: Tap[], noiseDb: number, humDb: number, seed: number) {
    const rec = new Float32Array(lead + delay + 700 + chirp.length + 14400);
    for (const [ms, gain] of taps) {
      mixIn(rec, chirp, gain, lead + delay + Math.round((ms * RATE) / 1000));
    }
    const direct = taps[0][1];
    const noise = whiteNoise(rec.length, direct * chirpRms * 10 ** (noiseDb / 20), seed);
    const hum = direct * 10 ** (humDb / 20);
    for (let i = 0; i < rec.length; i++) {
      rec[i] += noise[i] + hum * Math.sin((2 * Math.PI * 50 * i) / RATE);
    }
    return rec;
  }

  for (const delay of [17, 1234, 4000]) {
    it(`finds the direct path at ${delay} samples in a noisy room with reflections`, () => {
      const rec = room(delay, ROOM, -20, -30, delay);
      const est = estimateDelay(chirp, rec, 24000, { sampleRate: RATE });
      expect(Math.abs(est.lag - (lead + delay))).toBeLessThanOrEqual(1);
      expect(est.confidence).toBeGreaterThanOrEqual(0.6);
      expect(est.peakToBackground).toBeGreaterThan(10);
      expect(est.method).toBe('gcc-phat');
    });
  }

  it('still finds the direct path when a reflection is louder than it', () => {
    // The brief's room has a +7 ms bounce at 0.5 against a direct 0.4; here
    // the bounce is 0.6, so the direct path is only two thirds as strong.
    const taps: Tap[] = [
      [0, 0.4],
      [3, 0.35],
      [7, 0.6],
      [14, 0.2],
    ];
    const est = estimateDelay(chirp, room(1234, taps, -20, -30, 5), 24000, { sampleRate: RATE });
    expect(Math.abs(est.lag - (lead + 1234))).toBeLessThanOrEqual(1);
    expect(est.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('takes the loud reflection when the direct path is under the ratio', () => {
    // Direct at half the reflection's strength is below the 0.6 default, so
    // the rule moves on; loosening the ratio brings the direct path back.
    const taps: Tap[] = [
      [0, 0.4],
      [7, 0.8],
    ];
    const rec = room(1234, taps, -20, -30, 6);
    const reflection = lead + 1234 + 336;
    const strict = estimateDelay(chirp, rec, 24000, { sampleRate: RATE });
    expect(Math.abs(strict.lag - reflection)).toBeLessThanOrEqual(1);
    const loose = estimateDelay(chirp, rec, 24000, { sampleRate: RATE, firstArrivalRatio: 0.4 });
    expect(Math.abs(loose.lag - (lead + 1234))).toBeLessThanOrEqual(1);
  });

  it('keeps reflections in the background unless excludeMs covers them', () => {
    const rec = room(1234, ROOM, -20, -30, 7);
    const narrow = estimateDelay(chirp, rec, 24000, { sampleRate: RATE, excludeMs: 2 });
    const wide = estimateDelay(chirp, rec, 24000, { sampleRate: RATE, excludeMs: 16 });
    expect(wide.lag).toBeCloseTo(narrow.lag, 6);
    expect(wide.peakToBackground).toBeGreaterThan(narrow.peakToBackground);
  });

  it('keeps its lag in heavy noise, with a lower peak-to-background', () => {
    const quiet = estimateDelay(chirp, room(1234, ROOM, -20, -30, 8), 24000, { sampleRate: RATE });
    const loud = estimateDelay(chirp, room(1234, ROOM, 12, -30, 8), 24000, { sampleRate: RATE });
    expect(Math.abs(loud.lag - (lead + 1234))).toBeLessThanOrEqual(1);
    expect(loud.confidence).toBeGreaterThanOrEqual(0.6);
    expect(loud.peakToBackground).toBeLessThan(quiet.peakToBackground);
  });

  it('gives low confidence for noise alone, with or without hum', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const noise = whiteNoise(RATE * 1.5, 0.05, seed);
      expect(estimateDelay(chirp, noise, 24000).confidence).toBeLessThan(MIN_CONFIDENCE);
      mixIn(noise, sine(50, 1.5, 1), 0.1, 0);
      expect(estimateDelay(chirp, noise, 24000).confidence).toBeLessThan(MIN_CONFIDENCE);
    }
  });

  it('gives low confidence for a lone tone that is not the chirp', () => {
    const rec = sine(1000, 1, 0.3);
    expect(estimateDelay(chirp, rec, 24000).confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it('recovers a delay with no leading silence at all', () => {
    const rec = whiteNoise(17 + chirp.length + 2000, 0.01, 5);
    mixIn(rec, chirp, 0.3, 17);
    const { lag } = estimateDelay(chirp, rec, 500);
    expect(Math.abs(lag - 17)).toBeLessThanOrEqual(1);
  });

  it('gives the sub-sample position of a fractional delay', () => {
    // Build the echo by evaluating the same sweep 0.4 samples later.
    const rec = new Float32Array(lead + chirp.length + 400);
    mixIn(rec, makeShiftedChirp(0.4), 0.3, lead + 100);
    const { lag } = estimateDelay(chirp, rec, 20000);
    expect(Math.abs(lag - (lead + 100.4))).toBeLessThan(0.35);
  });

  it('finds an inverted echo, since polarity flips are harmless', () => {
    const rec = whiteNoise(lead + 800 + chirp.length + 4800, 0.005, 9);
    mixIn(rec, chirp, -0.3, lead + 800);
    const { lag, confidence } = estimateDelay(chirp, rec, 24000);
    expect(Math.abs(lag - (lead + 800))).toBeLessThanOrEqual(1);
    expect(confidence).toBeGreaterThan(0.5);
  });

  it('only searches lags up to the limit', () => {
    const { lag } = estimateDelay(chirp, room(1234, ROOM, -20, -30, 3), 1000);
    expect(lag).toBeLessThanOrEqual(1000);
  });

  it('does not mistake a near-silent start for a match', () => {
    // Digital silence then a quiet echo: whitening is scale free, so a tiny
    // echo is as findable as a loud one and silence scores nothing.
    const rec = new Float32Array(lead + 500 + chirp.length + 4800);
    mixIn(rec, chirp, 1e-4, lead + 500);
    const est = estimateDelay(chirp, rec, 24000);
    expect(Math.abs(est.lag - (lead + 500))).toBeLessThanOrEqual(1);
    expect(est.confidence).toBe(1);
  });

  it('handles degenerate input without NaN', () => {
    const none = { lag: 0, confidence: 0, peakToBackground: 0, method: 'gcc-phat' };
    expect(estimateDelay(chirp, new Float32Array(RATE), 24000)).toEqual(none);
    expect(estimateDelay(chirp, new Float32Array(100), 24000)).toEqual(none);
    expect(estimateDelay(new Float32Array(0), new Float32Array(100), 50)).toEqual(none);
    expect(estimateDelay(chirp, whiteNoise(RATE, 0.1, 1), Number.NaN)).toEqual(none);
    expect(estimateDelay(new Float32Array(100), whiteNoise(1000, 0.1, 1), 50).confidence).toBe(0);
  });

  it('ignores nonsense options rather than failing', () => {
    const rec = room(1234, ROOM, -20, -30, 3);
    const est = estimateDelay(chirp, rec, 24000, {
      firstArrivalRatio: -1,
      excludeMs: Number.NaN,
      sampleRate: 0,
    });
    expect(Math.abs(est.lag - (lead + 1234))).toBeLessThanOrEqual(1);
  });
});

/** The default chirp evaluated `frac` samples late (sub-sample echo). */
function makeShiftedChirp(frac: number): Float32Array {
  const n = 19200;
  const fade = 480;
  const slope = (6000 - 300) / (n / RATE);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - frac) / RATE;
    const edge = Math.min(i - frac, n - 1 - i + frac);
    const gain = edge <= 0 ? 0 : edge < fade ? 0.5 * (1 - Math.cos((Math.PI * edge) / fade)) : 1;
    out[i] = Math.sin(2 * Math.PI * (300 * t + 0.5 * slope * t * t)) * gain;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] *= 0.8 / peak;
  return out;
}

describe('rmsDb and loudestWindowDb', () => {
  it('rmsDb reads dB re full scale and floors silence at -120', () => {
    expect(rmsDb(sine(1000, 0.1, 1))).toBeCloseTo(-3.01, 1);
    expect(rmsDb(sine(1000, 0.1, 0.1))).toBeCloseTo(-23.01, 1);
    expect(rmsDb(new Float32Array(100).fill(1))).toBeCloseTo(0, 6);
    expect(rmsDb(new Float32Array(100))).toBe(-120);
    expect(rmsDb(new Float32Array(0))).toBe(-120);
  });

  it('loudestWindowDb finds the burst, not the average', () => {
    const pcm = whiteNoise(RATE * 3, 0.001, 1);
    const burst = sine(440, 0.4, 0.1);
    mixIn(pcm, burst, 1, RATE);
    expect(loudestWindowDb(pcm, RATE, 0.4, 0)).toBeCloseTo(-23, 0);
    // The whole recording is far quieter than the burst.
    expect(rmsDb(pcm)).toBeLessThan(-30);
  });

  it('loudestWindowDb ignores everything before fromSample', () => {
    const pcm = new Float32Array(RATE * 2);
    mixIn(pcm, sine(440, 0.4, 0.5), 1, 0);
    mixIn(pcm, sine(440, 0.4, 0.05), 1, RATE);
    expect(loudestWindowDb(pcm, RATE, 0.4, 0)).toBeCloseTo(-9, 0);
    expect(loudestWindowDb(pcm, RATE, 0.4, RATE / 2)).toBeCloseTo(-29, 0);
  });

  it('loudestWindowDb measures a short span whole and no span as silence', () => {
    const pcm = sine(440, 0.1, 0.5);
    expect(loudestWindowDb(pcm, RATE, 0.4, 0)).toBeCloseTo(rmsDb(pcm), 6);
    expect(loudestWindowDb(pcm, RATE, 0.4, pcm.length)).toBe(-120);
    expect(loudestWindowDb(pcm, RATE, 0.4, Number.NaN)).toBeCloseTo(rmsDb(pcm), 6);
    expect(loudestWindowDb(new Float32Array(0), RATE, 0.4, 0)).toBe(-120);
  });
});

describe('isHeard', () => {
  it('flags a chirp under the noise floor plus 6 dB, measured from a recording', () => {
    const chirp = makeChirp(RATE);
    const preRoll = whiteNoise(Math.round(0.4 * RATE), 0.01, 3);
    const noiseFloorDb = rmsDb(preRoll);
    /** Pre-roll noise, then noise plus the chirp at `gain`. */
    const level = (gain: number): number => {
      const pcm = new Float32Array(preRoll.length + chirp.length + RATE);
      pcm.set(preRoll, 0);
      const noise = whiteNoise(pcm.length - preRoll.length, 0.01, 4);
      pcm.set(noise, preRoll.length);
      mixIn(pcm, chirp, gain, preRoll.length + 4000);
      return loudestWindowDb(pcm, RATE, 0.4, preRoll.length);
    };
    // The chirp's RMS is about 0.57, so at gain 0.02 it is as loud as the
    // noise and lifts the window by under 4 dB; at 0.5 it towers over it.
    const faint = { chirpLevelDb: level(0.02), noiseFloorDb };
    const clear = { chirpLevelDb: level(0.5), noiseFloorDb };
    expect(faint.chirpLevelDb - noiseFloorDb).toBeLessThan(MIN_HEARD_DB);
    expect(isHeard(faint)).toBe(false);
    expect(clear.chirpLevelDb - noiseFloorDb).toBeGreaterThan(20);
    expect(isHeard(clear)).toBe(true);
  });

  it('counts exactly 6 dB over the floor as heard', () => {
    expect(isHeard({ chirpLevelDb: -44, noiseFloorDb: -50 })).toBe(true);
    expect(isHeard({ chirpLevelDb: -44.1, noiseFloorDb: -50 })).toBe(false);
  });
});

describe('agreeTrials', () => {
  /** A good trial at `ms` unless overridden. */
  function trial(ms: number, over: Partial<TrialResult> = {}): TrialResult {
    return {
      delayS: ms / 1000,
      confidence: 0.9,
      peakToBackground: 14,
      chirpLevelDb: -20,
      noiseFloorDb: -50,
      ...over,
    };
  }

  it('accepts trials that agree: median delay, weakest confidence, spread', () => {
    const a = agreeTrials([trial(86), trial(88, { confidence: 0.7 }), trial(87)], 0.005);
    expect(a.failure).toBeNull();
    expect(a.kept).toHaveLength(3);
    expect(a.delayS).toBeCloseTo(0.087, 9);
    expect(a.confidence).toBe(0.7);
    expect(a.spreadS).toBeCloseTo(0.002, 9);
  });

  it('rejects spreads over 5 ms as unstable and quotes the numbers', () => {
    const a = agreeTrials([trial(80), trial(81), trial(86.5)], 0.005);
    expect(a.failure?.code).toBe('unstable');
    expect(a.failure?.message).toContain('6.5 ms');
    expect(a.failure?.message).toContain('80.0, 81.0, 86.5');
    expect(a.failure?.message).toContain('5.0 ms');
    expect(a.spreadS).toBeCloseTo(0.0065, 9);
  });

  it('accepts a spread of exactly the limit', () => {
    expect(agreeTrials([trial(80), trial(85), trial(82)], 0.005).failure).toBeNull();
    expect(agreeTrials([trial(80), trial(85.2)], 0.005).failure?.code).toBe('unstable');
  });

  it('drops a low-confidence trial and judges the rest', () => {
    const a = agreeTrials([trial(87), trial(140, { confidence: 0.2 }), trial(88)], 0.005);
    expect(a.failure).toBeNull();
    expect(a.kept.map((t) => t.delayS)).toEqual([0.087, 0.088]);
    expect(a.delayS).toBeCloseTo(0.0875, 9);
  });

  it('drops a trial the mic did not hear even when it looks confident', () => {
    const deaf = trial(300, { chirpLevelDb: -48 });
    const a = agreeTrials([trial(87), deaf, trial(88)], 0.005);
    expect(a.failure).toBeNull();
    expect(a.kept).toHaveLength(2);
  });

  it('needs two usable trials', () => {
    const weak = trial(87, { confidence: 0.1 });
    const a = agreeTrials([trial(87), weak, weak], 0.005);
    expect(a.failure?.code).toBe('low-confidence');
    expect(a.failure?.message).toContain('1 of 3');
    expect(a.failure?.message).toContain('0.10');
    // A one-trial run only has to get its one trial right.
    expect(agreeTrials([trial(87)], 0.005).failure).toBeNull();
    expect(agreeTrials([weak], 0.005).failure?.code).toBe('low-confidence');
  });

  it('reports not-heard with the levels and the knob to turn', () => {
    const quiet = (over: number) => trial(87, { chirpLevelDb: -50 + over });
    const a = agreeTrials([quiet(2), quiet(1), quiet(2)], 0.005);
    expect(a.failure?.code).toBe('not-heard');
    expect(a.failure?.message).toContain('+2 dB over its noise floor');
    expect(a.failure?.message).toContain('+6 dB');
    expect(a.failure?.message).toContain('turn the speakers up or move the mic closer');
    expect(a.kept).toHaveLength(0);
    expect(a.delayS).toBeNaN();
    expect(a.confidence).toBe(0);
  });

  it('writes a negative margin with its sign and copes with no trials', () => {
    const a = agreeTrials([trial(87, { chirpLevelDb: -53 })], 0.005);
    expect(a.failure?.message).toContain('-3 dB over its noise floor');
    expect(agreeTrials([], 0.005).failure?.code).toBe('not-heard');
  });
});

describe('describeLatency', () => {
  it('shows the median, each trial and the confidence', () => {
    const good = (ms: number): TrialResult => ({
      delayS: ms / 1000,
      confidence: 0.91,
      peakToBackground: 14,
      chirpLevelDb: -20,
      noiseFloorDb: -50,
    });
    const trials = [good(86), good(87), good(88)];
    const result: LatencyResult = {
      delayS: 0.087,
      confidence: 0.912,
      spreadS: 0.002,
      trials,
      trialsS: trials.map((t) => t.delayS),
    };
    expect(describeLatency(result)).toBe('Latency 87 ms (trials 86, 87, 88 ms; confidence 0.91)');
  });
});

describe('median', () => {
  it('takes the middle of an odd count and the mean of the middle pair', () => {
    expect(median([5])).toBe(5);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([0.09, 0.05, 0.5])).toBe(0.09);
  });

  it('leaves its input alone and gives NaN for nothing', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
    expect(median([])).toBeNaN();
  });
});

describe('latencyKey', () => {
  it('is stable and distinguishes device pairs', () => {
    expect(latencyKey('out-1', 'in-1')).toBe(latencyKey('out-1', 'in-1'));
    expect(latencyKey('out-1', 'in-1')).not.toBe(latencyKey('out-2', 'in-1'));
    expect(latencyKey('out-1', 'in-1')).not.toBe(latencyKey('out-1', 'in-2'));
    expect(latencyKey('a', 'b')).not.toBe(latencyKey('b', 'a'));
  });

  it('treats null, empty and "default" as the same default device', () => {
    expect(latencyKey(null, null)).toBe('latency.default|default');
    expect(latencyKey('', 'default')).toBe(latencyKey(null, null));
  });

  it('cannot be forged by separators inside an id', () => {
    expect(latencyKey('a|b', 'c')).not.toBe(latencyKey('a', 'b|c'));
  });
});

describe('loadLatency and saveLatency', () => {
  it('round trips through a store', () => {
    const store = memoryStore();
    const key = latencyKey('speakers', 'usb-mic');
    expect(loadLatency(store, key)).toBeNull();
    saveLatency(store, key, 0.0873);
    expect(loadLatency(store, key)).toBe(0.0873);
    saveLatency(store, key, 0);
    expect(loadLatency(store, key)).toBe(0);
  });

  it('keeps device pairs apart', () => {
    const store = memoryStore();
    saveLatency(store, latencyKey('a', 'x'), 0.05);
    saveLatency(store, latencyKey('b', 'x'), 0.12);
    expect(loadLatency(store, latencyKey('a', 'x'))).toBe(0.05);
    expect(loadLatency(store, latencyKey('b', 'x'))).toBe(0.12);
  });

  it('reads nonsense as missing and refuses to write it', () => {
    const store = memoryStore();
    for (const junk of ['', ' ', 'abc', 'NaN', '-0.1', '9', 'Infinity']) {
      store.set('k', junk);
      expect(loadLatency(store, 'k')).toBeNull();
    }
    store.remove('k');
    saveLatency(store, 'k', Number.NaN);
    saveLatency(store, 'k', -1);
    saveLatency(store, 'k', Number.POSITIVE_INFINITY);
    expect(store.get('k')).toBeNull();
  });
});

describe('measureLatency', () => {
  interface Rig {
    engine: AudioEngine;
    mic: MicCapture;
    capture: PcmCapture;
    sleep: (ms: number) => Promise<void>;
    state: { recording: boolean; starts: number; scheduled: number[]; startedAt: number[] };
  }

  /**
   * A room that returns the chirp `latencyS` after it was scheduled (a list
   * gives each trial its own). The fake clock only moves when measureLatency
   * sleeps, like real time does, and the take starts a little after
   * capture.start(), like the worklet. `reflections` add later copies of the
   * chirp, `echo: false` is a deaf mic and `babble` adds noise after the
   * pre-roll that is loud enough to pass the level check but is not the chirp.
   */
  function rig(opts: {
    latencyS: number | number[];
    echo?: boolean;
    frozen?: boolean;
    micOpen?: boolean;
    reflections?: Tap[];
    babble?: number;
  }): Rig {
    const { echo = true, frozen = false, micOpen = true, reflections = [], babble = 0 } = opts;
    const chirp = makeChirp(RATE);
    let clock = 12.3;
    let startedAt = 0;
    let seed = 100;
    const state = {
      recording: false,
      starts: 0,
      scheduled: [] as number[],
      startedAt: [] as number[],
    };
    const engine = {
      context: {
        sampleRate: RATE,
        createBuffer: (_channels: number, length: number) => {
          const data = new Float32Array(length);
          return { getChannelData: () => data };
        },
        createBufferSource: () => ({
          buffer: null,
          connect: () => {},
          disconnect: () => {},
          start: (when: number) => void state.scheduled.push(when),
        }),
      },
      master: {},
      now: () => clock,
      resume: async () => {},
    } as unknown as AudioEngine;
    const capture = {
      load: async () => {},
      start: () => {
        state.recording = true;
        state.starts++;
        startedAt = clock;
        state.startedAt.push(clock);
      },
      stop: async () => {
        if (!state.recording) throw new Error('not recording');
        state.recording = false;
        const first = startedAt + 0.0213;
        const pcm = whiteNoise(Math.round((clock - first) * RATE), 0.003, seed++);
        const when = state.scheduled[state.scheduled.length - 1];
        if (when !== undefined) {
          const trialNo = state.scheduled.length - 1;
          const latencyS = Array.isArray(opts.latencyS)
            ? opts.latencyS[trialNo % opts.latencyS.length]
            : opts.latencyS;
          if (echo) {
            for (const [ms, gain] of [[0, 0.3] as Tap, ...reflections]) {
              mixIn(pcm, chirp, gain, Math.round((when + latencyS + ms / 1000 - first) * RATE));
            }
          }
          if (babble > 0) {
            const from = Math.round((when - first) * RATE);
            const noise = whiteNoise(pcm.length - from, babble, seed++);
            for (let i = 0; i < noise.length; i++) pcm[from + i] += noise[i];
          }
        }
        return { pcm, sampleRate: RATE, startedAtContextS: first };
      },
    } as unknown as PcmCapture;
    const mic = { source: micOpen ? {} : null } as unknown as MicCapture;
    const sleep = async (ms: number): Promise<void> => {
      if (!frozen) clock += ms / 1000;
    };
    return { engine, mic, capture, sleep, state };
  }

  /** The error a calibration run throws; the test fails if it succeeds. */
  async function failure(r: Rig): Promise<CalibrationError> {
    return measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep }).then(
      () => {
        throw new Error('measureLatency was expected to fail');
      },
      (error) => error,
    );
  }

  it('recovers the latency of the room from the context clock', async () => {
    const r = rig({ latencyS: 0.0873 });
    const seen: number[] = [];
    const result = await measureLatency(r.engine, r.mic, r.capture, {
      sleep: r.sleep,
      onProgress: (done) => seen.push(done),
    });
    expect(result.trialsS).toHaveLength(3);
    for (const t of result.trialsS) expect(Math.abs(t - 0.0873)).toBeLessThan(5e-5);
    expect(Math.abs(result.delayS - 0.0873)).toBeLessThan(5e-5);
    expect(result.confidence).toBeGreaterThan(0.6);
    expect(result.spreadS).toBeLessThan(5e-5);
    expect(seen).toEqual([1, 2, 3]);
    expect(r.state.starts).toBe(3);
    expect(r.state.recording).toBe(false);
  });

  it('reports each trial with its levels and evidence', async () => {
    const r = rig({ latencyS: 0.0873 });
    const result = await measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep });
    expect(result.trials).toHaveLength(3);
    for (const t of result.trials) {
      expect(t.delayS).toBeCloseTo(0.0873, 4);
      expect(t.peakToBackground).toBeGreaterThan(10);
      // The fake mic's noise is 0.003 RMS (-50 dB); the chirp arrives at 0.3.
      expect(t.noiseFloorDb).toBeGreaterThan(-52);
      expect(t.noiseFloorDb).toBeLessThan(-48);
      expect(t.chirpLevelDb).toBeGreaterThan(-18);
      expect(t.chirpLevelDb).toBeLessThan(-12);
    }
    expect(result.trialsS).toEqual(result.trials.map((t) => t.delayS));
  });

  it('finds the direct path in a room with reflections, not the loudest bounce', async () => {
    const r = rig({
      latencyS: 0.06,
      reflections: [
        [3, 0.26],
        [7, 0.4],
        [14, 0.15],
      ],
    });
    const result = await measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep });
    expect(Math.abs(result.delayS - 0.06)).toBeLessThan(5e-5);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('schedules each chirp a pre-roll after capture started, one per trial', async () => {
    const r = rig({ latencyS: 0.04 });
    await measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep, trials: 2 });
    expect(r.state.scheduled).toHaveLength(2);
    expect(r.state.scheduled[0] - r.state.startedAt[0]).toBeCloseTo(0.4, 6);
    expect(r.state.scheduled[1] - r.state.startedAt[1]).toBeCloseTo(0.4, 6);
    // Each trial waits out the chirp, the search window and the gap.
    expect(r.state.scheduled[1]).toBeGreaterThan(r.state.scheduled[0] + 1.3);
    const short = rig({ latencyS: 0.04 });
    await measureLatency(short.engine, short.mic, short.capture, {
      sleep: short.sleep,
      trials: 1,
      preRollS: 0.25,
    });
    expect(short.state.scheduled[0] - short.state.startedAt[0]).toBeCloseTo(0.25, 6);
  });

  it('finds a latency near the top of the search window', async () => {
    const r = rig({ latencyS: 0.55 });
    const result = await measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep });
    expect(Math.abs(result.delayS - 0.55)).toBeLessThan(5e-5);
  });

  it('counts a trial that lands late, so only a looser window accepts it', async () => {
    // The middle trial lands 40 ms late but still locks on, so it counts and
    // the run is unstable; with a 50 ms window the median is taken instead.
    const r = rig({ latencyS: [0.087, 0.127, 0.088] });
    const err = await failure(r);
    expect(err).toBeInstanceOf(CalibrationError);
    const loose = rig({ latencyS: [0.087, 0.127, 0.088] });
    const result = await measureLatency(loose.engine, loose.mic, loose.capture, {
      sleep: loose.sleep,
      agreeS: 0.05,
    });
    expect(Math.abs(result.delayS - 0.088)).toBeLessThan(5e-5);
    expect(result.spreadS).toBeCloseTo(0.04, 3);
  });

  it('throws not-heard after all three trials when the room is silent', async () => {
    const r = rig({ latencyS: 0.05, echo: false });
    const err = await failure(r);
    expect(err).toBeInstanceOf(CalibrationError);
    expect(err.code).toBe('not-heard');
    expect(err.message).toMatch(/Mic heard [+-]?\d+ dB over its noise floor/);
    expect(err.message).toContain('needs about +6 dB');
    expect(err.message).toContain('turn the speakers up or move the mic closer');
    expect(err.trials).toHaveLength(3);
    expect(r.state.starts).toBe(3);
    expect(r.state.recording).toBe(false);
  });

  it('throws unstable with the delays when the trials disagree', async () => {
    const r = rig({ latencyS: [0.08, 0.09, 0.085] });
    const err = await failure(r);
    expect(err).toBeInstanceOf(CalibrationError);
    expect(err.code).toBe('unstable');
    expect(err.message).toContain('10.0 ms');
    expect(err.message).toContain('80.0, 90.0, 85.0');
    expect(err.trials).toHaveLength(3);
  });

  it('throws low-confidence when the mic is loud but the chirp is not in it', async () => {
    // Babble at -20 dB re full scale passes the level check by a mile and has
    // no chirp in it, so nothing can be timed.
    const r = rig({ latencyS: 0.05, echo: false, babble: 0.1 });
    const err = await failure(r);
    expect(err).toBeInstanceOf(CalibrationError);
    expect(err.code).toBe('low-confidence');
    expect(err.message).toContain('0 of 3');
    expect(err.trials).toHaveLength(3);
  });

  it('refuses without an open mic and stops capture when the clock is stuck', async () => {
    const closed = rig({ latencyS: 0.05, micOpen: false });
    const err = await measureLatency(closed.engine, closed.mic, closed.capture).catch((e) => e);
    expect(err).toBeInstanceOf(CalibrationError);
    expect(err.code).toBe('no-mic');
    expect(err.message).toMatch(/mic/i);
    expect(closed.state.starts).toBe(0);

    const stuck = rig({ latencyS: 0.05, frozen: true });
    const stuckErr = await measureLatency(stuck.engine, stuck.mic, stuck.capture, {
      sleep: stuck.sleep,
    }).catch((e) => e);
    // A stopped clock is an audio fault, not a verdict on the room.
    expect(stuckErr).not.toBeInstanceOf(CalibrationError);
    expect(stuckErr.message).toMatch(/clock/);
    expect(stuck.state.recording).toBe(false);
  });
});
