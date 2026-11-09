/**
 * Taking over a linked song's audio, apart from the Session that acts on it.
 * Two halves. The first is what the song panel knows: `PrepareState` (a phase,
 * the steps the service last reported and one message) and the wording of its
 * steps (`stepLines`), which the Song reference card shows
 * (src/app/song-reference.ts), tested without a page. The second is
 * `adoptHeldSong`, the flow from a song the service already holds (the
 * recording of the video's sound, once uploaded) to its audio bytes: wait for
 * the fetch step, then download the audio. Encore never asks the service to
 * download a YouTube link; the only YouTube song the service holds is one the
 * singer's own recording put there. The flow takes the client and an
 * AbortSignal, so a newer load can stop it and a test can run it against a
 * stub.
 *
 * Nothing here decides that a song is prepared. The Session does, once a
 * recording has been uploaded, and it alone loads the bytes into the audio
 * engine and switches the clock.
 */
import { failedStep, isAbortError, ServiceError, settledAs } from '../service/client';
import type { PollOptions, PollOutcome } from '../service/client';
import { STEP_NAMES } from '../service/types';
import type { SongStatus, SongSteps, StepName, StepStatus } from '../service/types';

/**
 * Where a linked song stands on the way to prepared audio. 'none': no video is
 * the song, nothing to show. 'checking': asking the service whether it runs.
 * 'unavailable': it does not, so the melody cannot be had. 'ready': it does,
 * and the song's sound can be recorded. 'preparing': the service is working on
 * the recording. 'loading': the audio is being downloaded and decoded.
 * 'waiting': it is ready, but a take is being recorded on the video.
 * 'prepared': the app's own audio is the song. 'failed': it stopped with a
 * reason.
 */
export type PreparePhase =
  | 'none'
  | 'checking'
  | 'unavailable'
  | 'ready'
  | 'preparing'
  | 'loading'
  | 'waiting'
  | 'prepared'
  | 'failed';

/** What the panel is told about the linked song. */
export interface PrepareState {
  phase: PreparePhase;
  /** The service's latest word on the steps while it works; null otherwise. */
  steps: SongSteps | null;
  /** A note that goes with the phase: the reason it failed, or what is next. */
  message: string;
}

/** The state of a page with no linked song. */
export function initialPrepare(): PrepareState {
  return { phase: 'none', steps: null, message: '' };
}

/** The note while the service is asked whether it runs. */
export const CHECKING_NOTE = 'Checking whether the service is running…';
/** The progress line before the service has said anything about the steps. */
export const ASKING_LINE = 'Asking the service…';
/** The note while the fetched audio is downloaded and decoded. */
export const LOADING_NOTE = 'Loading the audio…';
/** The note while a prepared song waits for the take being recorded. */
export const WAITING_NOTE = 'Prepared; switching after this take.';
/** The note once the app's own audio has taken the song over. */
export const PREPARED_NOTE =
  "The app now plays this song's audio and keeps its own time. The video " +
  'follows, muted. The karaoke track and the melody follow below.';
/** Why a preparation failed when the service stopped answering. */
export const SERVICE_STOPPED =
  'The service stopped answering. Check that it is running (service/README.md), ' +
  'then try again.';
/** Why a preparation failed when the service no longer has the song. */
export const SONG_FORGOTTEN = 'The service no longer has this song.';
/** Why a preparation failed when the service has no audio to give. */
export const AUDIO_MISSING = 'The service has no audio for this song.';

/** How each step is named to the person. */
export const STEP_LABELS: Readonly<Record<StepName, string>> = {
  fetch: 'Fetching audio',
  separation: 'Separating the vocal',
  key: 'Finding the key',
  reference: 'Reading the melody',
  lyrics: 'Finding the lyrics',
};

/** Progress 0..1 as a whole percentage. */
function percent(progress: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * 100);
}

/** One step in a line: "Separating the vocal 45%", "Finding the key: waiting", ... */
export function describeStep(name: StepName, step: StepStatus): string {
  const label = STEP_LABELS[name];
  switch (step.state) {
    case 'queued':
      return `${label}: waiting`;
    case 'running':
      return `${label} ${percent(step.progress)}%`;
    case 'done':
      return `${label}: done`;
    case 'failed':
      return step.error?.trim() || `${label} failed`;
    case 'skipped': {
      const why = step.detail?.trim();
      return why ? `${label}: skipped (${why})` : `${label}: skipped`;
    }
  }
}

/**
 * The lines for the steps worth showing: the fetch always, since it is what
 * the person waits for, and any other step once it is under way. The later
 * steps sit queued or skipped until they have work, and saying so would be
 * noise. The lyrics step is never shown: the app finds lyrics itself, and the
 * service's step is only a stub.
 */
export function stepLines(steps: SongSteps | null): string[] {
  if (steps === null) return [ASKING_LINE];
  return STEP_NAMES.filter(
    (name) => name !== 'lyrics' && (name === 'fetch' || steps[name].state === 'running'),
  ).map((name) => describeStep(name, steps[name]));
}

/** The id the service files a recorded YouTube video under. */
export function heldSongId(videoId: string): string {
  return `yt-${videoId}`;
}

/** Why a step failed, in the service's words when it gave any. */
export function describeFailure(status: SongStatus, step: StepName): string {
  const reason = status.steps[step].error?.trim();
  return reason || `${STEP_LABELS[step]} failed.`;
}

/** A failed call, said so the person knows what to do next. */
export function describeServiceError(error: unknown): string {
  if (error instanceof ServiceError) {
    switch (error.kind) {
      case 'unreachable':
        return SERVICE_STOPPED;
      case 'not-found':
        return SONG_FORGOTTEN;
      case 'not-fetched':
        return AUDIO_MISSING;
      default:
        // 'rejected' carries the service's own plain reason; 'unexpected' says
        // what it was.
        return error.message;
    }
  }
  return error instanceof Error && error.message ? error.message : String(error);
}

/** The slice of ServiceClient that adoptHeldSong uses. */
export interface PrepareClient {
  getSong(id: string, signal?: AbortSignal): Promise<SongStatus>;
  pollSong(id: string, options?: PollOptions): Promise<PollOutcome>;
  fetchSongAudio(id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

/** How adoptHeldSong reports on its way and is stopped. */
export interface PrepareHooks {
  /** Stops the flow wherever it is; the result is then 'aborted'. */
  signal: AbortSignal;
  /** The service's latest word on the steps: first, and every poll. */
  onSteps(steps: SongSteps): void;
  /** The fetch is done and the audio is being downloaded. */
  onLoading(steps: SongSteps): void;
}

/** What adoptHeldSong ends with. */
export type PrepareOutcome =
  | { kind: 'audio'; bytes: ArrayBuffer; status: SongStatus }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted' };

/**
 * Takes a song the service holds to its audio. Its status is read, polled
 * until the fetch step is done, and the audio is downloaded. A failed step
 * ends it with that step's error, and so does audio the service no longer has.
 * Any failure becomes a message in `failed`, and a stop through the signal is
 * 'aborted', never a failure.
 */
export async function adoptHeldSong(
  client: PrepareClient,
  songId: string,
  hooks: PrepareHooks,
): Promise<PrepareOutcome> {
  const { signal } = hooks;
  try {
    let status = await client.getSong(songId, signal);
    hooks.onSteps(status.steps);
    if (settledAs(status) === null) {
      const outcome = await client.pollSong(status.song_id, {
        signal,
        onUpdate: (update) => hooks.onSteps(update.steps),
      });
      if (outcome.kind === 'aborted') return { kind: 'aborted' };
      if (outcome.kind === 'failed') {
        return { kind: 'failed', message: describeFailure(outcome.status, outcome.step) };
      }
      status = outcome.status;
    }
    const failed = settledAs(status) === 'failed' ? failedStep(status) : null;
    if (failed !== null) return { kind: 'failed', message: describeFailure(status, failed) };

    hooks.onLoading(status.steps);
    try {
      const bytes = await client.fetchSongAudio(status.song_id, signal);
      return { kind: 'audio', bytes, status };
    } catch (error) {
      const lost = error instanceof ServiceError && error.kind === 'not-fetched';
      if (!lost) throw error;
      return { kind: 'failed', message: AUDIO_MISSING };
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return { kind: 'aborted' };
    return { kind: 'failed', message: describeServiceError(error) };
  }
}
