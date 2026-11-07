/**
 * Where the clicks on a song's turns are kept: per song, keyed by the song's
 * hash like the free phrases are, in the settings' key-value store, as a JSON
 * object of span key to 'a', 'b' or 'both'. Reading never throws and never
 * trusts what it finds; an empty set removes the entry.
 */
import type { KeyValueStore } from '../app/storage';
import type { Overrides, Who } from './turns';

/** The storage key for a song's turn overrides. */
export function turnsKey(songHash: string): string {
  return `duet.turns.${songHash}`;
}

function isWho(value: unknown): value is Who {
  return value === 'a' || value === 'b' || value === 'both';
}

/** The overrides saved for a song; none when nothing is saved or it is unreadable. */
export function loadTurnOverrides(store: KeyValueStore, songHash: string): Overrides {
  const text = store.get(turnsKey(songHash));
  if (text === null) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const kept = Object.entries(raw).filter((entry): entry is [string, Who] => isWho(entry[1]));
    // fromEntries defines own properties, so a "__proto__" key stays inert.
    return Object.fromEntries(kept);
  } catch {
    return {};
  }
}

/** Saves a song's overrides; an empty set forgets them. */
export function saveTurnOverrides(store: KeyValueStore, songHash: string, overrides: Overrides): void {
  const key = turnsKey(songHash);
  if (Object.keys(overrides).length === 0) store.remove(key);
  else store.set(key, JSON.stringify(overrides));
}
