/**
 * Preparing a linked song for scoring, apart from the Session that acts on it.
 * Two halves. The first is what the song panel knows: `PrepareState` (a phase,
 * the steps the service last reported and one message) and the wording of its
 * steps (`stepLines`), which the Song reference card shows
 * (src/app/song-reference.ts), tested without a page. The second is
 * `prepareLink`, the flow from a link to the song's audio bytes: add the link
 * to the service, wait for the fetch step, download the audio, and add the
 * link once more if the service says the audio has gone. It takes the client
 * and an AbortSignal, so a newer load can stop it and a test can run it
 * against a stub.
 *
 * Nothing here decides that a song is prepared. The Session does, on a press
 * of Get the melody or the automatic settings (all opt-in; see the policy
 * note in service/README.md), and it alone loads the bytes into the audio
 * engine and switches the clock.
 */
import { failedStep, isAbortError, ServiceError, settledAs } from '../service/client';
import type { PollOptions, PollOutcome } from '../service/client';
import { STEP_NAMES } from '../service/types';
import type { SongStatus, SongSteps, StepName, StepStatus } from '../service/types';

/**
 * Where a linked song stands on the way to prepared audio. 'none': no video is
 * the song, nothing to show. 'checking': asking the service whether it runs.
 * 'unavailable': it does not, so Prepare is off. 'ready': it does, and Prepare
 * waits for a press. 'preparing': the service is fetching the audio. 'loading':
 * the audio is fetched and is being downloaded and decoded. 'waiting': it is
 * ready, but a take is being recorded on the video. 'prepared': the app's own
 * audio is the song. 'failed': it stopped with a reason, and can be added
 * again.
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
  'then add the song again.';
/** Why a preparation failed when the service no longer has the song. */
export const SONG_FORGOTTEN = 'The service no longer has this song. Add it again.';
/** Why a preparation failed when the service has no audio to give. */
export const AUDIO_MISSING = 'The service has no audio for this song, even after adding it again.';

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

/** One step in a line: "Fetching audio 45%", "Fetching audio: waiting", ... */
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

/** The address the service is given for a video, in the one form it takes. */
export function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/** Why a step failed, in the service's words when it gave any. */
export function describeFailure(status: SongStatus, step: StepName): string {
  const reason = status.steps[step].error?.trim();
  return reason || `${STEP_LABELS[step]} failed. Add the song again to retry.`;
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

/** The slice of ServiceClient that prepareLink uses. */
export interface PrepareClient {
  createSongFromUrl(url: string, signal?: AbortSignal): Promise<SongStatus>;
  pollSong(id: string, options?: PollOptions): Promise<PollOutcome>;
  fetchSongAudio(id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

/** How prepareLink reports on its way and is stopped. */
export interface PrepareHooks {
  /** Stops the flow wherever it is; the result is then 'aborted'. */
  signal: AbortSignal;
  /** The service's latest word on the steps: after adding, and every poll. */
  onSteps(steps: SongSteps): void;
  /** The fetch is done and the audio is being downloaded. */
  onLoading(steps: SongSteps): void;
}

/** What prepareLink ends with. */
export type PrepareOutcome =
  | { kind: 'audio'; bytes: ArrayBuffer; status: SongStatus }
  | { kind: 'failed'; message: string }
  | { kind: 'aborted' };

/**
 * Takes a link from the service to the song's audio. The link is added (a song
 * the service already has is a cache hit), its status is polled until the
 * fetch step is done, and the audio is downloaded. A failed step ends it with
 * that step's error. A 409 from the audio route means the cache lost the file,
 * and the link is added again once, which makes the service fetch it afresh;
 * a second 409 is reported. Any failure becomes a message in `failed`, and a
 * stop through the signal is 'aborted', never a failure.
 */
export async function prepareLink(
  client: PrepareClient,
  url: string,
  hooks: PrepareHooks,
): Promise<PrepareOutcome> {
  const { signal } = hooks;
  try {
    for (let round = 0; round < 2; round += 1) {
      let status = await client.createSongFromUrl(url, signal);
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
      }
    }
    return { kind: 'failed', message: AUDIO_MISSING };
  } catch (error) {
    if (signal.aborted || isAbortError(error)) return { kind: 'aborted' };
    return { kind: 'failed', message: describeServiceError(error) };
  }
}
