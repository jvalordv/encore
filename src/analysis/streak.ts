/**
 * Days sung in a row, from the dates of saved takes. It counts days and
 * nothing else, so it judges no singing and is shown in both modes. A take
 * counts when it has voiced frames (a take of silence is not singing) and is
 * not a Mic check take. Days are local calendar days: the caller supplies the
 * `dayOf` function so tests can fix a time zone (and a clock change) instead
 * of depending on the machine's. Today counts once a take exists today;
 * yesterday keeps a streak alive until today ends. Pure, no DOM; checked in
 * test/streak.test.ts.
 */
import { localDayNumber } from './progress';

/** Maps epoch milliseconds to a whole number for the calendar day it falls on. */
export type DayOf = (ms: number) => number;

/** The fields of a stored take the streak reads (a TakeSummary fits). */
export interface StreakTake {
  createdAt: number;
  kind?: 'song' | 'mic-check';
  /** Voiced frames in the take; absent on takes saved before it was kept. */
  voicedFrames?: number;
}

/** Fewest voiced frames that make a take count as singing. */
export const MIN_VOICED_FRAMES = 5;

const DAY_MS = 86_400_000;

/** The browser's local day, steady across clock changes. */
export const localDay: DayOf = localDayNumber;

/** A day function for a fixed UTC offset in minutes (east positive). */
export function fixedOffsetDay(offsetMinutes: number): DayOf {
  return (ms) => Math.floor((ms + offsetMinutes * 60_000) / DAY_MS);
}

/** True when the take counts as a day of singing. */
export function countsAsSinging(take: StreakTake): boolean {
  if (take.kind === 'mic-check') return false;
  return take.voicedFrames === undefined || take.voicedFrames >= MIN_VOICED_FRAMES;
}

/** The distinct days with a counted take, ascending. */
export function daysSung(takes: readonly StreakTake[], dayOf: DayOf = localDay): number[] {
  const days = new Set<number>();
  for (const take of takes) if (countsAsSinging(take)) days.add(dayOf(take.createdAt));
  return [...days].sort((a, b) => a - b);
}

/** The current and the longest run of consecutive days. */
export interface Streak {
  current: number;
  longest: number;
}

/**
 * The streak over `days` (ascending, distinct) as of day number `today`. The
 * current run is the one ending today or yesterday; it is 0 when the last day
 * sung is older than that.
 */
export function streakOf(days: readonly number[], today: number): Streak {
  let longest = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const last = days.length > 0 ? days[days.length - 1] : null;
  const alive = last !== null && last >= today - 1 && last <= today;
  return { current: alive ? run : 0, longest };
}

/** The chip's plain words: "3 days in a row"; empty when there is no streak. */
export function streakLabel(current: number, one: string, many: string): string {
  if (current <= 0) return '';
  return current === 1 ? one : many.replace('{n}', String(current));
}
