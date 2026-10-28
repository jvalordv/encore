/**
 * What learning mode says apart from the numbers, as pure functions of the
 * state so the wording and the rules are tested without a page: whether the
 * song in use is a karaoke track (so there is no original singer to compare
 * with), the notice that says so before the singer starts, what to search for
 * to find the original, which take's report card is open, and the Strict and
 * Open style choices. A karaoke track has no original singer to compare with,
 * so Strict says so and offers Open, which scores it on the song's key. Karaoke
 * mode never reaches any of this: every function answers "nothing" there.
 */
import type { TakeReport } from '../analysis/score';
import type { KeyState } from './key-state';
import { skippedForNoVocal } from './reference';
import type { PracticeMode, ScoringStyle } from './settings';
import type { AppState } from './state';
import type { TakeSummary } from './takes';

/** Said before the take, verbatim (docs/COACHING.md), on a karaoke track. */
export const KARAOKE_TRACK_NOTICE =
  "Learning mode compares your singing with the original singer's. This is a karaoke track, " +
  "so there is no singer in it to compare against: you're on your own for this one.";

/** Offered beside the notice, in Strict, with a button that switches to Open. */
export const OPEN_SWITCH_OFFER = "Switch to Open to be scored on the song's key instead.";

/** Said once, on a hint line, in learning mode. */
export const FREE_PHRASE_HINT = 'Shift+click a phrase on the lane to mark it free.';

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

/** The one plain line Open says on a karaoke track: scored on the key, or why it cannot be. */
export function openTrackNotice(key: KeyState): string {
  const lead = 'This is a karaoke track, ';
  switch (key.phase) {
    case 'ready':
      return `${lead}so you're scored on the song's key: notes that fit it count as in key.`;
    case 'unclear':
      return `${lead}and the service could not read its key, so you're judged on steadiness only.`;
    case 'missing': {
      const why = key.message.replace(/[.\s]+$/, '');
      return `${lead}and no key is available (${why}), so you're judged on steadiness only.`;
    }
    case 'none':
      return (
        `${lead}and its key is not available yet (the service has not sent one), ` +
        "so you're judged on steadiness only."
      );
  }
}

/** What the notice says in the current state; null when it is not due. */
export function karaokeTrackNotice(
  state: Pick<AppState, 'mode' | 'scoring' | 'key' | 'song' | 'pickedResult' | 'reference'>,
): string | null {
  if (state.mode !== 'learning' || !isKaraokeTrack(state)) return null;
  return state.scoring === 'open' ? openTrackNotice(state.key) : KARAOKE_TRACK_NOTICE;
}

/** The offer to switch to Open, shown beside the Strict notice; null when not due. */
export function openSwitchOffer(
  state: Pick<AppState, 'mode' | 'scoring' | 'song' | 'pickedResult' | 'reference'>,
): string | null {
  return state.mode === 'learning' && state.scoring === 'strict' && isKaraokeTrack(state)
    ? OPEN_SWITCH_OFFER
    : null;
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
 * (even for a take that has a report), for a take without a report, and on a
 * karaoke track unless the take was scored in Open, which scores such a track.
 */
export function openReport(
  state: Pick<AppState, 'mode' | 'song' | 'pickedResult' | 'reference' | 'takes' | 'reportTakeId'>,
): { take: TakeSummary; report: TakeReport } | null {
  if (state.mode !== 'learning' || state.reportTakeId === null) return null;
  const take = state.takes.find((t) => t.id === state.reportTakeId);
  if (!take?.report) return null;
  if (isKaraokeTrack(state) && take.report.style !== 'open') return null;
  return { take, report: take.report };
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

/** The two scoring styles as the selector beside the mode toggle labels them. */
export const SCORING_CHOICES: ReadonlyArray<{ style: ScoringStyle; label: string; title: string }> = [
  {
    style: 'strict',
    label: 'Strict',
    title: "Judged against the original singer's melody, octave and all",
  },
  {
    style: 'open',
    label: 'Open',
    title: "Any octave counts, the windows are wider, and notes that fit the song's key are freestyle, not misses",
  },
];
