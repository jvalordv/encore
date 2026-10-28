/**
 * Tests for the two scoring styles (src/analysis/score.ts, open-score.ts) on
 * synthetic takes whose answers are known: each style's windows, Open's
 * octave rule, which sung notes are on the melody and which are freestyle,
 * free phrases in Strict, the shares in the report, the live grade of a frame,
 * and that Strict with no free phrase measures exactly what W3 did.
 */
import { describe, expect, it } from 'vitest';
import { gradeFrameOpen, scoreTake, StyledScorer } from '../src/analysis/open-score';
import type { StyledScorerSource } from '../src/analysis/open-score';
import { midiToHz } from '../src/analysis/pitch';
import type { PitchFrame } from '../src/analysis/pitch';
import {
  buildScoreReference,
  gradeCents,
  reportTake,
  scoreFrame,
  SCORING_STYLES,
} from '../src/analysis/score';
import type { ScoreNote, ScoreReference } from '../src/analysis/score';
import type { KeyMap } from '../src/service/types';

const HOP = 0.01;

function reference(notes: ScoreNote[]): ScoreReference {
  const midis = notes.map((n) => n.midi);
  return buildScoreReference(notes, [], { lowMidi: Math.min(...midis), highMidi: Math.max(...midis) });
}

/** A take: a pitch per stretch (silence elsewhere) from 0 to `totalS`, one frame per 10 ms. */
function take(stretches: Array<[fromS: number, toS: number, midi: number]>, totalS: number): PitchFrame[] {
  const frames: PitchFrame[] = [];
  for (let i = 0; i * HOP < totalS - 1e-9; i++) {
    const t = Math.round(i * HOP * 1000) / 1000;
    const hit = stretches.find(([from, to]) => t >= from - 1e-9 && t < to - 1e-9);
    frames.push({ t, f0: hit ? midiToHz(hit[2]) : 0, clarity: 0.95, rms: 0.2 });
  }
  return frames;
}

/** C4 and E4 in one phrase (0.5 to 2.5 s), G4 in the next (4 to 5 s). */
const MELODY = reference([
  { onsetS: 0.5, offsetS: 1.5, midi: 60 },
  { onsetS: 1.5, offsetS: 2.5, midi: 64 },
  { onsetS: 4, offsetS: 5, midi: 67 },
]);

const C_MAJOR: KeyMap = {
  tuning_cents: 0,
  segments: [{ start_s: 0, end_s: 10, tonic: 0, mode: 'major', confidence: 0.9 }],
};
const UNCLEAR_KEY: KeyMap = {
  tuning_cents: 0,
  segments: [{ start_s: 0, end_s: 10, tonic: null, mode: null, confidence: 0.1 }],
};

const opts = (over: Partial<Parameters<typeof scoreTake>[2]> = {}): Parameters<typeof scoreTake>[2] => ({
  style: 'open',
  octaveInvariant: false,
  key: C_MAJOR,
  freeSpans: [],
  ...over,
});

describe('the two styles\' windows', () => {
  it('holds the numbers of the table in docs/COACHING.md', () => {
    expect(SCORING_STYLES.strict).toMatchObject({ hitCents: 25, okayCents: 50, onsetToleranceS: 0.15, timingTipS: 0.06 });
    expect(SCORING_STYLES.open).toMatchObject({ hitCents: 50, okayCents: 100, onsetToleranceS: 0.15, timingTipS: 0.12 });
  });

  it('grades 40 cents okay in Strict and a hit in Open', () => {
    expect(gradeCents(40, 'strict')).toBe('okay');
    expect(gradeCents(40, 'open')).toBe('hit');
  });

  it('grades 80 cents a miss in Strict and okay in Open, and 110 a miss in both', () => {
    expect(gradeCents(80, 'strict')).toBe('miss');
    expect(gradeCents(80, 'open')).toBe('okay');
    expect(gradeCents(-100, 'open')).toBe('okay');
    expect(gradeCents(110, 'open')).toBe('miss');
  });

  it('grades a frame an octave off a miss in Strict with the setting off, and a hit in Open', () => {
    const frame = { t: 1, f0: midiToHz(72) };
    expect(scoreFrame(frame, MELODY, false, 'strict')?.grade).toBe('miss');
    expect(scoreFrame(frame, MELODY, true, 'strict')?.grade).toBe('hit');
    expect(scoreFrame(frame, MELODY, false, 'open')?.grade).toBe('hit');
  });
});

describe('Strict with no free phrase', () => {
  const frames = take(
    [
      [0.5, 1.5, 60.2],
      [1.5, 2.5, 64.7],
      [4, 5, 67],
    ],
    5.4,
  );

  it('gives exactly the W3 report, with only the style named', () => {
    const w3 = reportTake(frames, MELODY, false);
    expect(scoreTake(frames, MELODY, opts({ style: 'strict' }))).toEqual({ ...w3, style: 'strict' });
    const folded = reportTake(frames, MELODY, true);
    expect(scoreTake(frames, MELODY, opts({ style: 'strict', octaveInvariant: true }))).toEqual({
      ...folded,
      style: 'strict',
    });
  });

  it('is not changed by a free span that covers no melody note, or by the key', () => {
    const w3 = { ...reportTake(frames, MELODY, false), style: 'strict' };
    expect(scoreTake(frames, MELODY, opts({ style: 'strict', freeSpans: [[7, 8]], key: null }))).toEqual(w3);
  });
});

describe('Open: which sung notes are on the melody', () => {
  // C4 an octave up (on the melody), G4 over E4 (in key, not the melody), a
  // C#4 in the rest between phrases (off key), then G4 on the melody.
  const frames = take(
    [
      [0.5, 1.5, 72],
      [1.5, 2.5, 67],
      [3, 3.5, 61],
      [4, 5, 67],
    ],
    5.4,
  );
  const report = scoreTake(frames, MELODY, opts());

  it('counts a melody note sung at another octave as on the melody, in tune', () => {
    expect(report.style).toBe('open');
    const first = report.notes.find((n) => n.index === 0);
    expect(first?.meanCents).toBeCloseTo(0, 6);
    expect(report.notesSung).toBe(2);
    expect(report.inTuneRate).toBe(1);
    expect(report.notes.find((n) => n.index === 1)?.meanCents).toBeNull();
  });

  it('calls an in-key ad-lib freestyle and in key, not a miss', () => {
    expect(report.freestyle?.inKey).toBe(1);
    expect(report.frames.miss).toBe(0);
  });

  it('calls a note in a gap off key when it is, with how far and where', () => {
    expect(report.freestyle?.offKey).toBe(1);
    const off = report.freestyle?.offNotes[0];
    expect(off?.midi).toBeCloseTo(61, 6);
    expect(off?.onsetS).toBeCloseTo(3, 2);
    expect(Math.abs(off?.centsOff ?? 0)).toBeCloseTo(100, 6);
  });

  it('reports the share of sung notes on the melody', () => {
    expect(report.melodyShare).toBeCloseTo(0.5, 6);
    expect(report.freestyle).toMatchObject({ unclear: 0, passing: 0, keyStatus: 'clear' });
    expect(report.noMelody).toBeUndefined();
  });

  it('matches a note within the okay window only: 120 cents off is freestyle', () => {
    const near = scoreTake(take([[4, 5, 67.9]], 5.4), MELODY, opts());
    expect(near.melodyShare).toBe(1);
    const far = scoreTake(take([[4, 5, 68.2]], 5.4), MELODY, opts());
    expect(far.melodyShare).toBe(0);
    expect(far.freestyle?.offKey).toBe(1);
  });

  it('does not match a note that only touches a melody note', () => {
    // Sung from 2.46 s, it overlaps E4 (ends 2.5) by 40 ms: under the 50 ms rule.
    const edge = scoreTake(take([[2.46, 3, 64]], 3.4), MELODY, opts());
    expect(edge.melodyShare).toBe(0);
    expect(edge.freestyle?.inKey).toBe(1);
  });

  it('counts a note under 150 ms off the melody as a passing tone, not judged', () => {
    const quick = scoreTake(take([[3, 3.1, 61]], 3.4), MELODY, opts());
    expect(quick.freestyle).toMatchObject({ passing: 1, inKey: 0, offKey: 0 });
    expect(quick.melodyShare).toBeNull();
  });

  it('uses the take\'s whole voice for shares, nothing for silence', () => {
    const silent = scoreTake(take([], 5), MELODY, opts());
    expect(silent.melodyShare).toBeNull();
    expect(silent.freestyle).toMatchObject({ inKey: 0, offKey: 0, unclear: 0, passing: 0 });
  });
});

describe('Open: no melody, an unclear key, no key', () => {
  const adLib = take(
    [
      [1, 1.5, 62],
      [2, 2.5, 61],
    ],
    3,
  );

  it('scores a song with no melody as all freestyle against the key', () => {
    const report = scoreTake(adLib, null, opts());
    expect(report.noMelody).toBe(true);
    expect(report.melodyShare).toBe(0);
    expect(report.freestyle).toMatchObject({ inKey: 1, offKey: 1, keyStatus: 'clear' });
    expect(report.notes).toEqual([]);
    expect(report.inTuneRate).toBeNull();
  });

  it('scores a melody with no notes the same way (a karaoke track\'s reference is skipped)', () => {
    const empty = buildScoreReference([], [], { lowMidi: 0, highMidi: 0 });
    expect(scoreTake(adLib, empty, opts()).noMelody).toBe(true);
  });

  it('judges on steadiness only where the key is unclear, and says so', () => {
    const report = scoreTake(adLib, null, opts({ key: UNCLEAR_KEY }));
    expect(report.freestyle).toMatchObject({ inKey: 0, offKey: 0, unclear: 2, keyStatus: 'unclear' });
  });

  it('does the same with no key at all', () => {
    const report = scoreTake(adLib, null, opts({ key: null }));
    expect(report.freestyle).toMatchObject({ unclear: 2, keyStatus: 'none' });
  });

  it('is partly unclear when the key is clear for only some of the notes', () => {
    const half: KeyMap = {
      tuning_cents: 0,
      segments: [
        { start_s: 0, end_s: 2, tonic: 0, mode: 'major', confidence: 0.9 },
        { start_s: 2, end_s: 10, tonic: null, mode: null, confidence: 0.1 },
      ],
    };
    const report = scoreTake(adLib, null, opts({ key: half }));
    expect(report.freestyle).toMatchObject({ inKey: 1, unclear: 1, keyStatus: 'partly_unclear' });
  });
});

describe('a free phrase in Strict', () => {
  // The first phrase is ad-libbed: C4 as written, then G4 over E4 and a C#4 in
  // the rest after it. The last note is sung 40 cents flat.
  const frames = take(
    [
      [0.5, 1.5, 60],
      [1.5, 2.5, 67],
      [3, 3.5, 61],
      [4, 5, 66.6],
    ],
    5.4,
  );
  const free: Array<[number, number]> = [[0.5, 2.5]];

  it('is scored as a miss without the mark', () => {
    const plain = scoreTake(frames, MELODY, opts({ style: 'strict' }));
    expect(plain.notes.find((n) => n.index === 1)?.meanCents).toBeCloseTo(300, 6);
    expect(plain.freestyle).toBeUndefined();
  });

  it('is left out of the melody\'s measures and judged against the key as in Open', () => {
    const report = scoreTake(frames, MELODY, opts({ style: 'strict', freeSpans: free }));
    expect(report.style).toBe('strict');
    expect(report.notes.map((n) => n.index)).toEqual([2]);
    expect(report.notes[0].meanCents).toBeCloseTo(-40, 4);
    expect(report.inTuneRate).toBe(1);
    // C4 matched the melody, so only the ad-lib counts as freestyle; the C#4
    // after the phrase is outside it and belongs to nobody in Strict.
    expect(report.freestyle).toMatchObject({ inKey: 1, offKey: 0, keyStatus: 'clear' });
    expect(report.freeSpans).toEqual(free);
    expect(report.melodyShare).toBeUndefined();
  });

  it('judges an off-key ad-lib in the phrase as off key', () => {
    const wrong = take([[1.5, 2.5, 66]], 3);
    const report = scoreTake(wrong, MELODY, opts({ style: 'strict', freeSpans: free }));
    expect(report.freestyle).toMatchObject({ inKey: 0, offKey: 1 });
  });
});

describe('the grade of one live frame', () => {
  const at = (t: number, midi: number): PitchFrame => ({ t, f0: midiToHz(midi), clarity: 0.95, rms: 0.2 });

  it('is hit or okay on the melody note under it, with Open\'s windows, at any octave', () => {
    expect(gradeFrameOpen(at(1, 60.4), MELODY, C_MAJOR)).toBe('hit');
    expect(gradeFrameOpen(at(1, 60.8), MELODY, C_MAJOR)).toBe('okay');
    expect(gradeFrameOpen(at(1, 72.4), MELODY, C_MAJOR)).toBe('hit');
    expect(gradeFrameOpen(at(1, 48.8), MELODY, C_MAJOR)).toBe('okay');
  });

  it('is free off the melody, in key or where the key is not clear', () => {
    expect(gradeFrameOpen(at(2, 67), MELODY, C_MAJOR)).toBe('free');
    expect(gradeFrameOpen(at(3.2, 62), MELODY, C_MAJOR)).toBe('free');
    expect(gradeFrameOpen(at(3.2, 61), MELODY, UNCLEAR_KEY)).toBe('free');
    expect(gradeFrameOpen(at(3.2, 61), MELODY, null)).toBe('free');
  });

  it('is a miss only where the key is clear and the pitch is over 50 cents from every tone', () => {
    expect(gradeFrameOpen(at(3.2, 61), MELODY, C_MAJOR)).toBe('miss');
    expect(gradeFrameOpen(at(3.2, 62.6), MELODY, C_MAJOR)).toBe('miss');
    expect(gradeFrameOpen(at(3.2, 62.4), MELODY, C_MAJOR)).toBe('free');
    // Over a melody note but not near it: the key decides.
    expect(gradeFrameOpen(at(2, 66), MELODY, C_MAJOR)).toBe('miss');
  });

  it('works with no melody at all, and gives an unvoiced frame nothing', () => {
    expect(gradeFrameOpen(at(1, 62), null, C_MAJOR)).toBe('free');
    expect(gradeFrameOpen(at(1, 61), null, C_MAJOR)).toBe('miss');
    expect(gradeFrameOpen({ t: 1, f0: 0, clarity: 0, rms: 0 }, MELODY, C_MAJOR)).toBeNull();
  });
});

describe('the live scorer', () => {
  function scorer(over: Partial<StyledScorerSource>) {
    return new StyledScorer({
      scoring: () => true,
      reference: () => MELODY,
      style: () => 'strict',
      octaveInvariant: () => false,
      key: () => C_MAJOR,
      freeSpans: () => [],
      ...over,
    });
  }
  const at = (t: number, midi: number): PitchFrame => ({ t, f0: midiToHz(midi), clarity: 0.95, rms: 0.2 });

  it('grades Strict as W3 did, and nothing outside a note', () => {
    const strict = scorer({});
    expect(strict.grade(at(1, 60.2))).toBe('hit');
    expect(strict.grade(at(1, 60.4))).toBe('okay');
    expect(strict.grade(at(1, 72))).toBe('miss');
    expect(strict.grade(at(3.2, 62))).toBeNull();
  });

  it('grades Open with its windows and free frames', () => {
    const open = scorer({ style: () => 'open' });
    expect(open.grade(at(1, 72.4))).toBe('hit');
    expect(open.grade(at(3.2, 62))).toBe('free');
    expect(open.grade(at(3.2, 61))).toBe('miss');
  });

  it('grades Strict inside a free phrase as Open, and the rest as Strict', () => {
    const strict = scorer({ freeSpans: () => [[0.5, 2.5]] });
    expect(strict.grade(at(1, 72.4))).toBe('hit');
    expect(strict.grade(at(2, 67))).toBe('free');
    expect(strict.grade(at(4.5, 67.3))).toBe('okay');
  });

  it('grades nothing when nothing is scored, and Open without a melody as freestyle', () => {
    expect(scorer({ scoring: () => false }).grade(at(1, 60))).toBeNull();
    expect(scorer({ reference: () => null }).grade(at(1, 60))).toBeNull();
    expect(scorer({ reference: () => null, style: () => 'open' }).grade(at(1, 62))).toBe('free');
  });

  it('hands each frame on the bus to the sink with its grade', () => {
    let listener: ((m: { frame: PitchFrame }) => void) | null = null;
    const bus = {
      subscribe(cb: (m: { frame: PitchFrame }) => void) {
        listener = cb;
        return () => undefined;
      },
    };
    const seen: Array<string | null> = [];
    scorer({}).attach(bus, (_m, grade) => seen.push(grade));
    (listener as unknown as (m: { frame: PitchFrame }) => void)({ frame: at(1, 60) });
    (listener as unknown as (m: { frame: PitchFrame }) => void)({ frame: at(3.2, 60) });
    expect(seen).toEqual(['hit', null]);
  });
});
