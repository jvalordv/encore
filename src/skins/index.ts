/**
 * Skin registry and switching. Holds the token contract (`SKIN_TOKENS`), the
 * list of skins, and the functions that apply one: set `data-skin` on <html>,
 * persist the choice, and tell canvases to re-read their colours. Nothing here
 * touches the DOM at import time so tests can load it under node.
 */
import { arcade } from './arcade';
import { dreamhouse } from './dreamhouse';
import { studio } from './studio';
import type { CopyKey, Skin } from './types';

/** Every CSS custom property a skin file must define (docs/SKINS.md). */
export const SKIN_TOKENS = [
  '--color-bg',
  '--color-surface',
  '--color-surface-2',
  '--color-text',
  '--color-text-muted',
  '--color-accent',
  '--color-accent-2',
  '--color-singer-a',
  '--color-singer-b',
  '--color-hit',
  '--color-okay',
  '--color-miss',
  '--color-reference',
  '--font-display',
  '--font-body',
  '--font-mono',
  '--radius',
  '--border-width',
  '--shadow',
  '--motion-fast',
  '--motion-slow',
  '--easing',
  '--lane-bg',
  '--lane-grid',
  '--lane-ribbon-width',
] as const;

/** One name from the token contract. */
export type SkinToken = (typeof SKIN_TOKENS)[number];

/** Registered skins, in switcher order. Studio is first and the default. */
export const SKINS: readonly Skin[] = [studio, arcade, dreamhouse];

/** The skin used when nothing is saved or the saved id is unknown. */
export const DEFAULT_SKIN: Skin = studio;

/** localStorage key holding the chosen skin id. */
export const SKIN_STORAGE_KEY = 'encore.skin';

/** Window event name fired after a skin is applied. */
export const SKIN_EVENT = 'encore:skin';

/** Payload of the `encore:skin` event. */
export interface SkinEventDetail {
  id: string;
}

/** Looks a skin up by id. */
export function findSkin(id: string | null | undefined): Skin | undefined {
  return SKINS.find((skin) => skin.id === id);
}

/** Applies a skin: sets data-skin, saves it, and notifies listeners. */
export function applySkin(id: string): Skin {
  const skin = findSkin(id) ?? DEFAULT_SKIN;
  document.documentElement.setAttribute('data-skin', skin.id);
  try {
    localStorage.setItem(SKIN_STORAGE_KEY, skin.id);
  } catch {
    // Storage can be blocked (private windows); the skin still applies.
  }
  window.dispatchEvent(new CustomEvent<SkinEventDetail>(SKIN_EVENT, { detail: { id: skin.id } }));
  return skin;
}

/** Reads the saved skin id, or Studio when none is saved or storage fails. */
export function loadSavedSkin(): Skin {
  try {
    return findSkin(localStorage.getItem(SKIN_STORAGE_KEY)) ?? DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

/** Returns the skin's phrasing for a key, falling back to Studio's. */
export function copyFor(skin: Skin, key: CopyKey): string {
  return skin.copy[key] ?? studio.copy[key];
}
