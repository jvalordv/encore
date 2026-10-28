/**
 * Tests for note segmentation of a take (src/analysis/take-notes.ts) on
 * synthetic contours whose notes are known: the rule of docs/COACHING.md, a
 * voiced run of at least 80 ms, split where the median-filtered pitch moves
 * 80 cents and holds 60 ms, gaps under 40 ms merged.
 */
import { describe, expect, it } from 'vitest';
import { midiToHz } from '../src/analysis/pitch';
import { median, segmentTake } from '../src/analysis/take-notes';

/** One 10 ms frame per step: `midi` of null is unvoiced. */
export function contour(parts: Array<[frames: number, midi: number | null]>, t0 = 0) {
  const out: Array<{ t: number; f0: number }> = [];
  for (const [frames, midi] of parts) {
    for (let i = 0; i < frames; i++) {
      out.push({ t: t0 + out.length * 0.01, f0: midi === null ? 0 : midiToHz(midi) });
    }
  }
  return out;
}

describe('segmentTake', () => {
  it('finds nothing in silence or an empty take', () => {
    expect(segmentTake([])).toEqual([]);
    expect(segmentTake(contour([[100, null]]))).toEqual([]);
  });

  it('finds one steady note with its onset, offset and pitch', () => {
    const notes = segmentTake(contour([[20, null], [100, 60], [20, null]]));
    expect(notes).toHaveLength(1);
    expect(notes[0].onsetS).toBeCloseTo(0.2, 6);
    expect(notes[0].offsetS).toBeCloseTo(1.2, 6);
    expect(notes[0].midi).toBeCloseTo(60, 6);
    expect(notes[0].frames).toHaveLength(100);
  });

  it('drops a voiced run under 80 ms and keeps one of exactly 80 ms', () => {
    expect(segmentTake(contour([[10, null], [7, 60], [10, null]]))).toEqual([]);
    expect(segmentTake(contour([[10, null], [8, 60], [10, null]]))).toHaveLength(1);
  });

  it('splits where the pitch jumps and holds', () => {
    const notes = segmentTake(contour([[50, 60], [50, 64]]));
    expect(notes).toHaveLength(2);
    expect(notes[0].midi).toBeCloseTo(60, 6);
    expect(notes[1].midi).toBeCloseTo(64, 6);
    expect(notes[1].onsetS).toBeCloseTo(0.5, 6);
    expect(notes[0].offsetS).toBeCloseTo(0.5, 6);
  });

  it('does not split on a short blip', () => {
    // Three frames (30 ms) of another pitch is a tracker slip, not a note.
    const notes = segmentTake(contour([[50, 60], [3, 64], [50, 60]]));
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBeCloseTo(60, 6);
  });

  it('needs the new pitch to hold 60 ms: five frames do not split, eight do', () => {
    expect(segmentTake(contour([[50, 60], [5, 64], [50, 60]]))).toHaveLength(1);
    expect(segmentTake(contour([[50, 60], [8, 64], [50, 60]]))).toHaveLength(3);
  });

  it('does not split on a move under 80 cents, however long it holds', () => {
    expect(segmentTake(contour([[50, 60], [50, 60.7]]))).toHaveLength(1);
    expect(segmentTake(contour([[50, 60], [50, 60.9]]))).toHaveLength(2);
  });

  it('merges a gap under 40 ms and keeps one of 40 ms apart', () => {
    expect(segmentTake(contour([[30, 60], [3, null], [30, 60]]))).toHaveLength(1);
    expect(segmentTake(contour([[30, 60], [4, null], [30, 60]]))).toHaveLength(2);
  });

  it('puts frames on the 10 ms grid whatever their jitter', () => {
    const jittered = contour([[100, 60]]).map((f, i) => ({ ...f, t: f.t + (i % 2 ? 0.002 : -0.002) + 5 }));
    const notes = segmentTake(jittered);
    expect(notes).toHaveLength(1);
    expect(notes[0].frames).toHaveLength(100);
  });

  it('takes a note\'s pitch as the median of its frames', () => {
    const notes = segmentTake(contour([[40, 60], [10, 60.5], [40, 60]]));
    expect(notes).toHaveLength(1);
    expect(notes[0].midi).toBeCloseTo(60, 6);
  });
});

describe('median', () => {
  it('is the middle value, the mean of the middle two, or NaN for none', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });
});
