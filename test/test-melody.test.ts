/**
 * Tests for the Mic check's test track (src/analysis/test-melody.ts): the
 * contour is exactly the f0 that was synthesised, the four sections tile the
 * 40 s, and the samples stay clear of full scale and sound where the contour
 * says.
 */
import { describe, expect, it } from 'vitest';
import { generateTestMelody, MELODY_HOP_S, melodyF0At, micCheckSections } from '../src/analysis/test-melody';

const RATE = 16000;

/** Rough f0 of a stretch by counting upward zero crossings. */
function zeroCrossingHz(pcm: Float32Array, from: number, to: number, rate: number): number {
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (pcm[i - 1]! < 0 && pcm[i]! >= 0) crossings++;
  return crossings / ((to - from) / rate);
}

describe('micCheckSections', () => {
  it('tiles 0 to 40 s in the four steps, silent then singing', () => {
    const s = micCheckSections();
    expect(s.map((x) => x.label)).toEqual(['quiet', 'speakers', 'sing-along', 'sing-alone']);
    expect(s.map((x) => x.kind)).toEqual(['silent', 'silent', 'sing', 'sing']);
    expect(s[0]!.startS).toBe(0);
    for (let i = 1; i < s.length; i++) expect(s[i]!.startS).toBe(s[i - 1]!.endS);
    expect(s[3]!.endS).toBe(40);
    expect(s.map((x) => x.endS - x.startS)).toEqual([5, 10, 15, 10]);
  });

  it('scales every step', () => {
    expect(micCheckSections(0.1)[3]!.endS).toBeCloseTo(4, 9);
  });
});

describe.each(['low', 'high'] as const)('generateTestMelody (%s)', (range) => {
  const m = generateTestMelody(RATE, range);

  it('has a contour that is exactly the synthesised f0 at a 10 ms hop', () => {
    expect(m.reference.hopS).toBe(MELODY_HOP_S);
    expect(m.reference.t0S).toBe(0);
    expect(m.reference.f0Hz.length).toBe(4001);
    for (let i = 0; i < m.reference.f0Hz.length; i++) {
      expect(m.reference.f0Hz[i]).toBe(melodyF0At(i * MELODY_HOP_S, range, m.sections));
    }
  });

  it('is silent in the quiet and sing-alone steps and voiced inside the melody', () => {
    const f0 = m.reference.f0Hz;
    for (let i = 0; i < 500; i++) expect(f0[i]).toBe(0);
    for (let i = 3000; i < f0.length; i++) expect(f0[i]).toBe(0);
    const voiced = Array.from(f0).filter((v) => v > 0).length;
    // Notes sound 5/6 of the time over the 25 s of melody.
    expect(voiced / 100).toBeGreaterThan(20);
    expect(voiced / 100).toBeLessThan(22);
  });

  it('stays in its range, vibrato included', () => {
    const [low, high] = range === 'low' ? [110, 220] : [220, 440];
    for (const v of Array.from(m.reference.f0Hz)) {
      if (v === 0) continue;
      expect(v).toBeGreaterThan(low * 0.98);
      expect(v).toBeLessThan(high * 1.02);
    }
  });

  it('keeps the peak below full scale and the silent steps empty', () => {
    let peak = 0;
    for (const v of m.pcm) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.6);
    expect(m.pcm.length).toBe(40 * RATE);
    expect(m.pcm.subarray(0, 5 * RATE).every((v) => v === 0)).toBe(true);
    expect(m.pcm.subarray(30 * RATE).every((v) => v === 0)).toBe(true);
  });

  it('sounds at the pitch the contour gives', () => {
    // The first note lasts 0.5 s from 5.0 s; listen to its middle.
    const from = Math.round(5.1 * RATE);
    const to = Math.round(5.4 * RATE);
    const expected = melodyF0At(5.25, range, m.sections);
    const heard = zeroCrossingHz(m.pcm, from, to, RATE);
    expect(Math.abs(heard - expected) / expected).toBeLessThan(0.04);
  });
});
