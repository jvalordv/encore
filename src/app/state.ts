/**
 * The one state object the UI reads from, and the store that owns it. The
 * state is a plain mutable object (same shape as the owner's StateStore in
 * 4th-dimension): the Session writes it through `patch`, and every change is
 * announced with the set of keys that changed, so a listener redraws only what
 * moved. Nothing here knows about Web Audio or the DOM, which keeps the store
 * usable from a native shell later (see "Built to become an app" in
 * docs/ARCHITECTURE.md). The selectors at the bottom turn state into the
 * strings the status bar and readouts show, so those can be tested too.
 */
import { hzToMidi } from '../analysis/pitch';
import type { PitchFrame } from '../analysis/pitch';
import type { MonitorMode } from '../audio/mic';
import type { ClockKind, LoopRegion, TrackInfo, TransportState } from '../audio/transport';
import { noteName } from '../render/lane-geometry';
import { initialKaraoke } from './karaoke';
import type { KaraokeState } from './karaoke';
import { initialMix } from './mix';
import type { MixState } from './mix';
import { initialPrepare } from './prepare';
import type { PrepareState } from './prepare';
import { initialReference } from './reference';
import type { ReferenceState } from './reference';
import { initialSearch } from './search';
import type { PickedResult, SearchState } from './search';
import { DEFAULT_GUIDE_LEVEL } from './settings';
import type { PracticeMode } from './settings';
import type { TakeSummary } from './takes';

/** How loudly the status line should speak. */
export type StatusKind = 'info' | 'warn' | 'error';

/** The mic a singer sings into, as the UI shows it. */
export interface InputState {
  deviceId: string | null;
  label: string;
  open: boolean;
  /** Peak level 0..1, smoothed by the Session for display. */
  level: number;
  /** What the browser really applied; null while unknown. */
  processing: { aec: boolean | null; ns: boolean | null; agc: boolean | null };
  /** How the singer monitors the song; the saved choice, open or not. */
  monitor: MonitorMode;
  /**
   * True when the open mic was asked for echo cancellation. Differs from
   * `monitor` only while calibration borrows a raw mic. Compare with
   * `processing.aec` to see whether the browser honoured the request.
   */
  requestedAec: boolean;
}

/** One singer: today just the mic; scoring and a second mic hang off this. */
export interface SingerState {
  /** Position in `AppState.singers`; the id frames on the bus carry. */
  id: number;
  input: InputState;
}

/** Everything the UI shows; the Session is the only writer. */
export interface AppState {
  /** The loaded song, whatever supplies it: a file or a YouTube video. */
  song: TrackInfo | null;
  /** State of the active transport (the audio player or the YouTube embed). */
  player: TransportState;
  /** The clock the song runs on; 'embed' while a YouTube video plays it. */
  clock: ClockKind;
  /**
   * The YouTube video the pane shows: the one that is the song, or, while no
   * video is the song yet, the one loading. Null hides the player pane.
   */
  embed: { videoId: string } | null;
  /** Seconds added to the latency while the clock is 'embed'. */
  embedOffsetS: number;
  /**
   * Where the linked song stands on the way to prepared audio, and what the
   * song panel says about it. Phase 'none' while no video is the song.
   */
  prepare: PrepareState;
  /**
   * Where the song stands on the way to its karaoke track (upload, the
   * service's steps, the stems), whatever the song's source.
   */
  karaoke: KaraokeState;
  /** The karaoke mix: whether the stems are in, what plays, the guide level. */
  mix: MixState;
  /** The reference melody the lane draws, or why there is none. */
  reference: ReferenceState;
  /** The song search: the chip, the words, the results, what to tell. */
  search: SearchState;
  /**
   * Karaoke (never judges) or learning (scores against the original). Mirrors
   * `settings.mode`; the Session is the one that changes both.
   */
  mode: PracticeMode;
  /** The search result that became the song, or null for a file or a link. */
  pickedResult: PickedResult | null;
  /**
   * The take whose report card is open, or null. The card is shown only in
   * learning mode and only for a take that has a report.
   */
  reportTakeId: string | null;
  positionS: number;
  loop: LoopRegion | null;
  durationS: number;
  input: InputState;
  /**
   * The singers, one entry for now. Entry 0 shares its `input` object with
   * the field above, which the store keeps in step (patchSection).
   */
  singers: SingerState[];
  output: { deviceId: string | null; label: string; selectable: boolean };
  /** Round-trip latency for the current device pair; null when not set. */
  latencyS: number | null;
  calibrating: boolean;
  tracker: 'unsupported' | 'idle' | 'running';
  framesPerSecond: number;
  lastFrame: PitchFrame | null;
  recording: boolean;
  /** Takes of the loaded song, newest first. */
  takes: TakeSummary[];
  playingTakeId: string | null;
  status: { text: string; kind: StatusKind };
}

/** Called after a change with the keys that changed. */
export type Listener = (state: AppState, changed: ReadonlySet<keyof AppState>) => void;

/** A fresh state for a page that has just loaded: nothing open, nothing set. */
export function initialState(): AppState {
  const input: InputState = {
    deviceId: null,
    label: '',
    open: false,
    level: 0,
    processing: { aec: null, ns: null, agc: null },
    monitor: 'headphones',
    requestedAec: false,
  };
  return {
    song: null,
    player: 'empty',
    clock: 'engine',
    embed: null,
    embedOffsetS: 0,
    prepare: initialPrepare(),
    karaoke: initialKaraoke(),
    mix: initialMix(DEFAULT_GUIDE_LEVEL),
    reference: initialReference(),
    search: initialSearch('karaoke', false),
    mode: 'karaoke',
    pickedResult: null,
    reportTakeId: null,
    positionS: 0,
    loop: null,
    durationS: 0,
    input,
    singers: [{ id: 0, input }],
    output: { deviceId: null, label: '', selectable: false },
    latencyS: null,
    calibrating: false,
    tracker: 'idle',
    framesPerSecond: 0,
    lastFrame: null,
    recording: false,
    takes: [],
    playingTakeId: null,
    status: { text: '', kind: 'info' },
  };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Structural equality for primitives and nested plain objects only. */
function samePlain(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!isPlain(a) || !isPlain(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && samePlain(a[k], b[k]));
}

/** Holds the AppState and tells subscribers what changed. */
export class StateStore {
  readonly state: AppState;
  private readonly listeners = new Set<Listener>();

  constructor(initial: AppState = initialState()) {
    this.state = initial;
  }

  /** Registers a listener; returns the function that removes it. */
  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  /**
   * Shallow-merges `p` into the state and notifies once with the keys whose
   * value changed (Object.is). Does nothing, and tells nobody, when no key
   * changed. Keys the state does not have, and undefined values, are ignored.
   */
  patch(p: Partial<AppState>): void {
    const target = this.state as unknown as Record<string, unknown>;
    const changed = new Set<keyof AppState>();
    for (const key of Object.keys(p) as Array<keyof AppState>) {
      const value = p[key];
      if (value === undefined || !(key in target)) continue;
      if (Object.is(target[key], value)) continue;
      target[key] = value;
      changed.add(key);
    }
    if (changed.size > 0) this.notify(changed);
  }

  /**
   * Like `patch`, for the nested `input` and `output` objects: merges the
   * fields and compares by content, so rewriting the same device name does not
   * wake the UI. Callers pass whole `processing` objects, not parts of one.
   */
  patchSection<K extends 'input' | 'output'>(key: K, p: Partial<AppState[K]>): void {
    const current = this.state[key];
    const next = { ...current, ...p } as AppState[K];
    if (samePlain(current, next)) return;
    const [first, ...others] = this.state.singers;
    if (key === 'input' && first) {
      // The first singer's mic is the same object, so it moves with `input`.
      const singers = [{ ...first, input: next as InputState }, ...others];
      this.patch({ input: next as InputState, singers });
    } else {
      this.patch({ [key]: next } as Partial<AppState>);
    }
  }

  /** Sets the status line; repeating the same message is not a change. */
  setStatus(text: string, kind: StatusKind = 'info'): void {
    const { status } = this.state;
    if (status.text === text && status.kind === kind) return;
    this.patch({ status: { text, kind } });
  }

  private notify(changed: ReadonlySet<keyof AppState>): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state, changed);
      } catch (err) {
        // One broken view must not stop the others from learning of a change.
        console.error('State listener failed', err);
      }
    }
  }
}

/** Floor of the level meter: anything quieter reads as empty. */
const METER_FLOOR_DB = -60;

/** Mic peak (0..1) as a 0..1 meter fill on a decibel scale, -60 dB to 0 dB. */
export function meterFraction(level: number): number {
  if (!(level > 0)) return 0;
  const db = 20 * Math.log10(Math.min(level, 1));
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / -METER_FLOOR_DB));
}

/** `m:ss`, or `h:mm:ss` from an hour up; negative and NaN read as 0:00. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const ss = String(total % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** Latency for display: whole milliseconds, or "not set". */
export function formatLatency(latencyS: number | null): string {
  return latencyS === null ? 'not set' : `${Math.round(latencyS * 1000)} ms`;
}

/** The device, latency and tracker readout for the right of the status bar. */
export function describeHealth(state: AppState): string {
  const mic = state.input.open ? state.input.label || 'open' : 'off';
  let tracker: string;
  if (state.tracker === 'unsupported') tracker = 'unavailable';
  else if (state.tracker === 'idle') tracker = 'idle';
  else tracker = `${Math.round(state.framesPerSecond)} fps`;
  return [
    `mic: ${mic}`,
    `out: ${state.output.label || 'default'}`,
    `latency: ${formatLatency(state.latencyS)}`,
    `tracker: ${tracker}`,
  ].join(' · ');
}

/** What the mic line and status bar say about the open mic's processing. */
export interface MonitorReport {
  text: string;
  /** 'warn' when the browser did not do what was asked of it. */
  kind: StatusKind;
}

/**
 * Whether the browser did what the open mic asked of it, in words: raw input
 * for headphones; echo cancellation on with noise suppression and auto gain
 * off for speakers. Null while no mic is open or when a raw mic reports
 * nothing either way.
 */
export function describeMonitor(input: AppState['input']): MonitorReport | null {
  if (!input.open) return null;
  const { aec, ns, agc } = input.processing;
  if (!input.requestedAec) {
    const on = [aec && 'echo cancel', ns && 'noise suppression', agc && 'auto gain'].filter(Boolean);
    if (on.length > 0) return { text: `Browser processing on: ${on.join(', ')}`, kind: 'warn' };
    return aec === false && ns === false && agc === false
      ? { text: 'Raw input: processing off', kind: 'info' }
      : null;
  }
  if (aec === false) {
    return {
      text: 'Speaker mode requested but this browser kept echo cancellation off: the song may bleed into your pitch',
      kind: 'warn',
    };
  }
  if (aec === null) {
    return {
      text: 'Speaker mode: echo cancellation requested, but this browser does not say whether it is on',
      kind: 'info',
    };
  }
  // NS and AGC smooth dynamics, so a browser that insists on them costs
  // coaching quality even though the song is being cancelled.
  const extra = [ns && 'noise suppression', agc && 'auto gain'].filter(Boolean);
  if (extra.length > 0) {
    return {
      text: `Speaker mode: echo cancellation on, but the browser also kept ${extra.join(' and ')} on, which flattens dynamics`,
      kind: 'warn',
    };
  }
  return { text: 'Speaker mode: echo cancellation on, NS/AGC off', kind: 'info' };
}

/** What the singer is hitting right now: nearest note and cents off it. */
export interface PitchReadout {
  note: string;
  /** Signed distance from the nearest semitone, -50..50. */
  cents: number;
  hz: number;
}

/** The readout for a voiced frame, or null for silence and unvoiced frames. */
export function describePitch(frame: PitchFrame | null): PitchReadout | null {
  if (!frame || !(frame.f0 > 0)) return null;
  const midi = hzToMidi(frame.f0);
  if (!Number.isFinite(midi)) return null;
  const nearest = Math.round(midi);
  // `|| 0` turns -0 into 0 so "-0 cents" never shows.
  return { note: noteName(nearest), cents: Math.round((midi - nearest) * 100) || 0, hz: frame.f0 };
}

/** Said after a failed load while the song that was loaded before stays. */
const SONG_KEPT = 'The previous song is still loaded.';

/**
 * The status line for a file or link that failed to load. A failed load
 * leaves the song in use as it was, and it may still be playing; an error
 * alone beside a playing song reads as if that song had gone, so the line
 * says it is still there. `reason` is the failure in the singer's words.
 */
export function describeLoadFailure(reason: string, songKept: boolean): string {
  if (!songKept) return reason;
  const text = reason.trimEnd();
  return `${text}${/[.!?…]$/.test(text) ? '' : '.'} ${SONG_KEPT}`;
}
