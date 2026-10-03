/**
 * Unit tests for the pitch lane's pure helpers: key colours, note names and
 * the MIDI-to-pixel mapping. The canvas drawing itself needs a DOM and is
 * checked by eye in the dev server.
 */
import { describe, expect, it } from 'vitest';
import { isBlackKey, midiToY, noteName } from '../src/render/pitch-lane';

describe('isBlackKey', () => {
  it('flags the five black pitch classes in every octave', () => {
    const black = [1, 3, 6, 8, 10];
    for (const octave of [0, 3, 5]) {
      for (let pc = 0; pc < 12; pc++) {
        expect(isBlackKey(octave * 12 + pc), `pc ${pc}`).toBe(black.includes(pc));
      }
    }
  });
});

describe('noteName', () => {
  it('uses scientific pitch notation', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(69)).toBe('A4');
    expect(noteName(36)).toBe('C2');
    expect(noteName(61)).toBe('C#4');
    expect(noteName(0)).toBe('C-1');
  });
});

describe('midiToY', () => {
  const [low, high, height] = [36, 84, 490]; // 49 rows of 10 px

  it('puts the lowest note in the bottom row and the highest in the top row', () => {
    expect(midiToY(low, low, high, height)).toBeCloseTo(485, 9);
    expect(midiToY(high, low, high, height)).toBeCloseTo(5, 9);
  });

  it('moves up by one row per semitone', () => {
    expect(midiToY(61, low, high, height) - midiToY(62, low, high, height)).toBeCloseTo(10, 9);
  });

  it('places fractional notes between rows', () => {
    const mid = (midiToY(60, low, high, height) + midiToY(61, low, high, height)) / 2;
    expect(midiToY(60.5, low, high, height)).toBeCloseTo(mid, 9);
  });
});
