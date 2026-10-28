/**
 * Notes from a take: the browser's half of the segmentation rule in
 * docs/COACHING.md, applied to the live tracker's frames. It is the same rule
 * the service applies to the original vocal (service/encore_service/melody.py,
 * `segment_notes`), so a sung note and a reference note mean the same thing:
 * a voiced run of at least 80 ms (gaps under 40 ms bridged), cut where the
 * median-filtered pitch moves 80 cents from the note's level and holds there
 * for 60 ms. Frames are laid on the tracker's 10 ms grid first, because the
 * rule counts frames. Pure, no DOM, checked against synthetic contours in
 * test/take-notes.test.ts.
 */
import { hzToMidi } from './pitch';

/** The tracker's frame spacing, which the rule's frame counts assume. */
export const HOP_S = 0.01;
/** A voiced run shorter than this is not a note (COACHING.md). */
export const MIN_RUN_S = 0.08;
/** The pitch must move this far from the note's level to start a new note. */
export const SPLIT_CENTS = 80;
/** ...and hold there this long. */
export const SPLIT_HOLD_S = 0.06;
/** A gap in voicing shorter than this stays inside the note around it. */
export const MERGE_GAP_S = 0.04;
/** Median filter length in frames: rides out a blip, far under a vibrato cycle. */
const SMOOTH_FRAMES = 5;
/** A note's level, for the split test, is the median of its latest frames. */
const LEVEL_FRAMES = 50;
/** Guards frame-count comparisons against floating-point dust. */
const EPSILON_S = 1e-9;

/** The two fields of a tracker frame this module reads. */
export interface NoteFrame {
  t: number;
  /** Fundamental in Hz; 0 for unvoiced. */
  f0: number;
}

/** One voiced frame of a sung note. */
export interface SungFrame {
  t: number;
  /** Fractional MIDI number. */
  midi: number;
}

/** A note found in a take. */
export interface SungNote {
  /** Time of the note's first frame. */
  onsetS: number;
  /** Time of the frame after its last, as the service reports a note's end. */
  offsetS: number;
  /** Median of the voiced frames, fractional MIDI. */
  midi: number;
  /** The voiced frames inside it, in time order. */
  frames: SungFrame[];
}

/** Median of numbers, ignoring none; NaN for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Frames `start` up to, not including, `end`. */
interface Span {
  start: number;
  end: number;
}

/** The stretches of consecutive true values, in order. */
function runs(mask: readonly boolean[]): Span[] {
  const out: Span[] = [];
  let start = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i];
    if (on && start < 0) start = i;
    else if (!on && start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  }
  return out;
}

/** Midi of each grid slot, NaN where nothing voiced was heard. */
function onGrid(frames: readonly NoteFrame[]): { midi: number[]; t0: number } {
  const voiced = frames.filter((f) => f.f0 > 0 && Number.isFinite(f.f0) && Number.isFinite(f.t));
  if (voiced.length === 0) return { midi: [], t0: 0 };
  let t0 = Infinity;
  let last = -Infinity;
  for (const f of voiced) {
    if (f.t < t0) t0 = f.t;
    if (f.t > last) last = f.t;
  }
  const midi = new Array<number>(Math.round((last - t0) / HOP_S) + 1).fill(Number.NaN);
  // Frames come in time order, so a later one in the same slot wins.
  for (const f of voiced) midi[Math.round((f.t - t0) / HOP_S)] = hzToMidi(f.f0);
  return { midi, t0 };
}

/** Fills gaps shorter than MERGE_GAP_S that have voiced frames on both sides. */
function bridgeGaps(midi: readonly number[]): { bridged: boolean[]; filled: number[] } {
  const voiced = midi.map((m) => !Number.isNaN(m));
  const bridged = [...voiced];
  for (const gap of runs(voiced.map((v) => !v))) {
    if (gap.start === 0 || gap.end === midi.length) continue;
    if ((gap.end - gap.start) * HOP_S < MERGE_GAP_S - EPSILON_S) bridged.fill(true, gap.start, gap.end);
  }
  // Linear interpolation across the bridged gaps, so the filter can run over them.
  const filled = new Array<number>(midi.length).fill(Number.NaN);
  let before = -1;
  for (let i = 0; i < midi.length; i++) {
    if (voiced[i]) {
      filled[i] = midi[i];
      before = i;
    } else if (bridged[i]) {
      let after = i;
      while (!voiced[after]) after++;
      filled[i] = midi[before] + ((midi[after] - midi[before]) * (i - before)) / (after - before);
    }
  }
  return { bridged, filled };
}

/** Running median over `size` frames (odd), ignoring NaN; NaN stays NaN. */
function runningMedian(values: readonly number[], size: number): number[] {
  const half = size >> 1;
  return values.map((value, i) => {
    if (Number.isNaN(value)) return Number.NaN;
    const near: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      if (!Number.isNaN(values[j])) near.push(values[j]);
    }
    return median(near);
  });
}

/** Cuts one smoothed run where it moves to a new level and stays there. */
function splitRun(pitch: readonly number[], hold: number): Span[] {
  const spans: Span[] = [];
  const cut = SPLIT_CENTS / 100;
  let start = 0;
  for (let frame = 1; frame < pitch.length; frame++) {
    if (frame + hold > pitch.length) break;
    const level = median(pitch.slice(Math.max(start, frame - LEVEL_FRAMES), frame));
    const ahead = pitch.slice(frame, frame + hold).map((p) => p - level);
    if (ahead.every((d) => d >= cut) || ahead.every((d) => d <= -cut)) {
      spans.push({ start, end: frame });
      start = frame;
    }
  }
  spans.push({ start, end: pitch.length });
  return spans;
}

/**
 * The notes sung in a take, from its frames (time order, song time). A frame
 * with f0 = 0 is unvoiced. Gaps in time (a dropped frame) read as unvoiced.
 */
export function segmentTake(frames: readonly NoteFrame[]): SungNote[] {
  const { midi, t0 } = onGrid(frames);
  if (midi.length === 0) return [];
  const { bridged, filled } = bridgeGaps(midi);
  const smooth = runningMedian(filled, SMOOTH_FRAMES);
  const hold = Math.max(Math.round(SPLIT_HOLD_S / HOP_S), 1);
  const notes: SungNote[] = [];
  for (const run of runs(bridged)) {
    if ((run.end - run.start) * HOP_S < MIN_RUN_S - EPSILON_S) continue;
    for (const piece of splitRun(smooth.slice(run.start, run.end), hold)) {
      // A piece shorter than the hold is a slip at a note's edge.
      if (piece.end - piece.start < hold) continue;
      const start = run.start + piece.start;
      const end = run.start + piece.end;
      const sung: SungFrame[] = [];
      for (let i = start; i < end; i++) {
        if (!Number.isNaN(midi[i])) sung.push({ t: t0 + i * HOP_S, midi: midi[i] });
      }
      if (sung.length === 0) continue;
      notes.push({
        onsetS: t0 + start * HOP_S,
        offsetS: t0 + end * HOP_S,
        midi: median(sung.map((f) => f.midi)),
        frames: sung,
      });
    }
  }
  return notes;
}
