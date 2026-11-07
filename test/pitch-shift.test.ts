/**
 * Tests for the pitch shifter core on synthetic sines with known answers:
 * the shifted pitch (measured with the repo's own estimator), the length, the
 * silence of a block join, and that the result does not depend on how the
 * stream is cut into blocks.
 */
import { describe, expect, it } from 'vitest';
import { estimatePitch } from '../src/analysis/pitch';
import { PitchShifter, SHIFT_LATENCY_SAMPLES, shiftLatencyS } from '../src/audio/pitch-shift';

const RATE = 48000;

function sine(hz: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}

/** Runs the mono signal through a stereo shifter in blocks; returns channel 0. */
function shift(signal: Float32Array, semitones: number, block = 128): Float32Array {
  const shifter = new PitchShifter(2);
  shifter.setSemitones(semitones);
  const out = new Float32Array(signal.length);
  for (let off = 0; off < signal.length; off += block) {
    const chunk = signal.subarray(off, Math.min(signal.length, off + block));
    const left = new Float32Array(chunk.length);
    const right = new Float32Array(chunk.length);
    shifter.process([chunk, chunk], [left, right]);
    out.set(left, off);
  }
  return out;
}

function centsBetween(a: number, b: number): number {
  return 1200 * Math.log2(a / b);
}

function measure(signal: Float32Array, fromS: number): number {
  const at = Math.round(fromS * RATE);
  return estimatePitch(signal.subarray(at, at + 2048), RATE).f0;
}

describe('PitchShifter', () => {
  it.each([3, -5, 6, -6, 0])('moves a 220 Hz sine by %i semitones within 5 cents', (semitones) => {
    const out = shift(sine(220, 1.5), semitones);
    const want = 220 * 2 ** (semitones / 12);
    for (const at of [0.5, 0.8, 1.1]) {
      expect(Math.abs(centsBetween(measure(out, at), want))).toBeLessThan(5);
    }
  });

  it('shifts a voice-range 130 Hz sine up without drifting', () => {
    const out = shift(sine(130, 1.5), 4);
    expect(Math.abs(centsBetween(measure(out, 0.9), 130 * 2 ** (4 / 12)))).toBeLessThan(5);
  });

  it('returns exactly as many samples as it is given, whatever the blocks', () => {
    const input = sine(220, 0.5);
    for (const block of [1, 64, 128, 1000, 4800]) {
      expect(shift(input, 3, block).length).toBe(input.length);
    }
  });

  it('gives the same samples however the stream is cut into blocks', () => {
    const input = sine(330, 0.4);
    const a = shift(input, -4, 128);
    const b = shift(input, -4, 777);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('has no NaNs and no jump above a sine\'s own slope, joins included', () => {
    const input = sine(220, 1.2);
    for (const semitones of [3, -5]) {
      const out = shift(input, semitones, 128);
      // The steepest step of a 0.5-amplitude sine at the shifted pitch.
      const f = 220 * 2 ** (semitones / 12);
      const steepest = 0.5 * 2 * Math.PI * (f / RATE);
      let worst = 0;
      for (let i = SHIFT_LATENCY_SAMPLES + 1; i < out.length; i++) {
        expect(Number.isFinite(out[i])).toBe(true);
        worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
      }
      expect(worst).toBeLessThan(steepest * 1.5);
    }
  });

  it('keeps the level of the signal (a unit-gain overlap)', () => {
    const out = shift(sine(220, 1.2), 3);
    let peak = 0;
    for (let i = Math.round(0.6 * RATE); i < Math.round(1.1 * RATE); i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeGreaterThan(0.45);
    expect(peak).toBeLessThan(0.56);
  });

  it('is silent until the latency has passed and states it', () => {
    const out = shift(sine(220, 0.2), 3);
    for (let i = 0; i < SHIFT_LATENCY_SAMPLES; i++) expect(out[i]).toBe(0);
    expect(shiftLatencyS(RATE)).toBeCloseTo(SHIFT_LATENCY_SAMPLES / RATE, 12);
    expect(shiftLatencyS(RATE)).toBeLessThan(0.06);
  });

  it('follows a change of shift mid-stream', () => {
    const shifter = new PitchShifter(1);
    const input = sine(220, 2);
    const out = new Float32Array(input.length);
    for (let off = 0; off < input.length; off += 128) {
      if (off === 48000) shifter.setSemitones(5);
      const chunk = input.subarray(off, off + 128);
      const dest = new Float32Array(chunk.length);
      shifter.process([chunk], [dest]);
      out.set(dest, off);
    }
    expect(Math.abs(centsBetween(measure(out, 1.6), 220 * 2 ** (5 / 12)))).toBeLessThan(5);
  });
});
