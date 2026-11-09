/**
 * The Song reference card, apart from the page and the Session. A YouTube
 * song plays in the embedded player, which Encore cannot hear, so learning
 * mode can only comment on the singer's voice until the service has the song's
 * sound and has read a melody and a key from it. There is one way to say yes to
 * that: Encore records the song's sound from the tab during the first take.
 * This file holds the words and the decisions around it: what Encore has for
 * the song (`melodySourceOf`, `keySourceOf`), what that means for learning
 * mode, the card's view (`describeSongReference`), and when to ask or to go
 * ahead without asking (`offerFor`). Pure, so each is tested without a page;
 * the Session's controller (session/song-reference.ts) acts on them and the
 * panel (panels/song-reference.ts) draws the view.
 *
 * Getting the melody is opt-in (docs/ARCHITECTURE.md): nothing is recorded or
 * leaves for the service until the singer presses the button, answers the
 * prompt, or has turned on the automatic setting, and then only at a Play or
 * Record press that can ask for the share.
 */
import type { TakeReport } from '../analysis/score';
import { classifyResult } from '../search/classify';
import type { AlignState } from './align';
import { describeAlign } from './align';
import { canStop, captureLine, isCapturing } from './capture';
import type { CaptureState } from './capture';
import type { KeyState } from './key-state';
import { CHECKING_NOTE, LOADING_NOTE, stepLines } from './prepare';
import type { PreparePhase, PrepareState } from './prepare';
import { skippedForNoVocal } from './reference';
import type { ReferenceState } from './reference';
import type { PracticeMode } from './settings';

/** Where the song's melody came from: nowhere, this video, or its original. */
export type MelodySource = 'none' | 'video' | 'original';
/** Where the song's key came from: nowhere, the song, or the singer's notes. */
export type KeySource = 'none' | 'song' | 'singing';

/** What the card remembers beyond the states it reads. */
export interface SongRefState {
  /**
   * The melody was asked for and the next Play or Record press starts
   * recording the song's sound from this tab, alongside the take.
   */
  armed: boolean;
  /** The singer chose "Not now" for this song in this session. */
  declined: boolean;
}

/** The state of a page whose song has no reference asked for. */
export function initialSongRef(): SongRefState {
  return { armed: false, declined: false };
}

/** The label of the one button. */
export const GET_MELODY_LABEL = 'Get the melody';
/** The question the prompt asks in learning mode. */
export const PROMPT_TEXT = 'Get the melody so learning mode can score you?';
/** The prompt's decline button. */
export const NOT_NOW_LABEL = 'Not now';
/** The prompt's checkbox, bound to the automatic setting. */
export const EVERY_SONG_LABEL = 'Do this for every song';
/** The label of the early end of a recording of the song's sound. */
export const STOP_RECORDING_LABEL = 'Stop recording';

/** Said once the melody is asked for and the song's sound will be recorded. */
export const ARMED_NOTE = "Encore will record the song's sound while you sing your first take.";
/** Said when this browser cannot record a tab's sound. */
export const NO_RECORDING_NOTE =
  "This browser cannot record the song's sound, so Encore cannot get the melody. Use Chrome or Edge.";
/** What to do next, under the note that says the sound will be recorded. */
export const ARMED_HINT =
  "Press Record, then choose this tab in the share dialog with 'Share tab audio' on. " +
  'Pressing Play does the same.';
/** The note while the service is not running. */
export const SERVICE_DOWN_NOTE =
  'The service is not running, so Encore cannot get the melody. Start it as ' +
  'service/README.md describes; this page checks again when you come back to ' +
  'it. The video plays as before.';
/** The note while the button is on offer. */
export const READY_NOTE =
  "Records this video's sound from this tab while you sing the first take, then " +
  'the local service reads its melody and key. See service/README.md.';
/** The hint under a karaoke or instrumental video. */
export const KARAOKE_HINT = 'This looks like a karaoke track, so there is no singing in it to read.';
/** The note while a prepared song waits for its melody. */
export const READING_NOTE = 'Reading the melody…';

/** The melody's source in plain words, as the card's first line. */
export function melodyLine(source: MelodySource): string {
  switch (source) {
    case 'none':
      return 'Melody: none';
    case 'video':
      return 'Melody: from this video';
    case 'original':
      return 'Melody: from the original (aligned)';
  }
}

/** The key's source in plain words, as the card's second line. */
export function keyLine(source: KeySource): string {
  switch (source) {
    case 'none':
      return 'Key: none';
    case 'song':
      return 'Key: estimated from the song';
    case 'singing':
      return 'Key: estimated from your singing';
  }
}

/** One line on what the reference means for learning mode (learning mode only). */
export function meaningLine(source: MelodySource): string {
  switch (source) {
    case 'none':
      return 'Without a melody, learning mode comments on your voice only.';
    case 'video':
      return 'With the melody, learning mode scores your pitch and timing against it.';
    case 'original':
      return "With the original's melody, learning mode scores your pitch and timing against it.";
  }
}

/** Where the melody comes from: the reference state says whether it was borrowed. */
export function melodySourceOf(reference: Pick<ReferenceState, 'phase' | 'alignedFrom'>): MelodySource {
  if (reference.phase !== 'ready') return 'none';
  return reference.alignedFrom ? 'original' : 'video';
}

/**
 * Where the key comes from: the service's reading of the song when it has one,
 * else the key a take's report estimated from the singer's own notes. That
 * second source is learning-mode output, so karaoke mode never reports it.
 */
export function keySourceOf(
  key: Pick<KeyState, 'phase'>,
  takes: ReadonlyArray<{ report?: TakeReport }>,
  mode: PracticeMode,
): KeySource {
  if (key.phase === 'ready') return 'song';
  if (mode !== 'learning') return 'none';
  return takes.some((take) => take.report?.voice?.reference === 'estimated_key') ? 'singing' : 'none';
}

/** True when the video's title (or channel) says it is a karaoke or backing track. */
export function titleLooksKaraoke(title: string, channel = ''): boolean {
  return classifyResult(title, channel) === 'karaoke';
}

/** What the card does about a song's missing melody without being asked. */
export type Offer = 'none' | 'prompt' | 'auto';

/** What offerFor decides from. */
export interface OfferInput {
  mode: PracticeMode;
  /** The Settings switch 'Get the song reference automatically'. */
  autoReference: boolean;
  /** 'Not now' was chosen for this song this session. */
  declined: boolean;
  /** Capture is armed already, so the answer is known. */
  armed: boolean;
  prepare: PreparePhase;
  melody: MelodySource;
  capture: CaptureState['phase'];
  /** The video says karaoke or instrumental: no singing in it to read. */
  karaoke: boolean;
  /** This browser can share a tab's sound; without that nothing can be asked. */
  recordable: boolean;
}

/**
 * Whether a song with no melody gets the prompt, an automatic start, or
 * nothing. Only learning mode ever asks: karaoke mode never prompts and never
 * starts by itself. A karaoke track has no singing to read, so it is never
 * offered either; the plain button stays for a singer who wants it anyway.
 * The service must be there (phase 'ready'), this browser must be able to
 * record the song's sound, and nothing else must be under way for this song.
 * An automatic start only arms the recording: the share is asked for at the
 * next Play or Record press.
 */
export function offerFor(input: OfferInput): Offer {
  if (input.mode !== 'learning' || input.prepare !== 'ready' || !input.recordable) return 'none';
  if (input.melody !== 'none' || input.armed || input.capture !== 'idle' || input.karaoke) return 'none';
  if (input.autoReference) return 'auto';
  return input.declined ? 'none' : 'prompt';
}

/** What describeSongReference reads. */
export interface SongRefInput {
  prepare: PrepareState;
  capture: CaptureState;
  reference: ReferenceState;
  key: KeyState;
  align: AlignState;
  mode: PracticeMode;
  autoReference: boolean;
  songRef: SongRefState;
  /** True when the video's title says karaoke or instrumental. */
  titleKaraoke: boolean;
  /** The takes of this song, for the key a take estimated from singing. */
  takes: ReadonlyArray<{ report?: TakeReport }>;
  /** True when this browser can share a tab's sound. */
  captureSupported: boolean;
}

/** What the panel draws for the card. */
export interface SongRefView {
  /** False while no YouTube video is the song. */
  visible: boolean;
  melodySource: MelodySource;
  keySource: KeySource;
  melody: string;
  key: string;
  /** What the reference means for learning mode; '' outside it, which hides the line. */
  meaning: string;
  /** The service's steps while it works, one line each. */
  lines: string[];
  /** The main status text; '' when there is none. */
  note: string;
  /** A second, smaller line: what to do next, or why the video has no melody. */
  hint: string;
  /** The primary button, shown unless something else says it or nothing is left to get. */
  button: { shown: boolean; disabled: boolean; label: string; title: string };
  /** Stop for an early end of the recording of the song's sound. */
  stop: { shown: boolean; disabled: boolean };
  /** The in-app prompt, with its checkbox state; shown in place of the button. */
  prompt: { shown: boolean; text: string; auto: boolean };
}

/** The Song reference card for the states of the page. */
export function describeSongReference(input: SongRefInput): SongRefView {
  const { prepare, capture, reference, songRef } = input;
  const phase = prepare.phase;
  const melodySource = melodySourceOf(reference);
  const keySource = keySourceOf(input.key, input.takes, input.mode);
  const karaoke = melodySource !== 'original' && (input.titleKaraoke || skippedForNoVocal(reference));
  const recording = isCapturing(capture) || capture.phase === 'preparing';
  const offer = offerFor({
    mode: input.mode,
    autoReference: input.autoReference,
    declined: songRef.declined,
    armed: songRef.armed,
    prepare: phase,
    melody: melodySource,
    capture: capture.phase,
    karaoke,
    recordable: input.captureSupported,
  });

  let note = '';
  let hint = '';
  let title = '';
  let disabled = false;
  let lines: string[] = [];
  switch (phase) {
    case 'none':
    case 'prepared':
      disabled = true;
      break;
    case 'checking':
      disabled = true;
      note = CHECKING_NOTE;
      break;
    case 'unavailable':
      disabled = true;
      note = SERVICE_DOWN_NOTE;
      title = SERVICE_DOWN_NOTE;
      break;
    case 'ready':
      if (!input.captureSupported) {
        disabled = true;
        note = NO_RECORDING_NOTE;
        title = NO_RECORDING_NOTE;
      } else if (songRef.armed) {
        note = ARMED_NOTE;
        hint = ARMED_HINT;
      } else {
        note = READY_NOTE;
        title = READY_NOTE;
      }
      break;
    case 'preparing':
      disabled = true;
      lines = stepLines(prepare.steps);
      break;
    case 'loading':
      disabled = true;
      lines = stepLines(prepare.steps);
      note = LOADING_NOTE;
      break;
    case 'waiting':
      disabled = true;
      note = prepare.message;
      break;
    case 'failed':
      note = songRef.armed ? ARMED_NOTE : prepare.message;
      hint = songRef.armed ? ARMED_HINT : '';
      break;
  }
  if (phase === 'prepared') {
    note = capture.phase === 'ready' && capture.message ? capture.message : prepare.message;
    if (melodySource === 'none' && reference.phase === 'none') hint = READING_NOTE;
  }
  // A recording of the song's sound says its own progress and failure.
  const recordingLine = captureLine(capture);
  if (capture.phase !== 'idle' && capture.phase !== 'ready' && recordingLine !== '') {
    note = recordingLine;
    hint = '';
  }
  if (recording) disabled = true;
  // The match with the original says how it is going and why it failed.
  const matching = describeAlign(input.align);
  if (input.align.phase !== 'idle' && input.align.phase !== 'done' && matching !== '') note = matching;
  // What is known beats what is being read.
  if (karaoke && (hint === '' || hint === READING_NOTE)) hint = KARAOKE_HINT;

  const nothingLeft = phase === 'none' || phase === 'prepared' || melodySource !== 'none';
  const prompt = offer === 'prompt';
  return {
    visible: phase !== 'none',
    melodySource,
    keySource,
    melody: melodyLine(melodySource),
    key: keyLine(keySource),
    // Learning-mode copy: karaoke mode shows nothing of it.
    meaning: input.mode === 'learning' ? meaningLine(melodySource) : '',
    lines,
    note,
    hint,
    button: { shown: !nothingLeft && !prompt && !songRef.armed, disabled, label: GET_MELODY_LABEL, title },
    stop: { shown: capture.phase === 'capturing', disabled: !canStop(capture) },
    prompt: { shown: prompt, text: PROMPT_TEXT, auto: input.autoReference },
  };
}
