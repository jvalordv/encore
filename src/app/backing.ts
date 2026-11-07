/**
 * What the song panel knows about the backing notes (W0g): whether the song
 * has any, how many, and whether the singer has them showing on the lane.
 * The notes themselves live in the session (session/backing.ts); this is the
 * small state the panel and the tests read. The toggle is on whenever notes
 * arrive: a song without them shows no toggle at all.
 */

/** Whether the song has backing notes. */
export type BackingPhase = 'none' | 'ready';

/** The backing notes as the panel sees them. */
export interface BackingState {
  phase: BackingPhase;
  /** How many notes the lane has. */
  notes: number;
  /** Whether the lane shows them; on by default, kept for the session only. */
  shown: boolean;
}

/** No backing yet. */
export function initialBacking(): BackingState {
  return { phase: 'none', notes: 0, shown: true };
}
