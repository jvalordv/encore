/**
 * The Session owns every long-lived object of the practice loop (audio
 * engine, player, mic, tracker, recorder, take store, settings) and the
 * StateStore the UI reads. The UI never touches those objects; it calls the
 * intents here (loadSong, play, chooseInput, calibrate, toggleRecord, ...) and
 * renders the state they leave behind. That is also what makes the shell
 * portable: a native window only has to call the same intents (see "Built to
 * become an app" in docs/ARCHITECTURE.md).
 *
 * Browsers want a user gesture before they start audio or open a mic, so each
 * intent that needs one does it itself and is meant to be called straight from
 * a click or key handler. Song time is the master clock: tracker frames arrive
 * stamped with context time and are moved onto song time, minus the calibrated
 * round-trip latency, before they reach the lane or a take. The maths for that
 * is in the pure exports at the top (frameToSongTime and friends), tested
 * without any audio. Importing this file touches no browser API.
 */
import type { PitchFrame } from '../analysis/pitch';
import { PitchTracker } from '../analysis/pitch-tracker';
import { PcmCapture } from '../audio/capture';
import { AudioEngine, listOutputDevices } from '../audio/engine';
import { latencyKey, measureLatency } from '../audio/latency';
import { classifyMicError, listInputDevices, MicCapture, onDeviceChange } from '../audio/mic';
import type { InputDevice } from '../audio/mic';
import { normaliseLoop, Player } from '../audio/player';
import type { LoopRegion, SongInfo } from '../audio/player';
import { Recorder } from '../audio/recorder';
import type { TakeRecording } from '../audio/recorder';
import { decodeWav, encodeWavBlob, songTimeOfSample } from '../audio/wav';
import type { PitchLane } from '../render/pitch-lane';
import { loadSettings, MAX_LATENCY_S, saveSettings } from './settings';
import type { Settings } from './settings';
import { formatClock, StateStore } from './state';
import type { AppState } from './state';
import { localStorageStore } from './storage';
import type { KeyValueStore } from './storage';
import { memoryTakeStore, openTakeStore } from './takes';
import type { TakeStore } from './takes';

/** Stem ids; 'original' is the player's own and is never removed. */
const ORIGINAL_STEM = 'original';
const TAKE_STEM = 'take';
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

/**
 * Song time of a pitch frame. The frame was stamped `frameT` on the context
 * clock; the song was at `positionNow` when the context read `contextNow`, and
 * the singer was reacting to audio that left the speakers `latencyS` before
 * the mic stamped it. Inside a loop, a frame from just before a wrap is folded
 * back into the previous pass instead of landing before the loop's start.
 */
export function frameToSongTime(
  frameT: number,
  contextNow: number,
  positionNow: number,
  latencyS: number,
  loop: LoopRegion | null = null,
): number {
  const songTime = positionNow - (contextNow - frameT) - latencyS;
  if (!loop || loop.endS <= loop.startS) return songTime;
  const inside = positionNow >= loop.startS && positionNow < loop.endS;
  if (!inside || songTime >= loop.startS) return songTime;
  const length = loop.endS - loop.startS;
  const into = (songTime - loop.startS) % length;
  return loop.startS + (into < 0 ? into + length : into);
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
export type LaneSink = Pick<PitchLane, 'setTime' | 'pushFrame' | 'clearFrames'>;

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
}

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

/** What a recording in progress needs to remember until it is saved. */
interface Recording {
  song: SongInfo;
  /** True when Record started the song, so stopping Record pauses it again. */
  startedPlayback: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
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

  constructor(options: SessionOptions = {}) {
    this.store = options.store ?? new StateStore();
    this.settingsStore = options.settings ?? localStorageStore();
    this.current = loadSettings(this.settingsStore);
    this.takesReady = Promise.resolve(options.takes ?? openTakeStore()).catch(() => memoryTakeStore());
    this.parts = this.buildParts();

    const sinkCapable = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    this.store.patch({ tracker: this.trackerSupported ? 'idle' : 'unsupported' });
    this.store.patchSection('input', { deviceId: this.current.inputDeviceId });
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

  /** Hands the Session the lane it should scroll and feed. */
  attachLane(lane: LaneSink): void {
    this.lane = lane;
    lane.setTime(this.parts?.player.position() ?? 0);
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

  /** Stops the loop, the device watch and the mic. */
  dispose(): void {
    this.running = false;
    if (this.rafId !== null) globalThis.cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.rafId = this.timerId = null;
    this.stopDeviceWatch?.();
    this.stopDeviceWatch = null;
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
    if (this.store.state.recording) await this.finishRecording();
    this.store.setStatus(`Loading ${file.name}…`);
    let info: SongInfo;
    try {
      info = await parts.player.load(file);
    } catch (error) {
      if (token === this.loadToken) this.store.setStatus(messageOf(error), 'error');
      return;
    }
    if (token !== this.loadToken) return;
    // load() already dropped the stems, so the take is gone; forget it too.
    this.replay = null;
    this.store.patch({ playingTakeId: null });
    this.lane?.clearFrames();
    await this.refreshTakes();
    const next = this.store.state.input.open ? 'Press Space to play.' : 'Pick a microphone, then press Play.';
    this.store.setStatus(`Loaded ${info.name} (${formatClock(info.durationS)}). ${next}`);
  }

  /** Plays, resuming the saved mic first if none is open. */
  play(): void {
    const parts = this.parts;
    if (!parts) return;
    if (parts.player.state === 'empty') {
      this.store.setStatus('Drop an audio file on the page to start.');
      return;
    }
    parts.player.play();
    this.reopenSavedInput();
  }

  /** Pauses at the current position. */
  pause(): void {
    this.parts?.player.pause();
  }

  /** Play when paused, pause when playing. */
  togglePlay(): void {
    if (this.store.state.player === 'playing') this.pause();
    else this.play();
  }

  /** Stops, ending any recording, and returns to the start. */
  stop(): void {
    if (this.store.state.recording) void this.finishRecording();
    this.parts?.player.stop();
  }

  /** Moves the playhead to `s` seconds; this ends a recording in progress. */
  seek(s: number): void {
    if (this.hasSong()) this.parts?.player.seek(s);
  }

  /** Moves the playhead by `ds` seconds, negative for back. */
  nudge(ds: number): void {
    const player = this.parts?.player;
    if (player && this.hasSong()) player.seek(player.position() + ds);
  }

  /**
   * Sets a loop from `a` to `b` seconds when both are given. With neither, it
   * clears the loop if there is one, else loops a short stretch from here.
   */
  toggleLoop(a?: number, b?: number): void {
    const player = this.parts?.player;
    if (!player || !this.hasSong() || !this.canEditLoop()) return;
    if (a !== undefined && b !== undefined) {
      this.applyLoop(normaliseLoop({ startS: a, endS: b }, this.store.state.durationS));
    } else if (player.loop) {
      player.setLoop(null);
      this.store.setStatus('Loop off.');
    } else {
      this.setLoopPoint('a');
    }
  }

  /** Marks the loop's start (A) or end (B) at the current position. */
  setLoopPoint(which: 'a' | 'b'): void {
    const player = this.parts?.player;
    if (!player || !this.hasSong() || !this.canEditLoop()) return;
    const { durationS } = this.store.state;
    const region = loopWithPoint(which, player.position(), player.loop, durationS);
    if (!this.applyLoop(region)) return;
    // B is pressed at the playhead, so the loop ends where the song already
    // is. A run that starts past a loop's end plays on, so without this jump
    // the loop would never engage and the passage could not be repeated.
    const loop = player.loop;
    if (which === 'b' && loop && player.position() >= loop.endS) player.seek(loop.startS);
  }

  // ---- Devices and latency ------------------------------------------------

  /**
   * Opens a microphone (null or '' for the system default) and points the
   * pitch tracker at it. Call from a click or key press.
   */
  async chooseInput(id: string | null): Promise<void> {
    const parts = this.parts;
    if (!parts) return;
    const deviceId = id === '' ? null : id;
    const token = ++this.inputToken;
    this.opening = true;
    this.store.patchSection('input', { deviceId });
    this.store.setStatus('Opening the microphone…');
    try {
      await parts.mic.open(deviceId);
    } catch (error) {
      if (token === this.inputToken) {
        this.opening = false;
        this.markInputClosed();
        this.store.setStatus(classifyMicError(error).message, 'error');
      }
      return;
    }
    if (token !== this.inputToken) return;
    const source = parts.mic.source;
    if (!source) {
      this.opening = false;
      this.markInputClosed();
      return;
    }
    const tracking = await this.attachTracker(parts, source, token);
    if (token !== this.inputToken) return;
    this.opening = false;

    const settings = parts.mic.settings;
    const processing = {
      aec: settings?.echoCancellation ?? null,
      ns: settings?.noiseSuppression ?? null,
      agc: settings?.autoGainControl ?? null,
    };
    this.store.patchSection('input', { deviceId, label: parts.mic.label, open: true, processing });
    this.store.patch({ tracker: tracking });
    this.current.inputDeviceId = deviceId;
    this.persist();
    this.refreshLatency();
    void this.refreshDevices();
    const raw = processing.aec || processing.ns || processing.agc;
    if (raw) {
      this.store.setStatus(
        'This browser kept voice processing on for that mic, which flattens dynamics. Try another input.',
        'warn',
      );
    } else if (tracking !== 'unsupported') {
      this.store.setStatus(`Microphone ready: ${parts.mic.label || 'default input'}.`);
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

  /** Measures round-trip latency with chirps and stores it for this pair. */
  async calibrate(): Promise<void> {
    const parts = this.parts;
    const state = this.store.state;
    if (!parts || state.calibrating || state.recording) return;
    if (!(await this.ensureInput())) return;
    if (state.player === 'playing') parts.player.pause();
    this.store.patch({ calibrating: true });
    this.store.setStatus('Calibrating: listen for the chirps.');
    try {
      const result = await measureLatency(parts.engine, parts.mic, parts.capture, {
        onProgress: (done, total) => this.store.setStatus(`Calibrating… ${done} of ${total}`),
      });
      this.setLatency(result.delayS);
      const text = `Latency ${Math.round(result.delayS * 1000)} ms saved for this mic and output.`;
      if (result.confidence < LOW_CONFIDENCE) {
        this.store.setStatus(`${text} Confidence is low; try again somewhere quieter.`, 'warn');
      } else {
        this.store.setStatus(text);
      }
    } catch (error) {
      this.store.setStatus(messageOf(error), 'error');
    } finally {
      this.store.patch({ calibrating: false });
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
      if (started) this.parts?.player.pause();
      await done;
      return;
    }
    await this.startRecording();
  }

  /** Plays a saved take under the song, aligned as it was sung. */
  async playTake(id: string): Promise<void> {
    const parts = this.parts;
    const state = this.store.state;
    if (!parts || state.recording || state.calibrating) return;
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

  /** Stops the take, restores the song's level and pauses. */
  stopTake(): void {
    const parts = this.parts;
    if (!parts || this.store.state.playingTakeId === null) return;
    parts.player.removeStem(TAKE_STEM);
    parts.player.setStemGain(ORIGINAL_STEM, 1);
    this.replay = null;
    this.store.patch({ playingTakeId: null });
    this.lane?.clearFrames();
    parts.player.pause();
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
    const events = ['load', 'play', 'pause', 'seek', 'ended', 'loop'] as const;
    for (const event of events) {
      parts.player.on(event, () => {
        this.syncPlayer(parts.player);
        // A take assumes the song advanced in real time from one anchor, so
        // anything that moves or stops the song ends it.
        const breaksTake = event === 'pause' || event === 'seek' || event === 'ended';
        if (breaksTake && this.store.state.recording) void this.finishRecording();
        if (event === 'seek') this.resyncReplay();
      });
    }
    parts.tracker.onFrame((frame) => this.onFrame(parts, frame));
    parts.mic.onEnded(() => this.onMicEnded(parts));
    if (!this.trackerSupported) {
      this.store.setStatus(
        'No AudioWorklet here (it needs localhost or https), so live pitch and recording are off.',
        'warn',
      );
    }
  }

  private syncPlayer(player: Player): void {
    const position = player.position();
    this.store.patch({
      song: player.info,
      player: player.state,
      positionS: position,
      loop: player.loop,
      durationS: player.info?.durationS ?? 0,
    });
    this.lane?.setTime(position);
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
    if (!parts) return;
    const position = parts.player.position();
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
    const { player, engine } = parts;
    // Off the song clock there is no song time to put the frame at; the
    // readout still follows lastFrame.
    if (player.state !== 'playing') return;
    const t = frameToSongTime(frame.t, engine.now(), player.position(), this.latencyOrZero(), player.loop);
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
    const player = this.parts?.player;
    if (!player) return false;
    if (!region) {
      this.store.setStatus('That loop is too short; move the other end further away.', 'warn');
      return false;
    }
    player.setLoop(region);
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
    const state = this.store.state;
    if (!parts || this.startingRecord || state.calibrating) return;
    const song = parts.player.info;
    if (!song) {
      this.store.setStatus('Load a song before recording.', 'warn');
      return;
    }
    if (parts.player.loop) {
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
      const startedPlayback = parts.player.state !== 'playing';
      if (startedPlayback) {
        parts.player.play();
        // The player starts its sources a few milliseconds ahead; wait for
        // them so position() is the true song time the recorder will anchor to.
        await sleep(RECORD_LEAD_MS);
      }
      if (parts.player.state !== 'playing') return;
      await parts.recorder.start(parts.player.position(), this.latencyOrZero());
      this.recording = { song, startedPlayback };
      this.takeFrames = [];
      this.store.patch({ recording: true });
      if (this.store.state.latencyS === null) {
        this.store.setStatus('Recording. Latency is not calibrated, so timing will read late.', 'warn');
      } else {
        this.store.setStatus('Recording. Press R to stop.');
      }
      // A pause during the worklet load came before `recording` was true.
      if (parts.player.state !== 'playing') void this.finishRecording();
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
        await this.saveTake(await parts.recorder.stop(), frames, meta.song);
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

  private async saveTake(rec: TakeRecording, frames: PitchFrame[], song: SongInfo): Promise<void> {
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
      latencyS: rec.latencyS,
      sampleRate: rec.sampleRate,
      startedAtSongS: rec.startedAtSongS,
      // Frames are on song time with the latency already taken off.
      frames,
      wav: encodeWavBlob(rec.pcm, rec.sampleRate, 16),
    });
    await this.refreshTakes();
    this.store.setStatus(`Take saved (${rec.durationS.toFixed(1)} s).`);
  }

  private async refreshTakes(): Promise<void> {
    const song = this.parts?.player.info;
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
    const player = this.parts?.player;
    if (!replay || !player) return;
    this.lane?.clearFrames();
    replay.next = firstFrameIndex(replay.frames, player.position() - REPLAY_BACK_S);
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
