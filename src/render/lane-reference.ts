/**
 * The pitch lane's reference layer: the melody the singer is following, drawn
 * under the ribbons. Back to front: a quiet tint across the lane's height
 * where the original sounds but no note is sung (a spoken line, a breath, an
 * effect), the contour as one soft band, and the target notes as bars over the
 * band. The band's voiced runs go into a single path and a single stroke,
 * strided so a long song stays cheap on a narrow lane. The layer draws the
 * melody and nothing about the singing: scores and hit colours are the
 * overlay's, in learning mode only.
 */
import {
  noteRect,
  overlappingRange,
  referenceSpan,
  regionRect,
  viewX,
  viewY,
  voicedRuns,
} from './lane-geometry';
import type { LaneReference, LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** Reference band thickness in semitones (plus or minus a quarter tone). */
const REFERENCE_BAND_SEMITONES = 1;
/** The reference band is never thinner than this many CSS pixels. */
const REFERENCE_BAND_MIN_PX = 6;
/** Reference band opacity; it must sit under the ribbons, not fight them. */
const REFERENCE_ALPHA = 0.35;
/** Target note bars: strong enough to aim at, still under the ribbons. */
const NOTE_ALPHA = 0.8;
/** Tint over stretches with sound but no note. */
const UNPITCHED_ALPHA = 0.1;

/** The reference melody: unpitched tint, soft band, target note bars. */
export function drawReference(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  ref: LaneReference | null,
  gutter: number,
): void {
  if (!ref) return;
  const left = view.now - (view.windowS - view.futureS);
  drawUnpitched(ctx, view, style, ref, left, gutter);
  drawBand(ctx, view, style, ref, left, gutter);
  drawNotes(ctx, view, style, ref, left, gutter);
}

/** The contour as one soft band, all voiced runs in a single stroke. */
function drawBand(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  ref: LaneReference,
  leftS: number,
  gutter: number,
): void {
  const span = referenceSpan(ref, leftS, view.now + view.futureS);
  if (!span) return;
  const samples = span.last - span.first + 1;
  const stride = Math.max(1, Math.floor(samples / Math.max(1, view.width - gutter)));
  const rowHeight = view.height / (view.midiHigh - view.midiLow + 1);
  const at = (i: number): [number, number] => [
    viewX(view, ref.t0S + i * ref.hopS, gutter),
    viewY(view, ref.f0Hz[i]),
  ];

  ctx.beginPath();
  for (const [start, end] of voicedRuns(ref.f0Hz, span.first, span.last, stride)) {
    const [x0, y0] = at(start);
    ctx.moveTo(x0, y0);
    for (let i = start + stride; i <= end; i += stride) ctx.lineTo(...at(i));
    // A lone sample is a zero-length line, which some browsers skip.
    if (start === end) ctx.lineTo(x0 + 0.01, y0);
  }
  ctx.globalAlpha = REFERENCE_ALPHA;
  ctx.strokeStyle = style.reference;
  ctx.lineWidth = Math.max(REFERENCE_BAND_MIN_PX, rowHeight * REFERENCE_BAND_SEMITONES);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** The tint over the unpitched regions that are in view. */
function drawUnpitched(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  ref: LaneReference,
  leftS: number,
  gutter: number,
): void {
  const regions = ref.unpitchedS ?? [];
  const range = overlappingRange(regions, (r) => r[0], (r) => r[1], leftS, view.now + view.futureS);
  if (!range) return;
  ctx.globalAlpha = UNPITCHED_ALPHA;
  ctx.fillStyle = style.caption;
  for (let i = range.first; i <= range.last; i++) {
    const { x, y, width, height } = regionRect(view, regions[i][0], regions[i][1], gutter);
    ctx.fillRect(x, y, width, height);
  }
  ctx.globalAlpha = 1;
}

/** The target notes that are in view, as bars. */
function drawNotes(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  ref: LaneReference,
  leftS: number,
  gutter: number,
): void {
  const notes = ref.notes ?? [];
  const range = overlappingRange(notes, (n) => n.onsetS, (n) => n.offsetS, leftS, view.now + view.futureS);
  if (!range) return;
  ctx.globalAlpha = NOTE_ALPHA;
  ctx.fillStyle = style.reference;
  for (let i = range.first; i <= range.last; i++) {
    const { x, y, width, height } = noteRect(view, notes[i], gutter);
    ctx.fillRect(x, y, width, height);
  }
  ctx.globalAlpha = 1;
}
