/**
 * Key fit (docs/COACHING.md, "Scoring styles"): whether a freestyle note, one
 * the singer chose rather than the melody's, belongs to the song's key. The
 * service estimates the key from the instrumental (`KeyMap`: segments with a
 * tonic, a mode and a tuning offset); this module only compares numbers.
 *
 * A note is in key when its mean pitch, after the song's tuning offset is taken
 * off, is within 50 cents of a tone of the segment's scale: the seven notes of
 * the major or natural minor scale, and in minor also the raised 6th and 7th
 * (a singer in a minor key leans on both). Notes shorter than 150 ms are
 * passing tones and not judged. Where the segment's key is unclear, or the song
 * has no key at all, a note is "unclear" and judged on steadiness only; the
 * card says so. A relative major and minor share their seven notes, so mixing
 * them up changes the verdict only on the minor's two raised tones.
 *
 * Pure, no DOM. Checked against synthetic notes with known answers in
 * test/key-fit.test.ts.
 */
import type { KeyMap, KeySegment } from '../service/types';

/** A note within this many cents of a scale tone is in key. */
export const IN_KEY_CENTS = 50;
/** A note shorter than this is a passing tone and is not judged. */
export const PASSING_NOTE_S = 0.15;

/** Semitones above the tonic of the major scale's seven notes. */
const MAJOR_TONES: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
/** The natural minor scale plus the raised 6th and 7th. */
const MINOR_TONES: readonly number[] = [0, 2, 3, 5, 7, 8, 9, 10, 11];

/** How a freestyle note sits in the song's key. */
export type NoteFit = 'in_key' | 'off_key' | 'unclear' | 'passing';

/** A fit with the distance that decided it. */
export interface KeyFit {
  fit: NoteFit;
  /**
   * Signed cents from the nearest scale tone (sung minus tone, so sharp is
   * positive); null unless the note was judged in or off key.
   */
  centsOff: number | null;
}

/** True for a segment whose key the service could name. */
export function isClearSegment(segment: KeySegment | null): segment is KeySegment & {
  tonic: number;
  mode: 'major' | 'minor';
} {
  return segment !== null && segment.tonic !== null && segment.mode !== null;
}

/**
 * The key segment sounding at song time `t`: a boundary belongs to the later
 * segment, and a time before the first or after the last takes that end one.
 * Null for no key map or a map without segments.
 */
export function keySegmentAt(key: KeyMap | null, t: number): KeySegment | null {
  if (key === null || key.segments.length === 0) return null;
  const { segments } = key;
  let found = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].start_s <= t) found = i;
    else break;
  }
  return segments[found];
}

/** The scale's tones as semitones above the tonic. */
export function scaleTones(mode: 'major' | 'minor'): readonly number[] {
  return mode === 'major' ? MAJOR_TONES : MINOR_TONES;
}

/**
 * Signed cents from `midi` (fractional) to the nearest tone of the key's
 * scale: the song's tuning offset is taken off the pitch first, and the
 * octave does not matter. Positive means the pitch is above the tone.
 */
export function centsToScale(midi: number, tonic: number, mode: 'major' | 'minor', tuningCents: number): number {
  const relative = midi - tuningCents / 100 - tonic;
  const inOctave = ((relative % 12) + 12) % 12;
  let best = Infinity;
  for (const tone of scaleTones(mode)) {
    let diff = inOctave - tone;
    // The nearest copy of the tone may sit in the octave above or below.
    if (diff > 6) diff -= 12;
    else if (diff < -6) diff += 12;
    if (Math.abs(diff) < Math.abs(best)) best = diff;
  }
  return best * 100;
}

/** A pitch against the key at one moment: in key, off key or unclear. */
export function fitPitch(midi: number, t: number, key: KeyMap | null): KeyFit {
  const segment = keySegmentAt(key, t);
  if (!isClearSegment(segment) || key === null) return { fit: 'unclear', centsOff: null };
  const cents = centsToScale(midi, segment.tonic, segment.mode, key.tuning_cents);
  return { fit: Math.abs(cents) <= IN_KEY_CENTS + 1e-9 ? 'in_key' : 'off_key', centsOff: cents };
}

/**
 * A sung note's fit, judged by its mean pitch against the key at its midpoint.
 * A note under 150 ms is a passing tone whatever its pitch.
 */
export function fitNote(midi: number, onsetS: number, offsetS: number, key: KeyMap | null): KeyFit {
  if (offsetS - onsetS < PASSING_NOTE_S - 1e-9) return { fit: 'passing', centsOff: null };
  return fitPitch(midi, (onsetS + offsetS) / 2, key);
}

/**
 * One live frame against the key, for the lane: 'off_key' only where the key is
 * clear and the pitch is more than 50 cents from every scale tone; otherwise
 * 'in_key', or 'unclear' where there is no usable key.
 */
export function fitFrame(midi: number, t: number, key: KeyMap | null): 'in_key' | 'off_key' | 'unclear' {
  const { fit } = fitPitch(midi, t, key);
  return fit === 'in_key' || fit === 'off_key' ? fit : 'unclear';
}

/** How much of the song's key the judged notes could lean on. */
export type KeyStatus = 'clear' | 'partly_unclear' | 'unclear' | 'none';

/** A sung note that was not on the melody and sat outside the song's key. */
export interface OffKeyNote {
  onsetS: number;
  offsetS: number;
  /** The note's median pitch, fractional MIDI. */
  midi: number;
  /** Signed cents from the nearest scale tone (sharp positive). */
  centsOff: number;
}

/** What the key made of the notes sung off the melody (or in a free phrase). */
export interface FreestyleReport {
  inKey: number;
  offKey: number;
  /** Notes in a stretch whose key was unclear, or in a song with no key. */
  unclear: number;
  /** Notes under 150 ms, which are not judged. */
  passing: number;
  /** The notes off key, in time order. */
  offNotes: OffKeyNote[];
  /** Whether the key could be used for the notes judged. */
  keyStatus: KeyStatus;
}

/**
 * Whether the key was usable for the notes judged: 'none' without a key map,
 * 'unclear' when every segment a note fell in was unclear, 'partly_unclear'
 * when some were, else 'clear'. With no notes to go by it describes the map.
 */
export function keyStatusOver(key: KeyMap | null, noteTimes: readonly number[]): KeyStatus {
  if (key === null || key.segments.length === 0) return 'none';
  const clear = (segment: KeySegment | null): boolean => isClearSegment(segment);
  const flags =
    noteTimes.length > 0 ? noteTimes.map((t) => clear(keySegmentAt(key, t))) : key.segments.map(clear);
  if (flags.every((ok) => ok)) return 'clear';
  return flags.some((ok) => ok) ? 'partly_unclear' : 'unclear';
}
