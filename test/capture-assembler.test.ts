/**
 * Tests for the capture assembler: blocks placed by video time, in order and
 * out of order, with pauses, an ad span, seeks, and the coverage and gap
 * numbers that the capture's Stop button and its summary rest on. The blocks
 * are constants of a known value, so where a sample landed is checked exactly.
 */
import { describe, expect, it } from 'vitest';
import { CaptureAssembler, SNAP_S } from '../src/audio/capture-assembler';

const RATE = 1000;

/** `seconds` of one constant value, so a block is identified by its value. */
function block(value: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE)).fill(value);
}

/** The value at video time `s`. */
function at(a: CaptureAssembler, s: number): number {
  return a.pcm[Math.round(s * RATE)] ?? Number.NaN;
}

describe('CaptureAssembler', () => {
  it('rejects a buffer with no length', () => {
    expect(() => new CaptureAssembler(0, 10)).toThrow(RangeError);
    expect(() => new CaptureAssembler(RATE, 0)).toThrow(RangeError);
  });

  it('places blocks in order and reports full coverage', () => {
    const a = new CaptureAssembler(RATE, 4);
    for (let i = 0; i < 4; i += 1) a.place(block(i + 1, 1), i);
    expect([at(a, 0.5), at(a, 1.5), at(a, 2.5), at(a, 3.5)]).toEqual([1, 2, 3, 4]);
    expect(a.coverage).toBe(1);
    expect(a.largestGapS).toBe(0);
    expect(a.durationS).toBe(4);
  });

  it('starts with nothing covered and a gap as long as the video', () => {
    const a = new CaptureAssembler(RATE, 10);
    expect(a.coverage).toBe(0);
    expect(a.largestGapS).toBe(10);
  });

  it('leaves the time of a pause uncovered only when blocks were skipped', () => {
    // Paused at 3 s: no blocks arrive, and playing resumes at 3 s, so the
    // video position is continuous and nothing is missing.
    const a = new CaptureAssembler(RATE, 6);
    a.place(block(1, 3), 0);
    a.place(block(2, 3), 3);
    expect(a.coverage).toBe(1);
  });

  it('leaves an ad span as a gap, and counts it', () => {
    // An ad ran from 2 s to 4 s of wall time; the video clock froze at 2 s
    // and no block was offered. The video then went on from 2 s: the ad cost
    // nothing. A video that played 0 to 2 s, then 4 to 6 s (the singer seeked
    // past something) has a 2 s hole.
    const a = new CaptureAssembler(RATE, 6);
    a.place(block(1, 2), 0);
    a.place(block(3, 2), 4);
    expect(a.coverage).toBeCloseTo(4 / 6, 10);
    expect(a.largestGapS).toBe(2);
    expect(at(a, 3)).toBe(0);
  });

  it('writes a seek back over what was there, and a seek forward leaves a gap', () => {
    const a = new CaptureAssembler(RATE, 10);
    a.place(block(1, 4), 0);
    a.place(block(2, 2), 1);
    expect([at(a, 0.5), at(a, 1.5), at(a, 2.5), at(a, 3.5)]).toEqual([1, 2, 2, 1]);
    a.place(block(3, 2), 7);
    expect(a.coverage).toBeCloseTo(0.6, 10);
    // 4 to 7 s is the biggest hole, ahead of 9 s to the end.
    expect(a.largestGapS).toBe(3);
  });

  it('counts overlapped time once', () => {
    const a = new CaptureAssembler(RATE, 10);
    a.place(block(1, 5), 0);
    a.place(block(1, 5), 2);
    a.place(block(1, 1), 3);
    expect(a.coverage).toBeCloseTo(0.7, 10);
    expect(a.largestGapS).toBe(3);
  });

  it('merges spans that a later block joins', () => {
    const a = new CaptureAssembler(RATE, 10);
    a.place(block(1, 2), 0);
    a.place(block(1, 2), 6);
    expect(a.largestGapS).toBe(4);
    a.place(block(1, 4), 2);
    expect(a.coverage).toBeCloseTo(0.8, 10);
    expect(a.largestGapS).toBe(2);
  });

  it('treats clock jitter inside the snap window as a continuation', () => {
    const a = new CaptureAssembler(RATE, 3);
    a.place(block(1, 1), 0);
    // 20 ms late and 20 ms early would leave a sliver and an overlap.
    a.place(block(2, 1), 1.02);
    a.place(block(3, 1), 1.98);
    expect(a.coverage).toBe(1);
    expect(at(a, 1.01)).toBe(2);
    expect(at(a, 2.01)).toBe(3);
  });

  it('keeps a start beyond the snap window where its time says', () => {
    const a = new CaptureAssembler(RATE, 3);
    a.place(block(1, 1), 0);
    a.place(block(2, 1), 1 + SNAP_S + 0.02);
    a.place(block(3, 0.95), 2.05);
    expect(a.largestGapS).toBeCloseTo(SNAP_S + 0.02, 6);
  });

  it('places by time after breakRun even when the next block is close', () => {
    const a = new CaptureAssembler(RATE, 3);
    a.place(block(1, 1), 0);
    a.breakRun();
    a.place(block(2, 1), 1.02);
    expect(at(a, 1.01)).toBe(0);
    expect(at(a, 1.03)).toBe(2);
  });

  it('crops what falls outside the video', () => {
    const a = new CaptureAssembler(RATE, 2);
    a.place(block(1, 1), -0.5);
    a.place(block(2, 1), 1.5);
    expect(a.pcm.length).toBe(2000);
    expect(at(a, 0.2)).toBe(1);
    expect(at(a, 1.8)).toBe(2);
    expect(a.coverage).toBeCloseTo(0.5, 10);
    expect(a.largestGapS).toBe(1);
  });

  it('ignores an empty block and a time that is not a number', () => {
    const a = new CaptureAssembler(RATE, 2);
    a.place(new Float32Array(0), 0);
    a.place(block(1, 1), Number.NaN);
    expect(a.coverage).toBe(0);
  });
});
