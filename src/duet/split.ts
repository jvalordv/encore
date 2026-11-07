/**
 * Scoring one mic's take for two singers. The frames and the melody's notes
 * are split by the turns: a stretch marked A is A's, B is B's, and a stretch
 * marked both is credited to both (and reported as shared). Each singer is
 * then measured by the one scorer (src/analysis/open-score.ts) against only
 * their own notes, so the other singer's lines never count as misses. The
 * report's note and phrase indices are put back to point into the full melody,
 * as the free-phrase scoring does. Pure, no DOM; tested in
 * test/duet-split.test.ts.
 */
import { scoreTake } from '../analysis/open-score';
import type { TakeScoreOptions } from '../analysis/open-score';
import type { PitchFrame } from '../analysis/pitch';
import { buildScoreReference } from '../analysis/score';
import type { ScoreReference, TakeReport } from '../analysis/score';
import { sharedSpans, singersOf, whoAt } from './turns';
import type { TurnSpan } from './turns';

/** Both singers' reports of one take, and the stretches they share. */
export interface DuetReports {
  /** Index 0 is A's report, 1 is B's. */
  reports: [TakeReport, TakeReport];
  /** The stretches marked both, as [start, end]. */
  shared: Array<[number, number]>;
}

/** True when the turn rule credits song time `t` to `singer`. */
export function creditsSinger(turns: readonly TurnSpan[], t: number, singer: 0 | 1): boolean {
  const who = whoAt(turns, t);
  return who !== null && singersOf(who).includes(singer);
}

/** The frames credited to `singer` by the turns. */
export function framesFor<F extends { t: number }>(frames: readonly F[], turns: readonly TurnSpan[], singer: 0 | 1): F[] {
  return frames.filter((f) => creditsSinger(turns, f.t, singer));
}

/** The melody reduced to `singer`'s notes; `kept` are their indices in the full one. */
export function referenceFor(
  ref: ScoreReference,
  turns: readonly TurnSpan[],
  singer: 0 | 1,
): { reference: ScoreReference; kept: number[] } {
  const kept: number[] = [];
  ref.notes.forEach((note, i) => {
    if (creditsSinger(turns, note.onsetS, singer)) kept.push(i);
  });
  const notes = kept.map((i) => ref.notes[i]);
  const unpitched = ref.unpitchedS.filter((r) => creditsSinger(turns, (r[0] + r[1]) / 2, singer));
  const midis = notes.map((n) => n.midi);
  const range =
    midis.length > 0
      ? { lowMidi: Math.min(...midis), highMidi: Math.max(...midis) }
      : { lowMidi: ref.lowMidi, highMidi: ref.highMidi };
  return { reference: buildScoreReference(notes, unpitched, range), kept };
}

/** Points a report scored on a reduced melody back into the full melody's indices. */
function remap(report: TakeReport, kept: readonly number[]): TakeReport {
  return {
    ...report,
    notes: report.notes.map((n) => ({ ...n, index: kept[n.index] ?? n.index })),
    worstPhrases: report.worstPhrases.map((p) => ({
      ...p,
      first: kept[p.first] ?? p.first,
      last: kept[p.last] ?? p.last,
    })),
  };
}

/** One singer's report from one mic's frames and the turns. */
export function scoreSinger(
  frames: readonly PitchFrame[],
  ref: ScoreReference | null,
  options: TakeScoreOptions,
  turns: readonly TurnSpan[],
  singer: 0 | 1,
): TakeReport {
  const mine = framesFor(frames, turns, singer);
  if (ref === null) return scoreTake(mine, null, options);
  const { reference, kept } = referenceFor(ref, turns, singer);
  return remap(scoreTake(mine, reference.notes.length > 0 ? reference : null, options), kept);
}

/** Both singers' reports of one mic's take, split by the turns. */
export function scoreTurns(
  frames: readonly PitchFrame[],
  ref: ScoreReference | null,
  options: TakeScoreOptions,
  turns: readonly TurnSpan[],
): DuetReports {
  return {
    reports: [scoreSinger(frames, ref, options, turns, 0), scoreSinger(frames, ref, options, turns, 1)],
    shared: sharedSpans(turns),
  };
}

/** True when a phrase (by its span) lies inside a stretch marked shared. */
export function isSharedPhrase(shared: ReadonlyArray<readonly [number, number]>, startS: number, endS: number): boolean {
  const mid = (startS + endS) / 2;
  return shared.some((s) => mid >= s[0] && mid <= s[1]);
}
