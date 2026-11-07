/**
 * The keyboard view's pure parts: key rows against the lane's rows, the
 * marker's height, the lit key at a time, and the latest voiced frame.
 */
import { describe, expect, it } from 'vitest';
import { isBlackKey, midiToY } from '../src/render/lane-geometry';
import type { LaneNote, LaneView } from '../src/render/lane-geometry';
import { bandRect, keyRows, latestVoiced, litKey, markerY } from '../src/render/lane-keyboard';

const VIEW: LaneView = {
  width: 600,
  height: 240,
  now: 10,
  windowS: 6,
  futureS: 1.5,
  midiLow: 60,
  midiHigh: 71,
};

describe('keyRows', () => {
  it('gives each key the lane row at midiToY', () => {
    const rows = keyRows(VIEW);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      const centre = midiToY(row.midi, VIEW.midiLow, VIEW.midiHigh, VIEW.height);
      expect(row.top + row.height / 2).toBeCloseTo(centre, 9);
      expect(row.height).toBeCloseTo(20, 9);
    }
    expect(rows[0].top + rows[0].height).toBeCloseTo(240, 9);
    expect(rows[11].top).toBeCloseTo(0, 9);
  });

  it('has the white and black pattern of a piano', () => {
    const pattern = keyRows(VIEW)
      .map((r) => (isBlackKey(r.midi) ? 'b' : 'w'))
      .join('');
    expect(pattern).toBe('wbwbwwbwbwbw');
  });
});

describe('markerY', () => {
  it('sits between rows for a fractional note', () => {
    const y60 = markerY(VIEW, 60);
    const y61 = markerY(VIEW, 61);
    expect(markerY(VIEW, 60.25)).toBeCloseTo(y60 - 0.25 * (y60 - y61), 9);
    expect(y60).toBeCloseTo(230, 9);
  });

  it('is held at the edge outside the range', () => {
    expect(markerY(VIEW, 20)).toBe(markerY(VIEW, 60));
    expect(markerY(VIEW, 100)).toBe(markerY(VIEW, 71));
  });
});

describe('litKey', () => {
  const notes: LaneNote[] = [
    { onsetS: 1, offsetS: 2, midi: 60.4 },
    { onsetS: 2, offsetS: 3, midi: 64 },
    { onsetS: 5, offsetS: 6, midi: 67 },
  ];

  it('includes the onset and excludes the offset', () => {
    expect(litKey(notes, 1)).toBe(60);
    expect(litKey(notes, 1.999)).toBe(60);
    expect(litKey(notes, 2)).toBe(64);
    expect(litKey(notes, 3)).toBeNull();
    expect(litKey(notes, 0.999)).toBeNull();
  });

  it('is null in a gap and without notes', () => {
    expect(litKey(notes, 4)).toBeNull();
    expect(litKey(undefined, 1)).toBeNull();
    expect(litKey([], 1)).toBeNull();
  });
});

describe('latestVoiced', () => {
  const frame = (t: number, f0: number) => ({ t, f0, clarity: 1 });

  it('is null when the newest frame is unvoiced', () => {
    expect(latestVoiced([frame(9.8, 440), frame(9.9, 0)], 10)).toBeNull();
  });

  it('is the newest voiced frame when it is fresh', () => {
    expect(latestVoiced([frame(9.7, 220), frame(9.9, 440)], 10)?.f0).toBe(440);
  });

  it('ignores frames from the future', () => {
    expect(latestVoiced([frame(9.8, 440), frame(10.1, 0), frame(10.2, 220)], 10)?.f0).toBe(440);
  });

  it('is null when the newest frame is stale', () => {
    expect(latestVoiced([frame(9, 440)], 10)).toBeNull();
    expect(latestVoiced([], 10)).toBeNull();
  });
});

describe('bandRect', () => {
  it('covers the keys of the range, edge to edge', () => {
    // Rows are 20 px; 71 is the top row (y 0..20), 60 the bottom (220..240).
    const rect = bandRect(VIEW, { lowMidi: 62, highMidi: 66 });
    expect(rect?.top).toBeCloseTo(100, 9);
    expect(rect?.height).toBeCloseTo(100, 9);
  });

  it('is held inside the lane when the range runs past it', () => {
    const rect = bandRect(VIEW, { lowMidi: 40, highMidi: 90 });
    expect(rect?.top).toBeCloseTo(0, 9);
    expect(rect?.height).toBeCloseTo(240, 9);
  });

  it('is null with no range, or one wholly out of view', () => {
    expect(bandRect(VIEW, null)).toBeNull();
    expect(bandRect(VIEW, { lowMidi: 30, highMidi: 40 })).toBeNull();
    expect(bandRect(VIEW, { lowMidi: 80, highMidi: 90 })).toBeNull();
  });
});
