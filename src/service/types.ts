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

/** Where a linked song's audio came from: the playing tab, or the downloader. */
export type AudioOrigin = 'capture' | 'download';

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

/** The steps of a song. */
export interface SongSteps {
  fetch: StepStatus;
  separation: StepStatus;
  key: StepStatus;
  reference: StepStatus;
  /** The backing notes (W0g); absent from a service older than that. */
  backing?: StepStatus;
  lyrics: StepStatus;
}

/** Preparation status of one song, as `GET /songs/{id}` answers it. */
export interface SongStatus {
  song_id: string;
  title?: string | null;
  duration_s?: number | null;
  source: SongSource;
  /** Set once a linked song has audio; absent from older services. */
  audio_source?: AudioOrigin | null;
  steps: SongSteps;
  /** The latest alignment to an original, if one was asked for. */
  alignment?: AlignmentStatus | null;
  /** Seconds the capture's audio lags the download's, when both exist and matched. */
  capture_offset_s?: number | null;
}

/** How aligning a karaoke song to an original is going, or how it ended. */
export type AlignState = 'queued' | 'running' | 'done' | 'refused' | 'failed';

/** The alignment of a karaoke song to an original (service/encore_service/schemas.py). */
export interface AlignmentStatus {
  state: AlignState;
  /** 0 to 1. */
  progress: number;
  original_id: string;
  /** Semitones the original's melody was shifted by to meet the karaoke. */
  key_offset?: number | null;
  /** 0 to 1: how sure the match is. */
  confidence?: number | null;
  /** Plain words for a refusal or a failure. */
  reason?: string | null;
}

/** Body of `POST /songs/{id}/align`: the original to take the melody from. */
export interface AlignRequest {
  original_id: string;
}

/** One line of `GET /songs`: a stored song and the steps it has finished. */
export interface SongSummary {
  id: string;
  name: string;
  source: SongSource;
  duration_s: number | null;
  steps_done: StepName[];
  /** True when the source file is held, so the song can be loaded again. */
  has_audio: boolean;
  updated_at: number;
}

/** Answer of `POST /songs/url/{video_id}/capture`: the status and what happened. */
export interface CaptureResponse extends SongStatus {
  /** True when the song already had audio, so the capture was kept beside it. */
  alongside: boolean;
  message: string;
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
  /** Set when the melody was borrowed from this original by alignment. */
  aligned_from?: string | null;
  /** Semitones the borrowed melody was shifted by. */
  key_offset?: number | null;
  /** 0 to 1: how sure the alignment was. */
  confidence?: number | null;
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

/** One note of the backing music, as `GET /songs/{id}/backing` sends it. */
export interface BackingNote {
  onset_s: number;
  offset_s: number;
  /** Whole MIDI note number. */
  midi: number;
  /** 1 to 127. */
  velocity: number;
}

/** The backing music as notes, in onset order; chords overlap. */
export interface BackingNotes {
  notes: BackingNote[];
}

/** The song's key over time, as `GET /songs/{id}/key` sends it. */
export interface KeyMap {
  /** [-50, 50): the song's offset from A = 440 equal temperament, in cents. */
  tuning_cents: number;
  /** In time order, contiguous from 0 to the song's end. */
  segments: KeySegment[];
}

/** What a stretch of a Mic check take turned out to hold. */
export type SectionVerdict = 'silence' | 'singer' | 'likely_bleed' | 'unclear';

/** The analysis of one labelled stretch of the Mic check. */
export interface AnalysedSection {
  label: string;
  kind: 'silent' | 'sing';
  verdict: SectionVerdict;
  start_s: number;
  end_s: number;
}

/** The tuned values in force, plus the latency (null when none is set). */
export interface TuningValues {
  draw_margin_db: number;
  clarity_threshold: number;
  bleed_match_cents: number;
  bleed_min_match: number;
  bleed_max_median_cents: number;
  latency_s: number | null;
}

/** The same keys, each a value to use or null to keep the current one. */
export type TuningOffer = { [K in keyof TuningValues]: number | null };

/** What `POST /takes/analyse` sends back for a Mic check take. */
export interface TakeAnalysis {
  report_text: string;
  findings: string[];
  sections: AnalysedSection[];
  current: TuningValues;
  recommended: TuningOffer;
  notes: string[];
}
