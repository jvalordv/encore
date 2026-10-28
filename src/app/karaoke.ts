/**
 * Making the karaoke track for a song, apart from the Session that does it.
 * Two halves, like src/app/prepare.ts. The first is what the song panel says:
 * `KaraokeState` (a phase, the steps the service last reported, how much of an
 * upload has gone and one message) and `describeKaraoke`, which turns it, the
 * melody and the mix into the lines, notes and switches the panel shows, so
 * the wording is tested without a page. The second is the wording itself.
 * Nothing here talks to the service; src/app/session/stems.ts does.
 *
 * The panel is quiet by design: the service being away costs the singer one
 * plain line (no karaoke track or melody without it) and nothing else.
 */
import type { SongSteps } from '../service/types';
import type { MixState } from './mix';
import { STEP_LABELS } from './prepare';
import type { ReferenceState } from './reference';

/**
 * Where a song stands on the way to its karaoke track. 'none': nothing to
 * show (no song, or a linked song not yet prepared, which the prepare group
 * speaks for). 'checking': asking the service whether it runs. 'unavailable':
 * it does not, so the song plays as it is. 'uploading': the file is being sent.
 * 'preparing': the service is separating the vocal and reading the melody.
 * 'loading': the stems are being downloaded and decoded. 'ready': the stems
 * are in the mix (the melody may still be coming). 'failed': it stopped with a
 * reason.
 */
export type KaraokePhase =
  | 'none'
  | 'checking'
  | 'unavailable'
  | 'uploading'
  | 'preparing'
  | 'loading'
  | 'ready'
  | 'failed';

/** What the panel is told about the karaoke track. */
export interface KaraokeState {
  phase: KaraokePhase;
  /** Share of the file sent, 0 to 1; only meaningful while uploading. */
  uploadProgress: number;
  /** The service's latest word on the steps while it works; null otherwise. */
  steps: SongSteps | null;
  /** A note that goes with the phase: the reason it failed. */
  message: string;
}

/** The state of a page with no song to make a karaoke track for. */
export function initialKaraoke(): KaraokeState {
  return { phase: 'none', uploadProgress: 0, steps: null, message: '' };
}

/** The one line the singer gets when the service is not running. */
export const MISSING_SERVICE_NOTE =
  'No karaoke track or melody without the service. Start it as service/README.md ' +
  'describes; this page checks again when you come back to it. The song plays as it is.';
/** The note while the service is asked whether it runs. */
export const CHECKING_SERVICE_NOTE = 'Checking whether the service is running…';
/** The note while the stems are downloaded and decoded. */
export const LOADING_STEMS_NOTE = 'Loading the karaoke track…';
/** The first line of an upload, before the browser reports any progress. */
export const SENDING_LINE = 'Sending the song to the service';

/** Progress 0..1 as a whole percentage. */
function percent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * 100);
}

/**
 * The lines for the steps that are yet to finish: the vocal separation and the
 * melody, waiting or at their percentage. Steps that are done, skipped or
 * failed are spoken for by the notes; the fetch has the prepare group; the
 * lyrics step is not offered by the app, so it is never named here.
 */
export function karaokeLines(steps: SongSteps | null): string[] {
  if (steps === null) return [];
  const lines: string[] = [];
  for (const name of ['separation', 'reference'] as const) {
    const { state, progress } = steps[name];
    if (state === 'queued') lines.push(`${STEP_LABELS[name]}: waiting`);
    else if (state === 'running') lines.push(`${STEP_LABELS[name]} ${percent(progress)}%`);
  }
  return lines;
}

/** The sentence about the melody for a song that has reached the stems. */
export function describeMelody(reference: ReferenceState): string {
  switch (reference.phase) {
    case 'ready':
      return reference.notes === 1
        ? 'Melody: 1 target note on the lane.'
        : `Melody: ${reference.notes} target notes on the lane.`;
    case 'skipped':
      return `Melody skipped: ${reference.message}`;
    case 'failed':
      return `Melody not available: ${reference.message}`;
    default:
      return '';
  }
}

/** What the panel shows. */
export interface KaraokeView {
  /** False when there is nothing to say, so the panel is hidden. */
  visible: boolean;
  /** Progress, one line per thing under way. */
  lines: string[];
  /** What is missing or what went wrong; empty when all is well. */
  note: string;
  /** The line about the melody; empty until there is one to speak of. */
  melody: string;
  /** True while a karaoke track is coming or here, so the mix is on show. */
  mixVisible: boolean;
  /** True when the mix can be changed: the stems are loaded. */
  mixEnabled: boolean;
}

/** The lines, notes and switches for a KaraokeState, a melody and a mix. */
export function describeKaraoke(
  karaoke: KaraokeState,
  reference: ReferenceState,
  mix: MixState,
): KaraokeView {
  const view = (fields: Partial<KaraokeView>): KaraokeView => ({
    visible: true,
    lines: [],
    note: '',
    melody: '',
    mixVisible: false,
    mixEnabled: mix.available,
    ...fields,
  });
  switch (karaoke.phase) {
    case 'none':
      return view({ visible: false });
    case 'checking':
      return view({ note: CHECKING_SERVICE_NOTE });
    case 'unavailable':
      return view({ note: MISSING_SERVICE_NOTE });
    case 'uploading':
      return view({
        lines: [`${SENDING_LINE} ${percent(karaoke.uploadProgress)}%`],
        mixVisible: true,
      });
    case 'preparing':
      return view({ lines: karaokeLines(karaoke.steps), mixVisible: true });
    case 'loading':
      return view({
        lines: karaokeLines(karaoke.steps),
        note: LOADING_STEMS_NOTE,
        mixVisible: true,
      });
    case 'ready':
      return view({
        lines: karaokeLines(karaoke.steps),
        melody: describeMelody(reference),
        mixVisible: true,
      });
    case 'failed':
      // A failure after the stems are in (the service went away during the
      // melody step) must not take the mix away from a song still playing.
      return view({
        note: karaoke.message,
        melody: describeMelody(reference),
        mixVisible: mix.available,
      });
  }
}
