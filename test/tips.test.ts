/**
 * Tests for the learning-mode tips (src/coach/tips.ts): every rule fires just
 * past its threshold and stays quiet just under it, at most three tips come
 * back with the strongest first, and each carries its evidence and a place to
 * jump to. Reports are built by hand so each number is the one under test.
 */
import { describe, expect, it } from 'vitest';
import type { NoteResult, TakeReport } from '../src/analysis/score';
import { MAX_TIPS, TIP_MESSAGES, TIP_THRESHOLDS, tipsFor } from '../src/coach/tips';
import { studio } from '../src/skins/studio';

/** A sung 1.5 s note at C4 that was perfect, onset at `index` seconds. */
function note(index: number, fields: Partial<NoteResult> = {}): NoteResult {
  return {
    index,
    onsetS: index,
    offsetS: index + 1.5,
    midi: 60,
    frames: 150,
    meanCents: 0,
    stdCents: null,
    scoopUpCents: null,
    onsetDeltaS: null,
    heldRatio: null,
    ...fields,
  };
}

function report(notes: NoteResult[], fields: Partial<TakeReport> = {}): TakeReport {
  return {
    notesCovered: notes.length,
    notesSung: notes.filter((n) => n.meanCents !== null).length,
    inTuneRate: 1,
    frames: { hit: 1, okay: 0, miss: 0 },
    timingBiasS: null,
    notes,
    worstPhrases: [],
    songRange: { lowMidi: 55, highMidi: 67, highAtS: 8 },
    sungRange: { lowMidi: 55, highMidi: 67 },
    ...fields,
  };
}

/** `count` notes of which the first `bad` carry `fields`. */
function mixed(count: number, bad: number, fields: Partial<NoteResult>): NoteResult[] {
  return Array.from({ length: count }, (_, i) => note(i, i < bad ? fields : {}));
}

const ids = (r: TakeReport): string[] => tipsFor(r).map((t) => t.id);

describe('flat_bias and sharp_bias', () => {
  it('fire on more than 40 percent of notes past 20 cents, and not at 40 percent', () => {
    expect(ids(report(mixed(10, 4, { meanCents: -30 })))).toEqual([]);
    expect(ids(report(mixed(10, 5, { meanCents: -30 })))).toEqual(['flat_bias']);
    expect(ids(report(mixed(10, 4, { meanCents: 30 })))).toEqual([]);
    expect(ids(report(mixed(10, 5, { meanCents: 30 })))).toEqual(['sharp_bias']);
  });

  it('count a note only past 20 cents', () => {
    expect(ids(report(mixed(10, 10, { meanCents: -20 })))).toEqual([]);
    expect(ids(report(mixed(10, 10, { meanCents: -20.5 })))).toEqual(['flat_bias']);
    expect(ids(report(mixed(10, 10, { meanCents: 20 })))).toEqual([]);
    expect(ids(report(mixed(10, 10, { meanCents: 20.5 })))).toEqual(['sharp_bias']);
  });

  it('say which note was worst, how far, and jump to it', () => {
    const notes = mixed(10, 6, { meanCents: -30 });
    notes[3] = note(3, { meanCents: -75, midi: 64 });
    const [tip] = tipsFor(report(notes));
    expect(tip.evidence).toBe('6 of 10 notes sat more than 20 c under the melody; the worst was E4 at 0:03, 75 c under.');
    expect(tip.jumpToS).toBe(3);
    expect(tip.message).toBe(TIP_MESSAGES.flat_bias);
  });

  it('do not trust a handful of notes, nor notes that were not sung', () => {
    expect(ids(report(mixed(3, 3, { meanCents: -40 })))).toEqual([]);
    expect(ids(report(mixed(10, 10, { meanCents: null })))).toEqual([]);
  });
});

describe('scoop', () => {
  it('fires on a median slide over 60 cents, not at 60', () => {
    expect(ids(report(mixed(5, 5, { scoopUpCents: 60 })))).toEqual([]);
    expect(ids(report(mixed(5, 5, { scoopUpCents: 61 })))).toEqual(['scoop']);
  });

  it('uses the median, so a few big slides do not make it fire', () => {
    expect(ids(report(mixed(7, 3, { scoopUpCents: 300 })))).toEqual([]);
    expect(ids(report(mixed(7, 4, { scoopUpCents: 300 })))).toEqual(['scoop']);
  });

  it('names the biggest slide', () => {
    const notes = mixed(5, 5, { scoopUpCents: 70 });
    notes[2] = note(2, { scoopUpCents: 140 });
    const [tip] = tipsFor(report(notes));
    expect(tip.evidence).toContain('a median of 70 c');
    expect(tip.evidence).toContain('C4 at 0:02, 140 c');
    expect(tip.jumpToS).toBe(2);
  });

  it('needs a few measured notes', () => {
    expect(ids(report(mixed(3, 3, { scoopUpCents: 200 })))).toEqual([]);
  });
});

describe('unstable_sustain', () => {
  it('fires when more than 30 percent of long notes wander past 35 cents', () => {
    expect(ids(report(mixed(10, 3, { stdCents: 40 }).map((n) => ({ ...n, stdCents: n.stdCents ?? 5 }))))).toEqual([]);
    expect(ids(report(mixed(10, 4, { stdCents: 40 }).map((n) => ({ ...n, stdCents: n.stdCents ?? 5 }))))).toEqual([
      'unstable_sustain',
    ]);
  });

  it('counts a note only past 35 cents', () => {
    const all = (std: number) => report(mixed(5, 5, { stdCents: std }));
    expect(ids(all(35))).toEqual([]);
    expect(ids(all(35.5))).toEqual(['unstable_sustain']);
  });

  it('names the worst note', () => {
    const notes = mixed(5, 5, { stdCents: 40 });
    notes[1] = note(1, { stdCents: 62 });
    const [tip] = tipsFor(report(notes));
    expect(tip.evidence).toBe('5 of 5 long notes wandered more than 35 c; the worst was C4 at 0:01, spread 62 c.');
    expect(tip.jumpToS).toBe(1);
  });

  it('needs three long notes', () => {
    expect(ids(report(mixed(2, 2, { stdCents: 90 })))).toEqual([]);
    expect(ids(report(mixed(3, 3, { stdCents: 90 })))).toEqual(['unstable_sustain']);
  });
});

describe('late_onsets and early_onsets', () => {
  const timed = (bias: number) => report(mixed(6, 6, { onsetDeltaS: bias }), { timingBiasS: bias });

  it('fire when the median onset is more than 60 ms off, and not at 60', () => {
    expect(ids(timed(0.06))).toEqual([]);
    expect(ids(timed(0.061))).toEqual(['late_onsets']);
    expect(ids(timed(-0.06))).toEqual([]);
    expect(ids(timed(-0.061))).toEqual(['early_onsets']);
  });

  it('say how late and which entry was worst', () => {
    const notes = mixed(6, 6, { onsetDeltaS: 0.09 });
    notes[4] = note(4, { onsetDeltaS: 0.31 });
    const [tip] = tipsFor(report(notes, { timingBiasS: 0.09 }));
    expect(tip.evidence).toBe(
      'Your entries came a median of 90 ms late over 6 notes; the worst was C4 at 0:04, 310 ms late.',
    );
    expect(tip.jumpToS).toBe(4);
  });

  it('say early the same way', () => {
    const [tip] = tipsFor(timed(-0.1));
    expect(tip.evidence).toContain('a median of 100 ms early');
    expect(tip.message).toBe(TIP_MESSAGES.early_onsets);
  });

  it('need a few timed notes', () => {
    expect(ids(report(mixed(3, 3, { onsetDeltaS: 0.2 }), { timingBiasS: 0.2 }))).toEqual([]);
  });
});

describe('out_of_range', () => {
  const ranged = (songHigh: number, sungHigh: number) =>
    report(mixed(5, 0, {}), {
      songRange: { lowMidi: 55, highMidi: songHigh, highAtS: 42 },
      sungRange: { lowMidi: 55, highMidi: sungHigh },
    });

  it('fires when the song tops the singer\'s p90 by more than 2 semitones', () => {
    expect(ids(ranged(71, 69))).toEqual([]);
    expect(ids(ranged(71, 68.9))).toEqual(['out_of_range']);
  });

  it('says where the song gets high and jumps there', () => {
    const [tip] = tipsFor(ranged(71, 66));
    expect(tip.evidence).toBe(
      'The song reaches B4; the top of your voice in this take was about F#4, 5.0 semitones lower.',
    );
    expect(tip.jumpToS).toBe(42);
  });

  it('has nothing to say when nothing was sung', () => {
    expect(ids(report(mixed(5, 0, {}), { sungRange: null, songRange: { lowMidi: 55, highMidi: 80, highAtS: 1 } }))).toEqual([]);
  });
});

describe('held_shorter', () => {
  const held = (short: number, ratio: number) =>
    report(mixed(10, short, { heldRatio: ratio }).map((n) => ({ ...n, heldRatio: n.heldRatio ?? 1 })));

  it('fires when more than 30 percent of long notes are held under 70 percent', () => {
    expect(ids(held(3, 0.5))).toEqual([]);
    expect(ids(held(4, 0.5))).toEqual(['held_shorter']);
  });

  it('counts a note only under 70 percent', () => {
    expect(ids(held(10, 0.7))).toEqual([]);
    expect(ids(held(10, 0.69))).toEqual(['held_shorter']);
  });

  it('ignores short notes', () => {
    const brief = mixed(10, 10, { heldRatio: 0.2 }).map((n) => ({ ...n, offsetS: n.onsetS + 0.3 }));
    expect(ids(report(brief))).toEqual([]);
  });

  it('names the shortest note', () => {
    const notes = mixed(10, 10, { heldRatio: 0.6 });
    notes[7] = note(7, { heldRatio: 0.25 });
    const [tip] = tipsFor(report(notes));
    expect(tip.evidence).toBe(
      '10 of 10 long notes were held under 70% of the original\'s length; the shortest was C4 at 0:07, held 25% of it.',
    );
    expect(tip.jumpToS).toBe(7);
  });
});

describe('the tips of a take', () => {
  /** A take that earns every rule, the scoop by far the strongest. */
  const everything = (): TakeReport =>
    report(
      Array.from({ length: 10 }, (_, i) =>
        note(i, { meanCents: -30, scoopUpCents: 300, stdCents: 50, onsetDeltaS: 0.1, heldRatio: 0.5 }),
      ),
      { timingBiasS: 0.1, songRange: { lowMidi: 55, highMidi: 75, highAtS: 5 }, sungRange: { lowMidi: 55, highMidi: 71 } },
    );

  it('returns at most three, strongest first', () => {
    const tips = tipsFor(everything());
    expect(tips).toHaveLength(MAX_TIPS);
    expect(tips.map((t) => t.strength)).toEqual([...tips.map((t) => t.strength)].sort((a, b) => b - a));
    // Wobble and held length tie at 3.3 times their threshold; the table's
    // order breaks the tie.
    expect(tips.map((t) => t.id)).toEqual(['scoop', 'unstable_sustain', 'held_shorter']);
  });

  it('keeps the table order among equal strengths and returns none for a clean take', () => {
    expect(tipsFor(report(mixed(10, 0, {})))).toEqual([]);
    const both = report(mixed(10, 10, { meanCents: 30 }).map((n, i) => ({ ...n, onsetDeltaS: 0 * i })));
    expect(tipsFor(both).map((t) => t.id)).toEqual(['sharp_bias']);
  });

  it('keeps every threshold in the one table', () => {
    expect(Object.keys(TIP_THRESHOLDS).sort()).toEqual(
      [
        'biasShare',
        'flatCents',
        'heldRatio',
        'heldShare',
        'minLongNotes',
        'minNotes',
        'onsetS',
        'rangeSemitones',
        'scoopCents',
        'sharpCents',
        'wobbleCents',
        'wobbleShare',
      ].sort(),
    );
  });

  it('words each tip as the Studio skin does, so the two cannot drift', () => {
    for (const [id, message] of Object.entries(TIP_MESSAGES)) {
      expect(message).toBe(studio.copy[id as keyof typeof studio.copy]);
    }
  });
});
