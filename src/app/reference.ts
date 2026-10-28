/**
 * The reference melody, from the service's shape to the lane's. The service
 * sends snake_case fields (src/service/types.ts); the pitch lane draws a
 * `LaneReference` (src/render/lane-geometry.ts): the contour as a band, the
 * notes as target bars and the unpitched regions as a tint. This is the one
 * place the two meet. The lane's overlap search needs the notes and the regions
 * in time order, so they are sorted here rather than trusted. Also the state
 * the song panel keeps about the melody.
 */
import type { LaneReference } from '../render/lane-geometry';
import type { Reference } from '../service/types';

/** Whether a song has a melody to show: none yet, drawn, or left out. */
export type ReferencePhase = 'none' | 'ready' | 'skipped' | 'failed';

/** What the song panel knows about the melody. */
export interface ReferenceState {
  phase: ReferencePhase;
  /** How many target notes the lane draws. */
  notes: number;
  /** Why there is none when phase is 'skipped' or 'failed'; empty otherwise. */
  message: string;
}

/** The state of a song with no melody asked for yet. */
export function initialReference(): ReferenceState {
  return { phase: 'none', notes: 0, message: '' };
}

/** The reference as the lane draws it. */
export function laneReferenceOf(reference: Reference): LaneReference {
  const { contour } = reference;
  const notes = reference.notes
    .map((n) => ({ onsetS: n.onset_s, offsetS: n.offset_s, midi: n.midi }))
    .sort((a, b) => a.onsetS - b.onsetS);
  const unpitchedS = reference.unpitched_regions
    .map(([start, end]): [number, number] => [start, end])
    .sort((a, b) => a[0] - b[0]);
  return { hopS: contour.hop_s, t0S: contour.t0_s, f0Hz: contour.f0_hz, notes, unpitchedS };
}
