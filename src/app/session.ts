/**
 * The Session owns every long-lived object of the practice loop (audio
 * engine, player, mic, tracker, recorder, take store, settings) and the
 * StateStore the UI reads. The UI never touches those objects; it calls the
 * intents here (loadSong, loadLink, play, chooseInput, calibrate,
 * toggleRecord, ...) and renders the state they leave behind. That is also
 * what makes the shell portable: a native window only has to call the same
 * intents (see "Built to become an app" in docs/ARCHITECTURE.md).
 *
 * The song comes from one of two transports (src/audio/transport.ts): the
 * audio Player for a dropped file, or a YouTubeTransport for a pasted link.
 * Exactly one is active, and everything that needs the song's position or
 * state (the lane, recording, loop A/B, the seek bar, the clock readout)
 * reads the active one; loading a file or a link swaps it once it is ready,
 * and a load that fails leaves the song in use as it was.
 *
 * Browsers want a user gesture before they start audio or open a mic, so each
 * intent that needs one does it itself and is meant to be called straight from
 * a click or key handler. Song time is the master clock: tracker frames arrive
 * stamped with context time and are moved onto song time, minus the calibrated
 * round-trip latency (and, for a YouTube video, the embed offset), before they
 * reach the lane or a take. The maths for that is in the pure exports at the
 * top (frameToSongTime and friends), tested without any audio. Importing this
 * file touches no browser API.
 */
import type { PitchFrame } from '../analysis/pitch';
import { PitchTracker } from '../analysis/pitch-tracker';
import { PcmCapture } from '../audio/capture';
import { AudioEngine, listOutputDevices } from '../audio/engine';
import { CalibrationError, describeLatency, latencyKey, measureLatency } from '../audio/latency';
import type { LatencyResult } from '../audio/latency';
import { classifyMicError, listInputDevices, MicCapture, onDeviceChange } from '../audio/mic';
import type { InputDevice, MonitorMode } from '../audio/mic';
import { normaliseLoop, Player } from '../audio/player';
import type { SongInfo } from '../audio/player';
import { Recorder } from '../audio/recorder';
import type { TakeRecording } from '../audio/recorder';
import { isRunning } from '../audio/transport';
import type {
  ClockKind,
  LoopRegion,
  TrackInfo,
  Transport,
  TransportEvent,
  TransportState,
} from '../audio/transport';
import { decodeWav, encodeWavBlob, songTimeOfSample } from '../audio/wav';
import { loadYouTubeApi } from '../audio/youtube-api';
import type { YouTubeApi } from '../audio/youtube-api';
import { EmbedClosedError, YouTubeTransport } from '../audio/youtube-transport';
import type { EmbedHost } from '../audio/youtube-transport';
import { parseYouTubeUrl } from '../audio/youtube-url';
import type { PitchLane } from '../render/pitch-lane';
import {
  clampEmbedOffsetS,
  loadSettings,
  MAX_EMBED_OFFSET_S,
  MAX_LATENCY_S,
  saveSettings,
} from './settings';
import type { Settings } from './settings';
import { describeLoadFailure, describeMonitor, formatClock, StateStore } from './state';
import type { AppState } from './state';
import { localStorageStore } from './storage';
import type { KeyValueStore } from './storage';
import { memoryTakeStore, openTakeStore } from './takes';
import type { TakeRecord, TakeStore } from './takes';

/** Stem ids; 'original' is the player's own and is never removed. */
const ORIGINAL_STEM = 'original';
const TAKE_STEM = 'take';
/** Every event a transport can send; the Session listens to all of them. */
const TRANSPORT_EVENTS: readonly TransportEvent[] = [
  'load',
  'play',
  'pause',
  'seek',
  'ended',
  'loop',
  'state',
];
/** Level of the song while a take plays over it, so the voice stays clear. */
export const DUCKED_ORIGINAL_GAIN = 0.6;
/** Seconds of song heard before the take's first sample when it is played. */
const TAKE_LEAD_IN_S = 1;
/** Length of the loop made by pressing A or B with no loop yet, seconds. */
export const DEFAULT_LOOP_S = 8;
/** How often the tick loop writes position, level and tracker health. */
const PATCH_INTERVAL_MS = 50;
/** The meter falls to this share of its last value per patch. */
const LEVEL_DECAY = 0.8;
/** Wait after starting the song so its sources are really running. */
const RECORD_LEAD_MS = 60;
/** Seconds of take trace redrawn behind the playhead after a seek. */
const REPLAY_BACK_S = 6;
/** A replay frame this far ahead of the playhead means time ran backwards. */
const REPLAY_SLACK_S = 0.05;
/** Calibrations under this confidence are reported with a warning. */
const LOW_CONFIDENCE = 0.6;
/** Said when headphone mode opened a mic the browser still processes. */
const PROCESSING_KEPT_ON =
  'This browser kept voice processing on for that mic, which flattens dynamics. Try another input.';
/** Longest wait for a video to start when Record has to press Play for it. */
const EMBED_START_TIMEOUT_MS = 4000;
/** Said while an advertisement is in the video player. */
const AD_STATUS = 'An ad is playing in the video. Nothing is drawn or recorded until it ends.';
/** The same, shorter, across the pitch lane. */
const AD_LANE_NOTICE = 'Ad playing: pitch is paused';

/**
 * Song time of a pitch frame. The frame was stamped `frameT` on the context
 * clock; the song was at `positionNow` when the context read `contextNow`, and
 * the singer was reacting to audio that left the speakers `latencyS` before
 * the mic stamped it. `embedOffsetS` is extra delay for the path calibration
 * cannot measure (a YouTube video's own audio output); it is 0 for a file.
 * Inside a loop, a frame from just before a wrap is folded back into the
 * previous pass instead of landing before the loop's start.
 */
export function frameToSongTime(
  frameT: number,
  contextNow: number,
  positionNow: number,
  latencyS: number,
  loop: LoopRegion | null = null,
  embedOffsetS = 0,
): number {
  const songTime = positionNow - (contextNow - frameT) - latencyS - embedOffsetS;
  if (!loop || loop.endS <= loop.startS) return songTime;
  const inside = positionNow >= loop.startS && positionNow < loop.endS;
  if (!inside || songTime >= loop.startS) return songTime;
  const length = loop.endS - loop.startS;
  const into = (songTime - loop.startS) % length;
  return loop.startS + (into < 0 ? into + length : into);
}

/** A frame this close behind the one before it is clock jitter, not a seek. */
export const FRAME_JITTER_S = 0.05;
/** How far past the previous frame a jittered frame is placed. */
const FRAME_STEP_S = 1e-6;

/**
 * Keeps the stamps of an embedded video's frames in order. The video's clock
 * runs smoothly while the audio context's is read in steps of a buffer, about
 * 10 ms, so two frames can come out a few milliseconds the wrong way round. A
 * frame less than FRAME_JITTER_S behind the one before it is put just after
 * it; a bigger step back is a seek or a loop wrap and is left alone.
 */
export function orderedFrameTime(t: number, previousT: number): number {
  return t <= previousT && previousT - t < FRAME_JITTER_S ? previousT + FRAME_STEP_S : t;
}

/** Index of the first frame at or after `t`; frames must be sorted by t. */
export function firstFrameIndex(frames: ReadonlyArray<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The loop after the A or B button is pressed at `positionS`: A moves the
 * start (keeping the end if it is still ahead), B moves the end. With no loop
 * yet, the other end is a default stretch away. Null when the result is too
 * short or not a number.
 */
export function loopWithPoint(
  which: 'a' | 'b',
  positionS: number,
  current: LoopRegion | null,
  durationS: number,
): LoopRegion | null {
  const region =
    which === 'a'
      ? {
          startS: positionS,
          endS: current && current.endS > positionS ? current.endS : positionS + DEFAULT_LOOP_S,
        }
      : {
          startS:
            current && current.startS < positionS ? current.startS : positionS - DEFAULT_LOOP_S,
          endS: positionS,
        };
  return normaliseLoop(region, durationS);
}

/** The lane methods the Session drives; PitchLane satisfies them. */
export type LaneSink = Pick<PitchLane, 'setTime' | 'pushFrame' | 'clearFrames' | 'setNotice'>;

/** The audio objects behind the Session, exposed for tests and debugging. */
export interface SessionParts {
  engine: AudioEngine;
  player: Player;
  mic: MicCapture;
  capture: PcmCapture;
  tracker: PitchTracker;
  recorder: Recorder;
}

/** Everything injectable; the defaults are the real browser services. */
export interface SessionOptions {
  /** Where settings persist; default is localStorage under `encore.`. */
  settings?: KeyValueStore;
  /** Take storage; default is IndexedDB with a memory fallback. */
  takes?: TakeStore | Promise<TakeStore>;
  /** State to write into; default is a fresh store. */
  store?: StateStore;
  /**
   * Loads the YouTube IFrame API when a link is first used; the default
   * fetches Google's script. Tests and the end-to-end run substitute a stub.
   */
  youtubeApi?: () => Promise<YouTubeApi>;
}

/** What openInput says once open: the plain line, the mode's line, or none. */
type Announce = 'ready' | 'monitor' | 'none';

/** How openInput ended; a failure has already put its reason on screen. */
type OpenOutcome = 'open' | 'failed' | 'superseded';

/** Devices the browser currently offers. */
export interface DeviceLists {
  inputs: InputDevice[];
  outputs: MediaDeviceInfo[];
}

/** A take being replayed: its f0 trace, fed to the lane as the song plays. */
interface Replay {
  frames: PitchFrame[];
  next: number;
}

/**
 * A take playing by itself, over no song: what replaying a take under a
 * YouTube video does, since the video's sound cannot be mixed with it. The
 * playhead is the take's own, on song time.
 */
interface SoloTake {
  source: AudioBufferSourceNode;
  /** Context time at which the take's first sample plays. */
  startedAtContextS: number;
  /** Song time of the take's first sample, with its latency shift applied. */
  offsetS: number;
}

/** What a recording in progress needs to remember until it is saved. */
interface Recording {
  song: TrackInfo;
  /** True when Record started the song, so stopping Record pauses it again. */
  startedPlayback: boolean;
  /** The clock the song time came from, kept with the take. */
  clock: ClockKind;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** The page's origin, which the YouTube iframe wants; empty outside a page. */
function pageOrigin(): string {
  return globalThis.location?.origin ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Owns the practice loop's objects and turns UI intents into state. */
export class Session {
  /** The state the UI renders; subscribe to it for changes. */
  readonly store: StateStore;
  /** The audio objects, or null when this browser has no Web Audio. */
  readonly parts: SessionParts | null;

  private readonly settingsStore: KeyValueStore;
  private current: Settings;
  private readonly takesReady: Promise<TakeStore>;
  // Both worklet users have to be available, or live pitch and recording are
  // off together and the status line says why.
  private readonly trackerSupported = PitchTracker.isSupported() && PcmCapture.isSupported();
  private lane: LaneSink | null = null;
  private devices: DeviceLists = { inputs: [], outputs: [] };
  private readonly deviceListeners = new Set<(devices: DeviceLists) => void>();
  private stopDeviceWatch: (() => void) | null = null;
  private running = false;
  private rafId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastPatchMs = -Infinity;
  private level = 0;
  private latestFrame: PitchFrame | null = null;
  // Song time of the last frame stamped, to keep an embed's stamps in order.
  private lastFrameT = Number.NEGATIVE_INFINITY;
  // Bumped by every open and close of the mic, so a slow permission prompt
  // that finishes after a newer choice cannot overwrite it.
  private inputToken = 0;
  private opening = false;
  private loadToken = 0;
  private startingRecord = false;
  private recording: Recording | null = null;
  private takeFrames: PitchFrame[] | null = null;
  private finishing: Promise<void> | null = null;
  private replay: Replay | null = null;
  private solo: SoloTake | null = null;
  // The transport everything reads: the audio player, or the YouTube embed
  // once a link has loaded. Null only when this browser has no Web Audio.
  private active: Transport | null = null;
  // The YouTube transport that is the song, or null. Another may be loading
  // behind it (`loadingEmbed`) and takes over only once it is ready, so a link
  // that fails to load costs the song in use nothing.
  private embed: YouTubeTransport | null = null;
  private loadingEmbed: YouTubeTransport | null = null;
  private embedHost: EmbedHost | null = null;
  private readonly loadApi: () => Promise<YouTubeApi>;
  // The state the last sync saw, to notice an ad starting or ending.
  private lastState: TransportState = 'empty';

  constructor(options: SessionOptions = {}) {
    this.store = options.store ?? new StateStore();
    this.settingsStore = options.settings ?? localStorageStore();
    this.current = loadSettings(this.settingsStore);
    this.takesReady = Promise.resolve(options.takes ?? openTakeStore()).catch(() => memoryTakeStore());
    this.loadApi = options.youtubeApi ?? (() => loadYouTubeApi());
    this.parts = this.buildParts();
    this.active = this.parts?.player ?? null;

    const sinkCapable = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    this.store.patch({
      tracker: this.trackerSupported ? 'idle' : 'unsupported',
      embedOffsetS: this.current.embedOffsetS,
    });
    this.store.patchSection('input', {
      deviceId: this.current.inputDeviceId,
      monitor: this.current.monitor,
    });
    this.store.patchSection('output', { selectable: this.parts !== null && sinkCapable });
    this.refreshLatency();
    if (this.parts) this.wire(this.parts);
  }

  /** The settings as saved; changing the returned object changes nothing. */
  get settings(): Readonly<Settings> {
    return this.current;
  }

  /** The devices seen by the last refreshDevices(). */
  get deviceLists(): DeviceLists {
    return this.devices;
  }

  /** The active transport (audio player or YouTube); null without Web Audio. */
  get transport(): Transport | null {
    return this.active;
  }

  /** Hands the Session the lane it should scroll and feed. */
  attachLane(lane: LaneSink): void {
    this.lane = lane;
    lane.setTime(this.currentPosition());
  }

  /**
   * Hands the Session the pane the YouTube player is built into. Without one a
   * pasted link is refused; null takes it away again.
   */
  attachEmbedHost(host: EmbedHost | null): void {
    this.embedHost = host;
  }

  /**
   * Begins the per-frame loop that moves the lane and writes position, level
   * and tracker health, starts watching for devices coming and going, and
   * restores the saved output device. Safe to call twice.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopDeviceWatch = onDeviceChange(() => void this.refreshDevices());
    void this.restoreOutput().then(() => this.refreshDevices());
    const frame = (nowMs: number): void => {
      if (!this.running) return;
      this.tick(nowMs);
      this.schedule(frame);
    };
    this.schedule(frame);
  }

  /** Stops the loop, the device watch, the YouTube player and the mic. */
  dispose(): void {
    this.running = false;
    if (this.rafId !== null) globalThis.cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.rafId = this.timerId = null;
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
    this.stopSolo();
    this.discardLoadingEmbed();
    this.disposeEmbed();
    this.parts?.tracker.disconnect();
    this.parts?.mic.close();
  }

  /** Subscribes to device list changes; returns the unsubscribe function. */
  onDevices(cb: (devices: DeviceLists) => void): () => void {
    this.deviceListeners.add(cb);
    return () => {
      this.deviceListeners.delete(cb);
    };
  }

  /** Re-reads the input and output devices and tells the listeners. */
  async refreshDevices(): Promise<DeviceLists> {
    const [inputs, outputs] = await Promise.all([listInputDevices(), listOutputDevices()]);
    this.devices = { inputs, outputs };
    const { input, output } = this.store.state;
    this.store.patchSection('output', { label: this.outputLabel(output.deviceId) });
    if (input.open && this.parts) this.store.patchSection('input', { label: this.parts.mic.label });
    for (const cb of [...this.deviceListeners]) cb(this.devices);
    return this.devices;
  }

  // ---- Song and transport -------------------------------------------------

  /** Decodes and loads a dropped or picked audio file. */
  async loadSong(file: File): Promise<void> {
    const parts = this.parts;
    if (!parts) return;
    const token = ++this.loadToken;
    // A link still loading is overtaken by this file, whatever comes of it.
    this.discardLoadingEmbed();
    if (this.store.state.recording) await this.finishRecording();
    this.store.setStatus(`Loading ${file.name}…`);
    let info: SongInfo;
    try {
      info = await parts.player.load(file);
    } catch (error) {
      this.reportLoadFailure(token, error);
      return;
    }
    if (token !== this.loadToken) return;
    // A file replaces any YouTube video, and the audio player is the
    // transport again; load() already dropped its stems, so a take that was
    // replaying is gone, and is forgotten here too. A take begun on the video
    // while the file decoded ends with it: closing the player sends no event.
    if (this.store.state.recording) void this.finishRecording();
    this.disposeEmbed();
    this.activate(parts.player);
    this.endReplay();
    this.lane?.clearFrames();
    await this.refreshTakes();
    const next = this.store.state.input.open ? 'Press Space to play.' : 'Pick a microphone, then press Play.';
    this.store.setStatus(`Loaded ${info.name} (${formatClock(info.durationS)}). ${next}`);
  }

  /**
   * Loads a pasted YouTube link into the embedded player and makes it the
   * song, the way loadSong does for a file: a recording in progress is
   * finished, a newer load wins over an older one, the lane is cleared and the
   * takes are those of the video. The API script is fetched now, on first use.
   * The song in use, a file or another video, stays as it is and stays
   * playable until the new video is ready, so a link that cannot be loaded
   * leaves it alone, as a bad file does. Nothing plays until Play is pressed.
   */
  async loadLink(text: string): Promise<void> {
    const parts = this.parts;
    if (!parts) return;
    const link = parseYouTubeUrl(text);
    if (!link) {
      this.store.setStatus('That does not look like a YouTube link.', 'warn');
      return;
    }
    const host = this.embedHost;
    if (!host) {
      this.store.setStatus('This page has no place to show the YouTube player.', 'error');
      return;
    }
    const token = ++this.loadToken;
    // A link still loading is overtaken by this one.
    this.discardLoadingEmbed();
    if (this.store.state.recording) await this.finishRecording();
    this.store.setStatus('Loading the YouTube video…');
    let api: YouTubeApi;
    try {
      api = await this.loadApi();
    } catch (error) {
      this.reportLoadFailure(token, error);
      return;
    }
    if (token !== this.loadToken) return;

    // The new player is built behind the one in use (the pane keeps it out of
    // reach), so the song carries on until this one is ready.
    const transport = new YouTubeTransport({ api, host, origin: pageOrigin() });
    this.loadingEmbed = transport;
    // With no video on the page yet, the pane opens now: a player loads with
    // the size it will have.
    if (this.embed === null) this.store.patch({ embed: { videoId: link.videoId } });
    this.watch(transport);
    transport.onNotice((notice) => {
      if (this.embed === transport) this.store.setStatus(notice.text, notice.kind);
    });
    let info: TrackInfo;
    try {
      info = await transport.load(link.videoId, link.startS);
    } catch (error) {
      // A newer load closed this player; it has already taken over.
      if (error instanceof EmbedClosedError) return;
      this.discardLoadingEmbed(transport);
      this.reportLoadFailure(token, error);
      return;
    }
    if (token !== this.loadToken || this.loadingEmbed !== transport) {
      this.discardLoadingEmbed(transport);
      return;
    }

    // Ready: it takes over from the song in use, which is paused and, if it
    // was a video, closed. A take begun on that song while this loaded ends
    // with it: closing the player sends no event.
    if (this.store.state.recording) void this.finishRecording();
    const previous = this.embed;
    this.loadingEmbed = null;
    this.embed = transport;
    this.store.patch({ embed: { videoId: link.videoId } });
    this.activate(transport);
    previous?.destroy();
    this.endReplay();
    this.lane?.clearFrames();
    // Said before the takes are read, so a message the player sends meanwhile
    // (it can still fail once cued) is the last word, not this one.
    const song = transport.info ?? info;
    const next = this.store.state.input.open ? 'Press Space to play.' : 'Pick a microphone, then press Play.';
    const length = song.durationS > 0 ? ` (${formatClock(song.durationS)})` : '';
    this.store.setStatus(`Loaded ${song.name}${length} from YouTube. ${next}`);
    await this.refreshTakes();
  }

  /** Plays, resuming the saved mic first if none is open. */
  play(): void {
    const parts = this.parts;
    const transport = this.active;
    if (!parts || !transport) return;
    if (transport.state === 'empty') {
      this.store.setStatus('Drop an audio file on the page or paste a YouTube link to start.');
      return;
    }
    // The song would drown the chirps; the Play button is already disabled,
    // and this keeps the Space key from starting it anyway.
    if (this.store.state.calibrating) return;
    // A take playing by itself yields to the song.
    if (this.solo) this.stopTake();
    // The audio player starts the context itself; the embed does not touch it,
    // and live pitch needs it running.
    if (transport.clock === 'embed') void parts.engine.resume().catch(() => {});
    transport.play();
    this.reopenSavedInput();
  }

  /** Pauses at the current position. */
  pause(): void {
    this.active?.pause();
  }

  /** Play when paused, pause when playing (or buffering, or in an ad). */
  togglePlay(): void {
    if (isRunning(this.store.state.player)) this.pause();
    else this.play();
  }

  /** Stops, ending any recording, and returns to the start. */
  stop(): void {
    if (this.store.state.recording) void this.finishRecording();
    if (this.solo) this.stopTake();
    this.active?.stop();
  }

  /** Moves the playhead to `s` seconds; this ends a recording in progress. */
  seek(s: number): void {
    if (!this.hasSong()) return;
    if (this.solo) this.stopTake();
    this.active?.seek(s);
  }

  /** Moves the playhead by `ds` seconds, negative for back. */
  nudge(ds: number): void {
    const transport = this.active;
    if (!transport || !this.hasSong()) return;
    if (this.solo) this.stopTake();
    transport.seek(transport.positionS + ds);
  }

  /**
   * Sets a loop from `a` to `b` seconds when both are given. With neither, it
   * clears the loop if there is one, else loops a short stretch from here.
   */
  toggleLoop(a?: number, b?: number): void {
    const transport = this.active;
    if (!transport || !this.hasSong() || !this.canEditLoop()) return;
    if (a !== undefined && b !== undefined) {
      this.applyLoop(normaliseLoop({ startS: a, endS: b }, this.store.state.durationS));
    } else if (transport.loop) {
      transport.setLoop(null);
      this.store.setStatus('Loop off.');
    } else {
      this.setLoopPoint('a');
    }
  }

  /** Marks the loop's start (A) or end (B) at the current position. */
  setLoopPoint(which: 'a' | 'b'): void {
    const transport = this.active;
    if (!transport || !this.hasSong() || !this.canEditLoop()) return;
    const { durationS } = this.store.state;
    const region = loopWithPoint(which, transport.positionS, transport.loop, durationS);
    if (!this.applyLoop(region)) return;
    // B is pressed at the playhead, so the loop ends where the song already
    // is. A run that starts past a loop's end plays on, so without this jump
    // the loop would never engage and the passage could not be repeated.
    const loop = transport.loop;
    if (which === 'b' && loop && transport.positionS >= loop.endS) transport.seek(loop.startS);
  }

  // ---- Devices and latency ------------------------------------------------

  /**
   * Opens a microphone (null or '' for the system default) in the saved
   * monitor mode and points the pitch tracker at it. Call from a click or key
   * press.
   */
  async chooseInput(id: string | null): Promise<void> {
    if (!this.parts) return;
    await this.openInput(id === '' ? null : id, this.current.monitor, 'ready');
  }

  /**
   * Chooses how the singer hears the song: headphones (raw mic) or speakers
   * (the browser cancels the song out of the mic). The choice is saved; an
   * open mic is reopened with the new constraints and handed back to the
   * tracker the way a device change is. Reopening cuts the stream a recording
   * or a calibration is reading, so both refuse it.
   */
  async setMonitor(mode: MonitorMode): Promise<void> {
    const parts = this.parts;
    if (!parts || (mode !== 'headphones' && mode !== 'speakers')) return;
    const { input, recording, calibrating } = this.store.state;
    if (recording || this.startingRecord) {
      this.store.setStatus('Stop recording before changing the monitor mode.', 'warn');
      return;
    }
    if (calibrating) {
      this.store.setStatus('Wait for calibration to finish before changing the monitor mode.', 'warn');
      return;
    }
    if (mode === this.current.monitor) return;
    this.current.monitor = mode;
    this.persist();
    this.store.patchSection('input', { monitor: mode });
    if (!input.open && !this.opening) {
      this.store.setStatus(
        mode === 'speakers'
          ? 'Speaker mode: echo cancellation will be on when the microphone opens.'
          : 'Headphone mode: the microphone will open raw.',
      );
      return;
    }
    await this.openInput(input.deviceId, mode, 'monitor');
  }

  /**
   * Opens `deviceId` with `mode`'s constraints, connects the tracker and
   * writes the result into the state. A newer open or close overtakes this
   * one, which then reports 'superseded' and leaves the state to its rival.
   */
  private async openInput(
    deviceId: string | null,
    mode: MonitorMode,
    announce: Announce,
  ): Promise<OpenOutcome> {
    const parts = this.parts;
    if (!parts) return 'failed';
    const token = ++this.inputToken;
    this.opening = true;
    this.store.patchSection('input', { deviceId });
    if (announce !== 'none') this.store.setStatus('Opening the microphone…');
    try {
      await parts.mic.open(deviceId, 1, mode);
    } catch (error) {
      if (token !== this.inputToken) return 'superseded';
      this.opening = false;
      this.markInputClosed();
      this.store.setStatus(classifyMicError(error).message, 'error');
      return 'failed';
    }
    if (token !== this.inputToken) return 'superseded';
    const source = parts.mic.source;
    if (!source) {
      this.opening = false;
      this.markInputClosed();
      return 'failed';
    }
    const tracking = await this.attachTracker(parts, source, token);
    if (token !== this.inputToken) return 'superseded';
    this.opening = false;

    const settings = parts.mic.settings;
    const processing = {
      aec: settings?.echoCancellation ?? null,
      ns: settings?.noiseSuppression ?? null,
      agc: settings?.autoGainControl ?? null,
    };
    this.store.patchSection('input', {
      deviceId,
      label: parts.mic.label,
      open: true,
      processing,
      requestedAec: mode === 'speakers',
    });
    this.store.patch({ tracker: tracking });
    this.current.inputDeviceId = deviceId;
    this.persist();
    this.refreshLatency();
    void this.refreshDevices();
    if (announce !== 'none') this.announceOpen(parts, tracking, announce);
    return 'open';
  }

  /** Puts the outcome of an open on the status line. */
  private announceOpen(parts: SessionParts, tracking: AppState['tracker'], announce: Announce): void {
    const { input } = this.store.state;
    const report = describeMonitor(input);
    if (report?.kind === 'warn') {
      this.store.setStatus(input.requestedAec ? report.text : PROCESSING_KEPT_ON, 'warn');
    } else if (tracking !== 'unsupported') {
      // A plain open names the mic; after a mode switch the mode's own line is
      // the answer to what the singer just did.
      const line = announce === 'monitor' || input.requestedAec ? report?.text : undefined;
      this.store.setStatus(line ?? `Microphone ready: ${parts.mic.label || 'default input'}.`);
    } else if (!this.trackerSupported) {
      // A failed worklet load has already said why; with no AudioWorklet at
      // all nothing has, and "Opening the microphone…" would stay up for ever.
      this.store.setStatus(
        'Microphone open, but this browser has no AudioWorklet, so live pitch and recording are off.',
        'warn',
      );
    }
  }

  /** Closes the microphone and the tracker, ending any recording first. */
  async closeInput(): Promise<void> {
    const parts = this.parts;
    if (!parts) return;
    if (this.store.state.recording) await this.finishRecording();
    this.inputToken++;
    this.opening = false;
    parts.tracker.disconnect();
    parts.mic.close();
    this.markInputClosed();
    this.store.setStatus('Microphone closed.');
  }

  /** Sends the song to an output device (null or '' for the default). */
  async chooseOutput(id: string | null): Promise<void> {
    const parts = this.parts;
    if (!parts) return;
    const deviceId = id === '' ? null : id;
    if (!this.store.state.output.selectable) {
      this.store.setStatus('This browser cannot pick an output device; the system default is used.', 'warn');
      return;
    }
    if (!(await parts.engine.setOutputDevice(deviceId))) {
      this.store.setStatus('That output device could not be used.', 'warn');
      return;
    }
    this.current.outputDeviceId = deviceId;
    this.persist();
    this.store.patchSection('output', { deviceId, label: this.outputLabel(deviceId) });
    this.refreshLatency();
    const needsCalibration = this.store.state.latencyS === null;
    this.store.setStatus(
      needsCalibration ? 'Output changed. Calibrate latency for this pair.' : 'Output changed.',
    );
  }

  /**
   * Measures round-trip latency with chirps and stores it for this pair. A
   * playing song is paused for the run, since it would drown the chirps, and
   * picks up where it left off afterwards. A CalibrationError is the room's
   * answer, not a fault, so it shows as a warning with its numbers.
   */
  async calibrate(): Promise<void> {
    const parts = this.parts;
    const state = this.store.state;
    if (!parts || state.calibrating || state.recording || this.startingRecord) return;
    if (!(await this.ensureInput())) return;
    // The song, whether a file or a YouTube video, would drown the chirps; a
    // take playing by itself would too, and is simply stopped.
    if (this.solo) this.stopTake();
    const transport = this.active;
    const resume = transport !== null && isRunning(state.player);
    if (resume) transport.pause();
    this.store.patch({ calibrating: true });
    this.store.setStatus('Calibrating: keep quiet and listen for the chirps.');
    try {
      const result = await this.measureOnRawMic(parts);
      if (result) this.reportCalibration(result);
    } catch (error) {
      // A mic that closed meanwhile has put its own reason on the status line.
      if (this.store.state.input.open) {
        this.store.setStatus(messageOf(error), error instanceof CalibrationError ? 'warn' : 'error');
      }
    } finally {
      this.store.patch({ calibrating: false });
      // Only a song still paused where calibration left it is resumed; one the
      // singer replaced or stopped meanwhile is left alone.
      if (resume && transport === this.active && transport.state === 'paused') transport.play();
    }
  }

  /**
   * Runs the chirp measurement on a raw mic. Echo cancellation exists to
   * remove what this page plays, so in speaker mode it would remove the chirp
   * and every run would read "not heard". The mic is reopened without it for
   * the run and put back in the saved mode afterwards, whatever the outcome.
   * Null when the swap itself failed; openInput has said why.
   */
  private async measureOnRawMic(parts: SessionParts): Promise<LatencyResult | null> {
    const { deviceId, requestedAec } = this.store.state.input;
    if (requestedAec && (await this.openInput(deviceId, 'headphones', 'none')) !== 'open') return null;
    try {
      return await measureLatency(parts.engine, parts.mic, parts.capture, {
        onProgress: (done, total) => this.store.setStatus(`Calibrating… ${done} of ${total}`),
      });
    } finally {
      if (requestedAec) await this.openInput(deviceId, this.current.monitor, 'none');
    }
  }

  private reportCalibration(result: LatencyResult): void {
    this.setLatency(result.delayS);
    // A mic that would not reopen has put its own reason on the status line.
    if (!this.store.state.input.open) return;
    const text = describeLatency(result);
    if (result.confidence < LOW_CONFIDENCE) {
      this.store.setStatus(`${text}. Confidence is low; try again somewhere quieter.`, 'warn');
    } else {
      this.store.setStatus(text);
    }
  }

  /** Sets, or with null clears, the latency for the current device pair. */
  setLatency(s: number | null): void {
    if (this.store.state.recording) {
      this.store.setStatus('Stop recording before changing latency.', 'warn');
      this.refreshLatency();
      return;
    }
    if (s !== null && !(Number.isFinite(s) && s >= 0 && s <= MAX_LATENCY_S)) {
      this.store.setStatus(`Latency must be between 0 and ${MAX_LATENCY_S * 1000} ms.`, 'warn');
      this.refreshLatency();
      return;
    }
    const key = this.pairKey();
    const map = { ...this.current.latencyByDevicePair };
    if (s === null) delete map[key];
    else map[key] = s;
    this.current.latencyByDevicePair = map;
    this.persist();
    this.refreshLatency();
  }

  /**
   * Sets the extra delay, in seconds, applied on top of the latency while a
   * YouTube video is the song: the video's own audio output is a path
   * calibration cannot play a chirp through. Limited to plus or minus 0.5 s.
   */
  setEmbedOffset(s: number): void {
    if (this.store.state.recording) {
      this.store.setStatus('Stop recording before changing the embed offset.', 'warn');
      this.store.patch({ embedOffsetS: this.current.embedOffsetS });
      return;
    }
    if (!Number.isFinite(s)) {
      this.store.setStatus('The embed offset must be a number of milliseconds.', 'warn');
      this.store.patch({ embedOffsetS: this.current.embedOffsetS });
      return;
    }
    const offset = clampEmbedOffsetS(s);
    this.current.embedOffsetS = offset;
    this.persist();
    this.store.patch({ embedOffsetS: offset });
    if (offset !== s) {
      this.store.setStatus(`The embed offset is limited to ${MAX_EMBED_OFFSET_S * 1000} ms either way.`, 'warn');
    }
  }

  /** Sets the clarity a frame needs to count as voiced (0..1). */
  setClarity(v: number): void {
    if (!Number.isFinite(v)) return;
    const clarity = Math.min(1, Math.max(0, v));
    if (this.parts) this.parts.tracker.clarityThreshold = clarity;
    this.current.clarityThreshold = clarity;
    this.persist();
  }

  // ---- Takes --------------------------------------------------------------

  /**
   * Starts recording from the current position, playing the song if needed, or
   * stops and saves the take in progress.
   */
  async toggleRecord(): Promise<void> {
    if (this.store.state.recording) {
      const started = this.recording?.startedPlayback ?? false;
      const done = this.finishRecording();
      if (started) this.active?.pause();
      await done;
      return;
    }
    await this.startRecording();
  }

  /**
   * Plays a saved take under the song, aligned as it was sung. Under a
   * YouTube video the take plays by itself instead, because the video's sound
   * cannot be mixed with it, and the status line says so.
   */
  async playTake(id: string): Promise<void> {
    const parts = this.parts;
    const state = this.store.state;
    if (!parts || !this.active || state.recording || state.calibrating) return;
    try {
      const take = await (await this.takesReady).get(id);
      if (!take) {
        this.store.setStatus('That take is gone.', 'warn');
        await this.refreshTakes();
        return;
      }
      if (take.songHash !== state.song?.hash) {
        this.store.setStatus('That take belongs to another song.', 'warn');
        return;
      }
      const wav = decodeWav(await take.wav.arrayBuffer());
      const buffer = parts.engine.context.createBuffer(1, wav.pcm.length, wav.sampleRate);
      buffer.getChannelData(0).set(wav.pcm);
      // The sung audio trails the song by the latency it was recorded with, so
      // it is placed that much earlier to sound the way it was meant to.
      const offsetS = songTimeOfSample(0, wav.sampleRate, take.startedAtSongS ?? 0, take.latencyS);
      if (this.active?.clock === 'embed') {
        this.playTakeAlone(parts, id, take, buffer, offsetS);
        return;
      }
      parts.player.addStem(TAKE_STEM, buffer, offsetS);
      parts.player.setStemGain(TAKE_STEM, 1);
      parts.player.setStemGain(ORIGINAL_STEM, DUCKED_ORIGINAL_GAIN);
      this.replay = { frames: take.frames, next: 0 };
      this.store.patch({ playingTakeId: id });
      // The seek event restarts the trace from just behind the playhead.
      parts.player.seek(Math.max(0, offsetS - TAKE_LEAD_IN_S));
      parts.player.play();
      this.store.setStatus(`Playing take from ${formatClock(take.startedAtSongS ?? 0)}.`);
    } catch (error) {
      this.store.setStatus(`Could not play the take: ${messageOf(error)}`, 'error');
    }
  }

  /**
   * Plays the take by itself, because the song is a YouTube video whose sound
   * cannot be mixed with it. The video is paused so it does not talk over the
   * take, and the lane follows the take's own playhead.
   */
  private playTakeAlone(
    parts: SessionParts,
    id: string,
    take: TakeRecord,
    buffer: AudioBuffer,
    offsetS: number,
  ): void {
    const { engine } = parts;
    this.endReplay();
    this.active?.pause();
    void engine.resume().catch(() => {});
    const source = engine.context.createBufferSource();
    source.buffer = buffer;
    source.connect(engine.master);
    source.onended = () => {
      if (this.solo?.source === source) this.stopTake();
    };
    const startedAtContextS = engine.now();
    source.start();
    this.solo = { source, startedAtContextS, offsetS };
    this.replay = { frames: take.frames, next: firstFrameIndex(take.frames, offsetS - REPLAY_BACK_S) };
    this.lane?.clearFrames();
    this.store.patch({ playingTakeId: id });
    this.store.setStatus(
      `Playing the take by itself from ${formatClock(take.startedAtSongS ?? 0)}: ` +
        'replay over a YouTube video is not synced yet.',
    );
  }

  /** Stops the take, restores the song's level and pauses. */
  stopTake(): void {
    if (!this.parts || this.store.state.playingTakeId === null) return;
    this.endReplay();
    this.lane?.clearFrames();
    this.active?.pause();
  }

  /** Deletes a take from storage. */
  async deleteTake(id: string): Promise<void> {
    if (this.store.state.playingTakeId === id) this.stopTake();
    try {
      await (await this.takesReady).remove(id);
      await this.refreshTakes();
      this.store.setStatus('Take deleted.');
    } catch (error) {
      this.store.setStatus(`Could not delete the take: ${messageOf(error)}`, 'error');
    }
  }

  // ---- Wiring -------------------------------------------------------------

  private buildParts(): SessionParts | null {
    if (!AudioEngine.isSupported()) {
      this.store.setStatus('This browser has no Web Audio. Use a current Chrome or Edge.', 'error');
      return null;
    }
    try {
      const engine = new AudioEngine();
      const mic = new MicCapture(engine);
      const capture = new PcmCapture(engine);
      const tracker = new PitchTracker(engine, { clarityThreshold: this.current.clarityThreshold });
      return {
        engine,
        player: new Player(engine),
        mic,
        capture,
        tracker,
        recorder: new Recorder(engine, mic, capture),
      };
    } catch (error) {
      this.store.setStatus(`Audio could not start: ${messageOf(error)}`, 'error');
      return null;
    }
  }

  private wire(parts: SessionParts): void {
    this.watch(parts.player);
    parts.tracker.onFrame((frame) => this.onFrame(parts, frame));
    parts.mic.onEnded(() => this.onMicEnded(parts));
    if (!this.trackerSupported) {
      this.store.setStatus(
        'No AudioWorklet here (it needs localhost or https), so live pitch and recording are off.',
        'warn',
      );
    }
  }

  /** Follows a transport's events; only the active transport's are acted on. */
  private watch(transport: Transport): void {
    for (const event of TRANSPORT_EVENTS) {
      transport.on(event, () => this.onTransportEvent(transport, event));
    }
  }

  private onTransportEvent(transport: Transport, event: TransportEvent): void {
    if (transport !== this.active) return;
    // A start is the move from not going to going, so note where it was.
    const wasRunning = isRunning(this.lastState);
    this.syncTransport();
    // The video can also be started with YouTube's own controls in the
    // iframe, which never pass through play().
    if (transport.clock === 'embed' && !wasRunning && isRunning(transport.state)) {
      this.embedStarted(transport);
    }
    // A take assumes the song advanced in real time from one anchor, so
    // anything that moves or stops the song ends it: a seek, the end, a pause,
    // or the embed stalling to buffer or showing an ad.
    const breaksTake = event === 'seek' || event === 'ended' || transport.state !== 'playing';
    if (breaksTake && this.store.state.recording) void this.finishRecording();
    if (event === 'seek') this.resyncReplay();
  }

  /**
   * The video has started, or begun to buffer for it, from a state where it
   * was not going. play() does the following before it asks the video to
   * play, but the iframe's own controls skip it, so it is done here as well:
   * a calibration run is not played over, a take playing by itself yields,
   * the audio context runs for the live pitch and the saved mic is reopened.
   */
  private embedStarted(transport: Transport): void {
    if (this.store.state.calibrating) {
      // The video would drown the chirps; the Play button is disabled for the
      // same reason.
      transport.pause();
      this.store.setStatus('Wait for calibration to finish before playing the video.', 'warn');
      return;
    }
    // Not stopTake(): that would pause the video that has just started.
    if (this.solo) {
      this.endReplay();
      this.lane?.clearFrames();
    }
    void this.parts?.engine.resume().catch(() => {});
    this.reopenSavedInput();
  }

  /** Copies the active transport's state into the store and the lane. */
  private syncTransport(): void {
    const transport = this.active;
    if (!transport) return;
    const position = this.currentPosition();
    const state = transport.state;
    this.store.patch({
      song: transport.info,
      player: state,
      clock: transport.clock,
      positionS: position,
      loop: transport.loop,
      durationS: transport.durationS,
    });
    this.lane?.setTime(position);
    this.lane?.setNotice(state === 'ad' ? AD_LANE_NOTICE : null);
    this.noteAd(state);
  }

  /** Says so on the status line when an ad starts or ends. */
  private noteAd(state: TransportState): void {
    const before = this.lastState;
    this.lastState = state;
    if (state === 'ad' && before !== 'ad') this.store.setStatus(AD_STATUS, 'warn');
    else if (before === 'ad' && state !== 'ad') this.store.setStatus('The ad ended.');
  }

  /**
   * Makes `next` the transport everything reads. The one it replaces is
   * paused so two sources are never heard, and a take that was replaying
   * against it is let go.
   */
  private activate(next: Transport): void {
    const previous = this.active;
    this.active = next;
    if (previous !== next) {
      previous?.pause();
      this.endReplay();
      this.lane?.clearFrames();
      this.lastState = 'empty';
      this.lastFrameT = Number.NEGATIVE_INFINITY;
    }
    this.syncTransport();
  }

  /**
   * Closes the YouTube player that is the song and hands the song back to the
   * audio player. The embed is only ever set together with being the active
   * transport, so there is always something to hand back.
   */
  private disposeEmbed(): void {
    const embed = this.embed;
    if (!embed) return;
    this.embed = null;
    embed.destroy();
    this.store.patch({ embed: null });
    if (this.parts) this.activate(this.parts.player);
  }

  /**
   * Closes the video that is loading (the one given, or whichever there is)
   * and puts the pane back as the song in use needs it: shown for a video,
   * hidden for a file.
   */
  private discardLoadingEmbed(which?: YouTubeTransport): void {
    const loading = this.loadingEmbed;
    if (!loading || (which !== undefined && loading !== which)) return;
    this.loadingEmbed = null;
    loading.destroy();
    this.store.patch({ embed: this.embed ? { videoId: this.embed.videoId } : null });
  }

  /**
   * Puts a failed load on the status line, unless a newer load has taken the
   * line over. A failed load leaves the song in use alone, so when there is
   * one the message says it is still loaded: it may well be playing on beside
   * a red error.
   */
  private reportLoadFailure(token: number, error: unknown): void {
    if (token !== this.loadToken) return;
    this.store.setStatus(describeLoadFailure(messageOf(error), this.hasSong()), 'error');
  }

  /** Stops whatever take is replaying, on the song or by itself. */
  private endReplay(): void {
    const wasSolo = this.solo !== null;
    this.stopSolo();
    const player = this.parts?.player;
    if (player && !wasSolo && this.store.state.playingTakeId !== null) {
      player.removeStem(TAKE_STEM);
      player.setStemGain(ORIGINAL_STEM, 1);
    }
    this.replay = null;
    this.store.patch({ playingTakeId: null });
  }

  private stopSolo(): void {
    const solo = this.solo;
    if (!solo) return;
    this.solo = null;
    solo.source.onended = null;
    try {
      solo.source.stop();
    } catch {
      // Already stopped; either way it is silent.
    }
    solo.source.disconnect();
  }

  /** The playhead: the take's own while it plays by itself, else the song's. */
  private currentPosition(): number {
    const solo = this.solo;
    if (solo && this.parts) {
      return solo.offsetS + Math.max(0, this.parts.engine.now() - solo.startedAtContextS);
    }
    return this.active?.positionS ?? 0;
  }

  /** Extra delay for the YouTube path; zero for a file. */
  private embedOffsetNow(): number {
    return this.active?.clock === 'embed' ? this.current.embedOffsetS : 0;
  }

  /**
   * Resolves true once the transport is playing, false if it is not within
   * `timeoutMs`. The audio player is playing the moment play() returns; the
   * embed takes a few hundred milliseconds (buffering) after the press.
   */
  private waitForPlaying(transport: Transport, timeoutMs: number): Promise<boolean> {
    if (transport.state === 'playing') return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const unsubscribe: Array<() => void> = [];
      const finish = (playing: boolean): void => {
        clearTimeout(timer);
        for (const off of unsubscribe) off();
        resolve(playing);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const check = (): void => {
        if (transport.state === 'playing') finish(true);
      };
      for (const event of ['play', 'state'] as const) unsubscribe.push(transport.on(event, check));
    });
  }

  private schedule(frame: (nowMs: number) => void): void {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.rafId = globalThis.requestAnimationFrame(frame);
    } else {
      this.timerId = setTimeout(() => frame(Date.now()), 33);
    }
  }

  private tick(nowMs: number): void {
    const parts = this.parts;
    if (!parts || !this.active) return;
    const position = this.currentPosition();
    this.lane?.setTime(position);
    this.feedReplay(position);
    if (nowMs - this.lastPatchMs < PATCH_INTERVAL_MS) return;
    this.lastPatchMs = nowMs;
    // The mic reports its peak since the last call; holding it briefly keeps
    // the meter readable at this slower rate.
    this.level = Math.max(parts.mic.level(), this.level * LEVEL_DECAY);
    if (this.level < 0.001) this.level = 0;
    this.store.patchSection('input', { level: Math.round(this.level * 100) / 100 });
    this.store.patch({
      positionS: position,
      framesPerSecond: Math.round(parts.tracker.framesPerSecond),
      lastFrame: this.latestFrame,
    });
  }

  private onFrame(parts: SessionParts, frame: PitchFrame): void {
    this.latestFrame = frame;
    const transport = this.active;
    if (!transport) return;
    // Read before the state: for an embed the position is what notices an ad
    // that began since the last poll, so the state is true only after it.
    const positionS = transport.positionS;
    // Off the song clock there is no song time to put the frame at (paused,
    // buffering, or an ad in the video); the readout still follows lastFrame.
    if (transport.state !== 'playing') return;
    let t = frameToSongTime(
      frame.t,
      parts.engine.now(),
      positionS,
      this.latencyOrZero(),
      transport.loop,
      this.embedOffsetNow(),
    );
    if (transport.clock === 'embed') t = orderedFrameTime(t, this.lastFrameT);
    this.lastFrameT = t;
    this.takeFrames?.push({ t, f0: frame.f0, clarity: frame.clarity, rms: frame.rms });
    // While a take replays, its own trace owns the lane.
    if (this.store.state.playingTakeId === null) {
      this.lane?.pushFrame({ t, f0: frame.f0, clarity: frame.clarity });
    }
  }

  private onMicEnded(parts: SessionParts): void {
    this.inputToken++;
    this.opening = false;
    parts.tracker.disconnect();
    if (this.store.state.recording) void this.finishRecording();
    this.markInputClosed();
    this.store.setStatus('The microphone was disconnected. Pick an input to continue.', 'warn');
  }

  private markInputClosed(): void {
    this.latestFrame = null;
    this.level = 0;
    this.store.patchSection('input', {
      label: '',
      open: false,
      level: 0,
      processing: { aec: null, ns: null, agc: null },
      requestedAec: false,
    });
    this.store.patch({
      tracker: this.trackerSupported ? 'idle' : 'unsupported',
      framesPerSecond: 0,
      lastFrame: null,
    });
  }

  /** Loads the worklets and connects the mic; reports the tracker's state. */
  private async attachTracker(
    parts: SessionParts,
    source: AudioNode,
    token: number,
  ): Promise<AppState['tracker']> {
    if (!this.trackerSupported) return 'unsupported';
    try {
      await parts.tracker.load();
      if (token !== this.inputToken) return 'idle';
      parts.tracker.connect(source);
      // Warm the recorder's worklet so the first Record press starts at once.
      void parts.capture.load().catch(() => {});
      return 'running';
    } catch (error) {
      this.store.setStatus(`Live pitch is unavailable: ${messageOf(error)}`, 'error');
      return 'unsupported';
    }
  }

  /** Reopens the remembered mic from a gesture; nudges if there is none. */
  private reopenSavedInput(): void {
    const { input } = this.store.state;
    if (input.open || this.opening) return;
    if (this.current.inputDeviceId !== null) void this.chooseInput(this.current.inputDeviceId);
    else this.store.setStatus('Pick a microphone to see your pitch live.');
  }

  /** True when a mic is open, opening the remembered one if it can. */
  private async ensureInput(): Promise<boolean> {
    if (this.store.state.input.open) return true;
    if (this.current.inputDeviceId === null) {
      this.store.setStatus('Pick a microphone first.', 'warn');
      return false;
    }
    await this.chooseInput(this.current.inputDeviceId);
    return this.store.state.input.open;
  }

  // ---- Loop, latency and settings helpers --------------------------------

  private hasSong(): boolean {
    return this.store.state.player !== 'empty';
  }

  private canEditLoop(): boolean {
    if (!this.store.state.recording) return true;
    this.store.setStatus('Stop recording before changing the loop.', 'warn');
    return false;
  }

  /** Applies a loop and says so; false when it was refused as too short. */
  private applyLoop(region: LoopRegion | null): boolean {
    const transport = this.active;
    if (!transport) return false;
    if (!region) {
      this.store.setStatus('That loop is too short; move the other end further away.', 'warn');
      return false;
    }
    transport.setLoop(region);
    if (!transport.loop) {
      // A video's length can still be unknown just after it loads.
      this.store.setStatus('The loop could not be set yet; the length of the song is not known.', 'warn');
      return false;
    }
    this.store.setStatus(`Loop ${formatClock(region.startS)} to ${formatClock(region.endS)}.`);
    return true;
  }

  private pairKey(): string {
    const { input, output } = this.store.state;
    return latencyKey(output.deviceId, input.deviceId);
  }

  private refreshLatency(): void {
    this.store.patch({ latencyS: this.current.latencyByDevicePair[this.pairKey()] ?? null });
  }

  private latencyOrZero(): number {
    return this.store.state.latencyS ?? 0;
  }

  private persist(): void {
    saveSettings(this.settingsStore, this.current);
  }

  private outputLabel(deviceId: string | null): string {
    if (deviceId === null) return '';
    const found = this.devices.outputs.find((d) => d.deviceId === deviceId);
    return found?.label || 'selected device';
  }

  private async restoreOutput(): Promise<void> {
    const parts = this.parts;
    const saved = this.current.outputDeviceId;
    if (!parts || saved === null || !this.store.state.output.selectable) return;
    // A refused device leaves the default in place and the saved id alone, so
    // plugging the headset back in later restores it.
    if (!(await parts.engine.setOutputDevice(saved))) return;
    this.store.patchSection('output', { deviceId: saved });
    this.refreshLatency();
  }

  // ---- Recording and takes -----------------------------------------------

  private async startRecording(): Promise<void> {
    const parts = this.parts;
    const transport = this.active;
    const state = this.store.state;
    if (!parts || !transport || this.startingRecord || state.calibrating) return;
    const song = transport.info;
    if (!song) {
      this.store.setStatus('Load a song before recording.', 'warn');
      return;
    }
    if (transport.loop) {
      // Looped passes would break the one-anchor timing a take relies on.
      this.store.setStatus('Clear the loop (L) to record; looped passes cannot be recorded yet.', 'warn');
      return;
    }
    // A take still replaying would sit under the new one in the headphones and
    // keep the lane showing its trace instead of the live pitch.
    if (state.playingTakeId !== null) this.stopTake();
    this.startingRecord = true;
    try {
      if (!(await this.ensureInput())) return;
      if (this.store.state.tracker !== 'running') {
        this.store.setStatus('Recording needs AudioWorklet, which is unavailable here.', 'error');
        return;
      }
      const embed = transport.clock === 'embed';
      const startedPlayback = transport.state !== 'playing';
      if (startedPlayback) {
        if (embed) void parts.engine.resume().catch(() => {});
        transport.play();
        // The audio player starts its sources a few milliseconds ahead and the
        // embed needs a moment to buffer; wait for them so the position is the
        // true song time the recorder will anchor to.
        const started = await this.waitForPlaying(transport, embed ? EMBED_START_TIMEOUT_MS : 0);
        if (!started && embed) {
          this.store.setStatus(
            transport.state === 'ad'
              ? 'An ad is playing in the video. Press Record again when it ends.'
              : 'The video did not start, so recording was not started. Press Play on the video, then Record.',
            'warn',
          );
        }
        await sleep(RECORD_LEAD_MS);
      }
      if (transport !== this.active || transport.state !== 'playing') return;
      await parts.recorder.start(transport.positionS, this.latencyOrZero() + this.embedOffsetNow());
      this.recording = { song, startedPlayback, clock: transport.clock };
      this.takeFrames = [];
      this.store.patch({ recording: true });
      const approximate = embed ? ' Timing over a YouTube video is approximate.' : '';
      if (this.store.state.latencyS === null) {
        this.store.setStatus(
          `Recording. Latency is not calibrated, so timing will read late.${approximate}`,
          'warn',
        );
      } else {
        this.store.setStatus(`Recording. Press R to stop.${approximate}`);
      }
      // A pause during the worklet load came before `recording` was true.
      if (transport.state !== 'playing') void this.finishRecording();
    } catch (error) {
      this.store.setStatus(`Could not start recording: ${messageOf(error)}`, 'error');
    } finally {
      this.startingRecord = false;
    }
  }

  /** Stops the recorder and saves the take; concurrent calls share one run. */
  private finishRecording(): Promise<void> {
    if (this.finishing) return this.finishing;
    const parts = this.parts;
    const meta = this.recording;
    if (!parts || !meta || !this.store.state.recording) return Promise.resolve();
    const frames = this.takeFrames ?? [];
    this.takeFrames = null;
    this.store.setStatus('Saving take…');
    this.finishing = (async () => {
      try {
        await this.saveTake(await parts.recorder.stop(), frames, meta.song, meta.clock);
      } catch (error) {
        this.store.setStatus(`Could not save the take: ${messageOf(error)}`, 'error');
      } finally {
        this.recording = null;
        this.finishing = null;
        this.store.patch({ recording: false });
      }
    })();
    return this.finishing;
  }

  private async saveTake(
    rec: TakeRecording,
    frames: PitchFrame[],
    song: TrackInfo,
    clock: ClockKind,
  ): Promise<void> {
    if (rec.pcm.length === 0) {
      this.store.setStatus('Nothing was recorded.', 'warn');
      return;
    }
    const takes = await this.takesReady;
    await takes.save({
      songHash: song.hash,
      songName: song.name,
      createdAt: Date.now(),
      durationS: rec.durationS,
      // For an embed take this includes the embed offset in force, so the WAV
      // and the frames below were shifted by the same amount.
      latencyS: rec.latencyS,
      sampleRate: rec.sampleRate,
      startedAtSongS: rec.startedAtSongS,
      clock,
      // Frames are on song time with the latency already taken off.
      frames,
      wav: encodeWavBlob(rec.pcm, rec.sampleRate, 16),
    });
    await this.refreshTakes();
    this.store.setStatus(`Take saved (${rec.durationS.toFixed(1)} s).`);
  }

  private async refreshTakes(): Promise<void> {
    const song = this.active?.info;
    try {
      const list = song ? await (await this.takesReady).list(song.hash) : [];
      this.store.patch({ takes: list });
    } catch (error) {
      this.store.setStatus(`Could not read saved takes: ${messageOf(error)}`, 'warn');
    }
  }

  /** Restarts the take trace from a few seconds behind the playhead. */
  private resyncReplay(): void {
    const replay = this.replay;
    if (!replay) return;
    this.lane?.clearFrames();
    replay.next = firstFrameIndex(replay.frames, this.currentPosition() - REPLAY_BACK_S);
  }

  /** Feeds the lane every take frame the playhead has now reached. */
  private feedReplay(position: number): void {
    const replay = this.replay;
    if (!replay || !this.lane) return;
    const { frames } = replay;
    // Time ran backwards (a loop wrapped): start the trace over.
    if (replay.next > 0 && frames[replay.next - 1].t > position + REPLAY_SLACK_S) {
      this.resyncReplay();
    }
    while (replay.next < frames.length && frames[replay.next].t <= position) {
      const f = frames[replay.next++];
      this.lane.pushFrame({ t: f.t, f0: f.f0, clarity: f.clarity });
    }
  }
}
