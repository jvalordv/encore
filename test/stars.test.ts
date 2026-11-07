/**
 * Tests for stars and personal bests (src/analysis/stars.ts): each style's
 * primary measure, the star cut points, the best per song, and what counts as
 * beating the earlier best.
 */
import { describe, expect, it } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import { bestStars, personalBest, songStarsBySong, starMeasure, starsBySong, starsFor, takeStars } from '../src/analysis/stars';
import type { StarTake } from '../src/analysis/stars';

function report(over: Partial<TakeReport> = {}): TakeReport {
  return {
    notesCovered: 10,
    notesSung: 10,
    inTuneRate: 0.5,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 60, highMidi: 72, highAtS: 1 },
    sungRange: { lowMidi: 60, highMidi: 72 },
    ...over,
  };
}

const freestyle = (inKey: number, offKey: number) => ({
  inKey,
  offKey,
  unclear: 0,
  passing: 0,
  offNotes: [],
  keyStatus: 'clear' as const,
});

const take = (id: string, at: number, r: TakeReport | undefined, extra: Partial<StarTake> = {}): StarTake => ({
  id,
  songHash: 'h1',
  createdAt: at,
  report: r,
  ...extra,
});

describe('starsFor', () => {
  it('cuts at 60, 75 and 90 percent', () => {
    expect([0, 0.59, 0.6, 0.74, 0.75, 0.89, 0.9, 1].map(starsFor)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
});

describe('starMeasure', () => {
  it('uses the in-tune share for Strict with a melody, and treats an old report as Strict', () => {
    expect(starMeasure(report({ inTuneRate: 0.8 }))).toEqual({ id: 'inTune', value: 0.8 });
    expect(starMeasure(report({ style: 'strict', inTuneRate: 0.4 }))).toEqual({ id: 'inTune', value: 0.4 });
    expect(starMeasure(report({ inTuneRate: null }))).toBeNull();
  });

  it('uses the within-50-cents share when there is no melody', () => {
    const voice = { reference: 'chromatic', summary: { within50: 0.92 } } as TakeReport['voice'];
    expect(starMeasure(report({ noMelody: true, inTuneRate: null, voice }))).toEqual({ id: 'within50', value: 0.92 });
    expect(starMeasure(report({ noMelody: true, inTuneRate: null }))).toBeNull();
  });

  it('uses on-melody plus in-key for Open, and the key share alone with no melody', () => {
    const open = report({ style: 'open', melodyShare: 0.5, freestyle: freestyle(3, 1) });
    expect(starMeasure(open)?.id).toBe('keyFit');
    expect(starMeasure(open)?.value).toBeCloseTo(0.5 + 0.5 * 0.75, 10);
    const none = report({ style: 'open', noMelody: true, melodyShare: 0, freestyle: freestyle(9, 1) });
    expect(starMeasure(none)?.value).toBeCloseTo(0.9, 10);
    expect(starMeasure(report({ style: 'open', melodyShare: 0.7 }))?.value).toBe(0.7);
    expect(starMeasure(report({ style: 'open', melodyShare: null }))).toBeNull();
  });
});

describe('best stars per song', () => {
  const takes = [
    take('a', 1, report({ inTuneRate: 0.65 })),
    take('b', 2, report({ inTuneRate: 0.95 })),
    take('c', 3, report({ inTuneRate: 0.99 }), { kind: 'mic-check' }),
    take('d', 4, undefined),
    take('e', 5, report({ inTuneRate: 0.8 }), { songHash: 'h2' }),
  ];

  it('takes the best learning take and leaves out Mic check and karaoke takes', () => {
    expect(bestStars(takes, 'h1')).toBe(3);
    expect(bestStars(takes, 'h2')).toBe(2);
    expect(bestStars(takes, 'nope')).toBe(0);
    expect(starsBySong(takes)).toEqual({ h1: 3, h2: 2 });
    expect(takeStars(report({ inTuneRate: 0.3 }))).toBe(0);
  });
});

describe('personalBest', () => {
  it('names both numbers when a take tops the earlier best', () => {
    const all = [take('a', 1, report({ inTuneRate: 0.7 })), take('b', 2, report({ inTuneRate: 0.64 })), take('c', 3, report({ inTuneRate: 0.82 }))];
    expect(personalBest(all[2], all)).toEqual({ measure: 'inTune', nowPercent: 82, wasPercent: 70 });
  });

  it('is not a best when it only ties, falls short, or is the first take', () => {
    const all = [take('a', 1, report({ inTuneRate: 0.7 })), take('b', 2, report({ inTuneRate: 0.7 })), take('c', 3, report({ inTuneRate: 0.5 }))];
    expect(personalBest(all[1], all)).toBeNull();
    expect(personalBest(all[2], all)).toBeNull();
    expect(personalBest(all[0], all)).toBeNull();
  });

  it('compares only like with like: another measure, song or a Mic check take is not an earlier best', () => {
    const open = take('o', 1, report({ style: 'open', melodyShare: 0.95 }));
    const other = take('x', 1, report({ inTuneRate: 0.99 }), { songHash: 'h2' });
    const mic = take('m', 1, report({ inTuneRate: 0.99 }), { kind: 'mic-check' });
    const strict = take('s', 2, report({ inTuneRate: 0.6 }));
    expect(personalBest(strict, [open, other, mic, strict])).toBeNull();
    const earlier = take('e', 1, report({ inTuneRate: 0.5 }));
    expect(personalBest(strict, [open, other, mic, earlier, strict])?.wasPercent).toBe(50);
  });

  it('ignores takes saved later than the one asked about', () => {
    const a = take('a', 1, report({ inTuneRate: 0.6 }));
    const b = take('b', 2, report({ inTuneRate: 0.9 }));
    expect(personalBest(a, [a, b])).toBeNull();
  });
});

describe('song stars within the latest measure', () => {
  it('shows the Strict stars and measure after an Open 92 % take then a Strict 50 % take', () => {
    const open = report({ style: 'open', freestyle: freestyle(92, 8) });
    const strict = report({ inTuneRate: 0.5 });
    const takes = [take('a', 1, open), take('b', 2, strict)];
    expect(songStarsBySong(takes).h1).toEqual({ stars: 0, measure: 'inTune' });
    expect(bestStars(takes, 'h1')).toBe(0);
    expect(starsBySong(takes).h1).toBe(0);
  });
});
