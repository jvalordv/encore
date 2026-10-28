/**
 * Free phrases on the pitch lane: the band drawn behind a phrase the singer
 * marked as theirs to ad-lib (learning mode only), and the hit test for a
 * Shift+click on the lane (a plain click is reserved for W5's turns). The hit
 * test is pure: pixel to song time (the inverse of `viewX`) to the phrase that
 * contains that time. Tested in test/free-phrases.test.ts.
 */
import { phraseAt } from '../analysis/free-phrases';
import type { Span } from '../analysis/free-phrases';
import type { Phrase } from '../analysis/phrases';
import { viewX } from './lane-geometry';
import type { LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/**
 * Song time at pixel column `x` of the lane, or null in the piano-key gutter
 * or past the lane's right edge (nothing there to point at).
 */
export function timeAtX(view: LaneView, x: number, gutter: number): number | null {
  const span = view.width - gutter;
  if (!(span > 0) || !(x >= gutter) || x > view.width) return null;
  return view.now - (view.windowS - view.futureS) + ((x - gutter) / span) * view.windowS;
}

/** The phrase under pixel column `x`, or null in a gap, the gutter or off the lane. */
export function phraseAtX(view: LaneView, x: number, gutter: number, phrases: readonly Phrase[]): Phrase | null {
  const t = timeAtX(view, x, gutter);
  return t === null ? null : phraseAt(phrases, t);
}

/** The free phrases as full-height bands, behind the ribbons. */
export function drawFreeBands(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  spans: readonly Span[],
  gutter: number,
): void {
  if (spans.length === 0) return;
  ctx.fillStyle = style.freeBand;
  for (const [start, end] of spans) {
    const x0 = viewX(view, start, gutter);
    const x1 = viewX(view, end, gutter);
    if (x1 < gutter || x0 > view.width) continue;
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), view.height);
  }
}
