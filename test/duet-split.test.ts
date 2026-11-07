/**
 * Scoring one mic's take for two singers: each singer is measured on their own
 * stretches only, shared stretches count for both and are marked, the report's
 * indices still point into the full melody, and a duet take stores A's report
 * as the take's own so an old take reads as singer A's.
 */
import { describe, expect, it } from 'vitest';
import type { PitchFrame } from '../src/analysis/pitch';
import { buildScoreReference } from '../src/analysis/score';
import type { ScoreReference } from '../src/analysis/score';
import { creditsSinger, framesFor, isSharedPhrase, scoreSinger, scoreTurns } from '../src/duet/split';
import { captureOf, scoreDuetTake, singerReports, takesOfSinger } from '../src/duet/take';
import type { DuetTake } from '../src/duet/take';
import { assignTurns } from '../src/duet/turns';

const A3 = 220;
const E4 = 329.63;
const C4 = 261.63;

/** Three one-second notes with a one-second rest between: three phrases. */
const REF: ScoreReference = buildScoreReference(
  [
    { onsetS: 0, offsetS: 1, midi: 57 },
    { onsetS: 2, offsetS: 3, midi: 64 },
    { onsetS: 4, offsetS: 5, midi: 60 },
  ],
  [],
  { lowMidi: 57, highMidi: 64 },
);
const SPANS: Array<[number, number]> = [
  [0, 1],
  [2, 3],
  [4, 5],
];
const OPTIONS = { style: 'strict' as const, octaveInvariant: false, key: null, freeSpans: [] };

/** 100 frames a second of `f0` between two times. */
function sing(f0: number, from: number, to: number): PitchFrame[] {
  const out: PitchFrame[] = [];
  for (let i = Math.round(from * 100); i < Math.round(to * 100); i++) {
    out.push({ t: i / 100, f0, clarity: 0.97, rms: 0.2 });
  }
  return out;
}

/** A takes the first note, B the second, A the third, on one mic. */
const TAKE = [...sing(A3, 0, 1), ...sing(E4, 2, 3), ...sing(C4, 4, 5)];

describe('splitting the frames and the melody', () => {
  const turns = assignTurns(SPANS);

  it('credits each frame to the singer of its stretch, and a gap to the stretch before', () => {
    expect(creditsSinger(turns, 0.5, 0)).toBe(true);
    expect(creditsSinger(turns, 0.5, 1)).toBe(false);
    expect(creditsSinger(turns, 2.5, 1)).toBe(true);
    // 1.5 s is a gap after A's stretch: out-of-turn singing counts for A.
    expect(creditsSinger(turns, 1.5, 0)).toBe(true);
    expect(framesFor(TAKE, turns, 1).every((f) => f.t >= 2 && f.t < 4)).toBe(true);
  });

  it('measures each singer on their own notes, indices pointing into the full melody', () => {
    const a = scoreSinger(TAKE, REF, OPTIONS, turns, 0);
    const b = scoreSinger(TAKE, REF, OPTIONS, turns, 1);
    expect(a.notes.map((n) => n.index)).toEqual([0, 2]);
    expect(b.notes.map((n) => n.index)).toEqual([1]);
    expect(a.notesSung).toBe(2);
    expect(b.notesSung).toBe(1);
    expect(b.inTuneRate).toBe(1);
  });

  it("does not count the other singer's silence as a miss", () => {
    const onlyB = sing(E4, 2, 3);
    const a = scoreSinger(onlyB, REF, OPTIONS, turns, 0);
    expect(a.notes.some((n) => n.index === 1)).toBe(false);
    const b = scoreSinger(onlyB, REF, OPTIONS, turns, 1);
    expect(b.notesSung).toBe(1);
  });

  it('credits a stretch marked both to both singers and marks it shared', () => {
    const shared = assignTurns(SPANS, { '2.00': 'both' });
    const { reports, shared: spans } = scoreTurns(TAKE, REF, OPTIONS, shared);
    expect(spans).toEqual([[2, 3]]);
    expect(reports[0].notes.map((n) => n.index)).toEqual([0, 1, 2]);
    expect(reports[1].notes.map((n) => n.index)).toEqual([1]);
    expect(isSharedPhrase(spans, 2, 3)).toBe(true);
    expect(isSharedPhrase(spans, 0, 1)).toBe(false);
  });

  it("scores a song with no melody on the singers' voices alone", () => {
    const report = scoreSinger(TAKE, null, OPTIONS, turns, 0);
    expect(report.noMelody).toBe(true);
    expect(report.voice).toBeDefined();
  });
});

describe('a duet take', () => {
  const turns = assignTurns(SPANS);
  const names: [string, string] = ['Ann', 'Bo'];

  it("keeps singer A's report as the take's own and singer B's beside it", () => {
    const capture = { mode: 'one-mic' as const, names, turns, framesB: [] };
    const { report, duet } = scoreDuetTake(capture, TAKE, REF, OPTIONS);
    expect(report.notes.map((n) => n.index)).toEqual([0, 2]);
    expect(duet.reportB.notes.map((n) => n.index)).toEqual([1]);
    expect(duet.mode).toBe('one-mic');
    expect(captureOf(duet, undefined).turns).toEqual(turns);
  });

  it('scores two mics each against the whole melody', () => {
    const capture = { mode: 'two-mics' as const, names, turns: [], framesB: sing(E4, 2, 3) };
    const { report, duet } = scoreDuetTake(capture, sing(A3, 0, 1), REF, OPTIONS);
    expect(report.notesSung).toBe(1);
    expect(report.notes.map((n) => n.index)).toEqual([0]);
    expect(duet.reportB.notesSung).toBe(1);
    expect(duet.reportB.notes.map((n) => n.index)).toEqual([1]);
    expect(duet.shared).toEqual([]);
  });

  it("reads an old take, with no duet record, as singer A's alone", () => {
    const old = { report: scoreSinger(TAKE, REF, OPTIONS, turns, 0) };
    const cards = singerReports(old);
    expect(cards.map((c) => c.singer)).toEqual([0]);
    expect(cards[0].name).toBe('Singer A');
    expect(singerReports({})).toEqual([]);
    expect(takesOfSinger([old], 1)).toEqual([]);
    expect(takesOfSinger([old], 0)).toHaveLength(1);
  });

  it('gives each singer their own history and cards', () => {
    const capture = { mode: 'one-mic' as const, names, turns, framesB: [] };
    const { report, duet } = scoreDuetTake(capture, TAKE, REF, OPTIONS);
    const take: { report: typeof report; duet: DuetTake } = { report, duet };
    expect(singerReports(take).map((c) => c.name)).toEqual(['Ann', 'Bo']);
    expect(takesOfSinger([take], 1)[0].report).toBe(duet.reportB);
    expect(takesOfSinger([take], 0)[0].report).toBe(report);
  });
});
