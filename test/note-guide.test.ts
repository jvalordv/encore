/**
 * Tests for the note guide (src/analysis/note-guide.ts) on synthetic pitches
 * with known answers: the nearest note and cents chromatically and against a
 * key (with its tuning offset), the median's rejection of a one-frame octave
 * slip, hysteresis between two notes, the hold through gaps, and the words.
 */
import { describe, expect, it } from 'vitest';
import {
  formatGuide,
  HOLD_S,
  IN_TUNE_CENTS,
  NEAREST_HOLD_CENTS,
  NoteGuide,
  SMOOTH_S,
} from '../src/analysis/note-guide';
import { midiToHz } from '../src/analysis/pitch';
import type { KeyMap, KeySegment } from '../src/service/types';

const seg = (tonic: number | null, mode: 'major' | 'minor' | null): KeySegment => ({
  start_s: 0,
  end_s: 100,
  tonic,
  mode,
  confidence: 0.8,
});
const keyOf = (segment: KeySegment, tuning = 0): KeyMap => ({ tuning_cents: tuning, segments: [segment] });
const cMajor = keyOf(seg(0, 'major'));

/** Feeds `seconds` of a steady fractional-MIDI pitch at 100 frames a second. */
function sing(guide: NoteGuide, midi: number, from: number, seconds: number, key: KeyMap | null): number {
  const frames = Math.round(seconds * 100);
  for (let i = 0; i < frames; i++) {
    const now = from + i * 0.01;
    guide.push(now, now, midiToHz(midi), key);
  }
  return from + frames * 0.01;
}

describe('chromatic readings', () => {
  it('reads A4 at 440 Hz as in tune', () => {
    const guide = new NoteGuide();
    const end = sing(guide, 69, 0, 0.5, null);
    expect(guide.read(end)).toEqual({ note: 'A4', centsOff: 0 });
  });

  it('reads 12 cents above and below a note as signed cents', () => {
    const sharp = new NoteGuide();
    expect(sharp.read(sing(sharp, 69.12, 0, 0.5, null))).toEqual({ note: 'A4', centsOff: 12 });
    const flat = new NoteGuide();
    expect(flat.read(sing(flat, 60 - 0.07, 0, 0.5, null))).toEqual({ note: 'C4', centsOff: -7 });
  });

  it('has nothing before the first voiced frame', () => {
    expect(new NoteGuide().read(0)).toBeNull();
  });

  it('ignores unvoiced frames', () => {
    const guide = new NoteGuide();
    guide.push(0, 0, 0, null);
    guide.push(0.01, 0.01, Number.NaN, null);
    expect(guide.read(0.01)).toBeNull();
  });
});

describe('steadiness', () => {
  it('shrugs off a one-frame octave slip with the median', () => {
    const guide = new NoteGuide();
    let now = sing(guide, 69, 0, 0.4, null);
    guide.push(now, now, midiToHz(81), null);
    now += 0.01;
    expect(guide.read(now)).toEqual({ note: 'A4', centsOff: 0 });
  });

  it('follows a real change of pitch once the window has moved on', () => {
    const guide = new NoteGuide();
    let now = sing(guide, 69, 0, 0.5, null);
    now = sing(guide, 71, now, SMOOTH_S + 0.05, null);
    expect(guide.read(now)).toEqual({ note: 'B4', centsOff: 0 });
  });

  it('keeps the held note while the pitch drifts a little past halfway', () => {
    const guide = new NoteGuide();
    let now = sing(guide, 69.3, 0, 0.5, null);
    // 58 c above A4 is nearer A#4 (42 c) but inside the hold distance of A4.
    expect(NEAREST_HOLD_CENTS).toBeGreaterThan(58);
    now = sing(guide, 69.58, now, SMOOTH_S + 0.05, null);
    expect(guide.read(now)).toEqual({ note: 'A4', centsOff: 58 });
    // A singer who starts there has no held note, so it is the nearest.
    const fresh = new NoteGuide();
    expect(fresh.read(sing(fresh, 69.58, 0, 0.5, null))?.note).toBe('A#4');
  });

  it('switches once the pitch is beyond the hold distance', () => {
    const guide = new NoteGuide();
    let now = sing(guide, 69.3, 0, 0.5, null);
    now = sing(guide, 69.8, now, SMOOTH_S + 0.05, null);
    expect(guide.read(now)).toEqual({ note: 'A#4', centsOff: -20 });
  });
});

describe('holding through gaps', () => {
  it('holds the last reading for HOLD_S, then drops it', () => {
    const guide = new NoteGuide();
    const end = sing(guide, 69, 0, 0.5, null);
    expect(guide.read(end + HOLD_S - 0.01)).toEqual({ note: 'A4', centsOff: 0 });
    expect(guide.read(end + HOLD_S + 0.1)).toBeNull();
  });

  it('starts afresh when the clock runs backwards', () => {
    const guide = new NoteGuide();
    sing(guide, 69, 10, 0.5, null);
    const end = sing(guide, 60, 0, 0.5, null);
    expect(guide.read(end)).toEqual({ note: 'C4', centsOff: 0 });
  });
});

describe('against the song key', () => {
  it('names the nearest scale tone, not the nearest semitone', () => {
    // 61.2 is 120 c above C4 and 80 c below D4, and C# is not in the scale.
    const guide = new NoteGuide();
    expect(guide.read(sing(guide, 61.2, 0, 0.5, cMajor))).toEqual({ note: 'D4', centsOff: -80 });
  });

  it('reads an in-scale note the same as chromatic', () => {
    const guide = new NoteGuide();
    expect(guide.read(sing(guide, 64.1, 0, 0.5, cMajor))).toEqual({ note: 'E4', centsOff: 10 });
  });

  it('takes the song tuning offset off, naming the note but not the offset', () => {
    // The song sits 30 c sharp of A440, so a singer 30 c above C4 is on C4.
    const guide = new NoteGuide();
    const tuned = keyOf(seg(0, 'major'), 30);
    expect(guide.read(sing(guide, 60.3, 0, 0.5, tuned))).toEqual({ note: 'C4', centsOff: 0 });
  });

  it('uses the minor scale where the key is minor', () => {
    // G# is the raised 7th, which A minor allows and C major does not.
    const guide = new NoteGuide();
    const aMinor = keyOf(seg(9, 'minor'));
    expect(guide.read(sing(guide, 68, 0, 0.5, aMinor))).toEqual({ note: 'G#4', centsOff: 0 });
  });

  it('falls back to chromatic where the key is unclear', () => {
    const guide = new NoteGuide();
    const unclear = keyOf(seg(null, null));
    expect(guide.read(sing(guide, 61.2, 0, 0.5, unclear))).toEqual({ note: 'C#4', centsOff: 20 });
  });

  it('drops the held note when the key changes under the singer', () => {
    const guide = new NoteGuide();
    let now = sing(guide, 61, 0, 0.5, null);
    expect(guide.read(now)?.note).toBe('C#4');
    now = sing(guide, 61, now, 0.5, cMajor);
    // C# is 100 c from C and from D in C major; either is a fresh pick.
    expect(['C4', 'D4']).toContain(guide.read(now)?.note);
  });
});

describe('formatGuide', () => {
  it('says in tune within the tolerance', () => {
    expect(formatGuide({ note: 'A4', centsOff: 0 })).toBe('A4 · in tune');
    expect(formatGuide({ note: 'A4', centsOff: IN_TUNE_CENTS })).toBe('A4 · in tune');
    expect(formatGuide({ note: 'A4', centsOff: -IN_TUNE_CENTS })).toBe('A4 · in tune');
  });

  it('says sharp or flat with the cents beyond it', () => {
    expect(formatGuide({ note: 'A4', centsOff: 12 })).toBe('A4 · 12 c sharp');
    expect(formatGuide({ note: 'C4', centsOff: -7 })).toBe('C4 · 7 c flat');
  });
});
