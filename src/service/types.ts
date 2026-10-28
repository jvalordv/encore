/**
 * The shapes the Python service sends and receives, copied by hand from
 * service/encore_service/schemas.py (small enough that code generation is not
 * worth a dependency; change both together). Field names are the wire's own,
 * snake_case, so a parsed JSON body is one of these without a translation
 * layer. Only what the browser reads today is mirrored: the song status the
 * app polls, the request that adds a link, the reference melody (`Reference`
 * with its `Contour` and `Note`s; a note's `vibrato` is not measured yet and is
 * left out) and the song's key (`KeyMap`). The rest (lyrics, take analysis)
 * joins it as the tasks that use it land.
 */

/** Lifecycle of one preparation step. */
export type StepState = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** The preparation steps, in the order the service runs them. */
export type StepName = 'fetch' | 'separation' | 'key' | 'reference' | 'lyrics';

/** How a song entered the service; only a linked one has a fetch to run. */
export type SongSource = 'file' | 'youtube';

/** The step names in run order, for code that walks them. */
export const STEP_NAMES: readonly StepName[] = ['fetch', 'separation', 'key', 'reference', 'lyrics'];

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

/** The five steps of a song. */
export interface SongSteps {
  fetch: StepStatus;
  separation: StepStatus;
  key: StepStatus;
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

/** Frame-by-frame pitch track: `f0_hz[i]` is at `t0_s + i * hop_s`. */
export interface Contour {
  hop_s: number;
  t0_s: number;
  /** Fundamental in Hz; 0 means unvoiced. */
  f0_hz: number[];
  confidence: number[];
}

/** One segmented note of the original vocal. */
export interface Note {
  onset_s: number;
  offset_s: number;
  /** Fractional MIDI note number. */
  midi: number;
  cents_mean: number;
  cents_std: number;
  scoop_cents: number;
}

/** The original vocal's melody, as `GET /songs/{id}/reference` sends it. */
export interface Reference {
  contour: Contour;
  notes: Note[];
  range: { low_midi: number; high_midi: number };
  /** Stretches [start_s, end_s] where something sounds but no note was sung. */
  unpitched_regions: Array<[number, number]>;
}

/** Which stem `GET /songs/{id}/stems/{stem}` serves. */
export type StemName = 'vocals' | 'no_vocals';

/** One stretch of a song in one key (or in none the service could name). */
export interface KeySegment {
  start_s: number;
  end_s: number;
  /** Pitch class 0..11, C = 0; null when the key is unclear. */
  tonic: number | null;
  /** Null exactly when `tonic` is null. */
  mode: 'major' | 'minor' | null;
  /** 0..1: how far the best key beat the runner-up. */
  confidence: number;
}

/** The song's key over time, as `GET /songs/{id}/key` sends it. */
export interface KeyMap {
  /** [-50, 50): the song's offset from A = 440 equal temperament, in cents. */
  tuning_cents: number;
  /** In time order, contiguous from 0 to the song's end. */
  segments: KeySegment[];
}
