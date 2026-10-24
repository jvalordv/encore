/**
 * The shapes the Python service sends and receives, copied by hand from
 * service/encore_service/schemas.py (small enough that code generation is not
 * worth a dependency; change both together). Field names are the wire's own,
 * snake_case, so a parsed JSON body is one of these without a translation
 * layer. Only what the browser reads today is mirrored: the song status the
 * app polls and the request that adds a link. The rest (contour, notes,
 * lyrics, take analysis) joins it as the tasks that use it land.
 */

/** Lifecycle of one preparation step. */
export type StepState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** The preparation steps, in the order the service runs them. */
export type StepName = 'fetch' | 'separation' | 'reference' | 'lyrics';

/** How a song entered the service; only a linked one has a fetch to run. */
export type SongSource = 'file' | 'youtube';

/** The step names in run order, for code that walks them. */
export const STEP_NAMES: readonly StepName[] = ['fetch', 'separation', 'reference', 'lyrics'];

/** State and progress of one step. The service sends null for what is unset. */
export interface StepStatus {
  state: StepState;
  /** 0 to 1. */
  progress: number;
  /** Why the step failed, as "what failed: why". */
  error?: string | null;
  /** Why the step was skipped, fit to show the person. */
  detail?: string | null;
}

/** The four steps of a song. */
export interface SongSteps {
  fetch: StepStatus;
  separation: StepStatus;
  reference: StepStatus;
  lyrics: StepStatus;
}

/** Preparation status of one song, as `GET /songs/{id}` answers it. */
export interface SongStatus {
  song_id: string;
  title?: string | null;
  duration_s?: number | null;
  source: SongSource;
  steps: SongSteps;
}

/** Body of `POST /songs/url`: the link, as the person pasted it. */
export interface SongLinkRequest {
  url: string;
}
