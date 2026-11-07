/**
 * Range and key (W6b): the singer's comfortable range, the semitone shift
 * that best seats the melody inside it, and the one transposition seam every
 * consumer of the reference goes through. The range is the median of the
 * per-take p10 and p90 that learning takes already measure (the voice
 * section's `range`); the shift is whole semitones in -6..+6. The reference
 * the lane draws, the keyboard's lit keys, scoring, the note guide, the key
 * map and the MIDI export are all derived from the song's own data by the
 * transpose functions here, so none of them needs to know a shift exists.
 * Pure, no DOM. Checked on synthetic ranges and notes in test/key-shift.test.ts.
 */
import { percentile } from './score';
import type { ScoreReference } from './score';
import type { LaneNote, LaneReference } from '../render/lane-geometry';
import type { KeyMap } from '../service/types';

/** The most a song is moved either way: half an octave. */
export const MAX_SHIFT = 6;
/** Takes the range is read from, newest first. */
export const RANGE_TAKES = 8;
/** Fewest takes a range is claimed from. */
export const MIN_RANGE_TAKES = 3;

/** A pitch span in fractional MIDI notes. */
export interface MidiSpan {
  lowMidi: number;
  highMidi: number;
}

/** The shift as a whole number of semitones inside -6..+6; NaN is none. */
export function clampShift(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, Math.round(n)));
}

/**
 * The comfortable range from per-take spans, newest first: the median p10 and
 * the median p90 over the first RANGE_TAKES takes that have one. Null until
 * MIN_RANGE_TAKES takes have a span, so one odd take never sets it.
 */
export function estimateRange(perTake: ReadonlyArray<MidiSpan | null>): (MidiSpan & { takes: number }) | null {
  const spans: MidiSpan[] = [];
  for (const span of perTake) {
    if (spans.length >= RANGE_TAKES) break;
    if (span && Number.isFinite(span.lowMidi) && Number.isFinite(span.highMidi)) spans.push(span);
  }
  if (spans.length < MIN_RANGE_TAKES) return null;
  const lowMidi = percentile(
    spans.map((s) => s.lowMidi),
    0.5,
  );
  const highMidi = percentile(
    spans.map((s) => s.highMidi),
    0.5,
  );
  return { lowMidi, highMidi: Math.max(lowMidi, highMidi), takes: spans.length };
}

/** The melody's p10 to p90 over its notes' pitches; null with no notes. */
export function melodyRange(notes: ReadonlyArray<{ midi: number }> | undefined): MidiSpan | null {
  if (!notes || notes.length === 0) return null;
  const midis = notes.map((n) => n.midi);
  return { lowMidi: percentile(midis, 0.1), highMidi: percentile(midis, 0.9) };
}

/**
 * The shift in -6..+6 that puts the middle of the melody's range closest to
 * the middle of the singer's; a tie takes the smaller move. Null without
 * either range. Zero means the song already sits well.
 */
export function suggestShift(melody: MidiSpan | null, band: MidiSpan | null): number | null {
  if (!melody || !band) return null;
  const gap = (melody.lowMidi + melody.highMidi) / 2 - (band.lowMidi + band.highMidi) / 2;
  let best = 0;
  for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s++) {
    const err = Math.abs(gap + s);
    const bestErr = Math.abs(gap + best);
    if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) <= 1e-9 && Math.abs(s) < Math.abs(best))) best = s;
  }
  return best;
}

/** Notes moved by `n` semitones, as a new array. */
export function transposeNotes<T extends { midi: number }>(notes: readonly T[], n: number): T[] {
  return n === 0 ? [...notes] : notes.map((note) => ({ ...note, midi: note.midi + n }));
}

/** A lane reference with its notes and contour moved by `n` semitones. */
export function transposeLane(ref: LaneReference, n: number): LaneReference {
  if (n === 0) return ref;
  const ratio = 2 ** (n / 12);
  const f0Hz = Array.from(ref.f0Hz, (hz) => (hz > 0 ? hz * ratio : hz));
  return { ...ref, f0Hz, notes: ref.notes ? transposeNotes<LaneNote>(ref.notes, n) : ref.notes };
}

/** The scoring reference moved by `n` semitones, its range and notes with it. */
export function transposeScore(ref: ScoreReference, n: number): ScoreReference {
  if (n === 0) return ref;
  return { ...ref, notes: transposeNotes(ref.notes, n), lowMidi: ref.lowMidi + n, highMidi: ref.highMidi + n };
}

/** The key map moved by `n` semitones: each tonic goes up, the tuning stays. */
export function transposeKey(key: KeyMap, n: number): KeyMap {
  if (n === 0) return key;
  const segments = key.segments.map((s) =>
    s.tonic === null ? s : { ...s, tonic: (((s.tonic + n) % 12) + 12) % 12 },
  );
  return { ...key, segments };
}
