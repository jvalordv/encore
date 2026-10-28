/**
 * The pitch lane's overlay layer, painted last: the line across the middle
 * (a notice such as an ad playing, or the invitation to sing when the lane is
 * empty) and the playhead. Anything that sits over the traces, such as hit
 * colours, belongs here.
 */
import { viewX } from './lane-geometry';
import type { LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** What an empty lane invites the singer to do. */
const EMPTY_CAPTION = 'sing to see your pitch';

/**
 * The line drawn across the middle of the lane, or null for none. A notice
 * (an ad is playing, so nothing is drawn) outranks the invitation, which only
 * shows while there is nothing else to look at.
 */
export function laneCaption(notice: string | null, empty: boolean): string | null {
  if (notice !== null && notice !== '') return notice;
  return empty ? EMPTY_CAPTION : null;
}

/** The notice or invitation, drawn when the lane is big enough to read it. */
export function drawCaption(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  notice: string | null,
  empty: boolean,
  gutter: number,
): void {
  const { width, height } = view;
  const caption = laneCaption(notice, empty);
  if (caption === null || height < 120 || width < 240) return;
  // A notice is something to act on or wait for, so it takes the accent.
  ctx.fillStyle = notice === null ? style.caption : style.accent;
  ctx.font = `700 18px ${style.captionFont}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption, gutter + (width - gutter) / 2, height / 2, width - gutter - 24);
}

/** The vertical line at the song time being sung. */
export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  gutter: number,
): void {
  const x = viewX(view, view.now, gutter);
  ctx.strokeStyle = style.accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, view.height);
  ctx.stroke();
}
