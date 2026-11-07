/**
 * Tests for the tips that read the voice section (src/coach/tips.ts): `drift`,
 * `vibrato_wide`, `vibrato_irregular` and `short_phrases` fire only strictly
 * past their thresholds, each names its number, and with no melody the bias,
 * scoop and wobble rules read the voice notes instead; with a melody they keep
 * reading the melody's notes, so a take is never told the same thing twice.
 * Reports are built by hand so each number is the one under test.
 */
import { describe, expect, it } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import type { VoiceNote, VoiceReport, VoiceSummary } from '../src/analysis/voice';
import { TIP_THRESHOLDS, tipsFor } from '../src/coach/tips';

function vnote(index: number, fields: Partial<VoiceNote> = {}): VoiceNote {
  return {
    onsetS: index * 2,
    offsetS: index * 2 + 1.5,
    midi: 60,
    centsOff: 0,
    stdCents: null,
    scoopCents: null,
    driftCps: null,
    vibrato: null,
    ...fields,
  };
}

const SUMMARY: VoiceSummary = {
  judged: 10,
  biasCents: 0,
  within25: 1,
  within50: 1,
  held: 0,
  stabilityCents: null,
  scoopCents: null,
  driftNotes: 0,
  driftCps: null,
  vibratoNotes: 0,
  vibratoOf: 0,
  vibratoRateHz: null,
  vibratoExtentCents: null,
  vibratoRegularity: null,
  range: { lowMidi: 55, highMidi: 67 },
  phraseCount: 1,
  phraseMedianS: 5,
  phraseLongestS: 5,
  breathMedianS: null,
};

function voice(notes: VoiceNote[], summary: Partial<VoiceSummary> = {}, extra: Partial<VoiceReport> = {}): VoiceReport {
  return {
    reference: 'estimated_key',
    keyName: 'C major',
    keyConfidence: 0.9,
    notes,
    phrases: [[0, 5]],
    summary: { ...SUMMARY, ...summary },
    ...extra,
  };
}

/** A report for a song with no melody, carrying only a voice section. */
function alone(v: VoiceReport, melody = false): TakeReport {
  return {
    notesCovered: 0,
    notesSung: 0,
    inTuneRate: null,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 0, highMidi: 0, highAtS: 0 },
    sungRange: null,
    style: 'strict',
    ...(melody ? {} : { noMelody: true }),
    voice: v,
  };
}

const ids = (r: TakeReport): string[] => tipsFor(r).map((t) => t.id);
const many = (count: number, bad: number, fields: Partial<VoiceNote>, good: Partial<VoiceNote> = {}): VoiceNote[] =>
  Array.from({ length: count }, (_, i) => vnote(i, i < bad ? fields : good));

describe('drift', () => {
  const drifting = (rate: number) => ({ driftCps: rate });
  /** `count` long notes, the first `bad` drifting at `rate` and the rest steady. */
  const slopes = (count: number, bad: number, rate: number): VoiceNote[] =>
    many(count, bad, drifting(rate), drifting(0));

  it('fires on more than 40 percent of long notes past 20 c/s, either way, and not at the numbers', () => {
    expect(ids(alone(voice(slopes(10, 4, -30))))).toEqual([]);
    expect(ids(alone(voice(slopes(10, 5, -30))))).toEqual(['drift']);
    expect(ids(alone(voice(many(10, 10, drifting(20)))))).toEqual([]);
    expect(ids(alone(voice(many(10, 10, drifting(20.5)))))).toEqual(['drift']);
    expect(ids(alone(voice(many(10, 10, drifting(-20.5)))))).toEqual(['drift']);
  });

  it('names the count, the worst note and its slope, and jumps to it', () => {
    const notes = slopes(10, 5, -30);
    notes[2] = vnote(2, { driftCps: 55, midi: 64 });
    const tip = tipsFor(alone(voice(notes))).find((t) => t.id === 'drift');
    expect(tip?.evidence).toBe(
      '5 of 10 notes over 600 ms drifted more than 20 c a second; the worst was E4 at 0:04, 55 c/s sharp.',
    );
    expect(tip?.jumpToS).toBe(4);
  });

  it('does not trust two notes, and fires with a melody too', () => {
    expect(ids(alone(voice(many(2, 2, drifting(60)))))).toEqual([]);
    expect(ids(alone(voice(many(10, 10, drifting(60))), true))).toEqual(['drift']);
  });
});

describe('vibrato_wide and vibrato_irregular', () => {
  const vib = (extentCents: number, regularity: number) => ({ vibrato: { rateHz: 6, extentCents, regularity } });

  it('calls a vibrato wide past 80 c either side, not at it, on the median of three or more', () => {
    expect(ids(alone(voice(many(5, 5, vib(80, 0.9)))))).toEqual([]);
    expect(ids(alone(voice(many(5, 5, vib(81, 0.9)))))).toEqual(['vibrato_wide']);
    expect(ids(alone(voice(many(2, 2, vib(120, 0.9)))))).toEqual([]);
    // A median under the line is not wide though one note is.
    const notes = [vnote(0, vib(150, 0.9)), vnote(1, vib(50, 0.9)), vnote(2, vib(50, 0.9))];
    expect(ids(alone(voice(notes)))).toEqual([]);
  });

  it('calls a vibrato irregular under 70 percent regular, not at it', () => {
    expect(ids(alone(voice(many(5, 5, vib(50, 0.7)))))).toEqual([]);
    expect(ids(alone(voice(many(5, 5, vib(50, 0.69)))))).toEqual(['vibrato_irregular']);
  });

  it('names the number', () => {
    const wide = tipsFor(alone(voice(many(5, 5, vib(100, 0.9)))))[0];
    expect(wide.evidence).toBe('Your vibrato on 5 notes swung a median of 100 c either side; the widest was C4 at 0:00, 100 c.');
    const odd = tipsFor(alone(voice(many(5, 5, vib(50, 0.5)))))[0];
    expect(odd.evidence).toContain('a median 50% regular (a steady swing is over 70%)');
  });
});

describe('short_phrases', () => {
  const phrased = (count: number, medianS: number): VoiceReport =>
    voice([vnote(0)], { phraseCount: count, phraseMedianS: medianS }, {
      phrases: Array.from({ length: count }, (_, i): [number, number] => [i * 3, i * 3 + medianS]),
    });

  it('fires under a 1.5 s median over at least four phrases, and not at it', () => {
    expect(ids(alone(phrased(5, 1.5)))).toEqual([]);
    expect(ids(alone(phrased(5, 1.4)))).toEqual(['short_phrases']);
    expect(ids(alone(phrased(3, 0.8)))).toEqual([]);
  });

  it('names the count, the median and the shortest phrase', () => {
    const v = phrased(5, 1.2);
    v.phrases[3] = [9, 9.6];
    const tip = tipsFor(alone(v))[0];
    expect(tip.evidence).toBe('Your 5 phrases ran a median of 1.2 s between breaths; the shortest was at 0:09, 0.6 s.');
    expect(tip.jumpToS).toBe(9);
  });
});

describe('the melody rules reading the voice with no melody', () => {
  it('fires flat_bias, sharp_bias, scoop and unstable_sustain from the voice notes, naming the key', () => {
    expect(ids(alone(voice(many(10, 5, { centsOff: -30 }))))).toEqual(['flat_bias']);
    expect(ids(alone(voice(many(10, 4, { centsOff: -30 }))))).toEqual([]);
    expect(ids(alone(voice(many(10, 10, { centsOff: 30 }))))).toEqual(['sharp_bias']);
    expect(ids(alone(voice(many(10, 10, { scoopCents: 70 }))))).toEqual(['scoop']);
    expect(ids(alone(voice(many(10, 10, { scoopCents: 60 }))))).toEqual([]);
    expect(ids(alone(voice(many(10, 4, { stdCents: 40 }, { stdCents: 5 }))))).toEqual(['unstable_sustain']);
    expect(ids(alone(voice(many(10, 3, { stdCents: 40 }, { stdCents: 5 }))))).toEqual([]);
    const flat = tipsFor(alone(voice(many(10, 6, { centsOff: -30 }))))[0];
    expect(flat.evidence).toBe(
      '6 of 10 notes sat more than 20 c under the nearest note of C major; the worst was C4 at 0:00, 30 c under.',
    );
    const chroma = tipsFor(alone(voice(many(10, 6, { centsOff: -30 }), {}, { reference: 'chromatic', keyName: null })))[0];
    expect(chroma.evidence).toContain('under the nearest semitone');
  });

  it('leaves the voice bias rules to the melody when there is a melody', () => {
    expect(ids(alone(voice(many(10, 10, { centsOff: -30 })), true))).toEqual([]);
  });

  it('keeps every new threshold in the one table', () => {
    for (const key of ['driftCps', 'driftShare', 'vibratoWideCents', 'vibratoRegularity', 'minVibratoNotes', 'phraseS', 'minPhrases']) {
      expect(TIP_THRESHOLDS, key).toHaveProperty(key);
    }
  });
});
