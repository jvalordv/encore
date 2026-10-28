/**
 * Where the phrases a singer marked free are kept: per song, keyed by the
 * song's hash as takes are, in the same small key-value store the settings
 * use (src/app/storage.ts), as a JSON list of `[startS, endS]` spans. Reading
 * never throws and never trusts what it finds (src/analysis/free-phrases.ts
 * drops anything that is not a span); an empty list removes the entry.
 */
import { parseSpans } from '../analysis/free-phrases';
import type { Span } from '../analysis/free-phrases';
import type { KeyValueStore } from './storage';

/** The storage key for a song's free phrases. */
export function freePhrasesKey(songHash: string): string {
  return `free.${songHash}`;
}

/** The spans saved for a song; none when nothing is saved or it cannot be read. */
export function loadFreePhrases(store: KeyValueStore, songHash: string): Array<[number, number]> {
  return parseSpans(store.get(freePhrasesKey(songHash)));
}

/** Saves a song's spans; an empty list forgets them. */
export function saveFreePhrases(store: KeyValueStore, songHash: string, spans: readonly Span[]): void {
  const key = freePhrasesKey(songHash);
  if (spans.length === 0) store.remove(key);
  else store.set(key, JSON.stringify(spans));
}
