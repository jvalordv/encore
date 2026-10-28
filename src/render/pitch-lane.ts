/**
 * The pitch lane canvas. Owns the <canvas>, keeps its bitmap matched to its
 * container (ResizeObserver plus devicePixelRatio) and composes the layers
 * back to front: the grid (background, semitone and octave rows, piano-key
 * gutter; lane-grid.ts), the reference melody (a tint where it has sound but
 * no note, the contour as a soft band, the target notes as bars;
 * lane-reference.ts), one live f0 ribbon per singer (lane-ribbon.ts), the hit
 * colours over the ribbons (learning mode only; lane-overlay.ts), and the
 * overlay with the notice and the playhead. The lane scrolls
 * with song time, so what the singer sees at the playhead is what they are
 * singing now and what is coming sits to its right. A one-line notice can be
 * set across the middle (an ad is playing in the embedded video, so nothing is
 * drawn); it takes the place of the empty-lane invitation.
 *
 * Everything with arithmetic in it (time to pixel, range fitting, ribbon
 * segmentation, the frame ring; lane-geometry.ts) and the redraw scheduler and
 * pixel-ratio watcher (lane-clock.ts) are pure exports tested in
 * test/pitch-lane.test.ts and re-exported from here; this class is the thin
 * canvas glue around them. All colours come from the active skin's tokens
 * (lane-style.ts) and are re-read on the `encore:skin` event.
 */
import { SKIN_EVENT } from '../skins';
import { RedrawLoop, watchPixelRatio } from './lane-clock';
import {
  DEFAULT_HIGH_MIDI,
  DEFAULT_LOW_MIDI,
  fitRange,
  FrameRing,
  gutterWidth,
} from './lane-geometry';
import type { LaneFrame, LaneOptions, LaneReference, LaneView } from './lane-geometry';
import { drawGrid } from './lane-grid';
import { drawCaption, drawGrades, drawPlayhead } from './lane-overlay';
import { drawReference } from './lane-reference';
import { drawRibbon } from './lane-ribbon';
import { readLaneStyle } from './lane-style';
import type { LaneStyle } from './lane-style';

export {
  alphaRuns,
  clarityAlpha,
  FrameRing,
  fitRange,
  gradeRuns,
  isBlackKey,
  midiToY,
  noteName,
  noteRect,
  overlappingRange,
  referenceSpan,
  regionRect,
  segmentRibbon,
  timeToX,
  voicedRuns,
} from './lane-geometry';
export type {
  AlphaRun,
  GradeRun,
  LaneFrame,
  LaneNote,
  LaneOptions,
  LaneRect,
  LaneReference,
  LaneView,
} from './lane-geometry';
export { RedrawLoop, watchPixelRatio } from './lane-clock';
export type { FrameClock, PixelRatioHost, PixelRatioQuery } from './lane-clock';
export { laneCaption } from './lane-overlay';

/** Visible seconds by default. */
const DEFAULT_WINDOW_S = 6;
/** Seconds right of the playhead by default: a glimpse of what is coming. */
const DEFAULT_FUTURE_S = 1.5;
/** Seconds of frames kept beyond the visible window. */
const TRIM_MARGIN_S = 1;
/** Ring slots per second: twice the live frame rate, so odd hops still fit. */
const RING_SLOTS_PER_S = 200;

/** True for a DOM element, so the constructor can tell it from options. */
function isElement(value: unknown): value is HTMLElement {
  return typeof value === 'object' && value !== null && 'clientWidth' in value;
}

/** Canvas renderer for the pitch lane. Call `destroy` to release listeners. */
export class PitchLane {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly container: HTMLElement;
  private readonly observer: ResizeObserver | null;
  private readonly loop: RedrawLoop;
  private readonly rings: [FrameRing, FrameRing];
  private readonly windowS: number;
  private readonly futureS: number;
  private readonly stopPixelRatio: () => void;
  private midiLow = DEFAULT_LOW_MIDI;
  private midiHigh = DEFAULT_HIGH_MIDI;
  // The rows the lane was built with, and whether a reference has moved them.
  private baseLow = DEFAULT_LOW_MIDI;
  private baseHigh = DEFAULT_HIGH_MIDI;
  private fitted = false;
  private style: LaneStyle;
  private reference: LaneReference | null = null;
  private notice: string | null = null;
  private now = 0;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private destroyed = false;
  // The grid never moves between frames, so it is painted once into an
  // offscreen layer and blitted; null when the browser will not give us one.
  private layer: HTMLCanvasElement | null = null;
  private layerStale = true;

  constructor(canvas: HTMLCanvasElement, options?: LaneOptions);
  /** Same, with the element whose size the lane follows (default: parent). */
  constructor(canvas: HTMLCanvasElement, container: HTMLElement, options?: LaneOptions);
  constructor(
    private readonly canvas: HTMLCanvasElement,
    second?: HTMLElement | LaneOptions,
    third?: LaneOptions,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    const container = isElement(second) ? second : undefined;
    const options = (isElement(second) ? third : second) ?? {};
    this.container = container ?? canvas.parentElement ?? canvas;

    this.windowS = Math.max(0.5, options.windowS ?? DEFAULT_WINDOW_S);
    this.futureS = Math.min(this.windowS * 0.9, Math.max(0, options.futureS ?? DEFAULT_FUTURE_S));
    this.applyRange(options.midiLow ?? DEFAULT_LOW_MIDI, options.midiHigh ?? DEFAULT_HIGH_MIDI);
    this.baseLow = this.midiLow;
    this.baseHigh = this.midiHigh;
    const capacity = Math.ceil((this.windowS + TRIM_MARGIN_S) * RING_SLOTS_PER_S);
    this.rings = [new FrameRing(capacity), new FrameRing(capacity)];
    this.style = readLaneStyle();
    this.loop = new RedrawLoop(() => this.draw());

    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.container);
    } else {
      this.observer = null;
      window.addEventListener('resize', this.onWindowResize);
    }
    window.addEventListener(SKIN_EVENT, this.onSkin);
    // Display fonts load lazily, after the first draw; repaint once they land.
    document.fonts?.addEventListener('loadingdone', this.onFonts);
    this.stopPixelRatio = watchPixelRatio(() => this.resize());
    this.resize();
  }

  /** Moves the playhead to a song time; the lane scrolls to match. */
  setTime(songTimeS: number): void {
    if (!Number.isFinite(songTimeS) || songTimeS === this.now) return;
    this.now = songTimeS;
    this.loop.invalidate();
  }

  /**
   * Adds a live pitch frame for a singer (0 or 1). Frames are kept for the
   * visible window plus a second; a frame earlier than the newest rewinds
   * that singer's trace (see FrameRing).
   */
  pushFrame(f: LaneFrame, singer: 0 | 1 = 0): void {
    const ring = this.rings[singer === 1 ? 1 : 0];
    ring.push(f);
    ring.trimBefore(f.t - this.windowS - TRIM_MARGIN_S);
    this.loop.invalidate();
  }

  /** Forgets every live frame of both singers, e.g. when a take restarts. */
  clearFrames(): void {
    this.rings[0].clear();
    this.rings[1].clear();
    this.loop.invalidate();
  }

  /** Shows a line across the lane (such as an ad notice); null clears it. */
  setNotice(text: string | null): void {
    const next = text === '' ? null : text;
    if (next === this.notice) return;
    this.notice = next;
    this.loop.invalidate();
  }

  /**
   * Sets the reference melody to overlay, or null to remove it. Removing it
   * also puts back the rows the lane was built with, if a reference had fitted
   * them to its melody.
   */
  setReference(ref: LaneReference | null): void {
    this.reference = ref;
    if (ref === null && this.fitted) {
      this.fitted = false;
      this.setRange(this.baseLow, this.baseHigh);
    }
    this.loop.invalidate();
  }

  /** Sets the visible MIDI rows, inclusive; whole notes, at least two rows. */
  setRange(midiLow: number, midiHigh: number): void {
    this.applyRange(midiLow, midiHigh);
    this.layerStale = true;
    this.loop.invalidate();
  }

  /** Frames the reference melody with fitRange; no-op without a reference. */
  fitRangeToReference(): void {
    if (!this.reference) return;
    const { midiLow, midiHigh } = fitRange(this.reference.f0Hz);
    this.fitted = true;
    this.setRange(midiLow, midiHigh);
  }

  /** Starts the redraw loop; frames are painted only after a change. */
  start(): void {
    if (this.destroyed) return;
    this.loop.start();
  }

  /** Stops the redraw loop; the last picture stays on the canvas. */
  stop(): void {
    this.loop.stop();
  }

  /** Matches the bitmap to the container's size and pixel ratio, then draws. */
  resize(): void {
    if (this.destroyed) return;
    this.ratio = window.devicePixelRatio || 1;
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    const bitmapWidth = Math.max(1, Math.round(this.width * this.ratio));
    const bitmapHeight = Math.max(1, Math.round(this.height * this.ratio));
    // Assigning a size clears the canvas, so only do it when it changed.
    if (this.canvas.width !== bitmapWidth) this.canvas.width = bitmapWidth;
    if (this.canvas.height !== bitmapHeight) this.canvas.height = bitmapHeight;
    this.ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    this.layerStale = true;
    // Drawn synchronously: a cleared canvas must not reach the screen.
    this.redrawNow();
  }

  /** Repaints the whole lane now, from the cached skin style. */
  draw(): void {
    const { ctx, width, height } = this;
    if (width === 0 || height === 0) return;
    const gutter = gutterWidth(width);
    const view = this.view();

    ctx.clearRect(0, 0, width, height);
    this.paintGrid(view);

    const traces = [this.rings[0].toArray(), this.rings[1].toArray()];
    const empty = !this.reference && traces[0].length === 0 && traces[1].length === 0;

    // Everything that scrolls is clipped so it never paints over the gutter.
    ctx.save();
    ctx.beginPath();
    ctx.rect(gutter, 0, width - gutter, height);
    ctx.clip();
    drawReference(ctx, view, this.style, this.reference, gutter);
    drawRibbon(ctx, view, this.style, traces[0], 0, gutter);
    drawRibbon(ctx, view, this.style, traces[1], 1, gutter);
    drawGrades(ctx, view, this.style, traces[0], gutter);
    drawGrades(ctx, view, this.style, traces[1], gutter);
    ctx.restore();

    drawCaption(ctx, view, this.style, this.notice, empty, gutter);
    drawPlayhead(ctx, view, this.style, gutter);
  }

  /** Stops observing and removes every listener the lane added. */
  destroy(): void {
    this.destroyed = true;
    this.loop.stop();
    this.observer?.disconnect();
    window.removeEventListener('resize', this.onWindowResize);
    window.removeEventListener(SKIN_EVENT, this.onSkin);
    document.fonts?.removeEventListener('loadingdone', this.onFonts);
    this.stopPixelRatio();
  }

  /** Normalises and stores the range; keeps at least two rows. */
  private applyRange(midiLow: number, midiHigh: number): void {
    if (!Number.isFinite(midiLow) || !Number.isFinite(midiHigh)) return;
    const low = Math.max(0, Math.min(126, Math.round(Math.min(midiLow, midiHigh))));
    this.midiLow = low;
    this.midiHigh = Math.min(127, Math.max(low + 1, Math.round(Math.max(midiLow, midiHigh))));
  }

  /** Draws immediately and clears any pending invalidation. */
  private redrawNow(): void {
    this.loop.settle();
    this.draw();
  }

  /** What the layers need to know about the lane right now. */
  private view(): LaneView {
    return {
      width: this.width,
      height: this.height,
      now: this.now,
      windowS: this.windowS,
      futureS: this.futureS,
      midiLow: this.midiLow,
      midiHigh: this.midiHigh,
    };
  }

  /** Blits the cached grid, repainting the cache first if stale. */
  private paintGrid(view: LaneView): void {
    const { width, height } = this;
    this.layer ??= this.canvas.ownerDocument.createElement('canvas');
    const layerCtx = this.layer.getContext('2d');
    if (!layerCtx) {
      drawGrid(this.ctx, view, this.style);
      return;
    }
    if (this.layerStale) {
      this.layer.width = this.canvas.width;
      this.layer.height = this.canvas.height;
      layerCtx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      layerCtx.clearRect(0, 0, width, height);
      drawGrid(layerCtx, view, this.style);
      this.layerStale = false;
    }
    this.ctx.drawImage(this.layer, 0, 0, width, height);
  }

  private readonly onSkin = (): void => {
    this.style = readLaneStyle();
    this.layerStale = true;
    this.redrawNow();
  };

  private readonly onFonts = (): void => {
    this.layerStale = true;
    this.redrawNow();
  };

  private readonly onWindowResize = (): void => this.resize();
}
