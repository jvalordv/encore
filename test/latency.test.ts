/**
 * Unit tests for latency calibration. The chirp, the cross-correlation delay
 * estimate, the confidence mapping, the median and the storage helpers are
 * checked against synthetic signals with known answers. measureLatency is
 * then driven through a fake engine, mic and capture whose "room" returns the
 * chirp after a chosen latency, which pins down the clock arithmetic (context
 * time of the chirp, the take's start stamp, the lag in samples) without a
 * browser.
 */
import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/app/storage';
import type { PcmCapture } from '../src/audio/capture';
import type { AudioEngine } from '../src/audio/engine';
import {
  MIN_CONFIDENCE,
  confidenceFromRatio,
  estimateDelay,
  latencyKey,
  loadLatency,
  makeChirp,
  measureLatency,
  median,
  saveLatency,
} from '../src/audio/latency';
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

describe('makeChirp', () => {
  const chirp = makeChirp(RATE);

  it('is 0.1 s long by default and honours other rates and durations', () => {
    expect(chirp.length).toBe(4800);
    expect(makeChirp(44100).length).toBe(4410);
    expect(makeChirp(RATE, 0.25).length).toBe(12000);
  });

  it('peaks at exactly 0.5 and never above', () => {
    let peak = 0;
    for (const v of chirp) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.5, 6);
  });

  it('fades in and out over 5 ms', () => {
    expect(Math.abs(chirp[0])).toBe(0);
    expect(Math.abs(chirp[chirp.length - 1])).toBe(0);
    // 60 samples in, the raised cosine is still under 15% of full scale.
    for (let i = 0; i < 60; i++) {
      expect(Math.abs(chirp[i])).toBeLessThan(0.08);
      expect(Math.abs(chirp[chirp.length - 1 - i])).toBeLessThan(0.08);
    }
    // Past the fade the tone is at full strength somewhere in the next ms.
    let after = 0;
    for (let i = 240; i < 288; i++) after = Math.max(after, Math.abs(chirp[i]));
    expect(after).toBeGreaterThan(0.45);
  });

  it('sweeps linearly from 500 Hz up to 4 kHz', () => {
    // Mean frequency of a linear sweep over a window is its midpoint value.
    const early = crossingRate(chirp, 960, 1920); // 20 to 40 ms: 1550 Hz
    const late = crossingRate(chirp, 2880, 3840); // 60 to 80 ms: 2950 Hz
    expect(early).toBeGreaterThan(1550 * 0.9);
    expect(early).toBeLessThan(1550 * 1.1);
    expect(late).toBeGreaterThan(2950 * 0.9);
    expect(late).toBeLessThan(2950 * 1.1);
  });

  it('rejects rates that cannot carry the sweep and bad durations', () => {
    expect(() => makeChirp(8000)).toThrow(RangeError);
    expect(() => makeChirp(Number.NaN)).toThrow(RangeError);
    expect(() => makeChirp(RATE, 0)).toThrow(RangeError);
    expect(() => makeChirp(RATE, -1)).toThrow(RangeError);
  });
});

describe('confidenceFromRatio', () => {
  it('is 0 at chance, 1 at the cap and monotonic in between', () => {
    expect(confidenceFromRatio(1)).toBe(0);
    expect(confidenceFromRatio(0.4)).toBe(0);
    expect(confidenceFromRatio(Number.NaN)).toBe(0);
    expect(confidenceFromRatio(10)).toBe(1);
    expect(confidenceFromRatio(1e6)).toBe(1);
    expect(confidenceFromRatio(2)).toBeCloseTo(0.301, 3);
    expect(confidenceFromRatio(3)).toBeGreaterThan(confidenceFromRatio(2));
  });
});

describe('estimateDelay', () => {
  const chirp = makeChirp(RATE);
  const lead = Math.round(0.3 * RATE);
  const chirpRms = rms(chirp);

  /** Silence, then the chirp at `lead + delay` scaled by 0.3, plus noise. */
  function recording(delay: number, noiseRms: number, seed: number): Float32Array {
    const rec = whiteNoise(lead + delay + chirp.length + 4800, noiseRms, seed);
    mixIn(rec, chirp, 0.3, lead + delay);
    return rec;
  }

  // -20 dB against the recorded echo, then the harsher -20 dB against the
  // unscaled reference (about 10 dB SNR once the 0.3 gain is counted).
  const noiseLevels: [string, number][] = [
    ['-20 dB against the echo', 0.1 * 0.3 * chirpRms],
    ['-20 dB against the reference', 0.1 * chirpRms],
  ];

  for (const delay of [1234, 17]) {
    for (const [label, noiseRms] of noiseLevels) {
      it(`recovers a ${delay} sample delay after 0.3 s of silence, noise ${label}`, () => {
        const { lag, confidence } = estimateDelay(chirp, recording(delay, noiseRms, delay), 24000);
        expect(Math.abs(lag - (lead + delay))).toBeLessThanOrEqual(1);
        expect(confidence).toBeGreaterThan(0.5);
        expect(confidence).toBeLessThanOrEqual(1);
      });
    }
  }

  it('recovers a delay with no leading silence at all', () => {
    const rec = whiteNoise(17 + chirp.length + 2000, 0.01, 5);
    mixIn(rec, chirp, 0.3, 17);
    const { lag } = estimateDelay(chirp, rec, 500);
    expect(Math.abs(lag - 17)).toBeLessThanOrEqual(1);
  });

  it('gives the sub-sample position of a fractional delay', () => {
    // Build the echo by evaluating the same sweep 0.4 samples later.
    const rec = new Float32Array(lead + chirp.length + 400);
    const shifted = makeShiftedChirp(0.4);
    mixIn(rec, shifted, 0.3, lead + 100);
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
    const rec = recording(1234, 0.003, 3);
    const { lag } = estimateDelay(chirp, rec, 1000);
    expect(lag).toBeLessThanOrEqual(1000);
  });

  it('gives low confidence for pure noise', () => {
    for (const seed of [1, 2, 3, 4]) {
      const { confidence } = estimateDelay(chirp, whiteNoise(RATE, 0.1, seed), 24000);
      expect(confidence).toBeLessThan(MIN_CONFIDENCE);
    }
  });

  it('gives low confidence for a lone tone that is not the chirp', () => {
    const rec = new Float32Array(RATE);
    for (let i = 0; i < rec.length; i++) rec[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / RATE);
    expect(estimateDelay(chirp, rec, 24000).confidence).toBeLessThan(MIN_CONFIDENCE);
  });

  it('handles degenerate input without NaN', () => {
    expect(estimateDelay(chirp, new Float32Array(RATE), 24000)).toEqual({ lag: 0, confidence: 0 });
    expect(estimateDelay(chirp, new Float32Array(100), 24000)).toEqual({ lag: 0, confidence: 0 });
    expect(estimateDelay(new Float32Array(0), new Float32Array(100), 50)).toEqual({
      lag: 0,
      confidence: 0,
    });
    expect(estimateDelay(chirp, whiteNoise(RATE, 0.1, 1), Number.NaN)).toEqual({
      lag: 0,
      confidence: 0,
    });
    expect(estimateDelay(new Float32Array(100), whiteNoise(1000, 0.1, 1), 50).confidence).toBe(0);
  });

  it('does not mistake a near-silent start for a match', () => {
    // Digital silence then a quiet echo: tiny windows must not score high.
    const rec = new Float32Array(lead + 500 + chirp.length + 4800);
    mixIn(rec, chirp, 1e-4, lead + 500);
    const { lag } = estimateDelay(chirp, rec, 24000);
    expect(Math.abs(lag - (lead + 500))).toBeLessThanOrEqual(1);
  });
});

/** The default chirp evaluated `frac` samples late (sub-sample echo). */
function makeShiftedChirp(frac: number): Float32Array {
  const n = 4800;
  const slope = (4000 - 500) / (n / RATE);
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = (i - frac) / RATE;
    const edge = Math.min(i - frac, n - 1 - i + frac);
    const gain = edge <= 0 ? 0 : edge < 240 ? 0.5 * (1 - Math.cos((Math.PI * edge) / 240)) : 1;
    out[i] = Math.sin(2 * Math.PI * (500 * t + 0.5 * slope * t * t)) * gain;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  for (let i = 0; i < n; i++) out[i] *= 0.5 / peak;
  return out;
}

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
    state: { recording: boolean; starts: number; scheduled: number[] };
  }

  /**
   * A room that returns the chirp `latencyS` after it was scheduled. The
   * fake clock only moves when measureLatency sleeps, like real time does,
   * and the take starts a little after capture.start(), like the worklet.
   */
  function rig(opts: {
    latencyS: number;
    echo?: boolean;
    frozen?: boolean;
    micOpen?: boolean;
  }): Rig {
    const { latencyS, echo = true, frozen = false, micOpen = true } = opts;
    const chirp = makeChirp(RATE);
    let clock = 12.3;
    let startedAt = 0;
    let seed = 100;
    const state = { recording: false, starts: 0, scheduled: [] as number[] };
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
      },
      stop: async () => {
        if (!state.recording) throw new Error('not recording');
        state.recording = false;
        const first = startedAt + 0.0213;
        const pcm = whiteNoise(Math.round((clock - first) * RATE), 0.003, seed++);
        const when = state.scheduled[state.scheduled.length - 1];
        if (echo && when !== undefined) {
          mixIn(pcm, chirp, 0.3, Math.round((when + latencyS - first) * RATE));
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
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(seen).toEqual([1, 2, 3]);
    expect(r.state.starts).toBe(3);
    expect(r.state.recording).toBe(false);
  });

  it('schedules each chirp after capture has started, one per trial', async () => {
    const r = rig({ latencyS: 0.04 });
    await measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep, trials: 2 });
    expect(r.state.scheduled).toHaveLength(2);
    expect(r.state.scheduled[1]).toBeGreaterThan(r.state.scheduled[0] + 0.5);
  });

  it('finds a latency near the top of the search window', async () => {
    const r = rig({ latencyS: 0.42 });
    const result = await measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep });
    expect(Math.abs(result.delayS - 0.42)).toBeLessThan(5e-5);
  });

  it('throws the no-echo message when the room is silent, after one trial', async () => {
    const r = rig({ latencyS: 0.05, echo: false });
    await expect(measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep })).rejects.toThrow(
      /No echo detected: check that the speakers\/headphones are audible to the mic/,
    );
    expect(r.state.starts).toBe(1);
    expect(r.state.recording).toBe(false);
  });

  it('tells the singer headphones must be audible to the mic', async () => {
    const r = rig({ latencyS: 0.05, echo: false });
    await expect(measureLatency(r.engine, r.mic, r.capture, { sleep: r.sleep })).rejects.toThrow(
      /headphones/,
    );
  });

  it('refuses without an open mic and stops capture when the clock is stuck', async () => {
    const closed = rig({ latencyS: 0.05, micOpen: false });
    await expect(measureLatency(closed.engine, closed.mic, closed.capture)).rejects.toThrow(/mic/i);
    expect(closed.state.starts).toBe(0);

    const stuck = rig({ latencyS: 0.05, frozen: true });
    await expect(
      measureLatency(stuck.engine, stuck.mic, stuck.capture, { sleep: stuck.sleep }),
    ).rejects.toThrow(/clock/);
    expect(stuck.state.recording).toBe(false);
  });
});
