/**
 * The pitch lane's reference layer: the melody the singer is following, drawn
 * as one soft band under the ribbons. All voiced runs go into a single path
 * and a single stroke, strided so a long song stays cheap on a narrow lane.
 */
import { referenceSpan, viewX, viewY, voicedRuns } from './lane-geometry';
import type { LaneReference, LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** Reference band thickness in semitones (plus or minus a quarter tone). */
const REFERENCE_BAND_SEMITONES = 1;
/** The reference band is never thinner than this many CSS pixels. */
const REFERENCE_BAND_MIN_PX = 6;
/** Reference band opacity; it must sit under the ribbons, not fight them. */
const REFERENCE_ALPHA = 0.35;

/** The reference melody as one soft band, all runs in a single stroke. */
export function drawReference(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  ref: LaneReference | null,
  gutter: number,
): void {
  if (!ref) return;
  const left = view.now - (view.windowS - view.futureS);
  const span = referenceSpan(ref, left, view.now + view.futureS);
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
