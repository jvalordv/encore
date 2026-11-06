/**
 * The note guide: karaoke mode's opt-in, neutral readout of the note the
 * singer is on and how many cents off it they are. It judges nothing: no
 * colour, no grade, only a note name and a signed distance, steadied so the
 * number does not jitter.
 *
 * Steadying: the pitch is the median of the voiced frames of the last 0.3 s
 * (a median ignores a one-frame octave slip); the note it is measured against
 * is held until the singer is clearly nearer another (hysteresis past the
 * halfway point, so a pitch sitting between two notes does not flip); and the
 * last reading is held for 0.5 s through gaps, then dropped. Against a clear
 * key segment the note is the nearest tone of the song's scale, after the
 * song's tuning offset; otherwise it is the nearest semitone.
 *
 * Pure, no DOM. Checked against synthetic pitches in test/note-guide.test.ts.
 */
import { noteName } from '../render/lane-geometry';
import type { KeyMap } from '../service/types';
import { centsToScale, isClearSegment, keySegmentAt } from './key-fit';
import { hzToMidi } from './pitch';

/** Seconds of voiced frames the median spans. */
export const SMOOTH_S = 0.3;
/** Seconds a reading is held after the last voiced frame. */
export const HOLD_S = 0.5;
/** Cents from the held note beyond which the nearest note is chosen afresh. */
export const NEAREST_HOLD_CENTS = 65;
/** Within this many cents the readout says "in tune". */
export const IN_TUNE_CENTS = 5;

/** The guide's reading: the note and the signed distance from it. */
export interface GuideNote {
  /** Scientific pitch name, e.g. "A4". */
  note: string;
  /** Rounded cents the singer is above (+) or below (-) the note. */
  centsOff: number;
}

/** The key's identity for resetting the held note when the key changes. */
function keySignature(key: KeyMap | null, songT: number): string {
  const segment = keySegmentAt(key, songT);
  if (!isClearSegment(segment) || key === null) return 'chromatic';
  return `${segment.tonic}|${segment.mode}|${key.tuning_cents}`;
}

/** Median of a non-empty list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The words for a reading: "A4 · in tune", "A4 · 12 c sharp", "A4 · 7 c flat". */
export function formatGuide(reading: GuideNote): string {
  const off = Math.abs(reading.centsOff);
  if (off <= IN_TUNE_CENTS) return `${reading.note} · in tune`;
  return `${reading.note} · ${off} c ${reading.centsOff > 0 ? 'sharp' : 'flat'}`;
}

/** Turns voiced frames into a steady reading. */
export class NoteGuide {
  private samples: Array<{ at: number; midi: number }> = [];
  private lastVoicedAt = Number.NEGATIVE_INFINITY;
  // The held note's pitch in the singer's own frame (tuning offset included),
  // as a fractional MIDI number.
  private target: number | null = null;
  private targetKey = '';
  private held: GuideNote | null = null;

  /**
   * Takes one voiced frame. `nowS` is any steadily increasing clock in
   * seconds (the tracker's context time); `songT` is where the song is, to
   * pick the key segment; `f0` is in Hz.
   */
  push(nowS: number, songT: number, f0: number, key: KeyMap | null): void {
    if (!(f0 > 0)) return;
    const midi = hzToMidi(f0);
    if (!Number.isFinite(midi)) return;
    // A clock that ran backwards is a new stream, not a long gap.
    if (nowS < this.lastVoicedAt) this.reset();
    this.samples.push({ at: nowS, midi });
    this.samples = this.samples.filter((s) => nowS - s.at <= SMOOTH_S);
    this.lastVoicedAt = nowS;
    const signature = keySignature(key, songT);
    if (signature !== this.targetKey) {
      this.targetKey = signature;
      this.target = null;
    }
    const pitch = median(this.samples.map((s) => s.midi));
    const hold =
      this.target !== null && Math.abs((pitch - this.target) * 100) <= NEAREST_HOLD_CENTS;
    if (!hold) this.target = this.nearest(pitch, songT, key);
    const target = this.target as number;
    const tuning = this.tuningOf(songT, key);
    this.held = {
      note: noteName(Math.round(target - tuning)),
      centsOff: Math.round((pitch - target) * 100) || 0,
    };
  }

  /** The reading at `nowS`, or null when none has been heard for HOLD_S. */
  read(nowS: number): GuideNote | null {
    if (this.held === null) return null;
    if (nowS - this.lastVoicedAt > HOLD_S) return null;
    return this.held;
  }

  /** Forgets the pitch and the held note, as when the mic or the song changes. */
  reset(): void {
    this.samples = [];
    this.lastVoicedAt = Number.NEGATIVE_INFINITY;
    this.target = null;
    this.targetKey = '';
    this.held = null;
  }

  /** The pitch, as fractional MIDI, of the nearest note for `pitch`. */
  private nearest(pitch: number, songT: number, key: KeyMap | null): number {
    const segment = keySegmentAt(key, songT);
    if (isClearSegment(segment) && key !== null) {
      return pitch - centsToScale(pitch, segment.tonic, segment.mode, key.tuning_cents) / 100;
    }
    return Math.round(pitch);
  }

  /** Semitones the key's scale sits above concert pitch; 0 without a key. */
  private tuningOf(songT: number, key: KeyMap | null): number {
    return isClearSegment(keySegmentAt(key, songT)) && key !== null ? key.tuning_cents / 100 : 0;
  }
}
