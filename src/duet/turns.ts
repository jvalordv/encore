/**
 * Turns on one mic: who sings which stretch of the song. The app decides, not
 * the voice. The song is cut into stretches at the gaps between notes (the one
 * phrase splitter, src/analysis/phrases.ts) or, when synced lyrics are loaded,
 * at the lyric lines. Stretches go to A, B, A, ... by default and a click
 * cycles one through A, B and both. A stretch marked both is credited to both
 * singers and reported as shared. Pure, no DOM; tested in test/duet-turns.test.ts.
 */
import type { Span } from '../analysis/free-phrases';
import { splitPhrases } from '../analysis/phrases';
import type { PhraseNote } from '../analysis/phrases';

/** Who a stretch belongs to. */
export type Who = 'a' | 'b' | 'both';

/** One stretch of the song and its singer(s). */
export interface TurnSpan {
  startS: number;
  endS: number;
  who: Who;
}

/** What the stretches came from; lyrics win when they are synced. */
export type TurnSource = 'phrases' | 'lyrics' | 'none';

/** A timed lyric line, as the lyrics reader gives it (src/lyrics/lrc.ts). */
export interface TimedLine {
  t: number;
  text: string;
}

/** Seconds the last lyric line is assumed to last when nothing ends it. */
export const LAST_LINE_S = 4;

/** The stretches of a melody: one per phrase. */
export function spansFromNotes(notes: readonly PhraseNote[]): Span[] {
  return splitPhrases(notes).map((p): Span => [p.startS, p.endS]);
}

/**
 * The stretches of synced lyrics: each non-empty line runs to the next stamp
 * (a blank stamp is a break and ends the line before it). The last line lasts
 * until `endS`, or LAST_LINE_S when the song's length is unknown.
 */
export function spansFromLyrics(lines: readonly TimedLine[], endS = 0): Span[] {
  const spans: Span[] = [];
  lines.forEach((line, i) => {
    if (line.text === '') return;
    const next = lines[i + 1]?.t;
    const stop = next ?? (endS > line.t ? endS : line.t + LAST_LINE_S);
    if (stop > line.t) spans.push([line.t, stop]);
  });
  return spans;
}

/** The key a span's override is saved under: its start, to the centisecond. */
export function spanKey(span: Span): string {
  return span[0].toFixed(2);
}

/** The default singer of the stretch at `index`: A, B, A, ... */
export function defaultWho(index: number): Who {
  return index % 2 === 0 ? 'a' : 'b';
}

/** The next choice when a stretch is clicked: A, then B, then both, then A. */
export function cycleWho(who: Who): Who {
  if (who === 'a') return 'b';
  return who === 'b' ? 'both' : 'a';
}

/** The overrides the singers made, by span key. */
export type Overrides = Readonly<Record<string, Who>>;

/** Spans with a singer each: the default alternation, then the overrides. */
export function assignTurns(spans: readonly Span[], overrides: Overrides = {}): TurnSpan[] {
  return spans.map((span, i) => ({
    startS: span[0],
    endS: span[1],
    who: overrides[spanKey(span)] ?? defaultWho(i),
  }));
}

/**
 * The overrides after a click on the stretch starting at `startS`: it moves to
 * the next choice, and the override is dropped when that is the default again.
 */
export function clickTurn(spans: readonly Span[], overrides: Overrides, startS: number): Overrides {
  const index = spans.findIndex((s) => Math.abs(s[0] - startS) < 0.005);
  if (index < 0) return overrides;
  const key = spanKey(spans[index]);
  const next = cycleWho(overrides[key] ?? defaultWho(index));
  const out: Record<string, Who> = { ...overrides };
  if (next === defaultWho(index)) delete out[key];
  else out[key] = next;
  return out;
}

/** The stretch that contains song time `t` (ends included), or null in a gap. */
export function turnAt(turns: readonly TurnSpan[], t: number): TurnSpan | null {
  return turns.find((s) => t >= s.startS && t <= s.endS) ?? null;
}

/**
 * Whose frame a sound at `t` is. Inside a stretch, that stretch's; in a gap,
 * the stretch just before (singing out of turn counts for the singer whose
 * turn it is); before the first stretch, the first. Null with no turns.
 */
export function whoAt(turns: readonly TurnSpan[], t: number): Who | null {
  if (turns.length === 0) return null;
  let current = turns[0];
  for (const turn of turns) {
    if (turn.startS > t) break;
    current = turn;
  }
  return current.who;
}

/** The singers (0 is A, 1 is B) a `who` credits. */
export function singersOf(who: Who): Array<0 | 1> {
  if (who === 'a') return [0];
  return who === 'b' ? [1] : [0, 1];
}

/** The spans marked both, as the report calls them shared. */
export function sharedSpans(turns: readonly TurnSpan[]): Array<[number, number]> {
  return turns.filter((t) => t.who === 'both').map((t): [number, number] => [t.startS, t.endS]);
}
