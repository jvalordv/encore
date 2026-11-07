/**
 * Tests for days sung in a row (src/analysis/streak.ts): which takes count,
 * local days across midnight and a clock change (fixed offsets, never the
 * machine's zone), gaps, today and yesterday, and the longest run.
 */
import { describe, expect, it } from 'vitest';
import { countsAsSinging, daysSung, fixedOffsetDay, streakLabel, streakOf } from '../src/analysis/streak';
import type { DayOf } from '../src/analysis/streak';

const HOUR = 3_600_000;
const utc = (d: number, h = 12, m = 0): number => Date.UTC(2026, 10, d, h, m);
const take = (createdAt: number, extra: { kind?: 'mic-check'; voicedFrames?: number } = {}) => ({
  createdAt,
  ...extra,
});

describe('countsAsSinging', () => {
  it('leaves out Mic check takes and takes with almost nothing voiced', () => {
    expect(countsAsSinging(take(0, { kind: 'mic-check', voicedFrames: 500 }))).toBe(false);
    expect(countsAsSinging(take(0, { voicedFrames: 0 }))).toBe(false);
    expect(countsAsSinging(take(0, { voicedFrames: 4 }))).toBe(false);
    expect(countsAsSinging(take(0, { voicedFrames: 5 }))).toBe(true);
  });

  it('counts a take saved before voiced frames were kept', () => {
    expect(countsAsSinging(take(0))).toBe(true);
  });
});

describe('daysSung', () => {
  it('gives each local day once, ascending', () => {
    const utcDay = fixedOffsetDay(0);
    const days = daysSung([take(utc(5)), take(utc(3)), take(utc(5, 20))], utcDay);
    expect(days).toEqual([utcDay(utc(3)), utcDay(utc(5))]);
  });

  it('puts a take on the day it was local: 23:30 and 00:30 are two days apart in time, one apart in days', () => {
    const utcDay = fixedOffsetDay(0);
    const before = utc(10, 23, 30);
    const after = utc(11, 0, 30);
    expect(utcDay(after) - utcDay(before)).toBe(1);
    expect(daysSung([take(before), take(after)], utcDay)).toHaveLength(2);
  });

  it('follows the time zone: the same instant is another day east and west', () => {
    const instant = utc(10, 23, 30);
    expect(fixedOffsetDay(120)(instant)).toBe(fixedOffsetDay(0)(instant) + 1);
    expect(fixedOffsetDay(-300)(instant)).toBe(fixedOffsetDay(0)(instant));
    expect(fixedOffsetDay(-300)(utc(10, 3))).toBe(fixedOffsetDay(0)(utc(10, 3)) - 1);
  });

  it('skips Mic check and silent takes', () => {
    const days = daysSung([take(utc(1), { kind: 'mic-check' }), take(utc(2), { voicedFrames: 1 })], fixedOffsetDay(0));
    expect(days).toEqual([]);
  });

  it('keeps a day boundary steady when the clock changes (23 and 25 hour days)', () => {
    // A zone that moves from +0 to +1 at utc(8, 2): local midnight of the 8th
    // is at utc(8, 0), and the day is only 23 hours long once it springs.
    const dst: DayOf = (ms) => Math.floor((ms + (ms >= utc(8, 2) ? 1 : 0) * HOUR) / (24 * HOUR));
    const nights = [take(utc(7, 22)), take(utc(8, 12)), take(utc(9, 12))];
    const days = daysSung(nights, dst);
    expect(days).toHaveLength(3);
    expect(streakOf(days, dst(utc(9, 13))).current).toBe(3);
    // Autumn: +1 back to +0 at utc(15, 2); 24-hour gaps still land on
    // consecutive local days, and two takes inside the 25-hour day are one.
    const back: DayOf = (ms) => Math.floor((ms + (ms < utc(15, 2) ? 1 : 0) * HOUR) / (24 * HOUR));
    const autumn = daysSung([take(utc(14, 12)), take(utc(15, 12)), take(utc(15, 22)), take(utc(16, 12))], back);
    expect(autumn).toHaveLength(3);
    expect(streakOf(autumn, back(utc(16, 13))).current).toBe(3);
  });
});

describe('streakOf', () => {
  it('is 0 for no days', () => {
    expect(streakOf([], 100)).toEqual({ current: 0, longest: 0 });
  });

  it('counts today as part of the run once a take exists today', () => {
    expect(streakOf([98, 99, 100], 100)).toEqual({ current: 3, longest: 3 });
  });

  it('keeps yesterday alive until today ends', () => {
    expect(streakOf([98, 99], 100)).toEqual({ current: 2, longest: 2 });
  });

  it('ends the run after a missed day but remembers the longest', () => {
    expect(streakOf([90, 91, 92, 93, 98, 99], 101)).toEqual({ current: 0, longest: 4 });
    expect(streakOf([90, 91, 92, 93, 98, 99, 101], 101)).toEqual({ current: 1, longest: 4 });
  });

  it('breaks a run at a gap inside it', () => {
    expect(streakOf([95, 96, 98, 99, 100], 100)).toEqual({ current: 3, longest: 3 });
  });

  it('does not count a future day as alive', () => {
    expect(streakOf([105], 100).current).toBe(0);
  });
});

describe('streakLabel', () => {
  it('says "1 day in a row" and "N days in a row", and nothing for none', () => {
    expect(streakLabel(1, '1 day in a row', '{n} days in a row')).toBe('1 day in a row');
    expect(streakLabel(4, '1 day in a row', '{n} days in a row')).toBe('4 days in a row');
    expect(streakLabel(0, 'one', 'many')).toBe('');
  });
});
