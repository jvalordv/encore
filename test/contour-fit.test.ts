/**
 * Tests for the contour fit (src/analysis/contour-fit.ts) on synthetic pitch
 * contours with known answers: a 6 Hz vibrato of 50 cents is found at 6 Hz and
 * about 50 cents with a regularity near 1; a drift of 30 cents a second is read
 * as 30 whether or not a vibrato rides on it; a steady note with tracker noise
 * has no vibrato and a spread near the noise; a slow wobble outside the 4 to 8
 * Hz band and a swing of under 25 cents, band-limited wander are not vibrato.
 */
import { describe, expect, it } from 'vitest';
import { measureContour } from '../src/analysis/contour-fit';

/** Deterministic noise in [-1, 1], so a test never flakes. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 4294967296) * 2 - 1;
  };
}

/** A contour of `seconds` at 10 ms, in cents, from a function of time. */
function contour(seconds: number, f: (t: number) => number): { ts: number[]; ys: number[] } {
  const ts: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i * 0.01 < seconds; i++) {
    ts.push(1 + i * 0.01);
    ys.push(f(i * 0.01));
  }
  return { ts, ys };
}

describe('measureContour', () => {
  it('finds a 6 Hz vibrato of 50 cents, regular, with no drift and no spread left', () => {
    const { ts, ys } = contour(1, (t) => 6900 + 50 * Math.sin(2 * Math.PI * 6 * t + 0.7));
    const m = measureContour(ts, ys);
    expect(m?.vibrato).not.toBeNull();
    expect(m?.vibrato?.rateHz).toBeCloseTo(6, 0);
    expect(m?.vibrato?.extentCents).toBeGreaterThan(45);
    expect(m?.vibrato?.extentCents).toBeLessThan(55);
    expect(m?.vibrato?.regularity).toBeGreaterThan(0.95);
    expect(Math.abs(m?.driftCps ?? 99)).toBeLessThan(3);
    expect(m?.stdCents).toBeLessThan(3);
  });

  it('finds the vibrato on a cut of two and a half cycles without mistaking it for drift', () => {
    const { ts, ys } = contour(0.45, (t) => 6900 + 50 * Math.sin(2 * Math.PI * 5.5 * t + 1.3));
    const m = measureContour(ts, ys);
    expect(m?.vibrato?.rateHz).toBeCloseTo(5.5, 0);
    expect(Math.abs(m?.driftCps ?? 99)).toBeLessThan(5);
  });

  it('reads a drift of 30 cents a second, alone and under a vibrato', () => {
    const plain = measureContour(...Object.values(contour(1, (t) => 6900 + 30 * t)) as [number[], number[]]);
    expect(plain?.driftCps).toBeCloseTo(30, 0);
    expect(plain?.vibrato).toBeNull();
    expect(plain?.stdCents).toBeLessThan(1);
    const { ts, ys } = contour(1, (t) => 6900 + 30 * t + 40 * Math.sin(2 * Math.PI * 6 * t));
    const m = measureContour(ts, ys);
    expect(m?.vibrato?.rateHz).toBeCloseTo(6, 0);
    expect(m?.driftCps).toBeGreaterThan(26);
    expect(m?.driftCps).toBeLessThan(34);
  });

  it('finds no vibrato on a steady note with tracker noise, and reports the noise as spread', () => {
    const rand = noise(7);
    const { ts, ys } = contour(1.2, () => 6900 + 12 * rand());
    const m = measureContour(ts, ys);
    expect(m?.vibrato).toBeNull();
    expect(m?.stdCents).toBeGreaterThan(4);
    expect(m?.stdCents).toBeLessThan(10);
    expect(Math.abs(m?.driftCps ?? 99)).toBeLessThan(10);
  });

  it('does not call a swing under 15 cents, or a 2 Hz wobble, a vibrato', () => {
    const small = contour(1, (t) => 6900 + 20 * Math.sin(2 * Math.PI * 6 * t));
    expect(measureContour(small.ts, small.ys)?.vibrato).toBeNull();
    const slow = contour(1.5, (t) => 6900 + 40 * Math.sin(2 * Math.PI * 2 * t));
    expect(measureContour(slow.ts, slow.ys)?.vibrato).toBeNull();
  });

  it('finds no vibrato in 20 cent band-limited wander around 4 to 5 Hz, over several seeds', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rand = noise(seed);
      const comps = Array.from({ length: 6 }, (_, i) => ({
        hz: 4 + i * 0.2,
        phase: rand() * Math.PI,
        amp: 0.5 + 0.5 * Math.abs(rand()),
      }));
      const raw = (t: number): number => comps.reduce((a, c) => a + c.amp * Math.sin(2 * Math.PI * c.hz * t + c.phase), 0);
      const peak = Math.max(...Array.from({ length: 150 }, (_, i) => Math.abs(raw(i * 0.01))));
      const { ts, ys } = contour(1.5, (t) => 6900 + (20 * raw(t)) / peak);
      expect(measureContour(ts, ys)?.vibrato).toBeNull();
    }
  });

  it('lowers the regularity of a vibrato whose speed sweeps, and returns null for too few frames', () => {
    const sweep = contour(1.2, (t) => 6900 + 50 * Math.sin(2 * Math.PI * (4.5 * t + 1.6 * t * t)));
    const m = measureContour(sweep.ts, sweep.ys);
    const steady = measureContour(...Object.values(contour(1.2, (t) => 6900 + 50 * Math.sin(2 * Math.PI * 6 * t))) as [number[], number[]]);
    expect(m?.vibrato?.regularity ?? 0).toBeLessThan(steady?.vibrato?.regularity ?? 0);
    expect(measureContour([1, 1.01], [6900, 6900])).toBeNull();
  });
});
