/**
 * Turns on one mic: the stretches from phrases and from lyric lines, the A, B,
 * A default, the click that cycles a stretch through A, B and both, which
 * singer a sound at a given time belongs to, and the per-song store.
 */
import { describe, expect, it } from 'vitest';
import { memoryStore } from '../src/app/storage';
import { loadTurnOverrides, saveTurnOverrides } from '../src/duet/turn-store';
import {
  assignTurns,
  clickTurn,
  cycleWho,
  defaultWho,
  sharedSpans,
  singersOf,
  spansFromLyrics,
  spansFromNotes,
  turnAt,
  whoAt,
} from '../src/duet/turns';

/** Three phrases: 0.5 to 2, 3 to 4, 5 to 6.5 (rests of 1 s). */
const NOTES = [
  { onsetS: 0.5, offsetS: 1, midi: 57 },
  { onsetS: 1, offsetS: 2, midi: 59 },
  { onsetS: 3, offsetS: 4, midi: 60 },
  { onsetS: 5, offsetS: 6.5, midi: 62 },
];

describe('the stretches', () => {
  it('cuts the melody at its long rests', () => {
    expect(spansFromNotes(NOTES)).toEqual([
      [0.5, 2],
      [3, 4],
      [5, 6.5],
    ]);
  });

  it('cuts synced lyrics at the lines, a blank stamp being a break', () => {
    const lines = [
      { t: 1, text: 'first' },
      { t: 4, text: '' },
      { t: 6, text: 'second' },
      { t: 9, text: 'third' },
    ];
    expect(spansFromLyrics(lines, 20)).toEqual([
      [1, 4],
      [6, 9],
      [9, 20],
    ]);
  });

  it('gives the last line a few seconds when the song length is unknown', () => {
    expect(spansFromLyrics([{ t: 2, text: 'only' }])).toEqual([[2, 6]]);
  });
});

describe('who sings what', () => {
  const spans = spansFromNotes(NOTES);

  it('alternates A, B, A by default', () => {
    expect(assignTurns(spans).map((t) => t.who)).toEqual(['a', 'b', 'a']);
    expect(defaultWho(3)).toBe('b');
  });

  it('assigns lyric lines the same way', () => {
    const lyric = spansFromLyrics(
      [
        { t: 0, text: 'x' },
        { t: 2, text: 'y' },
        { t: 4, text: 'z' },
        { t: 6, text: '' },
      ],
      10,
    );
    expect(assignTurns(lyric).map((t) => t.who)).toEqual(['a', 'b', 'a']);
  });

  it('cycles a stretch through A, B, both and back', () => {
    expect(cycleWho('a')).toBe('b');
    expect(cycleWho('b')).toBe('both');
    expect(cycleWho('both')).toBe('a');
  });

  it('turns a click into an override and drops it when it returns to the default', () => {
    let overrides = clickTurn(spans, {}, 0.5);
    expect(assignTurns(spans, overrides)[0].who).toBe('b');
    overrides = clickTurn(spans, overrides, 0.5);
    expect(assignTurns(spans, overrides)[0].who).toBe('both');
    overrides = clickTurn(spans, overrides, 0.5);
    expect(overrides).toEqual({});
    // The second stretch starts at B, so one click makes it both.
    expect(assignTurns(spans, clickTurn(spans, {}, 3))[1].who).toBe('both');
  });

  it('ignores a click that is on no stretch', () => {
    expect(clickTurn(spans, {}, 2.5)).toEqual({});
  });

  it('finds the stretch at a time, and credits a gap to the stretch before it', () => {
    const turns = assignTurns(spans, { '3.00': 'both' });
    expect(turnAt(turns, 3.5)?.who).toBe('both');
    expect(turnAt(turns, 2.5)).toBeNull();
    expect(whoAt(turns, 2.5)).toBe('a');
    expect(whoAt(turns, 4.5)).toBe('both');
    // Before the first stretch, the first singer's.
    expect(whoAt(turns, 0.1)).toBe('a');
    expect(whoAt([], 1)).toBeNull();
  });

  it('says which singers a choice credits and which stretches are shared', () => {
    expect(singersOf('a')).toEqual([0]);
    expect(singersOf('b')).toEqual([1]);
    expect(singersOf('both')).toEqual([0, 1]);
    expect(sharedSpans(assignTurns(spans, { '3.00': 'both' }))).toEqual([[3, 4]]);
  });
});

describe('the per-song store', () => {
  it('round-trips the overrides and forgets an empty set', () => {
    const store = memoryStore();
    saveTurnOverrides(store, 'song-1', { '3.00': 'both', '0.50': 'b' });
    expect(loadTurnOverrides(store, 'song-1')).toEqual({ '3.00': 'both', '0.50': 'b' });
    expect(loadTurnOverrides(store, 'song-2')).toEqual({});
    saveTurnOverrides(store, 'song-1', {});
    expect(store.get('duet.turns.song-1')).toBeNull();
  });

  it('never trusts what it reads', () => {
    const store = memoryStore();
    store.set('duet.turns.x', '{"1.00":"c","2.00":"a"}');
    expect(loadTurnOverrides(store, 'x')).toEqual({ '2.00': 'a' });
    store.set('duet.turns.x', 'not json');
    expect(loadTurnOverrides(store, 'x')).toEqual({});
    store.set('duet.turns.x', '[1,2]');
    expect(loadTurnOverrides(store, 'x')).toEqual({});
  });
});
