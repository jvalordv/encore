/**
 * Tests for scoring (src/analysis/score.ts) on synthetic takes whose answers
 * are known: the grade boundaries, octave folding, the note under a frame,
 * and the report of a take (in-tune rate, onset delta, scoop, stability, held
 * length, the worst phrases, the ranges).
 */
import { describe, expect, it, vi } from 'vitest';
import { midiToHz } from '../src/analysis/pitch';
import type { PitchFrame } from '../src/analysis/pitch';
import {
  buildScoreReference,
  centsOff,
  gradeCents,
  HIT_CENTS,
  LiveScorer,
  noteAt,
  OKAY_CENTS,
  percentile,
  reportTake,
  scoreFrame,
} from '../src/analysis/score';
import type { ScoreNote, ScoreReference } from '../src/analysis/score';

const HOP = 0.01;

/** A reference of the given notes, in the range they span. */
function reference(notes: ScoreNote[], unpitchedS: Array<[number, number]> = []): ScoreReference {
  const midis = notes.map((n) => n.midi);
  return buildScoreReference(notes, unpitchedS, { lowMidi: Math.min(...midis), highMidi: Math.max(...midis) });
}

/** A take: a pitch per stretch (null = silence) from 0 to `totalS`, one frame per 10 ms. */
function take(
  stretches: Array<[fromS: number, toS: number, midi: number | ((t: number) => number)]>,
  totalS: number,
): PitchFrame[] {
  const frames: PitchFrame[] = [];
  for (let i = 0; i * HOP < totalS - 1e-9; i++) {
    const t = Math.round(i * HOP * 1000) / 1000;
    const hit = stretches.find(([from, to]) => t >= from - 1e-9 && t < to - 1e-9);
    const midi = hit ? (typeof hit[2] === 'function' ? hit[2](t) : hit[2]) : null;
    frames.push({ t, f0: midi === null ? 0 : midiToHz(midi), clarity: 0.95, rms: 0.2 });
  }
  return frames;
}

describe('grading', () => {
  it('grades within 25 cents a hit, within 50 okay, beyond that a miss', () => {
    expect([HIT_CENTS, OKAY_CENTS]).toEqual([25, 50]);
    expect(gradeCents(0)).toBe('hit');
    expect(gradeCents(25)).toBe('hit');
    expect(gradeCents(-25)).toBe('hit');
    expect(gradeCents(25.5)).toBe('okay');
    expect(gradeCents(30)).toBe('okay');
    expect(gradeCents(-50)).toBe('okay');
    expect(gradeCents(50.5)).toBe('miss');
    expect(gradeCents(60)).toBe('miss');
    expect(gradeCents(-60)).toBe('miss');
  });

  it('measures the error in cents, sharp positive', () => {
    expect(centsOff(60.3, 60)).toBeCloseTo(30, 6);
    expect(centsOff(59.4, 60)).toBeCloseTo(-60, 6);
  });

  it('folds the error into plus or minus 600 cents when octave invariant', () => {
    expect(centsOff(72, 60)).toBeCloseTo(1200, 6);
    expect(centsOff(72, 60, true)).toBeCloseTo(0, 6);
    expect(centsOff(48.2, 60, true)).toBeCloseTo(20, 6);
    expect(centsOff(71.4, 60, true)).toBeCloseTo(-60, 6);
    expect(centsOff(66, 60, true)).toBeCloseTo(-600, 6);
  });
});

describe('the note under a frame', () => {
  const ref = reference(
    [
      { onsetS: 1, offsetS: 2, midi: 60 },
      { onsetS: 2, offsetS: 3, midi: 64 },
      { onsetS: 5, offsetS: 6, midi: 67 },
    ],
    [[3.5, 4.5]],
  );

  it('finds the note by time, onset inclusive and offset exclusive', () => {
    expect(noteAt(ref, 0.99)).toBe(-1);
    expect(noteAt(ref, 1)).toBe(0);
    expect(noteAt(ref, 1.99)).toBe(0);
    expect(noteAt(ref, 2)).toBe(1);
    expect(noteAt(ref, 3)).toBe(-1);
    expect(noteAt(ref, 5.5)).toBe(2);
    expect(noteAt(ref, 6)).toBe(-1);
  });

  it('does not score a frame in an unpitched region, even one a note overlaps', () => {
    expect(noteAt(ref, 4)).toBe(-1);
    const overlapping = reference([{ onsetS: 0, offsetS: 2, midi: 60 }], [[1, 1.5]]);
    expect(noteAt(overlapping, 1.2)).toBe(-1);
    expect(noteAt(overlapping, 0.5)).toBe(0);
    expect(noteAt(overlapping, 1.7)).toBe(0);
  });

  it('scores a voiced frame in a note and nothing else', () => {
    const f = (t: number, midi: number | null): PitchFrame => ({
      t,
      f0: midi === null ? 0 : midiToHz(midi),
      clarity: 0.9,
      rms: 0.1,
    });
    expect(scoreFrame(f(1.5, 60.3), ref)).toMatchObject({ note: 0, grade: 'okay' });
    expect(scoreFrame(f(1.5, 60.6), ref)).toMatchObject({ note: 0, grade: 'miss' });
    expect(scoreFrame(f(1.5, 60.2), ref)).toMatchObject({ grade: 'hit' });
    expect(scoreFrame(f(1.5, null), ref)).toBeNull();
    expect(scoreFrame(f(4, 60), ref)).toBeNull();
    expect(scoreFrame(f(1.5, 72), ref)).toMatchObject({ grade: 'miss' });
    expect(scoreFrame(f(1.5, 72), ref, true)).toMatchObject({ grade: 'hit' });
  });
});

describe('LiveScorer', () => {
  const ref = reference([{ onsetS: 0, offsetS: 10, midi: 60 }]);
  const frame = (midi: number): PitchFrame => ({ t: 1, f0: midiToHz(midi), clarity: 0.9, rms: 0.1 });

  it('grades frames from the bus for the sink, and nothing without a melody', () => {
    let current: ScoreReference | null = ref;
    const scorer = new LiveScorer({ reference: () => current, octaveInvariant: () => false });
    const subscribers: Array<(m: { frame: PitchFrame }) => void> = [];
    const unsubscribe = vi.fn();
    const bus = {
      subscribe(cb: (m: { frame: PitchFrame }) => void) {
        subscribers.push(cb);
        return unsubscribe;
      },
    };
    const sink = vi.fn();
    expect(scorer.attach(bus, sink)).toBe(unsubscribe);
    subscribers[0]({ frame: frame(60.1) });
    subscribers[0]({ frame: frame(60.4) });
    subscribers[0]({ frame: frame(61) });
    current = null;
    subscribers[0]({ frame: frame(60) });
    expect(sink.mock.calls.map((c) => c[1])).toEqual(['hit', 'okay', 'miss', null]);
  });
});

describe('percentile', () => {
  it('interpolates between ranks', () => {
    const values = Array.from({ length: 101 }, (_, i) => i);
    expect(percentile(values, 0.1)).toBe(10);
    expect(percentile(values, 0.9)).toBe(90);
    expect(percentile([0, 10], 0.5)).toBe(5);
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('reportTake', () => {
  const three = reference([
    { onsetS: 0.5, offsetS: 1.5, midi: 60 },
    { onsetS: 1.5, offsetS: 2.5, midi: 64 },
    { onsetS: 4, offsetS: 5, midi: 67 },
  ]);

  it('reports nothing for an empty take or an empty melody', () => {
    expect(reportTake([], three).notesCovered).toBe(0);
    const none = reportTake(take([[0, 1, 60]], 1), reference([]));
    expect(none.notes).toEqual([]);
    expect(none.inTuneRate).toBeNull();
  });

  it('gives the in-tune rate over the notes sung, with hit, okay and miss counts', () => {
    // A exact, B 30 cents sharp, C 100 cents flat; all on time.
    const frames = take(
      [
        [0.5, 1.5, 60],
        [1.5, 2.5, 64.3],
        [4, 5, 66],
      ],
      6,
    );
    const report = reportTake(frames, three);
    expect(report.notesCovered).toBe(3);
    expect(report.notesSung).toBe(3);
    expect(report.inTuneRate).toBeCloseTo(2 / 3, 6);
    expect(report.frames).toEqual({ hit: 100, okay: 100, miss: 100 });
    expect(report.notes.map((n) => Math.round(n.meanCents ?? NaN))).toEqual([0, 30, -100]);
    expect(report.notes.map((n) => n.index)).toEqual([0, 1, 2]);
  });

  it('counts a note within 50 cents as in tune and one past it as not', () => {
    const ok = reportTake(take([[0.5, 1.5, 60.49]], 2), reference([{ onsetS: 0.5, offsetS: 1.5, midi: 60 }]));
    expect(ok.inTuneRate).toBe(1);
    const off = reportTake(take([[0.5, 1.5, 60.52]], 2), reference([{ onsetS: 0.5, offsetS: 1.5, midi: 60 }]));
    expect(off.inTuneRate).toBe(0);
  });

  it('leaves out notes the take does not span, and notes not sung', () => {
    // Sings only the first note; the take ends at 3 s, before the third.
    const frames = take([[0.5, 1.5, 60]], 3);
    const report = reportTake(frames, three);
    expect(report.notesCovered).toBe(2);
    expect(report.notesSung).toBe(1);
    expect(report.inTuneRate).toBe(1);
    expect(report.notes[1]).toMatchObject({ index: 1, frames: 0, meanCents: null, onsetDeltaS: null });
  });

  it('does not count a note sung for under 50 ms', () => {
    const frames = take([[0.5, 0.54, 60]], 3);
    const report = reportTake(frames, reference([{ onsetS: 0.5, offsetS: 1.5, midi: 60 }]));
    expect(report.notesSung).toBe(0);
    expect(report.inTuneRate).toBeNull();
  });

  it('measures the onset delta against the note actually sung, and the median as the bias', () => {
    // Every note comes in 80 ms late.
    const frames = take(
      [
        [0.58, 1.5, 60],
        [1.58, 2.5, 64],
        [4.08, 5, 67],
      ],
      6,
    );
    const report = reportTake(frames, three);
    for (const n of report.notes) expect(n.onsetDeltaS).toBeCloseTo(0.08, 6);
    expect(report.timingBiasS).toBeCloseTo(0.08, 6);
    // And early is negative.
    const early = reportTake(take([[0.4, 1.5, 60], [1.4, 2.5, 64], [3.9, 5, 67]], 6), three);
    expect(early.timingBiasS).toBeCloseTo(-0.1, 6);
  });

  it('takes the median onset delta, so one bad entry does not move it', () => {
    const frames = take(
      [
        [0.5, 1.5, 60],
        [1.5, 2.5, 64],
        [4.5, 5, 67],
      ],
      6,
    );
    expect(reportTake(frames, three).timingBiasS).toBeCloseTo(0, 6);
  });

  it('measures a scoop as the first 150 ms against the steady state', () => {
    const ref = reference([{ onsetS: 1, offsetS: 2, midi: 60 }]);
    // The first 150 ms sit 70 cents under the note, then it is held steady.
    const frames = take([[1, 1.15, 59.3], [1.15, 2, 60]], 3);
    const note = reportTake(frames, ref).notes[0];
    expect(note.scoopUpCents).toBeCloseTo(70, 4);
    const steady = reportTake(take([[1, 2, 60]], 3), ref).notes[0];
    expect(steady.scoopUpCents).toBeCloseTo(0, 6);
  });

  describe('a scoop entered by a step', () => {
    const ref = reference([{ onsetS: 1, offsetS: 2.5, midi: 60 }]);

    it('reads as one note entered from below: onset on time, scoop kept, held in full', () => {
      // 100 cents under for 150 ms, then on the note: the segmentation cuts
      // here, but the singer came in on time.
      const note = reportTake(take([[1, 1.15, 59], [1.15, 2.5, 60]], 3), ref).notes[0];
      expect(note.onsetDeltaS).toBeCloseTo(0, 6);
      expect(note.scoopUpCents).toBeCloseTo(100, 4);
      expect(note.heldRatio).toBeCloseTo(1, 6);
    });

    it('does the same for a 200 cent step', () => {
      const note = reportTake(take([[1, 1.15, 58], [1.15, 2.5, 60]], 3), ref).notes[0];
      expect(note.onsetDeltaS).toBeCloseTo(0, 6);
      expect(note.scoopUpCents).toBeCloseTo(200, 4);
    });

    it('still reads a genuinely late entry as late, with no scoop', () => {
      const note = reportTake(take([[1.15, 2.5, 60]], 3), ref).notes[0];
      expect(note.onsetDeltaS).toBeCloseTo(0.15, 6);
      expect(note.scoopUpCents).toBeCloseTo(0, 6);
    });

    it('does not merge a wrong note held for 300 ms before the right one', () => {
      const note = reportTake(take([[1, 1.3, 59], [1.3, 2.5, 60]], 3), ref).notes[0];
      expect(note.onsetDeltaS).toBeCloseTo(0.3, 6);
      expect(note.scoopUpCents).toBeCloseTo(0, 6);
    });

    it('does not join a short piece that is nowhere near a reference onset', () => {
      const mid = reference([{ onsetS: 1, offsetS: 4, midi: 60 }]);
      const note = reportTake(take([[1, 2.5, 60], [2.5, 2.65, 59], [2.65, 4, 60]], 5), mid).notes[0];
      // The first piece is the best match; the later steps are not folded in.
      expect(note.onsetDeltaS).toBeCloseTo(0, 6);
      expect(note.heldRatio).toBeCloseTo(0.5, 2);
    });
  });

  it('measures the spread of a long note past the scoop window', () => {
    const ref = reference([{ onsetS: 1, offsetS: 2.5, midi: 60 }]);
    // A 5 Hz wobble of plus or minus 60 cents: a spread of about 42 cents.
    const wobble = (t: number): number => 60 + 0.6 * Math.sin(2 * Math.PI * 5 * (t - 1));
    const wobbly = reportTake(take([[1, 2.5, wobble]], 3), ref).notes[0];
    expect(wobbly.stdCents).toBeGreaterThan(38);
    expect(wobbly.stdCents).toBeLessThan(46);
    const steady = reportTake(take([[1, 2.5, 60]], 3), ref).notes[0];
    expect(steady.stdCents).toBeCloseTo(0, 6);
    // A short note has no stability figure.
    const short = reportTake(take([[1, 1.3, 60]], 3), reference([{ onsetS: 1, offsetS: 1.3, midi: 60 }]));
    expect(short.notes[0].stdCents).toBeNull();
  });

  it('measures the held length against the reference note', () => {
    const ref = reference([{ onsetS: 1, offsetS: 2, midi: 60 }]);
    expect(reportTake(take([[1, 1.5, 60]], 3), ref).notes[0].heldRatio).toBeCloseTo(0.5, 6);
    expect(reportTake(take([[1, 2, 60]], 3), ref).notes[0].heldRatio).toBeCloseTo(1, 6);
  });

  it('does not score frames in an unpitched region', () => {
    const ref = reference([{ onsetS: 1, offsetS: 3, midi: 60 }], [[2, 2.5]]);
    const report = reportTake(take([[1, 3, 61]], 4), ref);
    // 100 cents sharp throughout, but half a second of it is not scored.
    expect(report.frames.miss).toBe(150);
  });

  it('judges a singer an octave up as in tune when octave invariant', () => {
    const ref = reference([{ onsetS: 1, offsetS: 2, midi: 60 }]);
    const frames = take([[1, 2, 72]], 3);
    expect(reportTake(frames, ref).inTuneRate).toBe(0);
    expect(reportTake(frames, ref, true).inTuneRate).toBe(1);
  });

  it('names the worst phrases, worst first, at most three, and skips those sung within a hit', () => {
    // Five one-note phrases (3 s apart) sung 10, 30, 70, 45 and 55 cents sharp.
    const errors = [10, 30, 70, 45, 55];
    const notes = errors.map((_, i) => ({ onsetS: 4 * i + 1, offsetS: 4 * i + 2, midi: 60 }));
    const frames = take(
      errors.map((c, i): [number, number, number] => [4 * i + 1, 4 * i + 2, 60 + c / 100]),
      20,
    );
    const report = reportTake(frames, reference(notes));
    expect(report.worstPhrases.map((p) => p.first)).toEqual([2, 4, 3]);
    expect(report.worstPhrases.map((p) => Math.round(p.meanAbsCents))).toEqual([70, 55, 45]);
    expect(report.worstPhrases[0]).toMatchObject({ startS: 9, endS: 10, missShare: 1 });
    expect(report.worstPhrases[2].missShare).toBe(0);
  });

  it('names no phrase when every one was sung within a hit', () => {
    const notes = [{ onsetS: 1, offsetS: 2, midi: 60 }];
    expect(reportTake(take([[1, 2, 60.2]], 3), reference(notes)).worstPhrases).toEqual([]);
  });

  it('gives the song range and the middle 80 percent of the singing', () => {
    const ref = buildScoreReference([{ onsetS: 0, offsetS: 1, midi: 60 }], [], { lowMidi: 52, highMidi: 71 });
    // 101 frames from MIDI 40 to 90 in half-tone steps.
    const frames: PitchFrame[] = Array.from({ length: 101 }, (_, i) => ({
      t: i * HOP,
      f0: midiToHz(40 + i * 0.5),
      clarity: 0.9,
      rms: 0.1,
    }));
    const report = reportTake(frames, ref);
    expect(report.songRange).toEqual({ lowMidi: 52, highMidi: 71, highAtS: 0 });
    expect(report.sungRange?.lowMidi).toBeCloseTo(45, 6);
    expect(report.sungRange?.highMidi).toBeCloseTo(85, 6);
    expect(reportTake(take([], 1).slice(0, 0), ref).sungRange).toBeNull();
  });

  it('is a plain object that survives structured cloning', () => {
    const report = reportTake(take([[0.5, 1.5, 60]], 3), three);
    expect(structuredClone(report)).toEqual(report);
  });
});
