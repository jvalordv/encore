/**
 * The pitch lane's keyboard view: the piano-key gutter (painted by the grid)
 * made live. The key of the melody's note lights while that note sounds at the
 * playhead, and each singer's voice is a marker at its exact, unrounded
 * height, joined to the ribbon's head by a short line, with the nearest key
 * glowing softly. The singer's comfortable range is a neutral strip along the
 * keys (both modes; it judges nothing). Karaoke frames carry no grade, so they are drawn in the
 * singer's own colour; only a graded learning frame takes a grade colour. The
 * layout and lookups are pure and tested; the drawing is thin glue.
 */
import { hzToMidi } from '../analysis/pitch';
import { midiToY, overlappingRange, viewX } from './lane-geometry';
import type { LaneFrame, LaneNote, LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** A voice frame older than this at the playhead is not shown as a marker. */
export const MARKER_MAX_AGE_S = 0.3;
/** Black keys cover this share of the gutter; matches the grid's. */
const BLACK_KEY_SHARE = 0.6;

/** One piano key's row: where it sits in the lane, in CSS pixels. */
export interface KeyRow {
  midi: number;
  top: number;
  height: number;
}

/** Every key's row for the lane's range; each equals the grid's semitone row. */
export function keyRows(view: LaneView): KeyRow[] {
  const rows = view.midiHigh - view.midiLow + 1;
  const height = view.height / rows;
  const out: KeyRow[] = [];
  for (let midi = view.midiLow; midi <= view.midiHigh; midi++) {
    out.push({ midi, top: midiToY(midi, view.midiLow, view.midiHigh, view.height) - height / 2, height });
  }
  return out;
}

/** A span of the singer's range as a strip of the gutter. */
export interface BandRect {
  top: number;
  height: number;
}

/**
 * The strip of the keyboard the singer's range covers, from the top edge of
 * the highest key it touches to the bottom edge of the lowest, held inside
 * the lane; null when the range lies wholly above or below the visible keys.
 */
export function bandRect(view: LaneView, band: { lowMidi: number; highMidi: number } | null): BandRect | null {
  if (!band || band.highMidi < view.midiLow - 0.5 || band.lowMidi > view.midiHigh + 0.5) return null;
  const rows = view.midiHigh - view.midiLow + 1;
  const row = view.height / rows;
  const high = Math.min(view.midiHigh, Math.round(band.highMidi));
  const low = Math.max(view.midiLow, Math.round(band.lowMidi));
  const top = midiToY(high, view.midiLow, view.midiHigh, view.height) - row / 2;
  const bottom = midiToY(low, view.midiLow, view.midiHigh, view.height) + row / 2;
  return { top, height: Math.max(row, bottom - top) };
}

/** Height of a fractional MIDI note, held at the lane's edge when outside it. */
export function markerY(view: LaneView, midi: number): number {
  const held = Math.min(view.midiHigh, Math.max(view.midiLow, midi));
  return midiToY(held, view.midiLow, view.midiHigh, view.height);
}

/**
 * The key (nearest whole MIDI note) the melody holds at song time `t`, or
 * null in a gap. A note sounds from its onset up to, not including, its
 * offset, so back-to-back notes never light two keys. Notes are in time order.
 */
export function litKey(notes: readonly LaneNote[] | undefined, t: number): number | null {
  if (!notes || notes.length === 0) return null;
  const span = overlappingRange(notes, (n) => n.onsetS, (n) => n.offsetS, t, t);
  if (!span) return null;
  for (let i = span.last; i >= span.first; i--) {
    if (notes[i].onsetS <= t && t < notes[i].offsetS) return Math.round(notes[i].midi);
  }
  return null;
}

/** The newest voiced frame at or just before the playhead, or null. */
export function latestVoiced(frames: readonly LaneFrame[], now: number): LaneFrame | null {
  // Only the newest frame counts: a gated or unvoiced one (f0 = 0) means the
  // singer stopped, and an older voiced frame must not keep the marker lit.
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (f.t > now) continue;
    return f.f0 > 0 && now - f.t <= MARKER_MAX_AGE_S ? f : null;
  }
  return null;
}

/** Paints the lit key, the voice markers and their joining lines. */
export function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  notes: readonly LaneNote[] | undefined,
  traces: readonly [LaneFrame[], LaneFrame[]],
  gutter: number,
  band: { lowMidi: number; highMidi: number } | null = null,
): void {
  const rows = keyRows(view);
  const strip = bandRect(view, band);
  if (strip) {
    // The caption colour at low alpha reads as neutral in every skin, and it
    // is no grade: a range is a measurement, not a verdict.
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = style.caption;
    ctx.fillRect(0, strip.top, gutter, strip.height);
    ctx.globalAlpha = 0.7;
    ctx.fillRect(gutter - 2, strip.top, 2, strip.height);
    ctx.globalAlpha = 1;
  }
  const rowHeight = rows[0]?.height ?? 0;
  const keyArea = (midi: number): KeyRow | undefined => rows.find((r) => r.midi === midi);
  const lit = litKey(notes, view.now);
  const litRow = lit === null ? undefined : keyArea(lit);
  if (litRow) {
    // Translucent so the octave label under it stays readable.
    ctx.globalAlpha = 0.65;
    ctx.fillStyle = style.reference;
    ctx.fillRect(0, litRow.top, gutter, litRow.height);
    ctx.globalAlpha = 1;
  }

  for (const singer of [0, 1] as const) {
    const frame = latestVoiced(traces[singer], view.now);
    if (!frame) continue;
    const midi = hzToMidi(frame.f0);
    const y = markerY(view, midi);
    const colour = frame.grade ? style[frame.grade] : style.singers[singer];
    const nearest = keyArea(Math.min(view.midiHigh, Math.max(view.midiLow, Math.round(midi))));
    if (nearest) {
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = colour;
      ctx.fillRect(0, nearest.top, gutter * BLACK_KEY_SHARE, Math.max(rowHeight, 1));
      ctx.globalAlpha = 1;
    }
    const x = gutter - Math.min(6, gutter / 5);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(viewX(view, frame.t, gutter), y);
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.strokeStyle = style.background;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, Math.min(5, Math.max(3, rowHeight / 2)), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}
