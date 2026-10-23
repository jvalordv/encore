/**
 * Unit tests for the live pitch tracker: the pure maths in pitch.ts against
 * synthetic signals with known answers, the hop and timing behaviour of the
 * worklet's PitchWindower, and the main-thread PitchTracker's voicing gate and
 * wiring against a fake AudioWorkletNode. The processor registration itself
 * needs a real audio thread and is exercised by the Playwright smoke test in a
 * later phase.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLARITY,
  MAX_F0,
  MIN_F0,
  PITCH_HOP,
  PITCH_WINDOW,
  centsBetween,
  estimatePitch,
  hzToMidi,
  midiToHz,
  nsdf,
  parabolicInterpolate,
  pickPeak,
  rms,
} from '../src/analysis/pitch';
import type { PitchFrame } from '../src/analysis/pitch';
import { PitchTracker, RateMeter, applyVoicing } from '../src/analysis/pitch-tracker';
import { PITCH_PROCESSOR_NAME, PitchWindower } from '../src/analysis/pitch-worklet';
import type { AudioEngine } from '../src/audio/engine';

const RATE = 48000;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Seeded uniform noise in [-1, 1) so failures reproduce. */
function noise(n: number, seed: number): Float32Array {
  let a = seed >>> 0;
  return Float32Array.from({ length: n }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  });
}

/** `n` samples of `wave(phase)`, phase in cycles, starting at sample `from`. */
function tone(hz: number, n: number, wave: (cycles: number) => number, from = 0): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => wave((hz * (from + i)) / RATE));
}

const sine = (c: number) => 0.6 * Math.sin(2 * Math.PI * c);
const triangle = (c: number) => 0.6 * (4 * Math.abs(c - Math.floor(c + 0.5)) - 1);
/** Band-limited sawtooth: ten harmonics at 1/k, so the fundamental is weak. */
const sawtooth10 = (c: number) => {
  let sum = 0;
  for (let k = 1; k <= 10; k++) sum += Math.sin(2 * Math.PI * k * c) / k;
  return 0.4 * sum;
};

/** Signed error of a Hz estimate against the truth, in cents. */
function errCents(est: number, truth: number): number {
  return centsBetween(truth, est);
}

describe('constants', () => {
  it('match the architecture doc', () => {
    expect(PITCH_WINDOW).toBe(2048);
    expect(PITCH_HOP).toBe(480);
    expect(MIN_F0).toBe(60);
    expect(MAX_F0).toBe(1200);
    expect(DEFAULT_CLARITY).toBe(0.9);
  });
});

describe('conversions', () => {
  it('hzToMidi puts A4 at 69 and octaves 12 apart', () => {
    expect(hzToMidi(440)).toBeCloseTo(69, 10);
    expect(hzToMidi(880)).toBeCloseTo(81, 10);
    expect(hzToMidi(261.6256)).toBeCloseTo(60, 3);
  });

  it('midiToHz inverts hzToMidi, including fractional notes', () => {
    expect(midiToHz(69)).toBeCloseTo(440, 10);
    for (const hz of [82.4, 196, 523.25, 1046.5]) {
      expect(midiToHz(hzToMidi(hz))).toBeCloseTo(hz, 8);
    }
    expect(hzToMidi(midiToHz(60.37))).toBeCloseTo(60.37, 10);
  });

  it('centsBetween is signed and 100 per semitone', () => {
    expect(Math.abs(centsBetween(440, 466.1638) - 100)).toBeLessThan(0.01);
    expect(centsBetween(466.1638, 440)).toBeLessThan(-99.99);
    expect(centsBetween(440, 880)).toBeCloseTo(1200, 8);
    expect(centsBetween(440, 440)).toBe(0);
  });

  it('gives NaN, not infinity, for frequencies that cannot be converted', () => {
    expect(hzToMidi(0)).toBeNaN();
    expect(hzToMidi(-5)).toBeNaN();
    expect(centsBetween(0, 440)).toBeNaN();
    expect(centsBetween(440, 0)).toBeNaN();
  });
});

describe('rms', () => {
  it('is amplitude over root two for a sine and 0 when empty', () => {
    expect(rms(tone(100, 4800, (c) => Math.sin(2 * Math.PI * c)))).toBeCloseTo(Math.SQRT1_2, 3);
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(new Float32Array(10))).toBe(0);
  });
});

describe('nsdf', () => {
  it('is 1 at lag 0 and spans lags 0..N/2', () => {
    const curve = nsdf(tone(220, 2048, sine));
    expect(curve).toHaveLength(1025);
    expect(curve[0]).toBeCloseTo(1, 5);
  });

  it('peaks near 1 at the period of a sine, whatever its level', () => {
    for (const gain of [1, 0.01]) {
      const x = tone(480, 2048, sine).map((v) => v * gain);
      const curve = nsdf(x);
      // 480 Hz at 48 kHz is exactly 100 samples per cycle.
      expect(curve[100]).toBeGreaterThan(0.99);
      expect(curve[50]).toBeLessThan(-0.99);
    }
  });

  it('is all zeros for silence and bounded by 1 for anything', () => {
    expect(Math.max(...nsdf(new Float32Array(2048)))).toBe(0);
    const curve = nsdf(noise(2048, 3));
    for (const v of curve) expect(Math.abs(v)).toBeLessThanOrEqual(1.0001);
  });

  it('agrees with the textbook definition on a short random signal', () => {
    const x = noise(64, 8);
    const curve = nsdf(x);
    for (let tau = 0; tau <= 32; tau++) {
      let r = 0;
      let m = 0;
      for (let j = 0; j + tau < 64; j++) {
        r += x[j] * x[j + tau];
        m += x[j] * x[j] + x[j + tau] * x[j + tau];
      }
      expect(curve[tau]).toBeCloseTo((2 * r) / m, 4);
    }
  });
});

describe('parabolicInterpolate', () => {
  it('recovers the vertex of an exact parabola', () => {
    const vertex = 10.3;
    const arr = Float32Array.from({ length: 21 }, (_, i) => 0.8 - 0.01 * (i - vertex) ** 2);
    const { x, y } = parabolicInterpolate(arr, 10);
    expect(x).toBeCloseTo(vertex, 4);
    expect(y).toBeCloseTo(0.8, 5);
  });

  it('leaves a symmetric peak where it is and tolerates the array ends', () => {
    expect(parabolicInterpolate(Float32Array.of(0, 1, 0), 1)).toEqual({ x: 1, y: 1 });
    expect(parabolicInterpolate(Float32Array.of(1, 0.5, 0), 0)).toEqual({ x: 0, y: 1 });
    expect(parabolicInterpolate(Float32Array.of(0, 0.5, 1), 2)).toEqual({ x: 2, y: 1 });
    expect(parabolicInterpolate(Float32Array.of(1, 1, 1), 1)).toEqual({ x: 1, y: 1 });
  });
});

describe('pickPeak', () => {
  /** An NSDF-shaped curve: lobe at 0, then positive lobes at the given lags. */
  function curveWith(peaks: Record<number, number>, length = 400): Float32Array {
    const out = new Float32Array(length);
    out.fill(-0.3);
    for (let i = 0; i < 12; i++) out[i] = 1 - i / 12;
    for (const [lagText, height] of Object.entries(peaks)) {
      const lag = Number(lagText);
      for (let d = -6; d <= 6; d++) out[lag + d] = height * (1 - (d / 7) ** 2);
    }
    return out;
  }

  it('prefers the first peak within k of the tallest, avoiding octave errors', () => {
    const picked = pickPeak(curveWith({ 100: 0.95, 200: 1.0, 300: 0.97 }), 20, 350);
    expect(picked!.lag).toBeCloseTo(100, 1);
    expect(picked!.clarity).toBeCloseTo(0.95, 2);
  });

  it('skips a first peak that falls below k of the tallest', () => {
    const picked = pickPeak(curveWith({ 100: 0.6, 200: 1.0 }), 20, 350);
    expect(picked!.lag).toBeCloseTo(200, 1);
  });

  it('honours k', () => {
    const curve = curveWith({ 100: 0.6, 200: 1.0 });
    expect(pickPeak(curve, 20, 350, 0.5)!.lag).toBeCloseTo(100, 1);
  });

  it('ignores peaks outside the lag range and a lobe the range cuts off', () => {
    const curve = curveWith({ 100: 0.95, 200: 1.0 });
    expect(pickPeak(curve, 150, 350)!.lag).toBeCloseTo(200, 1);
    expect(pickPeak(curve, 20, 150)!.lag).toBeCloseTo(100, 1);
    // maxLag lands on the rising side of the 200 lobe: not a peak yet.
    expect(pickPeak(curve, 150, 196)).toBeNull();
  });

  it('returns null when the curve never goes negative or has no lobes', () => {
    expect(pickPeak(new Float32Array(100).fill(0.9), 5, 90)).toBeNull();
    expect(pickPeak(new Float32Array(100).fill(-0.5), 5, 90)).toBeNull();
    expect(pickPeak(new Float32Array(100), 50, 40)).toBeNull();
  });
});

describe('estimatePitch accuracy at 48 kHz on 2048-sample windows', () => {
  it.each([82.4, 110, 220, 440, 880])('reads a %f Hz sine within 5 cents', (hz) => {
    for (const offset of [0, 777, 12345]) {
      const est = estimatePitch(tone(hz, PITCH_WINDOW, sine, offset), RATE);
      expect(Math.abs(errCents(est.f0, hz))).toBeLessThan(5);
      expect(est.clarity).toBeGreaterThan(0.95);
    }
  });

  it('reads a ten-harmonic sawtooth at 196 Hz within 5 cents, no octave error', () => {
    const est = estimatePitch(tone(196, PITCH_WINDOW, sawtooth10), RATE);
    expect(Math.abs(errCents(est.f0, 196))).toBeLessThan(5);
    expect(est.clarity).toBeGreaterThan(0.9);
  });

  it('reads a triangle at 330 Hz within 5 cents', () => {
    const est = estimatePitch(tone(330, PITCH_WINDOW, triangle), RATE);
    expect(Math.abs(errCents(est.f0, 330))).toBeLessThan(5);
  });

  it('sweeps the singing range with no octave jumps', () => {
    for (let midi = 40; midi <= 84; midi += 1.37) {
      const hz = midiToHz(midi);
      const est = estimatePitch(tone(hz, PITCH_WINDOW, sawtooth10), RATE);
      expect(Math.abs(errCents(est.f0, hz))).toBeLessThan(8);
    }
  });

  it('tracks a 440 Hz tone with 6 Hz, +/-30 cent vibrato to within 10 cents', () => {
    const seconds = 1;
    const total = RATE * seconds;
    const x = new Float32Array(total);
    const instantHz = (t: number) => 440 * 2 ** ((30 / 1200) * Math.sin(2 * Math.PI * 6 * t));
    let phase = 0;
    for (let i = 0; i < total; i++) {
      x[i] = 0.6 * Math.sin(phase);
      // Integrate the frequency so the phase is exact, not f(t) * t.
      phase += (2 * Math.PI * instantHz(i / RATE)) / RATE;
    }
    let worst = 0;
    let windows = 0;
    for (let start = 0; start + PITCH_WINDOW <= total; start += PITCH_HOP) {
      const est = estimatePitch(x.subarray(start, start + PITCH_WINDOW), RATE);
      const centre = (start + PITCH_WINDOW / 2) / RATE;
      worst = Math.max(worst, Math.abs(errCents(est.f0, instantHz(centre))));
      windows++;
    }
    expect(windows).toBeGreaterThan(90);
    expect(worst).toBeLessThan(10);
  });

  it('still reads the right pitch through DC offset and low level', () => {
    const x = tone(220, PITCH_WINDOW, sine).map((v) => v * 0.01 + 0.3);
    const est = estimatePitch(x, RATE);
    expect(Math.abs(errCents(est.f0, 220))).toBeLessThan(5);
    expect(est.rms).toBeCloseTo(0.006 / Math.SQRT2, 3);
  });

  it('honours the search range', () => {
    const x = tone(1000, PITCH_WINDOW, sine);
    expect(estimatePitch(x, RATE, { maxF0: 500 }).f0).not.toBeCloseTo(1000, -1);
    expect(Math.abs(errCents(estimatePitch(x, RATE, { maxF0: 1500 }).f0, 1000))).toBeLessThan(5);
  });
});

describe('estimatePitch on signals with no pitch', () => {
  it('reports low clarity for white noise', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const est = estimatePitch(noise(PITCH_WINDOW, seed), RATE);
      expect(est.clarity).toBeLessThan(0.5);
      expect(est.rms).toBeGreaterThan(0.4);
    }
  });

  it('reports zero clarity, zero f0 and zero level for silence', () => {
    expect(estimatePitch(new Float32Array(PITCH_WINDOW), RATE)).toEqual({ f0: 0, clarity: 0, rms: 0 });
  });

  it('reports a constant offset as unvoiced rather than as a strong pitch', () => {
    const est = estimatePitch(new Float32Array(PITCH_WINDOW).fill(0.5), RATE);
    expect(est.f0).toBe(0);
    expect(est.clarity).toBe(0);
  });

  it('does not mistake sub-range hum for the lowest note', () => {
    const est = estimatePitch(tone(30, PITCH_WINDOW, sine), RATE);
    expect(est.clarity < 0.5 || est.f0 >= MIN_F0).toBe(true);
  });
});

describe('estimatePitch speed', () => {
  it('runs 100 windows of 2048 samples well inside the audio-thread budget', () => {
    const x = tone(196, PITCH_WINDOW, sawtooth10);
    estimatePitch(x, RATE);
    const started = performance.now();
    for (let i = 0; i < 100; i++) estimatePitch(x, RATE);
    const ms = performance.now() - started;
    console.log(`100 x estimatePitch(2048 @ 48 kHz): ${ms.toFixed(1)} ms (${(ms / 100).toFixed(3)} ms each)`);
    // One second of audio is 100 hops, so this is a real-time factor check;
    // the bound is generous so a loaded CI machine does not flake.
    expect(ms).toBeLessThan(200);
  });
});

describe('PitchWindower', () => {
  /** Streams `x` through a windower in 128-sample quanta from time t0. */
  function run(x: Float32Array, t0 = 0, opts = {}): PitchFrame[] {
    const frames: PitchFrame[] = [];
    const windower = new PitchWindower(RATE, (f) => frames.push(f), opts);
    for (let at = 0; at < x.length; at += 128) {
      windower.push(x.subarray(at, Math.min(at + 128, x.length)), t0 + at / RATE);
    }
    return frames;
  }

  it('emits nothing until a full window has arrived', () => {
    expect(run(tone(440, PITCH_WINDOW - 1, sine))).toHaveLength(0);
    expect(run(tone(440, PITCH_WINDOW, sine))).toHaveLength(1);
  });

  it('emits one frame per hop, a steady 100 per second, though 480 is not a multiple of 128', () => {
    const frames = run(tone(440, RATE, sine));
    expect(frames).toHaveLength(Math.floor((RATE - PITCH_WINDOW) / PITCH_HOP) + 1);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].t - frames[i - 1].t).toBeCloseTo(PITCH_HOP / RATE, 9);
    }
  });

  it('stamps frames at the window centre on the context clock', () => {
    const t0 = 12.5;
    const frames = run(tone(440, 8000, sine), t0);
    expect(frames[0].t).toBeCloseTo(t0 + PITCH_WINDOW / 2 / RATE, 9);
    expect(frames[1].t).toBeCloseTo(t0 + (PITCH_WINDOW / 2 + PITCH_HOP) / RATE, 9);
  });

  it('feeds estimatePitch the latest samples in time order across the ring wrap', () => {
    // A tone that changes pitch halfway: late frames must see only the new one.
    const x = new Float32Array(RATE / 2);
    x.set(tone(220, RATE / 4, sine), 0);
    x.set(tone(440, RATE / 4, sine), RATE / 4);
    const frames = run(x);
    expect(Math.abs(errCents(frames[0].f0, 220))).toBeLessThan(5);
    const last = frames[frames.length - 1];
    expect(Math.abs(errCents(last.f0, 440))).toBeLessThan(5);
    expect(last.clarity).toBeGreaterThan(0.95);
  });

  it('passes the search range through and reports silence as unvoiced', () => {
    const quiet = run(new Float32Array(4096));
    expect(quiet.length).toBeGreaterThan(0);
    for (const f of quiet) expect(f).toMatchObject({ f0: 0, clarity: 0, rms: 0 });
    const high = run(tone(1000, 4096, sine), 0, { maxF0: 500 });
    expect(Math.abs(errCents(high[0].f0, 1000))).toBeGreaterThan(50);
  });

  it('restarts cleanly after reset', () => {
    const frames: PitchFrame[] = [];
    const windower = new PitchWindower(RATE, (f) => frames.push(f));
    windower.push(tone(440, PITCH_WINDOW, sine), 0);
    expect(frames).toHaveLength(1);
    windower.reset();
    windower.push(tone(440, PITCH_WINDOW - 1, sine), 1);
    expect(frames).toHaveLength(1);
  });
});

describe('applyVoicing', () => {
  const base: PitchFrame = { t: 1, f0: 220, clarity: 0.93, rms: 0.2 };

  it('keeps f0 for frames at or above the threshold', () => {
    expect(applyVoicing(base, 0.9)).toBe(base);
    expect(applyVoicing(base, 0.93).f0).toBe(220);
  });

  it('zeroes f0 below the threshold but keeps the evidence', () => {
    expect(applyVoicing(base, 0.95)).toEqual({ t: 1, f0: 0, clarity: 0.93, rms: 0.2 });
  });

  it('never reports a pitch for a frame the estimator gave none', () => {
    expect(applyVoicing({ t: 0, f0: 0, clarity: 1, rms: 1 }, 0).f0).toBe(0);
  });
});

describe('RateMeter', () => {
  it('measures events per second from the span of the window', () => {
    let now = 0;
    const meter = new RateMeter(1000, () => now);
    expect(meter.rate).toBe(0);
    for (let i = 0; i < 50; i++) {
      now = i * 10;
      meter.tick();
    }
    expect(meter.rate).toBeCloseTo(100, 6);
  });

  it('decays to 0 when events stop and ignores bursts shorter than 100 ms', () => {
    let now = 0;
    const meter = new RateMeter(1000, () => now);
    meter.tick();
    now = 5;
    meter.tick();
    expect(meter.rate).toBe(0);
    now = 5000;
    expect(meter.rate).toBe(0);
  });

  it('forgets everything on reset', () => {
    let now = 0;
    const meter = new RateMeter(1000, () => now);
    for (let i = 0; i < 30; i++) {
      now = i * 10;
      meter.tick();
    }
    meter.reset();
    expect(meter.rate).toBe(0);
  });
});

/** Stand-in for AudioWorkletNode: records wiring, lets a test play worklet. */
class FakeNode {
  static last: FakeNode | null = null;
  readonly options: { name: string; processorOptions?: Record<string, unknown> };
  readonly connections: unknown[] = [];
  disconnected = false;
  closed = false;
  readonly port = {
    onmessage: null as ((e: { data: PitchFrame }) => void) | null,
    close: () => {
      this.closed = true;
    },
  };

  constructor(_context: unknown, name: string, options: object) {
    this.options = { name, ...options };
    FakeNode.last = this;
  }

  connect(target: unknown) {
    this.connections.push(target);
  }

  disconnect() {
    this.disconnected = true;
  }

  /** Delivers a frame from the "worklet" to the main thread. */
  emit(data: PitchFrame) {
    this.port.onmessage?.({ data });
  }
}

function fakeEngine(opts: { audioWorklet?: boolean } = {}) {
  const addModule = vi.fn(async (_url: string) => {});
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  const destination = {};
  const context = {
    sampleRate: RATE,
    destination,
    audioWorklet: opts.audioWorklet === false ? undefined : { addModule },
    createGain: () => gain,
  };
  const engine = { context, now: () => 0 } as unknown as AudioEngine;
  return { engine, addModule, gain, destination };
}

function fakeSource() {
  return { connect: vi.fn(), disconnect: vi.fn() };
}

describe('PitchTracker', () => {
  beforeEach(() => {
    FakeNode.last = null;
    vi.stubGlobal('AudioWorkletNode', FakeNode);
  });

  it('is unsupported where AudioWorklet is absent', () => {
    expect(PitchTracker.isSupported()).toBe(false);
  });

  it('loads the module once per context, even across instances', async () => {
    const { engine, addModule } = fakeEngine();
    await Promise.all([new PitchTracker(engine).load(), new PitchTracker(engine).load()]);
    await new PitchTracker(engine).load();
    expect(addModule).toHaveBeenCalledTimes(1);
  });

  it('explains a missing AudioWorklet instead of crashing at import', async () => {
    const { engine } = fakeEngine({ audioWorklet: false });
    await expect(new PitchTracker(engine).load()).rejects.toThrow(/AudioWorklet/);
  });

  it('refuses to connect before load', () => {
    const { engine } = fakeEngine();
    expect(() => new PitchTracker(engine).connect(fakeSource() as unknown as AudioNode)).toThrow(/load/);
  });

  it('builds a mono node with the search options and mutes its output path', async () => {
    const { engine, gain, destination } = fakeEngine();
    const tracker = new PitchTracker(engine, { minF0: 80, maxF0: 900 });
    await tracker.load();
    const source = fakeSource();
    tracker.connect(source as unknown as AudioNode);
    const node = FakeNode.last!;
    expect(node.options).toMatchObject({
      name: PITCH_PROCESSOR_NAME,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { minF0: 80, maxF0: 900 },
    });
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node.connections).toEqual([gain]);
    expect(gain.gain.value).toBe(0);
    expect(gain.connect).toHaveBeenCalledWith(destination);
  });

  it('delivers voiced frames as they are and unvoiced ones with f0 = 0', async () => {
    const { engine } = fakeEngine();
    const tracker = new PitchTracker(engine);
    await tracker.load();
    tracker.connect(fakeSource() as unknown as AudioNode);
    const got: PitchFrame[] = [];
    tracker.onFrame((f) => got.push(f));
    FakeNode.last!.emit({ t: 1, f0: 220, clarity: 0.97, rms: 0.3 });
    FakeNode.last!.emit({ t: 1.01, f0: 231, clarity: 0.6, rms: 0.01 });
    expect(got).toEqual([
      { t: 1, f0: 220, clarity: 0.97, rms: 0.3 },
      { t: 1.01, f0: 0, clarity: 0.6, rms: 0.01 },
    ]);
  });

  it('applies a changed clarity threshold to the next frame and clamps it', async () => {
    const { engine } = fakeEngine();
    const tracker = new PitchTracker(engine, { clarityThreshold: 0.5 });
    expect(tracker.clarityThreshold).toBe(0.5);
    await tracker.load();
    tracker.connect(fakeSource() as unknown as AudioNode);
    const got: PitchFrame[] = [];
    tracker.onFrame((f) => got.push(f));
    FakeNode.last!.emit({ t: 0, f0: 200, clarity: 0.7, rms: 0.1 });
    tracker.clarityThreshold = 0.8;
    FakeNode.last!.emit({ t: 0.01, f0: 200, clarity: 0.7, rms: 0.1 });
    expect(got.map((f) => f.f0)).toEqual([200, 0]);
    tracker.clarityThreshold = 7;
    expect(tracker.clarityThreshold).toBe(1);
    tracker.clarityThreshold = Number.NaN;
    expect(tracker.clarityThreshold).toBe(1);
    expect(new PitchTracker(engine).clarityThreshold).toBe(DEFAULT_CLARITY);
  });

  it('stops delivering to an unsubscribed listener and survives a throwing one', async () => {
    const deferred: Array<() => void> = [];
    vi.stubGlobal('queueMicrotask', (fn: () => void) => deferred.push(fn));
    const { engine } = fakeEngine();
    const tracker = new PitchTracker(engine);
    await tracker.load();
    tracker.connect(fakeSource() as unknown as AudioNode);
    const a = vi.fn();
    const b = vi.fn();
    tracker.onFrame(() => {
      throw new Error('listener bug');
    });
    const offA = tracker.onFrame(a);
    tracker.onFrame(b);
    FakeNode.last!.emit({ t: 0, f0: 100, clarity: 1, rms: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveLength(1);
    offA();
    FakeNode.last!.emit({ t: 0.01, f0: 100, clarity: 1, rms: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  it('ignores malformed messages', async () => {
    const { engine } = fakeEngine();
    const tracker = new PitchTracker(engine);
    await tracker.load();
    tracker.connect(fakeSource() as unknown as AudioNode);
    const cb = vi.fn();
    tracker.onFrame(cb);
    FakeNode.last!.emit(null as unknown as PitchFrame);
    FakeNode.last!.emit({ nope: 1 } as unknown as PitchFrame);
    expect(cb).not.toHaveBeenCalled();
  });

  it('tears the node down on disconnect, keeps listeners, and can reconnect', async () => {
    const { engine } = fakeEngine();
    const tracker = new PitchTracker(engine);
    await tracker.load();
    const source = fakeSource();
    tracker.connect(source as unknown as AudioNode);
    const first = FakeNode.last!;
    const cb = vi.fn();
    tracker.onFrame(cb);
    tracker.disconnect();
    expect(first.disconnected).toBe(true);
    expect(first.closed).toBe(true);
    expect(source.disconnect).toHaveBeenCalledWith(first);
    expect(tracker.framesPerSecond).toBe(0);
    tracker.disconnect();
    tracker.connect(source as unknown as AudioNode);
    expect(FakeNode.last).not.toBe(first);
    FakeNode.last!.emit({ t: 0, f0: 100, clarity: 1, rms: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('swaps the source on a second connect without building a second node', async () => {
    const { engine } = fakeEngine();
    const tracker = new PitchTracker(engine);
    await tracker.load();
    const one = fakeSource();
    const two = fakeSource();
    tracker.connect(one as unknown as AudioNode);
    const node = FakeNode.last!;
    tracker.connect(two as unknown as AudioNode);
    expect(FakeNode.last).toBe(node);
    expect(one.disconnect).toHaveBeenCalledWith(node);
    expect(two.connect).toHaveBeenCalledWith(node);
  });
});
