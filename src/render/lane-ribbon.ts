/**
 * The pitch lane's ribbon layer: one singer's live f0 trace, split into
 * ribbons at gaps and unvoiced frames and stroked in runs of equal opacity so
 * a shaky note is dim and a clean one solid. It is called once per singer,
 * each with its own colour from the skin.
 */
import { alphaRuns, LIVE_HOP_S, segmentRibbon, viewX, viewY } from './lane-geometry';
import type { LaneFrame, LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** One singer's live ribbons: paths, one stroke per run of equal opacity. */
export function drawRibbon(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  frames: LaneFrame[],
  singer: 0 | 1,
  gutter: number,
): void {
  if (frames.length === 0) return;
  ctx.strokeStyle = style.singers[singer];
  ctx.lineWidth = style.ribbonWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const segment of segmentRibbon(frames, LIVE_HOP_S)) {
    for (const run of alphaRuns(segment)) {
      ctx.globalAlpha = run.alpha;
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
  ctx.globalAlpha = 1;
}
