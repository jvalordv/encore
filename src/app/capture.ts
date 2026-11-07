/**
 * "Capture for learning", apart from the audio and the page. When the
 * downloader cannot fetch a YouTube video, the app can record the video's own
 * sound from this tab while it plays once, send that to the service, and
 * prepare it like any linked song. This module is the pure half: the state
 * machine (`captureReducer`), the gates on Stop and on a usable end
 * (`canStop`, `usableAtEnd`), and the wording (`describeCapture`), so each is
 * tested without a page. `src/audio/tab-capture.ts` records, and
 * `src/app/session/capture.ts` drives this machine from it.
 *
 * It is opt-in and in the same policy category as Prepare (ROADMAP, Policy
 * flag): nothing starts until the singer presses the button.
 */
import { MIN_STOP_COVERAGE } from '../audio/capture-assembler';
import type { PreparePhase } from './prepare';

/** Where a capture stands. 'ready' is a finished one, prepared by the service. */
export type CapturePhase = 'idle' | 'requesting' | 'capturing' | 'uploading' | 'preparing' | 'ready' | 'failed';

/** What the panel is told about the capture. */
export interface CaptureState {
  phase: CapturePhase;
  /** Share of the video heard so far, 0 to 1. */
  coverage: number;
  /** Longest unheard stretch, seconds. */
  largestGapS: number;
  /** Share of the upload sent, 0 to 1. */
  uploadFraction: number;
  /** Why it failed, or what the singer should do; empty otherwise. */
  message: string;
}

/** The state of a page that has not captured anything. */
export function initialCapture(): CaptureState {
  return { phase: 'idle', coverage: 0, largestGapS: 0, uploadFraction: 0, message: '' };
}

/** What happens to a capture. */
export type CaptureEvent =
  | { type: 'start' }
  | { type: 'stream'; hasAudio: boolean }
  | { type: 'progress'; coverage: number; largestGapS: number }
  | { type: 'finish'; reason: 'ended' | 'stop' }
  | { type: 'upload-progress'; fraction: number }
  | { type: 'uploaded' }
  | { type: 'prepared'; note?: string }
  | { type: 'fail'; message: string }
  | { type: 'reset' };

/** Said when the share did not carry the tab's sound. */
export const NO_AUDIO_MESSAGE =
  "No sound came with the share. Share this tab with 'Share tab audio' on, then try again.";
/** Said when the video ended with too little of it heard. */
export function tooLittleMessage(coverage: number): string {
  const percent = Math.round(coverage * 100);
  return (
    `Only ${percent}% of the video was heard (it was skipped over, or an ad ` +
    'ran). Capture again and let it play through.'
  );
}

/** The least coverage a video that has played to its end may have. */
export const MIN_END_COVERAGE = 0.5;

/** Whether Stop is on offer: capturing, with most of the video heard. */
export function canStop(state: CaptureState): boolean {
  return state.phase === 'capturing' && state.coverage >= MIN_STOP_COVERAGE;
}

/** Whether a video that has ended has enough of it to be sent. */
export function usableAtEnd(coverage: number): boolean {
  return coverage >= MIN_END_COVERAGE;
}

/** True from the press of the button until the capture has been handed on. */
export function isCapturing(state: CaptureState): boolean {
  return state.phase === 'requesting' || state.phase === 'capturing' || state.phase === 'uploading';
}

/** The next state; an event that does not fit the phase changes nothing. */
export function captureReducer(state: CaptureState, event: CaptureEvent): CaptureState {
  switch (event.type) {
    case 'start':
      return isCapturing(state) || state.phase === 'preparing'
        ? state
        : { ...initialCapture(), phase: 'requesting' };
    case 'stream':
      if (state.phase !== 'requesting') return state;
      return event.hasAudio
        ? { ...state, phase: 'capturing' }
        : { ...initialCapture(), phase: 'failed', message: NO_AUDIO_MESSAGE };
    case 'progress':
      return state.phase === 'capturing'
        ? { ...state, coverage: event.coverage, largestGapS: event.largestGapS }
        : state;
    case 'finish':
      if (state.phase !== 'capturing') return state;
      if (event.reason === 'stop' && !canStop(state)) return state;
      if (event.reason === 'ended' && !usableAtEnd(state.coverage)) {
        return { ...state, phase: 'failed', message: tooLittleMessage(state.coverage) };
      }
      return { ...state, phase: 'uploading', uploadFraction: 0 };
    case 'upload-progress':
      return state.phase === 'uploading' ? { ...state, uploadFraction: event.fraction } : state;
    case 'uploaded':
      return state.phase === 'uploading' ? { ...state, phase: 'preparing', uploadFraction: 1 } : state;
    case 'prepared':
      return state.phase === 'preparing' ? { ...state, phase: 'ready', message: event.note ?? '' } : state;
    case 'fail':
      return state.phase === 'idle' || state.phase === 'ready'
        ? state
        : { ...state, phase: 'failed', message: event.message };
    case 'reset':
      return initialCapture();
  }
}

/** The label of the button that starts a capture. */
export const CAPTURE_LABEL = 'Capture for learning';
/** The label of the button that ends one early. */
export const STOP_LABEL = 'Stop capture';
/** The one line on what it does, shown while the capture is on offer. */
export const CAPTURE_NOTE =
  "Records this video's sound from this tab while it plays once, and sends it " +
  'to the local service to find the melody and key. Like Prepare, it uses the ' +
  "video's audio beyond YouTube's player, so it is off until you press it.";
/** Why the button is off when the browser cannot share a tab's sound. */
export const UNSUPPORTED_TITLE = 'This browser cannot share a tab with its sound. Use Chrome or Edge.';
/** Why the button is off while Prepare or the service check holds the song. */
export const BUSY_TITLE = 'Wait for the service check or the preparation to finish.';

/** What the panel shows for a CaptureState. */
export interface CaptureView {
  visible: boolean;
  label: string;
  disabled: boolean;
  title: string;
  /** The Stop button is shown only while capturing. */
  showStop: boolean;
  stopDisabled: boolean;
  /** The status line; empty when there is none. */
  line: string;
  note: string;
}

/** What the page knows besides the capture itself. */
export interface CaptureContext {
  /** The linked song's preparation phase. */
  prepare: PreparePhase;
  /** True when the browser can share a tab's sound (or the test seam is on). */
  supported: boolean;
}

function percent(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 100);
}

/** The status line for a state; plain, and says why when it failed. */
export function captureLine(state: CaptureState): string {
  switch (state.phase) {
    case 'idle':
      return '';
    case 'requesting':
      return "Choose this tab in the share dialog, with 'Share tab audio' on.";
    case 'capturing': {
      const gap = state.largestGapS >= 1 ? `, largest gap ${Math.round(state.largestGapS)} s` : '';
      const stop =
        state.coverage === 0
          ? ' Press Play on the video if it has not started.'
          : canStop(state)
            ? ''
            : ' Let the video play through.';
      return `Capturing: ${percent(state.coverage)}% of the video heard${gap}.${stop}`;
    }
    case 'uploading':
      return `Uploading the capture: ${percent(state.uploadFraction)}%`;
    case 'preparing':
      return 'Capture sent. Preparing the melody and key.';
    case 'ready':
      return state.message || 'Capture done: the song is prepared.';
    case 'failed':
      return state.message;
  }
}

/** The button, Stop button and lines for a capture and what surrounds it. */
export function describeCapture(state: CaptureState, context: CaptureContext): CaptureView {
  const active = isCapturing(state) || state.phase === 'preparing';
  const offered = context.prepare === 'ready' || context.prepare === 'failed';
  const waiting = context.prepare === 'checking' || context.prepare === 'unavailable';
  const visible = active || offered || waiting;
  let title = CAPTURE_NOTE;
  let disabled = false;
  if (active) {
    disabled = true;
    title = '';
  } else if (!context.supported) {
    disabled = true;
    title = UNSUPPORTED_TITLE;
  } else if (!offered) {
    disabled = true;
    title = BUSY_TITLE;
  }
  return {
    visible,
    label: CAPTURE_LABEL,
    disabled,
    title,
    showStop: state.phase === 'capturing',
    stopDisabled: !canStop(state),
    line: captureLine(state),
    note: active || state.phase === 'failed' ? '' : CAPTURE_NOTE,
  };
}
