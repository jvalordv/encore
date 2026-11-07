/**
 * Tests for the voice alone (src/analysis/voice.ts) on synthetic contours with
 * known answers: a steady +25 cents bias, a 6 Hz vibrato of 50 cents, a drift
 * of 30 cents a second, a 100 cent scoop, no false vibrato on a steady note
 * with tracker noise, an estimated key on a C-major melody (and the song's key
 * when the service sent one), the chromatic fallback, phrases and breaths, the
 * range, and the live tuner grade.
 */
import { describe, expect, it } from 'vitest';
import { hzToMidi } from '../src/analysis/pitch';
import type { PitchFrame } from '../src/analysis/pitch';
import type { SungNote } from '../src/analysis/take-notes';
import { gradeFrameTuner, measureNote, measureVoice, mergeRisingScoops } from '../src/analysis/voice';
import type { KeyMap } from '../src/service/types';

const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** Deterministic noise in [-1, 1]. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return (state / 4294967296) * 2 - 1;
  };
}

/** One tracker frame per 10 ms from `startS` for `seconds`, pitched by `midiAt(t since start)`. */
function frames(startS: number, seconds: number, midiAt: (t: number) => number): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let i = 0; i < Math.round(seconds / 0.01); i++) {
    out.push({ t: startS + i * 0.01, f0: midiToHz(midiAt(i * 0.01)), clarity: 0.95, rms: 0.1 });
  }
  return out;
}

/** A take of notes [midi, seconds], each followed by `gap` seconds of silence. */
function take(notes: ReadonlyArray<readonly [number, number]>, gap: number, centsAdded = 0): PitchFrame[] {
  const out: PitchFrame[] = [];
  let t = 0;
  for (const [midi, seconds] of notes) {
    out.push(...frames(t, seconds, () => midi + centsAdded / 100));
    t += seconds;
    for (let i = 0; i < Math.round(gap / 0.01); i++) out.push({ t: t + i * 0.01, f0: 0, clarity: 0, rms: 0 });
    t += gap;
  }
  return out;
}

/** A sung note built directly, for contours the segmentation rule would cut. */
function noteOf(startS: number, seconds: number, midiAt: (t: number) => number): SungNote {
  const fs = frames(startS, seconds, midiAt).map((f) => ({ t: f.t, midi: hzToMidi(f.f0) }));
  const mids = fs.map((f) => f.midi).sort((a, b) => a - b);
  return { onsetS: startS, offsetS: startS + seconds, midi: mids[mids.length >> 1], frames: fs };
}

const C_MAJOR_TUNE: ReadonlyArray<readonly [number, number]> = [
  [60, 0.8], [64, 0.4], [67, 0.4], [72, 0.6], [71, 0.3], [69, 0.3], [67, 0.6], [65, 0.3],
  [64, 0.3], [62, 0.3], [60, 0.8], [67, 0.5], [64, 0.4], [65, 0.3], [62, 0.3], [60, 1],
];

describe('measureVoice: intonation and the key', () => {
  it('reads a steady +25 cents as a sharp bias of 25 against an estimated C major', () => {
    const v = measureVoice(take(C_MAJOR_TUNE, 0.12, 25), null);
    expect(v.reference).toBe('estimated_key');
    expect(v.keyName).toBe('C major');
    expect(v.keyConfidence).toBeGreaterThan(0.75);
    expect(v.summary.judged).toBe(C_MAJOR_TUNE.length);
    expect(v.summary.biasCents).toBeCloseTo(25, 0);
    expect(v.summary.within50).toBe(1);
    expect(v.notes.every((n) => Math.abs((n.centsOff ?? 0) - 25) < 1)).toBe(true);
  });

  it('counts the share within 25 cents separately from within 50', () => {
    // Half the notes 10 cents off, half 40 cents off.
    const notes = C_MAJOR_TUNE.map((n, i) => [n[0] + (i % 2 === 0 ? 0.1 : 0.4), n[1]] as const);
    const v = measureVoice(take(notes, 0.12), null);
    expect(v.summary.within25).toBeCloseTo(0.5, 5);
    expect(v.summary.within50).toBe(1);
  });

  it("judges against the song's key when the service sent one, with its tuning taken off", () => {
    const key: KeyMap = { tuning_cents: 20, segments: [{ start_s: 0, end_s: 99, tonic: 0, mode: 'major', confidence: 1 }] };
    const v = measureVoice(take(C_MAJOR_TUNE, 0.12, 20 + 15), key);
    expect(v.reference).toBe('song_key');
    expect(v.keyName).toBe('C major');
    expect(v.summary.biasCents).toBeCloseTo(15, 0);
  });

  it('falls back to the nearest semitone when no key is clear, and to concert pitch', () => {
    const v = measureVoice(take([[60.3, 0.6], [62.3, 0.6]], 0.12), null);
    expect(v.reference).toBe('chromatic');
    expect(v.keyName).toBeNull();
    expect(v.notes[0].centsOff).toBeCloseTo(30, 0);
    const unclear: KeyMap = { tuning_cents: 0, segments: [{ start_s: 0, end_s: 9, tonic: null, mode: null, confidence: 0 }] };
    expect(measureVoice(take([[60.3, 0.6]], 0.1), unclear).reference).toBe('chromatic');
  });

  it('gives an empty section for no singing', () => {
    const v = measureVoice([], null);
    expect(v.notes).toEqual([]);
    expect(v.summary.judged).toBe(0);
    expect(v.summary.range).toBeNull();
  });
});

describe('measureNote and measureVoice: the shape of a note', () => {
  it('finds a 6 Hz, 50 cent vibrato through the segmentation, and no spread or drift in it', () => {
    const fs = frames(0, 1.5, (t) => 69 + 0.5 * Math.sin(2 * Math.PI * 6 * t));
    const v = measureVoice(fs, null);
    expect(v.notes).toHaveLength(1);
    const n = v.notes[0];
    expect(n.vibrato?.rateHz).toBeCloseTo(6, 0);
    expect(n.vibrato?.extentCents).toBeGreaterThan(44);
    expect(n.vibrato?.extentCents).toBeLessThan(56);
    expect(n.stdCents).toBeLessThan(4);
    expect(Math.abs(n.driftCps ?? 99)).toBeLessThan(4);
    expect(v.summary.vibratoNotes).toBe(1);
    expect(v.summary.vibratoOf).toBe(1);
    expect(v.summary.vibratoRateHz).toBeCloseTo(6, 0);
  });

  it('reads a drift of 30 cents a second after the first 150 ms', () => {
    const n = measureNote(noteOf(0, 0.9, (t) => 69 + 0.3 * t), 0);
    expect(n.driftCps).toBeCloseTo(30, 0);
    expect(n.vibrato).toBeNull();
    const flat = measureNote(noteOf(0, 0.9, (t) => 69 - 0.3 * t), 0);
    expect(flat.driftCps).toBeCloseTo(-30, 0);
  });

  it('leaves drift unmeasured on a note under 600 ms, and spread on one under 650 ms', () => {
    const mid = measureNote(noteOf(0, 0.5, () => 69), 0);
    expect(mid.driftCps).toBeNull();
    expect(mid.stdCents).toBeNull();
    const held = measureNote(noteOf(0, 0.7, () => 69), 0);
    expect(held.stdCents).not.toBeNull();
    // A 5 Hz vibrato on a 0.5 s note cannot be fitted, so it is not a wobble.
    const vib = measureNote(noteOf(0, 0.5, (t) => 69 + 0.4 * Math.sin(2 * Math.PI * 5 * t)), 0);
    expect(vib.stdCents).toBeNull();
    const short = measureNote(noteOf(0, 0.3, () => 69), 0);
    expect(short.stdCents).toBeNull();
    expect(short.scoopCents).not.toBeNull();
  });

  it('measures a 100 cent scoop: the first 150 ms under the steady part', () => {
    const n = measureNote(noteOf(0, 0.8, (t) => (t < 0.15 ? 68 : 69)), 0);
    expect(n.scoopCents).toBeCloseTo(100, 0);
    const steadyNote = measureNote(noteOf(0, 0.8, () => 69), 0);
    expect(steadyNote.scoopCents).toBeCloseTo(0, 5);
  });

  it('joins a scoop the segmentation cut off into its note, so the scoop is measured', () => {
    // 100 ms 100 cents under, then the note: two pieces by the 80 cent rule.
    const fs = frames(0, 0.9, (t) => (t < 0.1 ? 68 : 69));
    const v = measureVoice(fs, null);
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0].scoopCents).toBeGreaterThan(90);
    const pieces = [noteOf(0, 0.1, () => 68), noteOf(0.1, 0.7, () => 69)];
    expect(mergeRisingScoops(pieces)).toHaveLength(1);
    // A short piece that steps down, or a long one, is a note of its own.
    expect(mergeRisingScoops([noteOf(0, 0.1, () => 70), noteOf(0.1, 0.7, () => 69)])).toHaveLength(2);
    expect(mergeRisingScoops([noteOf(0, 0.3, () => 68), noteOf(0.3, 0.7, () => 69)])).toHaveLength(2);
  });

  it('finds no vibrato on a steady note with tracker noise, and reports the noise as spread', () => {
    const rand = noise(11);
    const v = measureVoice(frames(0, 1.2, () => 69 + 0.1 * rand()), null);
    expect(v.notes).toHaveLength(1);
    expect(v.notes[0].vibrato).toBeNull();
    expect(v.notes[0].stdCents).toBeGreaterThan(3);
    expect(v.notes[0].stdCents).toBeLessThan(9);
    expect(v.summary.vibratoNotes).toBe(0);
    expect(v.summary.vibratoOf).toBe(1);
  });
});

describe('measureVoice: range, phrases and breaths', () => {
  it('takes the range from the 10th to the 90th percentile of the voiced frames', () => {
    // Ten equal notes a semitone apart, 60 to 69: p10 near 60.9, p90 near 68.1.
    const notes = Array.from({ length: 10 }, (_, i) => [60 + i, 0.5] as const);
    const range = measureVoice(take(notes, 0.12), null).summary.range;
    expect(range?.lowMidi).toBeGreaterThan(60.5);
    expect(range?.lowMidi).toBeLessThan(61.5);
    expect(range?.highMidi).toBeGreaterThan(67.5);
    expect(range?.highMidi).toBeLessThan(68.5);
  });

  it('splits phrases at breaths over 250 ms and measures their lengths', () => {
    // Three notes 0.5 s with 0.1 s between (one phrase of 1.7 s), a 0.4 s breath, then two more.
    const fs = [
      ...frames(0, 0.5, () => 60),
      ...frames(0.6, 0.5, () => 62),
      ...frames(1.2, 0.5, () => 64),
      ...frames(2.1, 0.5, () => 65),
      ...frames(2.7, 0.5, () => 67),
    ];
    const v = measureVoice(fs, null);
    expect(v.summary.phraseCount).toBe(2);
    expect(v.phrases[0][0]).toBeCloseTo(0, 1);
    expect(v.phrases[0][1]).toBeCloseTo(1.7, 1);
    expect(v.summary.phraseLongestS).toBeCloseTo(1.7, 1);
    expect(v.summary.phraseMedianS).toBeCloseTo(1.4, 1);
    expect(v.summary.breathMedianS).toBeCloseTo(0.4, 1);
  });
});

describe('gradeFrameTuner', () => {
  const frame = (hz: number): PitchFrame => ({ t: 1, f0: hz, clarity: 0.9, rms: 0.1 });

  it('grades by cents from the nearest semitone with no key: 25 hit, 50 okay', () => {
    expect(gradeFrameTuner(frame(440), null)).toBe('hit');
    expect(gradeFrameTuner(frame(midiToHz(69.2)), null)).toBe('hit');
    expect(gradeFrameTuner(frame(midiToHz(69.35)), null)).toBe('okay');
    expect(gradeFrameTuner(frame(0), null)).toBeNull();
  });

  it('grades by cents from the nearest note of a clear key, so a note outside it is a miss', () => {
    const key: KeyMap = { tuning_cents: 0, segments: [{ start_s: 0, end_s: 9, tonic: 0, mode: 'major', confidence: 1 }] };
    expect(gradeFrameTuner(frame(midiToHz(64)), key)).toBe('hit');
    // C sharp is 100 cents from C and from D: on the semitone it would be a hit.
    expect(gradeFrameTuner(frame(midiToHz(61)), key)).toBe('miss');
    expect(gradeFrameTuner(frame(midiToHz(61)), null)).toBe('hit');
  });
});
