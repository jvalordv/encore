/**
 * Tests for the progress aggregation (src/analysis/progress.ts) on synthetic
 * takes with known answers: best, latest, the first-week baseline and the
 * change since it, the Theil-Sen trend, takes missing fields, the styles kept
 * apart, Mic check takes left out, and the first week counted in local days.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSeries,
  localDayNumber,
  pointsFor,
  songsOf,
  takePoint,
  takePoints,
  theilSenPerWeek,
  trendOf,
} from '../src/analysis/progress';
import type { ProgressTake } from '../src/analysis/progress';
import type { TakeReport } from '../src/analysis/score';
import type { VoiceReference } from '../src/analysis/voice';

const DAY = 86_400_000;
/** Local time on day `d` of November 2026, so no zone or clock change shifts it. */
const day = (d: number, hour = 12, minute = 0): number => new Date(2026, 10, d, hour, minute, 0).getTime();

function report(
  over: Partial<TakeReport> & { within25?: number; bias?: number; reference?: VoiceReference } = {},
): TakeReport {
  const { within25, bias, reference, ...rest } = over;
  const base = {
    notesCovered: 4,
    notesSung: 4,
    inTuneRate: 0.5,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 60, highMidi: 72, highAtS: 1 },
    sungRange: { lowMidi: 60, highMidi: 72 },
    ...rest,
  } as TakeReport;
  if (within25 !== undefined || bias !== undefined) {
    base.voice = {
      reference: reference ?? 'chromatic',
      summary: { within25: within25 ?? null, biasCents: bias ?? null, range: { lowMidi: 57, highMidi: 69 } },
    } as TakeReport['voice'];
  }
  return base;
}

function take(id: string, at: number, r?: TakeReport, extra: Partial<ProgressTake> = {}): ProgressTake {
  return { id, songHash: 'h1', songName: 'Song', createdAt: at, report: r, ...extra };
}

describe('takePoints', () => {
  it('leaves out Mic check takes and takes with no report, and sorts oldest first', () => {
    const points = takePoints([
      take('b', day(3), report()),
      take('mic', day(2), report(), { kind: 'mic-check' }),
      take('none', day(2)),
      take('a', day(1), report()),
    ]);
    expect(points.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('reads an old take with no voice section as nulls, not guesses', () => {
    const p = takePoint(take('old', day(1), report({ inTuneRate: 0.7 })));
    expect(p?.values.inTune).toBe(0.7);
    expect(p?.values.within25).toBeNull();
    expect(p?.values.bias).toBeNull();
    // The range falls back to the melody report's own sung range.
    expect(p?.values.rangeWidth).toBe(12);
  });

  it('names the style: strict by default, open, or no melody', () => {
    expect(takePoint(take('s', 1, report()))?.style).toBe('strict');
    expect(takePoint(take('o', 1, report({ style: 'open', melodyShare: 0.8 })))?.style).toBe('open');
    expect(takePoint(take('n', 1, report({ style: 'open', noMelody: true })))?.style).toBe('none');
    expect(takePoint(take('n', 1, report({ noMelody: true, inTuneRate: null })))?.values.inTune).toBeNull();
  });
});

describe('buildSeries', () => {
  const rates = [0.4, 0.5, 0.6, 0.9];
  const days = [1, 3, 5, 12];
  const points = takePoints(days.map((d, i) => take(`t${i}`, day(d), report({ inTuneRate: rates[i] }))));

  it('finds best, latest, the first-week baseline and the change since it', () => {
    const s = buildSeries(points, 'inTune', 'strict', 'high', 0.02);
    expect(s?.best).toBe(0.9);
    expect(s?.latest).toBe(0.9);
    // Days 1, 3 and 5 are the first week (day 1 plus six); the median is 0.5.
    expect(s?.baseline).toBeCloseTo(0.5, 10);
    expect(s?.change).toBeCloseTo(0.4, 10);
  });

  it('has no change while the latest take is itself in the first week', () => {
    const s = buildSeries(points.slice(0, 3), 'inTune', 'strict', 'high', 0.02);
    expect(s?.baseline).toBeCloseTo(0.5, 10);
    expect(s?.change).toBeNull();
  });

  it('picks the best by target: lowest, highest, nearest zero, or none', () => {
    const p = takePoints([5, -2, 9].map((b, i) => take(`b${i}`, day(1 + i), report({ bias: b }))));
    expect(buildSeries(p, 'bias', null, 'zero', 2)?.best).toBe(-2);
    expect(buildSeries(p, 'bias', null, 'low', 2)?.best).toBe(-2);
    expect(buildSeries(p, 'bias', null, 'high', 2)?.best).toBe(9);
    expect(buildSeries(p, 'bias', null, 'none', 2)?.best).toBeNull();
  });

  it('keeps Strict and Open in-tune shares in separate series', () => {
    const mixed = takePoints([
      take('s1', day(1), report({ inTuneRate: 0.9 })),
      take('o1', day(2), report({ style: 'open', melodyShare: 0.3 })),
      take('s2', day(3), report({ inTuneRate: 0.8 })),
    ]);
    const strict = buildSeries(mixed, 'inTune', 'strict', 'high', 0.02);
    const open = buildSeries(mixed, 'inTune', 'open', 'high', 0.02);
    expect(strict?.points.map((p) => p.value)).toEqual([0.9, 0.8]);
    expect(open?.points.map((p) => p.value)).toEqual([0.3]);
  });

  it('skips takes without the measure, and is null when none have it', () => {
    const p = takePoints([take('a', day(1), report()), take('b', day(2), report({ within25: 0.6 }))]);
    expect(buildSeries(p, 'within25', null, 'high', 0.02)?.points).toHaveLength(1);
    expect(buildSeries(p, 'drift', null, 'zero', 2)).toBeNull();
    expect(buildSeries([], 'inTune', null, 'high', 0.02)).toBeNull();
  });

  it('counts the first week in local calendar days, across midnight', () => {
    // The first take is at 23:50 on day 1. A take at 00:10 on day 8 is only
    // 6 days 0 h 20 m later, yet it is the eighth calendar day: outside.
    const edge = takePoints([
      take('a', day(1, 23, 50), report({ inTuneRate: 0.2 })),
      take('b', day(7, 23, 59), report({ inTuneRate: 0.4 })),
      take('c', day(8, 0, 10), report({ inTuneRate: 0.9 })),
    ]);
    const s = buildSeries(edge, 'inTune', 'strict', 'high', 0.02);
    expect(localDayNumber(edge[2].at) - localDayNumber(edge[0].at)).toBe(7);
    expect(s?.baseline).toBeCloseTo(0.3, 10);
    expect(s?.change).toBeCloseTo(0.6, 10);
  });
});

describe('trends', () => {
  const line = (values: number[], gapDays: number) =>
    values.map((value, i) => ({ id: `p${i}`, at: day(1) + i * gapDays * DAY, value }));

  it('is the exact slope per week for a straight line', () => {
    expect(theilSenPerWeek(line([0, 1, 2, 3], 1))).toBeCloseTo(7, 10);
    expect(trendOf(line([0, 1, 2, 3], 1), 0.5)).toMatchObject({ kind: 'up', points: 4 });
    expect(trendOf(line([3, 2, 1, 0], 1), 0.5).kind).toBe('down');
  });

  it('is not bent by one stray take', () => {
    const slope = theilSenPerWeek(line([0, 1, 2, 3, 100, 5, 6, 7, 8], 1));
    expect(slope).toBeGreaterThan(6);
    expect(slope).toBeLessThan(8);
  });

  it('reads flat under the threshold, and says not enough under 3 points', () => {
    expect(trendOf(line([5, 5.01, 5, 5.01], 3), 0.5).kind).toBe('flat');
    expect(trendOf(line([1, 2], 3), 0.5)).toEqual({ kind: 'not-enough', slopePerWeek: null, points: 2 });
  });

  it('calls takes on fewer than three days too short for a weekly slope', () => {
    expect(trendOf(line([1, 2, 3], 0.1), 0.5)).toMatchObject({ kind: 'short', slopePerWeek: null });
    expect(trendOf(line([1, 2, 3, 4], 1 / 3), 0.5)).toMatchObject({ kind: 'short', slopePerWeek: null });
  });

  it('counts a session of close takes as one day, so it makes no wild slope', () => {
    // Five takes within minutes one evening, then one a week later.
    const evening = [10, 20, 30, 40, 50].map((value, i) => ({ id: `e${i}`, at: day(1, 20, i * 3), value }));
    const later = { id: 'l', at: day(8, 20), value: 52 };
    expect(trendOf([...evening, later], 0.5)).toMatchObject({ kind: 'short', slopePerWeek: null });
    // With a third day, the evening is its median (30) and the slope is tame.
    const third = { id: 't', at: day(15, 20), value: 34 };
    const slope = theilSenPerWeek([...evening, later, third]);
    expect(slope).toBeGreaterThan(-30);
    expect(slope).toBeLessThan(30);
  });
});

describe('references', () => {
  it('keeps each reference in its own series and leaves unlabelled takes out', () => {
    const p = takePoints([
      take('a', day(1), report({ within25: 0.9, reference: 'song_key' })),
      take('b', day(2), report({ within25: 0.2, reference: 'chromatic' })),
      take('c', day(3), report({ within25: 0.8, reference: 'song_key' })),
    ]);
    expect(buildSeries(p, 'within25', null, 'high', 0.02, 'song_key')?.points.map((x) => x.value)).toEqual([0.9, 0.8]);
    expect(buildSeries(p, 'within25', null, 'high', 0.02, 'chromatic')?.points.map((x) => x.value)).toEqual([0.2]);
    expect(buildSeries(p, 'within25', null, 'high', 0.02, 'estimated_key')).toBeNull();
  });
});

describe('songs', () => {
  it('lists songs most recent first and filters points by song', () => {
    const p = takePoints([
      take('a', day(1), report(), { songHash: 'x', songName: 'Old' }),
      take('b', day(5), report(), { songHash: 'y', songName: 'New' }),
      take('c', day(6), report(), { songHash: 'x', songName: 'Old' }),
    ]);
    expect(songsOf(p)).toEqual([
      { hash: 'x', name: 'Old', takes: 2 },
      { hash: 'y', name: 'New', takes: 1 },
    ]);
    expect(pointsFor(p, 'x')).toHaveLength(2);
    expect(pointsFor(p, null)).toHaveLength(3);
  });
});
