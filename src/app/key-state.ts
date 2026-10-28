/**
 * What the app knows about the song's key, for the words around Open scoring.
 * The key map itself (src/service/types.ts) is held by the scoring controller;
 * the state keeps only its verdict and, when there is none, why, so a notice
 * can say whether a karaoke track can be scored on its key. Pure, no DOM.
 */
import type { KeyMap } from '../service/types';

/**
 * 'none': not asked for yet, or no service. 'ready': the key is known for at
 * least part of the song. 'unclear': the service read the track but could not
 * name a key anywhere. 'missing': the service has no key, with the reason.
 */
export type KeyPhase = 'none' | 'ready' | 'unclear' | 'missing';

/** The song panel's knowledge of the key. */
export interface KeyState {
  phase: KeyPhase;
  /** Why there is no key when phase is 'missing'; empty otherwise. */
  message: string;
}

/** The state of a song whose key has not been asked for. */
export function initialKey(): KeyState {
  return { phase: 'none', message: '' };
}

/** The state for a key map: ready if any stretch has a key, else unclear. */
export function keyStateOf(map: KeyMap): KeyState {
  const named = map.segments.some((s) => s.tonic !== null && s.mode !== null);
  return { phase: named ? 'ready' : 'unclear', message: '' };
}

/** The state for a key the service could not give, with the reason. */
export function missingKey(message: string): KeyState {
  return { phase: 'missing', message };
}
