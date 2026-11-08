/**
 * The pitch lane's ribbon layer: one singer's live f0 trace, split into
 * ribbons at gaps and unvoiced frames and stroked in runs of equal opacity so
 * a shaky note is dim and a clean one solid. It is called once per singer,
 * each with its own colour from the skin. Under it runs the faint trace: the
 * frames too unclear to count as voiced but clear enough to show where the
 * voice may be, in the same colour at a low flat opacity. It is only drawn,
 * never graded.
 */
import { alphaRuns, LIVE_HOP_S, segmentRibbon, viewX, viewY } from './lane-geometry';
import type { LaneFrame, LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/**
 * The frames of the faint trace: every frame with a pitch to show, faint ones
 * at their hinted pitch and voiced ones at their own, so the pale line runs on
 * into the solid ribbon instead of stopping short of it. Empty when no frame
 * is faint, which leaves a clean take drawing exactly as before.
 */
export function faintTrace(frames: readonly LaneFrame[]): LaneFrame[] {
  if (!frames.some((f) => (f.faintF0 ?? 0) > 0)) return [];
  const out: LaneFrame[] = [];
  for (const f of frames) {
    const f0 = f.f0 > 0 ? f.f0 : (f.faintF0 ?? 0);
    if (f0 > 0) out.push({ t: f.t, f0, clarity: f.clarity });
  }
  return out;
}

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

  ctx.globalAlpha = style.faintAlpha;
  for (const segment of segmentRibbon(faintTrace(frames), LIVE_HOP_S)) {
    ctx.beginPath();
    segment.forEach((f, i) => {
      const x = viewX(view, f.t, gutter);
      const y = viewY(view, f.f0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      if (segment.length === 1) ctx.lineTo(x + 0.01, y);
    });
    ctx.stroke();
  }

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
