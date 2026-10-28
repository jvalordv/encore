/**
 * The pitch lane's overlay layer, painted last: the line across the middle
 * (a notice such as an ad playing, or the invitation to sing when the lane is
 * empty) and the playhead, plus the hit colours: in learning mode each graded
 * stretch of the ribbon is painted over in the grade's skin colour. A frame
 * without a grade paints nothing, so karaoke mode draws exactly the ribbon.
 */
import { gradeRuns, LIVE_HOP_S, segmentRibbon, viewX, viewY } from './lane-geometry';
import type { LaneFrame, LaneView } from './lane-geometry';
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

/** One singer's graded frames, painted over their ribbon in the grade colours. */
export function drawGrades(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  frames: LaneFrame[],
  gutter: number,
): void {
  if (!frames.some((f) => f.grade !== undefined)) return;
  ctx.lineWidth = style.ribbonWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const segment of segmentRibbon(frames, LIVE_HOP_S)) {
    for (const run of gradeRuns(segment)) {
      ctx.strokeStyle = style[run.grade];
      ctx.beginPath();
      for (let i = run.from; i <= run.to; i++) {
        const x = viewX(view, segment[i].t, gutter);
        const y = viewY(view, segment[i].f0);
        if (i === run.from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        // An isolated frame is a zero-length line; nudge it so caps paint.
        if (run.from === run.to) ctx.lineTo(x + 0.01, y);
      }
      ctx.stroke();
    }
  }
}
