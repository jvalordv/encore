/**
 * What the app knows about the song's key shift and the singer's range, for
 * the Key control and the lane's keyboard band: the shift in force, the
 * suggestion, whether this song can be moved at all, and the words that say
 * why not. The shift is also kept per song, in the small key-value store the
 * settings use (src/app/storage.ts), keyed by the song's hash like the free
 * phrases; zero removes the entry. Reading never throws and never trusts what
 * it finds. Pure, no DOM.
 */
import { clampShift } from '../analysis/key-shift';
import type { MidiSpan } from '../analysis/key-shift';
import type { KeyValueStore } from './storage';

/** What the Key control draws from. */
export interface KeyShiftState {
  /** The shift in force on playback, lane, scoring and export; 0 when none. */
  shift: number;
  /** The shift that best seats the melody in the range; null without both. */
  suggested: number | null;
  /** False when the song's sound cannot be moved (YouTube's own player). */
  canShift: boolean;
  /** The singer's comfortable range; null until enough takes. */
  band: MidiSpan | null;
  /** How many takes the range was read from. */
  bandTakes: number;
}

/** The state of an app with no song, no range and nothing shifted. */
export function initialKeyShift(): KeyShiftState {
  return { shift: 0, suggested: null, canShift: true, band: null, bandTakes: 0 };
}

/** A shift as the control shows it: "+2", "-3", or "0". */
export function shiftLabel(shift: number): string {
  return shift > 0 ? `+${shift}` : String(shift);
}

/** Why a song cannot be moved, in one plain line; empty when it can. */
export function whyNoShift(canShift: boolean): string {
  return canShift
    ? ''
    : "YouTube's own player cannot change key; get the melody to record the song and play it here, or load a file.";
}

/** The suggestion worth offering: one that differs from what is in force. */
export function offeredSuggestion(state: KeyShiftState): number | null {
  const { suggested, shift } = state;
  return suggested === null || suggested === 0 || suggested === shift ? null : suggested;
}

/** The storage key for a song's shift. */
export function shiftKey(songHash: string): string {
  return `shift.${songHash}`;
}

/** The shift saved for a song; 0 when none is saved or it cannot be read. */
export function loadShift(store: KeyValueStore, songHash: string): number {
  const raw = store.get(shiftKey(songHash));
  return raw === null || raw === undefined ? 0 : clampShift(Number(raw));
}

/** Saves a song's shift; zero forgets it. */
export function saveShift(store: KeyValueStore, songHash: string, shift: number): void {
  const key = shiftKey(songHash);
  const value = clampShift(shift);
  if (value === 0) store.remove(key);
  else store.set(key, String(value));
}
