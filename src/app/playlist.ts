/**
 * Favorites as a playlist: pure order and advance logic over Library entries,
 * with no storage and no DOM. The order is each favorite's `order` number;
 * every change renumbers the whole list 0..n-1, so there are never ties and a
 * move is a swap of two neighbours. Next and Previous stop at the ends rather
 * than wrapping: a list that quietly started over would play the same songs
 * again to a singer who walked away.
 */
import type { LibraryEntry } from './library';

/** The favorites in play order. */
export function favoritesOf(entries: readonly LibraryEntry[]): LibraryEntry[] {
  return entries
    .filter((e) => e.favorite)
    .sort((a, b) => a.order - b.order || a.addedAt - b.addedAt || a.id.localeCompare(b.id));
}

/** Renumbers `list` 0..n-1 in its own order, returning only entries that changed. */
function renumbered(list: readonly LibraryEntry[]): LibraryEntry[] {
  const changed: LibraryEntry[] = [];
  list.forEach((entry, index) => {
    if (entry.order !== index) changed.push({ ...entry, order: index });
  });
  return changed;
}

/** The entries to store to make `id` a favorite at the end; empty if it already is. */
export function addFavorite(entries: readonly LibraryEntry[], id: string): LibraryEntry[] {
  const target = entries.find((e) => e.id === id);
  if (!target || target.favorite) return [];
  const last = favoritesOf(entries).length;
  return [{ ...target, favorite: true, order: last }];
}

/** The entries to store to take `id` out of the favorites and close the gap. */
export function removeFavorite(entries: readonly LibraryEntry[], id: string): LibraryEntry[] {
  const target = entries.find((e) => e.id === id);
  if (!target || !target.favorite) return [];
  const rest = favoritesOf(entries).filter((e) => e.id !== id);
  return [{ ...target, favorite: false, order: 0 }, ...renumbered(rest)];
}

/**
 * The entries to store to move favorite `id` one place up (-1) or down (+1);
 * empty at an end or for a song that is not a favorite.
 */
export function moveFavorite(entries: readonly LibraryEntry[], id: string, step: -1 | 1): LibraryEntry[] {
  const list = favoritesOf(entries);
  const from = list.findIndex((e) => e.id === id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= list.length) return [];
  const moved = [...list];
  [moved[from], moved[to]] = [moved[to]!, moved[from]!];
  return renumbered(moved);
}

/**
 * The song after (+1) or before (-1) `currentId` in `ids`, or null at an end
 * or when the current song is not in the list.
 */
export function neighbour(ids: readonly string[], currentId: string | null, step: -1 | 1): string | null {
  if (currentId === null) return null;
  const at = ids.indexOf(currentId);
  if (at < 0) return null;
  return ids[at + step] ?? null;
}

/** Where a song's end leads: the next favorite while a playlist runs on auto-advance. */
export function advanceTarget(
  ids: readonly string[],
  currentId: string | null,
  active: boolean,
  autoAdvance: boolean,
): string | null {
  return active && autoAdvance ? neighbour(ids, currentId, 1) : null;
}
