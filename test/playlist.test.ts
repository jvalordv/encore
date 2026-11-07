/**
 * Tests for the favorites playlist logic (src/app/playlist.ts): order,
 * adding and removing with renumbering, moves, and where Next, Previous and a
 * song's end lead.
 */
import { describe, expect, it } from 'vitest';
import { entryAfterLoad } from '../src/app/library';
import type { LibraryEntry } from '../src/app/library';
import {
  addFavorite,
  advanceTarget,
  favoritesOf,
  moveFavorite,
  neighbour,
  removeFavorite,
} from '../src/app/playlist';

function entry(id: string, favorite = false, order = 0): LibraryEntry {
  return {
    ...entryAfterLoad(null, { id, source: 'file', title: id, videoId: null, fileName: id, durationS: 1 }, 1),
    favorite,
    order,
  };
}

/** Applies the entries a change returns, as the store would. */
function apply(entries: LibraryEntry[], changed: LibraryEntry[]): LibraryEntry[] {
  return entries.map((e) => changed.find((c) => c.id === e.id) ?? e);
}

const ids = (entries: LibraryEntry[]): string[] => favoritesOf(entries).map((e) => e.id);

describe('favoritesOf', () => {
  it('lists only favorites, by order', () => {
    expect(ids([entry('a', true, 2), entry('b'), entry('c', true, 0), entry('d', true, 1)])).toEqual(['c', 'd', 'a']);
  });
});

describe('addFavorite / removeFavorite', () => {
  it('appends a new favorite at the end', () => {
    let list = [entry('a', true, 0), entry('b', true, 1), entry('c')];
    list = apply(list, addFavorite(list, 'c'));
    expect(ids(list)).toEqual(['a', 'b', 'c']);
  });

  it('changes nothing for a favorite already, or an unknown id', () => {
    const list = [entry('a', true, 0)];
    expect(addFavorite(list, 'a')).toEqual([]);
    expect(addFavorite(list, 'zz')).toEqual([]);
    expect(removeFavorite(list, 'zz')).toEqual([]);
  });

  it('closes the gap when one is removed', () => {
    let list = [entry('a', true, 0), entry('b', true, 1), entry('c', true, 2)];
    list = apply(list, removeFavorite(list, 'a'));
    expect(ids(list)).toEqual(['b', 'c']);
    expect(list.filter((e) => e.favorite).map((e) => e.order)).toEqual([0, 1]);
    expect(list.find((e) => e.id === 'a')?.favorite).toBe(false);
  });
});

describe('moveFavorite', () => {
  const base = [entry('a', true, 0), entry('b', true, 1), entry('c', true, 2)];

  it('swaps with the neighbour', () => {
    expect(ids(apply(base, moveFavorite(base, 'b', -1)))).toEqual(['b', 'a', 'c']);
    expect(ids(apply(base, moveFavorite(base, 'b', 1)))).toEqual(['a', 'c', 'b']);
  });

  it('does nothing at the ends or for a song that is not a favorite', () => {
    expect(moveFavorite(base, 'a', -1)).toEqual([]);
    expect(moveFavorite(base, 'c', 1)).toEqual([]);
    expect(moveFavorite([...base, entry('d')], 'd', 1)).toEqual([]);
  });

  it('renumbers away ties left by an import or a hand edit', () => {
    const tied = [entry('a', true, 0), entry('b', true, 0), entry('c', true, 0)];
    const moved = apply(tied, moveFavorite(tied, 'a', 1));
    expect(favoritesOf(moved).map((e) => e.order)).toEqual([0, 1, 2]);
  });
});

describe('neighbour and advanceTarget', () => {
  const list = ['a', 'b', 'c'];

  it('steps to the next and previous, and stops at the ends', () => {
    expect(neighbour(list, 'a', 1)).toBe('b');
    expect(neighbour(list, 'b', -1)).toBe('a');
    expect(neighbour(list, 'c', 1)).toBeNull();
    expect(neighbour(list, 'a', -1)).toBeNull();
  });

  it('has no neighbour for a song that is not in the list', () => {
    expect(neighbour(list, 'zz', 1)).toBeNull();
    expect(neighbour(list, null, 1)).toBeNull();
  });

  it('advances only while the playlist runs with auto-advance on', () => {
    expect(advanceTarget(list, 'a', true, true)).toBe('b');
    expect(advanceTarget(list, 'a', false, true)).toBeNull();
    expect(advanceTarget(list, 'a', true, false)).toBeNull();
    expect(advanceTarget(list, 'c', true, true)).toBeNull();
  });
});
