/**
 * Tests for the one phrase splitter (src/analysis/phrases.ts): where a rest is
 * long enough to start a phrase, with the boundary pinned on both sides.
 */
import { describe, expect, it } from 'vitest';
import { PHRASE_GAP_S, splitPhrases } from '../src/analysis/phrases';

const note = (onsetS: number, offsetS: number) => ({ onsetS, offsetS });

describe('splitPhrases', () => {
  it('has no phrases for no notes', () => {
    expect(splitPhrases([])).toEqual([]);
  });

  it('keeps notes with short rests between them in one phrase', () => {
    const phrases = splitPhrases([note(0, 1), note(1.2, 2), note(2.5, 3)]);
    expect(phrases).toEqual([{ first: 0, last: 2, startS: 0, endS: 3 }]);
  });

  it('starts a new phrase at a rest of 0.6 s or more, and not just under it', () => {
    expect(PHRASE_GAP_S).toBe(0.6);
    const at = splitPhrases([note(0, 1), note(1.6, 2)]);
    expect(at.map((p) => [p.first, p.last])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    const under = splitPhrases([note(0, 1), note(1.59, 2)]);
    expect(under).toHaveLength(1);
    // Sixes that are not quite sixes in floating point still split.
    expect(splitPhrases([note(0.1, 0.5), note(1.1, 1.5)])).toHaveLength(2);
  });

  it('reports each phrase with its notes and span', () => {
    const phrases = splitPhrases([note(0, 1), note(1.1, 2), note(4, 5), note(9, 10), note(10.1, 11)]);
    expect(phrases).toEqual([
      { first: 0, last: 1, startS: 0, endS: 2 },
      { first: 2, last: 2, startS: 4, endS: 5 },
      { first: 3, last: 4, startS: 9, endS: 11 },
    ]);
  });

  it('measures a rest from the latest end, so a long note holds its neighbours', () => {
    const phrases = splitPhrases([note(0, 10), note(1, 2), note(10.3, 11)]);
    expect(phrases).toHaveLength(1);
  });

  it('takes another gap when asked', () => {
    expect(splitPhrases([note(0, 1), note(1.2, 2)], 0.1)).toHaveLength(2);
  });
});
