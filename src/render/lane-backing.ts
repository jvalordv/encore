/**
 * The pitch lane's backing layer (W0g): the song's instrumental written out as
 * notes, drawn in a neutral grey behind the melody's bars and lighting grey
 * keys on the keyboard under the melody's own key. Backing notes overlap (a
 * chord is several notes at once) and are not in end order, so the lookups
 * here cannot use `overlappingRange`: they search by onset and look back by
 * the longest note. The layer judges nothing and is in both modes. This file
 * also holds the lane's layer order, a pure list so the order and the colour
 * choice are tested without pixels.
 */
import { transposeNotes } from '../analysis/key-shift';
import { noteRect } from './lane-geometry';
import type { LaneNote, LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** Backing bars are quiet: they must sit behind the melody, never fight it. */
const BACKING_ALPHA = 0.32;
/** The lit grey keys are paler than the melody's key, which is drawn over. */
export const BACKING_KEY_ALPHA = 0.5;

/** The backing notes in onset order, with the longest note's length. */
export interface LaneBacking {
  notes: readonly LaneNote[];
  maxDurS: number;
}

/** The layers that scroll with the song, back to front. */
export type ScrollingLayer =
  | 'backing'
  | 'reference'
  | 'free'
  | 'ribbon-0'
  | 'ribbon-1'
  | 'grades-0'
  | 'grades-1';

/** What the lane has to draw, as far as the layer list is concerned. */
export interface LayerFlags {
  /** True when backing notes are loaded and shown. */
  backing: boolean;
}

/** The scrolling layers in painting order; the backing is under the melody. */
export function scrollingLayers(flags: LayerFlags): ScrollingLayer[] {
  const layers: ScrollingLayer[] = ['reference', 'free', 'ribbon-0', 'ribbon-1', 'grades-0', 'grades-1'];
  return flags.backing ? ['backing', ...layers] : layers;
}

/** The colour of the backing: the skin's neutral caption grey, no grade or melody colour. */
export function backingColour(style: LaneStyle): string {
  return style.caption;
}

/** Backing notes (any order) as a `LaneBacking`; null when there are none. */
export function laneBackingOf(
  notes: ReadonlyArray<{ onset_s: number; offset_s: number; midi: number }>,
): LaneBacking | null {
  if (notes.length === 0) return null;
  const sorted = notes
    .map((n): LaneNote => ({ onsetS: n.onset_s, offsetS: n.offset_s, midi: n.midi }))
    .sort((a, b) => a.onsetS - b.onsetS || a.midi - b.midi);
  let maxDurS = 0;
  for (const n of sorted) maxDurS = Math.max(maxDurS, n.offsetS - n.onsetS);
  return { notes: sorted, maxDurS };
}

/** The backing moved by `n` semitones, with the song (the key shift's seam). */
export function transposeBacking(backing: LaneBacking, n: number): LaneBacking {
  if (n === 0) return backing;
  return { notes: transposeNotes<LaneNote>(backing.notes, n), maxDurS: backing.maxDurS };
}

/** The notes that overlap [fromS, toS], in onset order. */
export function backingWindow(backing: LaneBacking, fromS: number, toS: number): LaneNote[] {
  const { notes, maxDurS } = backing;
  // First note that could still be sounding at fromS: onset >= fromS - maxDur.
  const earliest = fromS - maxDurS;
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].onsetS < earliest) lo = mid + 1;
    else hi = mid;
  }
  const out: LaneNote[] = [];
  for (let i = lo; i < notes.length && notes[i].onsetS <= toS; i++) {
    if (notes[i].offsetS >= fromS) out.push(notes[i]);
  }
  return out;
}

/**
 * The keys (nearest whole MIDI notes, ascending, no repeats) the backing
 * holds at song time `t`. A note sounds from its onset up to, not including,
 * its offset, so back-to-back notes never light two keys of one voice.
 */
export function litBackingKeys(backing: LaneBacking | null | undefined, t: number): number[] {
  if (!backing) return [];
  const keys = new Set<number>();
  for (const n of backingWindow(backing, t, t)) {
    if (n.onsetS <= t && t < n.offsetS) keys.add(Math.round(n.midi));
  }
  return [...keys].sort((a, b) => a - b);
}

/** Paints the backing notes in view as grey bars. */
export function drawBacking(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  backing: LaneBacking | null,
  gutter: number,
): void {
  if (!backing) return;
  const left = view.now - (view.windowS - view.futureS);
  const visible = backingWindow(backing, left, view.now + view.futureS);
  if (visible.length === 0) return;
  ctx.globalAlpha = BACKING_ALPHA;
  ctx.fillStyle = backingColour(style);
  for (const note of visible) {
    const { x, y, width, height } = noteRect(view, note, gutter);
    ctx.fillRect(x, y, width, height);
  }
  ctx.globalAlpha = 1;
}
