/**
 * Duet bits of the lane and the take list: which turn a column is over, how a
 * click is routed (plain cycles the turn, Shift marks the phrase free), the
 * `?secondFake` seam's pitch and a second singer's personal best.
 */
import { describe, expect, it } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import { personalBest } from '../src/analysis/stars';
import type { StarTake } from '../src/analysis/stars';
import { fakeSecondHz } from '../src/duet/second-mic';
import { takesOfSinger } from '../src/duet/take';
import type { DuetTake } from '../src/duet/take';
import type { LaneView } from '../src/render/lane-geometry';
import { routeLaneClick, turnAtX } from '../src/render/lane-turns';
import type { LaneTurn } from '../src/render/lane-turns';

// Gutter 100 of 600: 500 px for 5 s, so t = (x - 100) / 100 seconds.
const VIEW: LaneView = { width: 600, height: 300, now: 4, windowS: 5, futureS: 1, midiLow: 48, midiHigh: 72 };
const GUTTER = 100;
const TURNS: LaneTurn[] = [
  { startS: 1, endS: 2, who: 'a' },
  { startS: 3, endS: 4, who: 'b' },
];
const PHRASES = [{ startS: 1, endS: 2 }, { startS: 3, endS: 4 }] as unknown as Parameters<typeof routeLaneClick>[5];

describe('turnAtX', () => {
  it('finds the stretch under a column, and none in a gap, the gutter or off the lane', () => {
    expect(turnAtX(VIEW, 250, GUTTER, TURNS)?.startS).toBe(1);
    expect(turnAtX(VIEW, 450, GUTTER, TURNS)?.startS).toBe(3);
    expect(turnAtX(VIEW, 350, GUTTER, TURNS)).toBeNull();
    expect(turnAtX(VIEW, 50, GUTTER, TURNS)).toBeNull();
    expect(turnAtX(VIEW, 650, GUTTER, TURNS)).toBeNull();
  });
});

describe('routeLaneClick', () => {
  it('sends a plain click to the turn cycle', () => {
    expect(routeLaneClick(VIEW, 250, GUTTER, false, TURNS, PHRASES)).toEqual({ kind: 'turn', startS: 1 });
    expect(routeLaneClick(VIEW, 350, GUTTER, false, TURNS, PHRASES)).toBeNull();
  });

  it('sends Shift+click to mark the phrase free', () => {
    expect(routeLaneClick(VIEW, 450, GUTTER, true, TURNS, PHRASES)).toEqual({ kind: 'phrase', span: [3, 4] });
    expect(routeLaneClick(VIEW, 350, GUTTER, true, TURNS, PHRASES)).toBeNull();
  });
});

describe('fakeSecondHz', () => {
  it('is null without the parameter', () => {
    expect(fakeSecondHz('')).toBeNull();
    expect(fakeSecondHz('?other=1')).toBeNull();
  });

  it('defaults to 330 Hz and takes a pitch in range', () => {
    expect(fakeSecondHz('?secondFake')).toBe(330);
    expect(fakeSecondHz('?secondFake=262')).toBe(262);
    expect(fakeSecondHz('?secondFake=5')).toBe(330);
    expect(fakeSecondHz('?secondFake=abc')).toBe(330);
  });
});

describe('singer B\'s personal best', () => {
  const rep = (inTuneRate: number): TakeReport =>
    ({
      notesCovered: 10,
      notesSung: 10,
      inTuneRate,
      frames: { hit: 0, okay: 0, miss: 0 },
      timingBiasS: null,
      notes: [],
      worstPhrases: [],
      songRange: { lowMidi: 60, highMidi: 72, highAtS: 1 },
      sungRange: { lowMidi: 60, highMidi: 72 },
    }) as TakeReport;
  const duet = (b: number): DuetTake => ({ mode: 'one-mic', names: ['A', 'B'], reportB: rep(b), shared: [], turns: [] });
  type T = StarTake & { duet?: DuetTake };
  const t = (id: string, at: number, a: number, b?: number): T => ({
    id,
    songHash: 'h',
    createdAt: at,
    report: rep(a),
    ...(b === undefined ? {} : { duet: duet(b) }),
  });

  it('compares B only with B\'s own takes, never A\'s', () => {
    // A's solo take at 0.95 must not count as B's earlier best.
    const all = [t('1', 1, 0.95), t('2', 2, 0.5, 0.6), t('3', 3, 0.5, 0.8)];
    const mine = takesOfSinger(all, 1);
    expect(mine.map((x) => x.id)).toEqual(['2', '3']);
    expect(personalBest(mine[1], mine)).toEqual({ measure: 'inTune', nowPercent: 80, wasPercent: 60 });
    expect(personalBest(all[2], all)).toBeNull();
  });
});
