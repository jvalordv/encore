/**
 * Tests for the Library's per-song takes (src/app/song-takes.ts): whose takes
 * count (the active singer's, "No singer" and others' only under All singers),
 * grouping by song, the date words and the "N takes · last sung" line, and the
 * learning figures of a take, including singer B's side of a duet.
 */
import { describe, expect, it } from 'vitest';
import type { TakeReport } from '../src/analysis/score';
import { NO_SINGER } from '../src/app/profiles';
import { dayLabel, scoreOfTake, takesBySong, takesInScope, takesLine } from '../src/app/song-takes';
import type { TakeScope } from '../src/app/song-takes';
import type { TakeSummary } from '../src/app/takes';

function report(inTuneRate: number | null): TakeReport {
  return {
    notesCovered: 10,
    notesSung: 10,
    inTuneRate,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange: { lowMidi: 60, highMidi: 72, highAtS: 1 },
    sungRange: { lowMidi: 60, highMidi: 72 },
  };
}

function take(id: string, songHash: string, createdAt: number, over: Partial<TakeSummary> = {}): TakeSummary {
  return { id, songHash, songName: songHash, createdAt, durationS: 10, latencyS: 0, sampleRate: 48000, ...over };
}

const mine: TakeScope = { allSingers: false, activeId: 'ann', legacyId: 'ann' };
const everyone: TakeScope = { ...mine, allSingers: true };
/** Local noon on 10 Nov 2026 and some days around it. */
const NOW = new Date(2026, 10, 10, 12).getTime();
const daysAgo = (n: number, hour = 9): number => new Date(2026, 10, 10 - n, hour).getTime();

describe('takesInScope', () => {
  const takes = [
    take('old', 's1', 1), // no profileId: the oldest profile's (ann)
    take('bob', 's1', 2, { profileId: 'bob' }),
    take('none', 's1', 3, { profileId: NO_SINGER }),
    take('b-side', 's2', 4, { profileId: 'bob', profileIdB: 'ann' }),
    take('check', 's1', 5, { kind: 'mic-check' }),
  ];

  it('keeps the active singer\'s takes, as singer A or B, newest first', () => {
    expect(takesInScope(takes, mine).map((t) => t.id)).toEqual(['b-side', 'old']);
  });

  it('counts everyone\'s, "No singer" included, only under All singers, never a Mic check', () => {
    expect(takesInScope(takes, everyone).map((t) => t.id)).toEqual(['b-side', 'none', 'bob', 'old']);
  });

  it('reads another singer as the active one', () => {
    expect(takesInScope(takes, { ...mine, activeId: 'bob' }).map((t) => t.id)).toEqual(['b-side', 'bob']);
  });
});

describe('takesBySong', () => {
  it('groups by song hash with each list newest first', () => {
    const grouped = takesBySong([take('a', 's1', 1), take('b', 's2', 2), take('c', 's1', 3)], mine);
    expect(Object.keys(grouped).sort()).toEqual(['s1', 's2']);
    expect(grouped['s1'].map((t) => t.id)).toEqual(['c', 'a']);
  });

  it('has no entry for a song with no counted takes', () => {
    expect(takesBySong([take('bob', 's1', 1, { profileId: 'bob' })], mine)).toEqual({});
  });
});

describe('dayLabel', () => {
  it('says today and yesterday, then the date', () => {
    expect(dayLabel(daysAgo(0, 8), NOW)).toBe('today');
    expect(dayLabel(daysAgo(1, 23), NOW)).toBe('yesterday');
    expect(dayLabel(daysAgo(7), NOW)).toBe('3 Nov');
    expect(dayLabel(new Date(2025, 11, 25, 9).getTime(), NOW)).toBe('25 Dec 2025');
  });
});

describe('takesLine', () => {
  it('is empty for no takes', () => {
    expect(takesLine([], NOW)).toBe('');
  });

  it('counts the takes and dates the latest one', () => {
    const list = [take('a', 's1', daysAgo(5)), take('b', 's1', daysAgo(1)), take('c', 's1', daysAgo(9))];
    expect(takesLine(list, NOW)).toBe('3 takes · last sung yesterday');
    expect(takesLine([list[0]], NOW)).toBe('1 take · last sung 5 Nov');
  });
});

describe('scoreOfTake', () => {
  it('gives the share and stars of a take with a report', () => {
    expect(scoreOfTake(take('a', 's1', 1, { report: report(0.8) }), mine)).toEqual({
      percent: 80,
      measure: 'inTune',
      stars: 2,
    });
  });

  it('is null without a report or a share', () => {
    expect(scoreOfTake(take('a', 's1', 1), mine)).toBeNull();
    expect(scoreOfTake(take('a', 's1', 1, { report: report(null) }), mine)).toBeNull();
  });

  it('reads singer B\'s report when B is the active singer', () => {
    const duet = {
      profileId: 'bob',
      profileIdB: 'ann',
      report: report(0.95),
      duet: { reportB: report(0.6) },
    } as unknown as Partial<TakeSummary>;
    const t = take('d', 's1', 1, duet);
    expect(scoreOfTake(t, mine)?.percent).toBe(60);
    expect(scoreOfTake(t, everyone)?.percent).toBe(95);
  });
});
