/**
 * Tests for free phrases: the pure span helpers (src/analysis/free-phrases.ts),
 * how they are stored per song (src/app/free-store.ts), and the hit test for a
 * Shift+click on the lane (src/render/lane-free.ts): pixel to song time to the
 * phrase under the pointer.
 */
import { describe, expect, it } from 'vitest';
import {
  inSpans,
  isMarked,
  noteInSpan,
  parseSpans,
  phraseAt,
  phrasesOf,
  sameSpan,
  withSpan,
} from '../src/analysis/free-phrases';
import { freePhrasesKey, loadFreePhrases, saveFreePhrases } from '../src/app/free-store';
import { memoryStore } from '../src/app/storage';
import { timeAtX, phraseAtX } from '../src/render/lane-free';
import { timeToX, viewX } from '../src/render/lane-geometry';
import type { LaneView } from '../src/render/lane-geometry';

/** Two phrases: 1 to 3 s (two notes) and 5 to 6 s (one). */
const NOTES = [
  { onsetS: 1, offsetS: 2 },
  { onsetS: 2, offsetS: 3 },
  { onsetS: 5, offsetS: 6 },
];

describe('finding a phrase', () => {
  const phrases = phrasesOf(NOTES);

  it('splits with the one splitter', () => {
    expect(phrases.map((p) => [p.startS, p.endS])).toEqual([
      [1, 3],
      [5, 6],
    ]);
  });

  it('finds the phrase a time is in, ends included, and none in a gap', () => {
    expect(phraseAt(phrases, 1)?.first).toBe(0);
    expect(phraseAt(phrases, 2.5)?.first).toBe(0);
    expect(phraseAt(phrases, 3)?.first).toBe(0);
    expect(phraseAt(phrases, 4)).toBeNull();
    expect(phraseAt(phrases, 5.5)?.first).toBe(2);
    expect(phraseAt(phrases, 0.5)).toBeNull();
  });
});

describe('marking spans', () => {
  it('marks, unmarks and flips a span, keeping time order', () => {
    const marked = withSpan([], [5, 6]);
    expect(marked).toEqual([[5, 6]]);
    expect(withSpan(marked, [1, 3])).toEqual([
      [1, 3],
      [5, 6],
    ]);
    expect(withSpan(marked, [5, 6])).toEqual([]);
    expect(withSpan(marked, [5, 6], true)).toEqual([[5, 6]]);
    expect(withSpan(marked, [1, 3], false)).toEqual([[5, 6]]);
  });

  it('takes spans within a millisecond for the same phrase', () => {
    expect(sameSpan([1, 3], [1.0004, 2.9996])).toBe(true);
    expect(sameSpan([1, 3], [1.01, 3])).toBe(false);
    expect(isMarked([[1, 3]], [1, 3.0001])).toBe(true);
    expect(isMarked([[1, 3]], [5, 6])).toBe(false);
  });

  it('knows a time inside a span and a note inside it', () => {
    expect(inSpans([[1, 3]], 2)).toBe(true);
    expect(inSpans([[1, 3]], 3.01)).toBe(false);
    expect(noteInSpan(NOTES[1], [1, 3])).toBe(true);
    expect(noteInSpan(NOTES[2], [1, 3])).toBe(false);
  });
});

describe('reading spans back', () => {
  it('keeps good pairs in order and drops the rest', () => {
    expect(parseSpans('[[5,6],[1,3]]')).toEqual([
      [1, 3],
      [5, 6],
    ]);
    expect(parseSpans('[[1,3],[4],["a",2],[7,7],[9,8],null,[2,null]]')).toEqual([[1, 3]]);
  });

  it('gives none for nothing, for text that is not JSON, and for JSON that is not a list', () => {
    expect(parseSpans(null)).toEqual([]);
    expect(parseSpans('{oops')).toEqual([]);
    expect(parseSpans('{"a":1}')).toEqual([]);
  });
});

describe('free phrases per song', () => {
  it('are kept under the song\'s hash, and a song with none reads as none', () => {
    const store = memoryStore();
    saveFreePhrases(store, 'hash-a', [[1, 3]]);
    saveFreePhrases(store, 'hash-b', [[5, 6]]);
    expect(loadFreePhrases(store, 'hash-a')).toEqual([[1, 3]]);
    expect(loadFreePhrases(store, 'hash-b')).toEqual([[5, 6]]);
    expect(loadFreePhrases(store, 'hash-c')).toEqual([]);
    expect(freePhrasesKey('hash-a')).toBe('free.hash-a');
  });

  it('forget the entry when the last one is unmarked', () => {
    const store = memoryStore();
    saveFreePhrases(store, 'h', [[1, 3]]);
    saveFreePhrases(store, 'h', []);
    expect(store.get(freePhrasesKey('h'))).toBeNull();
  });

  it('survive a corrupt entry', () => {
    const store = memoryStore();
    store.set(freePhrasesKey('h'), 'not json');
    expect(loadFreePhrases(store, 'h')).toEqual([]);
  });
});

describe('the Shift+click hit test', () => {
  // A 600 px lane with a 50 px gutter, 6 s across, 1.5 s ahead of the playhead.
  const view: LaneView = { width: 600, height: 300, now: 4, windowS: 5.5, futureS: 1.5, midiLow: 48, midiHigh: 72 };
  const gutter = 50;
  const phrases = phrasesOf(NOTES);

  it('turns a pixel back into the song time that viewX drew there', () => {
    for (const t of [0.3, 2, 4, 5.5]) {
      expect(timeAtX(view, viewX(view, t, gutter), gutter)).toBeCloseTo(t, 9);
    }
    expect(timeToX(4, 4, 5.5, 1.5, 550)).toBeCloseTo(400, 9);
  });

  it('is null in the gutter and past the right edge', () => {
    expect(timeAtX(view, 10, gutter)).toBeNull();
    expect(timeAtX(view, 601, gutter)).toBeNull();
    expect(timeAtX(view, 300, 600)).toBeNull();
  });

  it('finds the phrase under the pointer', () => {
    expect(phraseAtX(view, viewX(view, 2.5, gutter), gutter, phrases)?.startS).toBe(1);
    expect(phraseAtX(view, viewX(view, 5.4, gutter), gutter, phrases)?.startS).toBe(5);
  });

  it('finds none between phrases, in the gutter or before the song', () => {
    expect(phraseAtX(view, viewX(view, 4, gutter), gutter, phrases)).toBeNull();
    expect(phraseAtX(view, 20, gutter, phrases)).toBeNull();
    expect(phraseAtX(view, viewX(view, 0.2, gutter), gutter, phrases)).toBeNull();
  });
});
