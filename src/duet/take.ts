/**
 * A duet take's per-singer reports and how they are stored. Singer A's report
 * stays in the take's own `report` field, so an old take, and everything that
 * reads `take.report` (progress, stars, the streak), is singer A's and never
 * mixes in B. Singer B's report, the names, the turns and the shared stretches
 * ride in `duet`, and B's own frames (two mics) beside the take's, so a
 * re-score can redo both. Pure, no DOM; tested in test/duet-take.test.ts.
 */
import { scoreTake } from '../analysis/open-score';
import type { TakeScoreOptions } from '../analysis/open-score';
import type { ScoreReference, TakeReport } from '../analysis/score';
import type { TakeFrame } from '../app/take-trace';
import { DEFAULT_NAME_A, DEFAULT_NAME_B } from './settings';
import type { SingerIndex } from './settings';
import { scoreTurns } from './split';
import type { TurnSpan } from './turns';

/** How the two singers were heard: one mic taking turns, or a mic each. */
export type DuetMode = 'one-mic' | 'two-mics';

/** What a duet take keeps beyond singer A's report. */
export interface DuetTake {
  mode: DuetMode;
  names: [string, string];
  /** Singer B's report; A's is the take's `report`. */
  reportB: TakeReport;
  /** The stretches credited to both singers, as [start, end]. */
  shared: Array<[number, number]>;
  /** One mic: the stretches and who had each. Empty with two mics. */
  turns: TurnSpan[];
}

/** What the controller collected while a take was recorded. */
export interface DuetCapture {
  mode: DuetMode;
  names: [string, string];
  turns: TurnSpan[];
  /** Two mics: singer B's frames on song time. Empty with one mic. */
  framesB: TakeFrame[];
}

/** One singer's card: who, their name and the report. */
export interface SingerReport {
  singer: SingerIndex;
  name: string;
  report: TakeReport;
  /** The stretches credited to both singers, which the card marks shared. */
  shared: Array<[number, number]>;
}

/** A take as far as the reports go. */
interface HasReports {
  report?: TakeReport;
  duet?: DuetTake;
}

/** Both singers' reports of a take scored now, A's first. */
export function scoreDuetTake(
  capture: DuetCapture,
  framesA: readonly TakeFrame[],
  ref: ScoreReference | null,
  options: TakeScoreOptions,
): { report: TakeReport; duet: DuetTake } {
  if (capture.mode === 'one-mic') {
    const { reports, shared } = scoreTurns(framesA, ref, options, capture.turns);
    const duet: DuetTake = { mode: 'one-mic', names: capture.names, reportB: reports[1], shared, turns: capture.turns };
    return { report: reports[0], duet };
  }
  const duet: DuetTake = {
    mode: 'two-mics',
    names: capture.names,
    reportB: scoreTake(capture.framesB, ref, options),
    shared: [],
    turns: [],
  };
  return { report: scoreTake(framesA, ref, options), duet };
}

/** The capture a stored duet take was made from, for a re-score. */
export function captureOf(duet: DuetTake, framesB: readonly TakeFrame[] | undefined): DuetCapture {
  return { mode: duet.mode, names: duet.names, turns: duet.turns, framesB: [...(framesB ?? [])] };
}

/**
 * The cards a take has: singer A's from `report` (an old take, with no duet
 * record, is A's alone) and, for a duet take, singer B's. None without a report.
 */
export function singerReports(take: HasReports): SingerReport[] {
  if (!take.report) return [];
  const duet = take.duet;
  const first: SingerReport = {
    singer: 0,
    name: duet?.names[0] ?? DEFAULT_NAME_A,
    report: take.report,
    shared: duet?.shared ?? [],
  };
  if (!duet) return [first];
  return [first, { singer: 1, name: duet.names[1] ?? DEFAULT_NAME_B, report: duet.reportB, shared: duet.shared }];
}

/**
 * The takes as one singer's own list, each with that singer's report in
 * `report`: A's is the list as it stands; B's keeps only duet takes. Progress
 * and stars read `report`, so each singer's history stays their own.
 */
export function takesOfSinger<T extends HasReports>(takes: readonly T[], singer: SingerIndex): T[] {
  if (singer === 0) return [...takes];
  return takes.filter((t) => t.duet !== undefined).map((t) => ({ ...t, report: t.duet?.reportB }));
}
