/**
 * Pure geometry and data helpers of the pitch lane: time to pixel, MIDI row
 * to pixel, range fitting, ribbon segmentation and opacity runs, the frame
 * ring, and the shape of a lane view that the drawing layers share. Nothing
 * here touches the canvas or the DOM, so it is tested with synthetic input
 * (test/pitch-lane.test.ts); src/render/pitch-lane.ts re-exports it.
 */
import { hzToMidi } from '../analysis/pitch';

/** Lowest MIDI note shown by default (C2). */
export const DEFAULT_LOW_MIDI = 36;
/** Highest MIDI note shown by default (C6). */
export const DEFAULT_HIGH_MIDI = 84;
/** Width of the piano-key gutter in CSS pixels. */
const GUTTER_WIDTH = 56;
/** Hop of the live tracker (docs/ARCHITECTURE.md), used to spot f0 gaps. */
export const LIVE_HOP_S = 0.01;
/** A gap longer than this many hops breaks a ribbon. */
const GAP_HOPS = 2.5;
/** Narrowest range fitRange returns, in semitones: one octave. */
const MIN_FIT_SPAN = 12;
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
export function pitchClass(midi: number): number {
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

/** What the drawing layers need to know about the lane right now. */
export interface LaneView {
  /** CSS pixel size of the lane. */
  width: number;
  height: number;
  /** Song time at the playhead. */
  now: number;
  windowS: number;
  futureS: number;
  /** Visible MIDI rows, inclusive. */
  midiLow: number;
  midiHigh: number;
}

/** Width of the piano-key gutter, which never takes more than a third. */
export function gutterWidth(width: number): number {
  return Math.min(GUTTER_WIDTH, width / 3);
}

/** Pixel column of a song time in the scrolling area right of the gutter. */
export function viewX(view: LaneView, t: number, gutter: number): number {
  return gutter + timeToX(t, view.now, view.windowS, view.futureS, view.width - gutter);
}

/** Pixel row of a frequency, held at the lane's edge when out of range. */
export function viewY(view: LaneView, hz: number): number {
  const midi = Math.min(view.midiHigh, Math.max(view.midiLow, hzToMidi(hz)));
  return midiToY(midi, view.midiLow, view.midiHigh, view.height);
}
