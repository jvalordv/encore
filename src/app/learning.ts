/**
 * What learning mode says apart from the numbers, as pure functions of the
 * state so the wording and the rules are tested without a page: whether the
 * song in use is a karaoke track (so there is no original singer to compare
 * with), the notice that says so before the singer starts, what to search for
 * to find the original, and which take's report card is open. Karaoke mode
 * never reaches any of this: every function answers "nothing" there.
 */
import type { TakeReport } from '../analysis/score';
import { skippedForNoVocal } from './reference';
import type { PracticeMode } from './settings';
import type { AppState } from './state';
import type { TakeSummary } from './takes';

/** Said before the take, verbatim (docs/COACHING.md), on a karaoke track. */
export const KARAOKE_TRACK_NOTICE =
  "Learning mode compares your singing with the original singer's. This is a karaoke track, " +
  "so there is no singer in it to compare against: you're on your own for this one.";

/**
 * True when the song in use is a karaoke track: the search result that became
 * it carries the Karaoke badge, or the service found no singer in its vocal.
 */
export function isKaraokeTrack(state: Pick<AppState, 'song' | 'pickedResult' | 'reference'>): boolean {
  const { song, pickedResult } = state;
  if (song === null) return false;
  const picked = pickedResult !== null && song.hash === `yt-${pickedResult.videoId}`;
  return (picked && pickedResult.kind === 'karaoke') || skippedForNoVocal(state.reference);
}

/** What the notice says in the current state; null when it is not due. */
export function karaokeTrackNotice(
  state: Pick<AppState, 'mode' | 'song' | 'pickedResult' | 'reference'>,
): string | null {
  return state.mode === 'learning' && isKaraokeTrack(state) ? KARAOKE_TRACK_NOTICE : null;
}

/** The words "Find the original" searches from: the picked result, else the file's name. */
export function originalQueryFor(state: Pick<AppState, 'song' | 'pickedResult'>): {
  title: string;
  channel: string;
} {
  const { song, pickedResult } = state;
  if (pickedResult !== null && song?.hash === `yt-${pickedResult.videoId}`) {
    return { title: pickedResult.title, channel: pickedResult.channel };
  }
  return { title: (song?.name ?? '').replace(/\.[a-z0-9]{2,5}$/i, ''), channel: '' };
}

/**
 * The take whose report card is shown, with its report. Null in karaoke mode
 * (even for a take that has a report), on a karaoke track, and for a take
 * without a report.
 */
export function openReport(
  state: Pick<AppState, 'mode' | 'song' | 'pickedResult' | 'reference' | 'takes' | 'reportTakeId'>,
): { take: TakeSummary; report: TakeReport } | null {
  if (state.mode !== 'learning' || state.reportTakeId === null || isKaraokeTrack(state)) return null;
  const take = state.takes.find((t) => t.id === state.reportTakeId);
  return take?.report ? { take, report: take.report } : null;
}

/** The two modes as the header toggle labels them. */
export const MODE_CHOICES: ReadonlyArray<{ mode: PracticeMode; label: string; title: string }> = [
  { mode: 'karaoke', label: 'Karaoke', title: 'Sing and have fun: no scores, misses or tips' },
  {
    mode: 'learning',
    label: 'Learning',
    title: "Compare your singing with the original singer's and see where it misses",
  },
];
