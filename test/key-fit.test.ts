/**
 * Tests for key fit (src/analysis/key-fit.ts) on synthetic notes with known
 * answers: the segment at a time and its boundaries, the major and minor
 * scales (the minor's raised 6th and 7th included), the song's tuning offset,
 * passing tones, an unclear or missing key, and a relative major and minor.
 */
import { describe, expect, it } from 'vitest';
import {
  centsToScale,
  fitFrame,
  fitNote,
  fitPitch,
  IN_KEY_CENTS,
  keySegmentAt,
  keyStatusOver,
  PASSING_NOTE_S,
  scaleTones,
} from '../src/analysis/key-fit';
import type { KeyMap, KeySegment } from '../src/service/types';

const seg = (start: number, end: number, tonic: number | null, mode: 'major' | 'minor' | null): KeySegment => ({
  start_s: start,
  end_s: end,
  tonic,
  mode,
  confidence: tonic === null ? 0.1 : 0.8,
});

const keyOf = (segments: KeySegment[], tuning = 0): KeyMap => ({ tuning_cents: tuning, segments });
const cMajor = keyOf([seg(0, 100, 0, 'major')]);
const aMinor = keyOf([seg(0, 100, 9, 'minor')]);

/** A note long enough to be judged, around song time 5, at fractional MIDI `midi`. */
const judge = (midi: number, key: KeyMap | null) => fitNote(midi, 5, 5.5, key);

describe('the key segment at a time', () => {
  const key = keyOf([seg(0, 10, 0, 'major'), seg(10, 20, 2, 'major'), seg(20, 30, null, null)]);

  it('finds the segment a time is in, a boundary belonging to the later one', () => {
    expect(keySegmentAt(key, 0)?.tonic).toBe(0);
    expect(keySegmentAt(key, 9.99)?.tonic).toBe(0);
    expect(keySegmentAt(key, 10)?.tonic).toBe(2);
    expect(keySegmentAt(key, 25)?.tonic).toBeNull();
  });

  it('holds the first and last segments for times outside the song', () => {
    expect(keySegmentAt(key, -3)?.tonic).toBe(0);
    expect(keySegmentAt(key, 99)?.tonic).toBeNull();
  });

  it('has none without a key or without segments', () => {
    expect(keySegmentAt(null, 5)).toBeNull();
    expect(keySegmentAt(keyOf([]), 5)).toBeNull();
  });
});

describe('the scales', () => {
  it('has the seven notes of the major scale', () => {
    expect([...scaleTones('major')]).toEqual([0, 2, 4, 5, 7, 9, 11]);
  });

  it('has natural minor plus the raised 6th and 7th', () => {
    expect([...scaleTones('minor')]).toEqual([0, 2, 3, 5, 7, 8, 9, 10, 11]);
  });
});

describe('a note against a major key', () => {
  it('is in key on a scale tone, with no distance', () => {
    expect(judge(62, cMajor)).toEqual({ fit: 'in_key', centsOff: 0 });
    expect(judge(74, cMajor).fit).toBe('in_key');
    expect(judge(48, cMajor).fit).toBe('in_key');
  });

  it('is in key within 50 cents of a tone and off key beyond, with the signed distance', () => {
    const sharp40 = judge(62.4, cMajor);
    expect(sharp40.fit).toBe('in_key');
    expect(sharp40.centsOff).toBeCloseTo(40, 6);
    const flat40 = judge(61.6, cMajor);
    expect(flat40.fit).toBe('in_key');
    expect(flat40.centsOff).toBeCloseTo(-40, 6);
    const sharp60 = judge(62.6, cMajor);
    expect(sharp60.fit).toBe('off_key');
    expect(sharp60.centsOff).toBeCloseTo(60, 6);
    expect(IN_KEY_CENTS).toBe(50);
  });

  it('calls the five notes outside the scale off key, a semitone from the nearest tone', () => {
    for (const pc of [1, 3, 6, 8, 10]) {
      const fit = judge(60 + pc, cMajor);
      expect(fit.fit, `pitch class ${pc}`).toBe('off_key');
      expect(Math.abs(fit.centsOff ?? 0)).toBeCloseTo(100, 6);
    }
  });

  it('reads the scale from the tonic, in any octave', () => {
    const dMajor = keyOf([seg(0, 100, 2, 'major')]);
    expect(judge(66, dMajor).fit).toBe('in_key');
    expect(judge(65, dMajor).fit).toBe('off_key');
    expect(judge(78, dMajor).fit).toBe('in_key');
  });
});

describe('a note against a minor key', () => {
  it('takes the natural minor tones and the raised 6th and 7th', () => {
    // A minor: A B C D E F G, plus F# and G#.
    for (const pc of [9, 11, 0, 2, 4, 5, 7, 6, 8]) {
      expect(judge(60 + pc, aMinor).fit, `pitch class ${pc}`).toBe('in_key');
    }
  });

  it('still calls the notes outside both forms off key', () => {
    for (const pc of [10, 1, 3]) expect(judge(60 + pc, aMinor).fit, `pitch class ${pc}`).toBe('off_key');
  });
});

describe('a relative major and minor', () => {
  it('give the same verdict on the seven notes they share and on the notes neither has', () => {
    for (const pc of [0, 2, 4, 5, 7, 9, 11, 1, 3, 10]) {
      expect(judge(60 + pc, cMajor).fit, `pitch class ${pc}`).toBe(judge(60 + pc, aMinor).fit);
    }
  });

  it('differ only on the minor\'s two raised tones', () => {
    const differ = [...Array(12).keys()].filter((pc) => judge(60 + pc, cMajor).fit !== judge(60 + pc, aMinor).fit);
    expect(differ).toEqual([6, 8]);
  });
});

describe('the song\'s tuning', () => {
  it('is taken off the pitch before it meets the scale', () => {
    // A song tuned 30 cents sharp: its D sits at 62.3, and so does the singer's.
    const tuned = keyOf([seg(0, 100, 0, 'major')], 30);
    expect(judge(62.7, cMajor).fit).toBe('off_key');
    const against = judge(62.7, tuned);
    expect(against.fit).toBe('in_key');
    expect(against.centsOff).toBeCloseTo(40, 6);
  });

  it('works for a song tuned flat', () => {
    const flat = keyOf([seg(0, 100, 0, 'major')], -40);
    expect(judge(61.4, cMajor).fit).toBe('off_key');
    expect(judge(61.4, flat).fit).toBe('in_key');
    expect(centsToScale(61.8, 0, 'major', -40)).toBeCloseTo(20, 6);
  });
});

describe('passing tones', () => {
  it('are notes under 150 ms, not judged whatever their pitch', () => {
    expect(PASSING_NOTE_S).toBe(0.15);
    expect(fitNote(61, 5, 5.12, cMajor)).toEqual({ fit: 'passing', centsOff: null });
    expect(fitNote(62, 5, 5.12, cMajor)).toEqual({ fit: 'passing', centsOff: null });
  });

  it('are judged from 150 ms on', () => {
    expect(fitNote(61, 5, 5.15, cMajor).fit).toBe('off_key');
    expect(fitNote(61, 5, 5.2, cMajor).fit).toBe('off_key');
  });
});

describe('an unclear or missing key', () => {
  it('is unclear where the segment has no key, in or out of tune', () => {
    const key = keyOf([seg(0, 10, 0, 'major'), seg(10, 30, null, null)]);
    expect(fitNote(61, 12, 12.5, key)).toEqual({ fit: 'unclear', centsOff: null });
    expect(fitNote(62, 12, 12.5, key)).toEqual({ fit: 'unclear', centsOff: null });
    expect(fitNote(61, 5, 5.5, key).fit).toBe('off_key');
  });

  it('is unclear with no key map at all', () => {
    expect(fitNote(61, 5, 5.5, null)).toEqual({ fit: 'unclear', centsOff: null });
    expect(fitPitch(61, 5, keyOf([]))).toEqual({ fit: 'unclear', centsOff: null });
  });

  it('judges a note by the segment at its middle', () => {
    const key = keyOf([seg(0, 10, 0, 'major'), seg(10, 20, 1, 'major')]);
    // C# is off key in C major and a tone of C# major.
    expect(fitNote(61, 9.7, 10.1, key).fit).toBe('off_key');
    expect(fitNote(61, 9.9, 10.5, key).fit).toBe('in_key');
  });
});

describe('a live frame against the key', () => {
  it('is in key within 50 cents of a tone and off key beyond it', () => {
    expect(fitFrame(62.5, 5, cMajor)).toBe('in_key');
    expect(fitFrame(62.51, 5, cMajor)).toBe('off_key');
    expect(fitFrame(61, 5, cMajor)).toBe('off_key');
  });

  it('is unclear where the key is', () => {
    expect(fitFrame(61, 5, null)).toBe('unclear');
    expect(fitFrame(61, 5, keyOf([seg(0, 10, null, null)]))).toBe('unclear');
  });
});

describe('how usable the key was', () => {
  const mixed = keyOf([seg(0, 10, 0, 'major'), seg(10, 20, null, null)]);

  it('is none without a key and clear when every note had one', () => {
    expect(keyStatusOver(null, [5])).toBe('none');
    expect(keyStatusOver(cMajor, [1, 2, 3])).toBe('clear');
  });

  it('is partly unclear when some notes fell in an unclear stretch, unclear when all did', () => {
    expect(keyStatusOver(mixed, [5, 15])).toBe('partly_unclear');
    expect(keyStatusOver(mixed, [15, 16])).toBe('unclear');
  });

  it('describes the map itself when there are no notes to go by', () => {
    expect(keyStatusOver(mixed, [])).toBe('partly_unclear');
    expect(keyStatusOver(cMajor, [])).toBe('clear');
    expect(keyStatusOver(keyOf([seg(0, 10, null, null)]), [])).toBe('unclear');
  });
});
