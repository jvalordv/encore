/**
 * The Library's per-song takes, as pure functions over take summaries: which
 * takes count for whom (the active singer's, or everyone's), how they group by
 * song, the "3 takes · last sung yesterday" line of a row, and the learning
 * mode figures of one take. No DOM and no storage; the Library controller
 * reads the summaries and the panel draws what these return. Karaoke mode
 * never asks for the figures (scoreOfTake), so nothing here leaks a judgement
 * into it.
 */
import { starMeasure, starsFor } from '../analysis/stars';
import type { StarMeasureId } from '../analysis/stars';
import { takesLabel } from './library-state';
import { involvesProfile, ownsTake } from './profiles';
import type { TakeSummary } from './takes';

/** Whose takes a Library row counts. */
export interface TakeScope {
  /** True for the "All singers" switch; false counts the active singer's. */
  allSingers: boolean;
  activeId: string;
  /** The oldest profile, owner of takes saved before profiles existed. */
  legacyId: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** The song takes in scope, newest first. Mic check takes are nobody's song. */
export function takesInScope(takes: readonly TakeSummary[], scope: TakeScope): TakeSummary[] {
  return takes
    .filter(
      (t) =>
        t.kind !== 'mic-check' &&
        (scope.allSingers || involvesProfile(t, scope.activeId, scope.legacyId)),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** The takes in scope grouped by song hash, each list newest first. */
export function takesBySong(takes: readonly TakeSummary[], scope: TakeScope): Record<string, TakeSummary[]> {
  const out: Record<string, TakeSummary[]> = {};
  for (const take of takesInScope(takes, scope)) (out[take.songHash] ??= []).push(take);
  return out;
}

const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A local date in words: today, yesterday, "3 Nov", or "3 Nov 2025" in an earlier year. */
export function dayLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  if (sameDay(date, today)) return 'today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(date, yesterday)) return 'yesterday';
  const base = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === today.getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

/** A row's takes line, "3 takes · last sung yesterday"; '' for a song with none. */
export function takesLine(list: readonly TakeSummary[], now: number): string {
  if (list.length === 0) return '';
  const last = Math.max(...list.map((t) => t.createdAt));
  return `${takesLabel(list.length)} · last sung ${dayLabel(last, now)}`;
}

/** What learning mode shows of one take: the share it was starred on and the stars. */
export interface TakeScore {
  /** Whole percent, 0..100. */
  percent: number;
  measure: StarMeasureId;
  stars: number;
}

/**
 * The learning mode figures of a take as the counted singer sang it: singer A's
 * report, or singer B's on a duet take where B is the active singer. Null when
 * the take has no report or nothing to star on. Only learning mode may call it.
 */
export function scoreOfTake(take: TakeSummary, scope: TakeScope): TakeScore | null {
  const asB = !scope.allSingers && !ownsTake(take, scope.activeId, scope.legacyId) && take.profileIdB === scope.activeId;
  const report = asB ? take.duet?.reportB : take.report;
  if (!report) return null;
  const measure = starMeasure(report);
  if (measure === null) return null;
  return { percent: Math.round(measure.value * 100), measure: measure.id, stars: starsFor(measure.value) };
}
