/**
 * The pitch lane canvas. Owns the <canvas>, keeps its bitmap matched to its
 * container (ResizeObserver plus devicePixelRatio) and draws, back to front:
 * the furniture (background, semitone and octave grid, piano-key gutter), the
 * reference contour as a soft band, one live f0 ribbon per singer, and the
 * playhead. The lane scrolls with song time, so what the singer sees at the
 * playhead is what they are singing now and what is coming sits to its right.
 *
 * Everything with arithmetic in it (time to pixel, range fitting, ribbon
 * segmentation, the frame ring, the redraw scheduler, the pixel-ratio
 * watcher) is a pure export tested in test/pitch-lane.test.ts; the class is
 * the thin canvas glue around them. All colours come from the active skin's
 * tokens and are re-read on the `encore:skin` event.
 */
import { hzToMidi } from '../analysis/pitch';
import { SKIN_EVENT } from '../skins';
import type { SkinToken } from '../skins';

/** Lowest MIDI note shown by default (C2). */
const DEFAULT_LOW_MIDI = 36;
/** Highest MIDI note shown by default (C6). */
const DEFAULT_HIGH_MIDI = 84;
/** Visible seconds by default. */
const DEFAULT_WINDOW_S = 6;
/** Seconds right of the playhead by default: a glimpse of what is coming. */
const DEFAULT_FUTURE_S = 1.5;
/** Width of the piano-key gutter in CSS pixels. */
const GUTTER_WIDTH = 56;
/** Black keys cover this share of the gutter, like a piano roll. */
const BLACK_KEY_SHARE = 0.6;
/** Hop of the live tracker (docs/ARCHITECTURE.md), used to spot f0 gaps. */
const LIVE_HOP_S = 0.01;
/** A gap longer than this many hops breaks a ribbon. */
const GAP_HOPS = 2.5;
/** Seconds of frames kept beyond the visible window. */
const TRIM_MARGIN_S = 1;
/** Ring slots per second: twice the live frame rate, so odd hops still fit. */
const RING_SLOTS_PER_S = 200;
/** Narrowest range fitRange returns, in semitones: one octave. */
const MIN_FIT_SPAN = 12;
/** Reference band thickness in semitones (plus or minus a quarter tone). */
const REFERENCE_BAND_SEMITONES = 1;
/** The reference band is never thinner than this many CSS pixels. */
const REFERENCE_BAND_MIN_PX = 6;
/** Reference band opacity; it must sit under the ribbons, not fight them. */
const REFERENCE_ALPHA = 0.35;
/** Below this clarity a ribbon is drawn at its faintest. */
const ALPHA_CLARITY_FLOOR = 0.8;
/** Faintest ribbon opacity, so a shaky note is dim but never invisible. */
const MIN_RIBBON_ALPHA = 0.25;
/** Ribbon opacity is rounded to this many steps to keep strokes few. */
const ALPHA_LEVELS = 4;
/** Frames per ribbon chunk; a stroke is issued per run of equal opacity. */
const ALPHA_CHUNK = 8;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

/** Skin colours and fonts the lane draws with, resolved to plain strings. */
interface LaneStyle {
  background: string;
  grid: string;
  whiteKey: string;
  blackKey: string;
  caption: string;
  captionFont: string;
  labelFont: string;
  reference: string;
  accent: string;
  singers: [string, string];
  ribbonWidth: number;
}

/** Reference melody to overlay; mirrors the service's Contour. */
export interface LaneReference {
  /** Seconds between samples. */
  hopS: number;
  /** Song time of sample 0, in seconds. */
  t0S: number;
  /** Fundamental per sample in Hz; 0 means unvoiced. */
  f0Hz: ArrayLike<number>;
}

/** One live pitch sample positioned in song time. */
export interface LaneFrame {
  /** Song time in seconds (not context time). */
  t: number;
  /** Fundamental in Hz; 0 when unvoiced. */
  f0: number;
  /** Tracker confidence, 0 to 1; scales the ribbon's opacity. */
  clarity: number;
}

/** Lane geometry and range; every field is optional. */
export interface LaneOptions {
  /** Visible seconds, default 6. */
  windowS?: number;
  /** Seconds right of the playhead, default 1.5. */
  futureS?: number;
  /** Lowest MIDI row shown, default 36. */
  midiLow?: number;
  /** Highest MIDI row shown, default 84. */
  midiHigh?: number;
}

/** Pitch class (0 = C) of a MIDI note, correct for negative numbers. */
function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** True when the MIDI note is a black piano key. */
export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(pitchClass(midi));
}

/** Scientific pitch name of a MIDI note, e.g. 60 is "C4". */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[pitchClass(midi)]}${Math.floor(Math.round(midi) / 12) - 1}`;
}

/**
 * Vertical centre of a MIDI note's row. The range is split into equal
 * semitone rows, highest note at the top, so `midi` may be fractional and
 * lands between rows.
 */
export function midiToY(midi: number, lowMidi: number, highMidi: number, height: number): number {
  const rowHeight = height / (highMidi - lowMidi + 1);
  return height - (midi - lowMidi + 0.5) * rowHeight;
}

/**
 * Horizontal pixel of song time `t` when the playhead is at `now`. The
 * window spans `width` pixels and shows `windowS - futureS` seconds of past
 * to the playhead's left and `futureS` seconds ahead to its right.
 */
export function timeToX(
  t: number,
  now: number,
  windowS: number,
  futureS: number,
  width: number,
): number {
  if (!(windowS > 0)) return 0;
  return ((t - now + (windowS - futureS)) / windowS) * width;
}

/** Linear-interpolated quantile (0 to 1) of an ascending array. */
function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * MIDI rows that frame a melody: the 2nd to 98th percentile of the voiced
 * frames (so one stray octave jump cannot squash the lane), padded, widened
 * to at least an octave around the middle, and kept inside MIDI 0 to 127.
 * Returns whole notes because the lane draws whole rows. No voiced frames
 * gives the default range.
 */
export function fitRange(
  f0Hz: ArrayLike<number>,
  padSemitones = 2,
): { midiLow: number; midiHigh: number } {
  const midis: number[] = [];
  for (let i = 0; i < f0Hz.length; i++) {
    const hz = f0Hz[i];
    if (hz > 0 && Number.isFinite(hz)) midis.push(hzToMidi(hz));
  }
  if (midis.length === 0) return { midiLow: DEFAULT_LOW_MIDI, midiHigh: DEFAULT_HIGH_MIDI };
  midis.sort((a, b) => a - b);

  // The epsilon stops float noise (59.9999999 for C4) from costing a row.
  const pad = Math.max(0, padSemitones);
  let low = Math.floor(quantile(midis, 0.02) - pad + 1e-6);
  let high = Math.ceil(quantile(midis, 0.98) + pad - 1e-6);
  const deficit = MIN_FIT_SPAN - (high - low);
  if (deficit > 0) {
    low -= Math.floor(deficit / 2);
    high += Math.ceil(deficit / 2);
  }
  if (low < 0) {
    high -= low;
    low = 0;
  }
  if (high > 127) {
    low = Math.max(0, low - (high - 127));
    high = 127;
  }
  return { midiLow: low, midiHigh: high };
}

/**
 * Splits live frames into drawable ribbons. A new ribbon starts wherever the
 * time gap exceeds 2.5 hops (a seek, a dropout) or the frame is unvoiced
 * (f0 = 0); unvoiced frames themselves are dropped. Input must be ascending
 * in time.
 */
export function segmentRibbon(frames: LaneFrame[], hopS: number): LaneFrame[][] {
  const maxGap = GAP_HOPS * (hopS > 0 ? hopS : LIVE_HOP_S);
  const out: LaneFrame[][] = [];
  let current: LaneFrame[] = [];
  const flush = (): void => {
    if (current.length > 0) out.push(current);
    current = [];
  };
  let prev: LaneFrame | null = null;
  for (const f of frames) {
    if (!(f.f0 > 0) || !Number.isFinite(f.f0)) {
      flush();
      prev = null;
      continue;
    }
    if (prev && f.t - prev.t > maxGap) flush();
    current.push(f);
    prev = f;
  }
  flush();
  return out;
}

/**
 * Fixed-capacity ring of live frames, oldest first. A frame older than the
 * newest one means song time went backwards (a seek or a loop wrap), so it
 * rewinds the ring: everything at or after its time is dropped and the new
 * pass overwrites the old one instead of drawing on top of it.
 */
export class FrameRing {
  private readonly slots: LaneFrame[];
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.slots = new Array<LaneFrame>(Math.max(1, Math.floor(capacity)));
  }

  /** Number of frames held. */
  get length(): number {
    return this.size;
  }

  /** Appends a copy of `f`, dropping the oldest frame when full. */
  push(f: LaneFrame): void {
    if (!Number.isFinite(f.t)) return;
    while (this.size > 0 && this.at(this.size - 1).t >= f.t) this.size--;
    if (this.size === this.slots.length) {
      this.head = (this.head + 1) % this.slots.length;
      this.size--;
    }
    this.slots[(this.head + this.size) % this.slots.length] = {
      t: f.t,
      f0: f.f0,
      clarity: f.clarity,
    };
    this.size++;
  }

  /** Drops every frame with `t` earlier than the given time. */
  trimBefore(t: number): void {
    while (this.size > 0 && this.slots[this.head].t < t) {
      this.head = (this.head + 1) % this.slots.length;
      this.size--;
    }
  }

  /** Empties the ring. */
  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /** The held frames, oldest first; the frame objects are shared. */
  toArray(): LaneFrame[] {
    const out = new Array<LaneFrame>(this.size);
    for (let i = 0; i < this.size; i++) out[i] = this.at(i);
    return out;
  }

  private at(i: number): LaneFrame {
    return this.slots[(this.head + i) % this.slots.length];
  }
}

/** Ribbon opacity for a clarity: faint when shaky, solid when clean. */
export function clarityAlpha(clarity: number): number {
  const x = (clarity - ALPHA_CLARITY_FLOOR) / (1 - ALPHA_CLARITY_FLOOR);
  const clamped = x > 0 ? (x < 1 ? x : 1) : 0;
  return MIN_RIBBON_ALPHA + (1 - MIN_RIBBON_ALPHA) * clamped;
}

/** A stretch of one ribbon drawn at one opacity; indices are inclusive. */
export interface AlphaRun {
  from: number;
  to: number;
  alpha: number;
}

/**
 * Groups a ribbon into runs of equal quantised opacity so a whole ribbon
 * costs a handful of strokes instead of one per frame. Runs share their
 * boundary vertex, so the stroke has no gap where opacity changes. Opacity
 * is decided per chunk of frames, which also stops a clarity hovering on a
 * step boundary from flickering into hundreds of strokes.
 */
export function alphaRuns(segment: LaneFrame[], chunk = ALPHA_CHUNK): AlphaRun[] {
  const n = segment.length;
  if (n === 0) return [];
  const step = Math.max(1, Math.floor(chunk));
  const quantised = (from: number, to: number): number => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += segment[i].clarity;
    return Math.round(clarityAlpha(sum / (to - from)) * ALPHA_LEVELS) / ALPHA_LEVELS;
  };
  if (n === 1) return [{ from: 0, to: 0, alpha: quantised(0, 1) }];

  const runs: AlphaRun[] = [];
  for (let from = 0; from < n - 1; from += step) {
    const to = Math.min(from + step, n - 1);
    const alpha = quantised(from, Math.min(from + step, n));
    const last = runs[runs.length - 1];
    if (last && last.alpha === alpha) last.to = to;
    else runs.push({ from, to, alpha });
  }
  return runs;
}

/**
 * Index range of reference samples that overlap [fromS, toS], with one
 * sample of margin either side so the band reaches the lane's edges. Null
 * when the reference is empty or entirely outside the span.
 */
export function referenceSpan(
  ref: LaneReference,
  fromS: number,
  toS: number,
): { first: number; last: number } | null {
  const n = ref.f0Hz.length;
  if (n === 0 || !(ref.hopS > 0)) return null;
  const first = Math.max(0, Math.floor((fromS - ref.t0S) / ref.hopS));
  const last = Math.min(n - 1, Math.ceil((toS - ref.t0S) / ref.hopS));
  return first > last ? null : { first, last };
}

/**
 * Runs of voiced samples (f0 above 0) between two indices, sampled every
 * `stride` samples, as inclusive [start, end] index pairs. Striding keeps a
 * three-minute song's band cheap when the lane is narrower than its data.
 */
export function voicedRuns(
  f0Hz: ArrayLike<number>,
  first: number,
  last: number,
  stride = 1,
): Array<[number, number]> {
  const step = Math.max(1, Math.floor(stride));
  const runs: Array<[number, number]> = [];
  let start = -1;
  let prev = -1;
  for (let i = first; i <= last; i += step) {
    if (f0Hz[i] > 0) {
      if (start < 0) start = i;
      prev = i;
    } else if (start >= 0) {
      runs.push([start, prev]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, prev]);
  return runs;
}

/** Where animation frames come from; injectable so tests need no browser. */
export interface FrameClock {
  request(cb: () => void): number;
  cancel(id: number): void;
}

/** requestAnimationFrame when present, else a 60 Hz timer (never throws). */
function defaultClock(): FrameClock {
  if (typeof requestAnimationFrame === 'function') {
    return {
      request: (cb) => requestAnimationFrame(() => cb()),
      cancel: (id) => cancelAnimationFrame(id),
    };
  }
  return {
    request: (cb) => setTimeout(cb, 16) as unknown as number,
    cancel: (id) => clearTimeout(id),
  };
}

/**
 * Calls `draw` at most once per animation frame, and only after
 * `invalidate`. It schedules a frame on demand rather than ticking while
 * idle, so a paused song with nothing changing costs nothing.
 */
export class RedrawLoop {
  private clock: FrameClock | null = null;
  private pending: number | null = null;
  private dirty = false;
  private active = false;

  constructor(
    private readonly draw: () => void,
    private readonly clockFactory: () => FrameClock = defaultClock,
  ) {}

  /** True between `start` and `stop`. */
  get running(): boolean {
    return this.active;
  }

  /** Marks the picture stale; a frame is scheduled if the loop is running. */
  invalidate(): void {
    this.dirty = true;
    this.schedule();
  }

  /** Starts honouring invalidations; draws at once if one is waiting. */
  start(): void {
    this.active = true;
    this.schedule();
  }

  /** Stops scheduling and cancels any frame already requested. */
  stop(): void {
    this.active = false;
    if (this.pending !== null && this.clock) this.clock.cancel(this.pending);
    this.pending = null;
  }

  /** Forgets a pending invalidation, for callers that just drew directly. */
  settle(): void {
    this.dirty = false;
  }

  private schedule(): void {
    if (!this.active || !this.dirty || this.pending !== null) return;
    this.clock ??= this.clockFactory();
    this.pending = this.clock.request(() => {
      this.pending = null;
      if (!this.active || !this.dirty) return;
      this.dirty = false;
      this.draw();
    });
  }
}

/** The slice of a MediaQueryList the pixel-ratio watcher needs. */
export interface PixelRatioQuery {
  addEventListener?(type: 'change', cb: () => void): void;
  removeEventListener?(type: 'change', cb: () => void): void;
}

/** The slice of `window` the pixel-ratio watcher needs. */
export interface PixelRatioHost {
  devicePixelRatio: number;
  matchMedia?: (query: string) => PixelRatioQuery;
}

/**
 * Calls `onChange` with the new ratio whenever devicePixelRatio changes
 * (browser zoom, a window dragged between monitors). There is no event for
 * the ratio itself, so it listens to a `(resolution: Xdppx)` query that
 * stops matching when the ratio moves, then re-arms on the new value.
 * Returns a function that stops watching; degrades to a no-op without
 * matchMedia.
 */
export function watchPixelRatio(
  onChange: (ratio: number) => void,
  host?: PixelRatioHost,
): () => void {
  const win = host ?? (typeof window !== 'undefined' ? window : undefined);
  if (!win || typeof win.matchMedia !== 'function') return () => undefined;
  const matchMedia = win.matchMedia.bind(win);

  let disarm: () => void = () => undefined;
  let stopped = false;
  const arm = (): void => {
    const query = matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    if (typeof query.addEventListener !== 'function') return;
    const handler = (): void => {
      disarm();
      if (stopped) return;
      onChange(win.devicePixelRatio || 1);
      // The callback may have disposed the watcher; do not revive it.
      if (!stopped) arm();
    };
    query.addEventListener('change', handler);
    disarm = () => query.removeEventListener?.('change', handler);
  };
  arm();
  return () => {
    stopped = true;
    disarm();
  };
}

/** Perceived brightness (0 to 1) of a hex or rgb() colour; 0 if unparsed. */
function brightness(color: string): number {
  let channels: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    channels = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  } else {
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
    if (rgb) channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  if (!channels) return 0;
  return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
}

/** Reads the lane's colours and fonts from the active skin's tokens. */
function readLaneStyle(): LaneStyle {
  const computed = getComputedStyle(document.documentElement);
  const token = (name: SkinToken): string => computed.getPropertyValue(name).trim();
  const text = token('--color-text');
  const surface = token('--color-surface');
  // The paler of text and surface is the white key, so a dark skin gets pale
  // keys and a light skin keeps pale keys with dark ones on top.
  const textIsPaler = brightness(text) >= brightness(surface);
  const width = parseFloat(token('--lane-ribbon-width'));
  return {
    background: token('--lane-bg'),
    grid: token('--lane-grid'),
    whiteKey: textIsPaler ? text : surface,
    blackKey: textIsPaler ? surface : text,
    caption: token('--color-text-muted'),
    captionFont: token('--font-display'),
    labelFont: token('--font-mono'),
    reference: token('--color-reference'),
    accent: token('--color-accent'),
    singers: [token('--color-singer-a'), token('--color-singer-b')],
    ribbonWidth: Number.isFinite(width) ? Math.min(12, Math.max(1, width)) : 3,
  };
}

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
  private style: LaneStyle;
  private reference: LaneReference | null = null;
  private now = 0;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private destroyed = false;
  // The furniture never moves between frames, so it is painted once into an
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

  /** Sets the reference contour to overlay, or null to remove it. */
  setReference(ref: LaneReference | null): void {
    this.reference = ref;
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
    const gutter = Math.min(GUTTER_WIDTH, width / 3);

    ctx.clearRect(0, 0, width, height);
    this.paintFurniture();

    const traces = [this.rings[0].toArray(), this.rings[1].toArray()];
    const empty = !this.reference && traces[0].length === 0 && traces[1].length === 0;

    // Everything that scrolls is clipped so it never paints over the gutter.
    ctx.save();
    ctx.beginPath();
    ctx.rect(gutter, 0, width - gutter, height);
    ctx.clip();
    this.drawReference(gutter);
    this.drawRibbon(traces[0], 0, gutter);
    this.drawRibbon(traces[1], 1, gutter);
    ctx.restore();

    if (empty && height >= 120 && width >= 240) {
      ctx.fillStyle = this.style.caption;
      ctx.font = `700 18px ${this.style.captionFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('sing to see your pitch', gutter + (width - gutter) / 2, height / 2);
    }

    const x = this.mapX(this.now, gutter);
    ctx.strokeStyle = this.style.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
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

  /** Pixel column of a song time in the scrolling area right of the gutter. */
  private mapX(t: number, gutter: number): number {
    return gutter + timeToX(t, this.now, this.windowS, this.futureS, this.width - gutter);
  }

  /** Pixel row of a frequency, held at the lane's edge when out of range. */
  private mapY(hz: number): number {
    const midi = Math.min(this.midiHigh, Math.max(this.midiLow, hzToMidi(hz)));
    return midiToY(midi, this.midiLow, this.midiHigh, this.height);
  }

  /** Blits the cached furniture, repainting the cache first if stale. */
  private paintFurniture(): void {
    const { width, height } = this;
    this.layer ??= this.canvas.ownerDocument.createElement('canvas');
    const layerCtx = this.layer.getContext('2d');
    if (!layerCtx) {
      this.drawFurniture(this.ctx, width, height);
      return;
    }
    if (this.layerStale) {
      this.layer.width = this.canvas.width;
      this.layer.height = this.canvas.height;
      layerCtx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
      layerCtx.clearRect(0, 0, width, height);
      this.drawFurniture(layerCtx, width, height);
      this.layerStale = false;
    }
    this.ctx.drawImage(this.layer, 0, 0, width, height);
  }

  /** Background, grid and piano-key gutter. */
  private drawFurniture(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const { style } = this;
    const rows = this.midiHigh - this.midiLow + 1;
    const rowHeight = height / rows;
    const gutter = Math.min(GUTTER_WIDTH, width / 3);

    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);

    for (let midi = this.midiLow; midi <= this.midiHigh; midi++) {
      const top = midiToY(midi, this.midiLow, this.midiHigh, height) - rowHeight / 2;
      const black = isBlackKey(midi);

      // Lane rows: black-key rows are tinted so notes read like a piano roll.
      if (black) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = style.grid;
        ctx.fillRect(gutter, top, width - gutter, rowHeight);
        ctx.globalAlpha = 1;
      }

      // A short black key over a full-width white one is how a piano roll
      // reads at a glance, so the gutter doubles as the pitch legend.
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = style.whiteKey;
      ctx.fillRect(0, top, gutter, rowHeight);
      if (black) {
        ctx.fillStyle = style.blackKey;
        ctx.fillRect(0, top, gutter * BLACK_KEY_SHARE, rowHeight);
      }
      ctx.globalAlpha = 1;

      // Only the C lines are strong, so 49 rows stay readable.
      const octaveLine = pitchClass(midi) === 0;
      ctx.strokeStyle = style.grid;
      ctx.lineWidth = octaveLine ? 1.5 : 1;
      ctx.globalAlpha = octaveLine ? 1 : 0.35;
      const lineY = Math.round(top + rowHeight) + 0.5;
      ctx.beginPath();
      ctx.moveTo(octaveLine ? 0 : gutter, lineY);
      ctx.lineTo(width, lineY);
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (octaveLine && rowHeight >= 5) {
        ctx.fillStyle = style.blackKey;
        ctx.font = `600 10px ${style.labelFont}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(midi), gutter - 5, top + rowHeight / 2);
      }
    }

    ctx.strokeStyle = style.grid;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gutter + 0.5, 0);
    ctx.lineTo(gutter + 0.5, height);
    ctx.stroke();
  }

  /** The reference melody as one soft band, all runs in a single stroke. */
  private drawReference(gutter: number): void {
    const ref = this.reference;
    if (!ref) return;
    const left = this.now - (this.windowS - this.futureS);
    const span = referenceSpan(ref, left, this.now + this.futureS);
    if (!span) return;

    const { ctx } = this;
    const samples = span.last - span.first + 1;
    const stride = Math.max(1, Math.floor(samples / Math.max(1, this.width - gutter)));
    const rowHeight = this.height / (this.midiHigh - this.midiLow + 1);
    const at = (i: number): [number, number] => [
      this.mapX(ref.t0S + i * ref.hopS, gutter),
      this.mapY(ref.f0Hz[i]),
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
    ctx.strokeStyle = this.style.reference;
    ctx.lineWidth = Math.max(REFERENCE_BAND_MIN_PX, rowHeight * REFERENCE_BAND_SEMITONES);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** One singer's live ribbons: paths, one stroke per run of equal opacity. */
  private drawRibbon(frames: LaneFrame[], singer: 0 | 1, gutter: number): void {
    if (frames.length === 0) return;
    const { ctx } = this;
    ctx.strokeStyle = this.style.singers[singer];
    ctx.lineWidth = this.style.ribbonWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const segment of segmentRibbon(frames, LIVE_HOP_S)) {
      for (const run of alphaRuns(segment)) {
        ctx.globalAlpha = run.alpha;
        ctx.beginPath();
        for (let i = run.from; i <= run.to; i++) {
          const x = this.mapX(segment[i].t, gutter);
          const y = this.mapY(segment[i].f0);
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
