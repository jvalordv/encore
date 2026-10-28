/**
 * A fake-parts harness for the session controllers: a transport that plays
 * under test control, a mic, a pitch tracker, a recorder and an audio clock
 * that do nothing but remember what they were asked, wired into a real
 * SessionCore over an in-memory settings store and take store. Controller
 * tests drive the intents and read the state; no Web Audio or DOM is needed.
 */
import { vi } from 'vitest';
import type { PitchFrame } from '../src/analysis/pitch';
import { SessionCore } from '../src/app/session/core';
import type { SearchOptions } from '../src/app/session/search';
import type { LaneSink, SessionParts } from '../src/app/session/types';
import { loadSettings } from '../src/app/settings';
import { StateStore } from '../src/app/state';
import { memoryStore } from '../src/app/storage';
import type { KeyValueStore } from '../src/app/storage';
import { memoryTakeStore } from '../src/app/takes';
import type { TakeStore } from '../src/app/takes';
import type { TakeRecording } from '../src/audio/recorder';
import type {
  ClockKind,
  LoopRegion,
  TrackInfo,
  Transport,
  TransportEvent,
  TransportState,
} from '../src/audio/transport';

/** A transport that changes state only when told, and says what it was told. */
export class FakeTransport implements Transport {
  clock: ClockKind = 'engine';
  state: TransportState = 'empty';
  positionS = 0;
  durationS = 0;
  info: TrackInfo | null = null;
  loop: LoopRegion | null = null;
  /** Every command received, in order, for assertions. */
  readonly calls: string[] = [];
  private readonly listeners = new Map<TransportEvent, Set<() => void>>();

  /** Gives the transport a song and leaves it ready at the start. */
  setSong(info: TrackInfo): void {
    this.info = info;
    this.durationS = info.durationS;
    this.state = 'ready';
    this.positionS = 0;
    this.emit('load');
  }

  play(): void {
    this.calls.push('play');
    if (this.state === 'empty') return;
    this.state = 'playing';
    this.emit('play');
  }

  pause(): void {
    this.calls.push('pause');
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.emit('pause');
  }

  stop(): void {
    this.calls.push('stop');
    this.state = this.info ? 'ready' : 'empty';
    this.positionS = 0;
    this.emit('seek');
  }

  seek(positionS: number): void {
    this.calls.push(`seek ${positionS}`);
    this.positionS = Math.max(0, Math.min(positionS, this.durationS || positionS));
    this.emit('seek');
  }

  setLoop(region: LoopRegion | null): void {
    this.calls.push('setLoop');
    this.loop = region;
    this.emit('loop');
  }

  on(event: TransportEvent, listener: () => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Announces an event as the real transports do. */
  emit(event: TransportEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

/** The audio Player's extras over a transport: loading and take stems. */
export class FakePlayer extends FakeTransport {
  /** Resolves a load; tests replace it to make one slow or failing. */
  load = vi.fn(async (file: File, name?: string, key?: string): Promise<TrackInfo> => {
    const info = { name: name ?? file.name, durationS: 100, hash: key ?? `hash-${file.name}` };
    this.setSong(info);
    return { ...info, sampleRate: 44100, channels: 2 } as TrackInfo;
  });
  readonly addStem = vi.fn();
  readonly removeStem = vi.fn();
  readonly setStemGain = vi.fn();
  /** Decodes a stem; the fake hands back an empty buffer of the bytes' size. */
  readonly decode = vi.fn(async (bytes: ArrayBuffer) => ({ length: bytes.byteLength }) as unknown as AudioBuffer);
}

/** The mic: opens instantly with a label, and can be ended by the test. */
export class FakeMic {
  label = '';
  source: object | null = null;
  settings: MediaTrackSettings | null = null;
  readonly open = vi.fn(async (deviceId: string | null) => {
    this.label = deviceId ? `mic ${deviceId}` : 'default mic';
    this.source = {};
    this.settings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  });
  readonly close = vi.fn(() => {
    this.source = null;
    this.label = '';
  });
  level = vi.fn(() => 0);
  private ended: Array<() => void> = [];

  onEnded(cb: () => void): () => void {
    this.ended.push(cb);
    return () => undefined;
  }

  /** Simulates the device being unplugged. */
  unplug(): void {
    for (const cb of this.ended) cb();
  }
}

/** The tracker: hands the test a way to emit frames as the worklet would. */
export class FakeTracker {
  framesPerSecond = 100;
  clarityThreshold = 0.9;
  readonly load = vi.fn(async () => undefined);
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  private callbacks: Array<(frame: PitchFrame) => void> = [];

  onFrame(cb: (frame: PitchFrame) => void): () => void {
    this.callbacks.push(cb);
    return () => undefined;
  }

  /** Delivers a frame stamped on the context clock. */
  emit(frame: PitchFrame): void {
    for (const cb of this.callbacks) cb(frame);
  }
}

/** The audio engine's clock and the few calls the controllers make on it. */
export class FakeEngine {
  /** Context time in seconds; tests move it. */
  t = 0;
  readonly master = {};
  readonly context = {
    createBuffer: (_channels: number, length: number, sampleRate: number) => ({
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource: () => ({
      buffer: null as unknown,
      onended: null as unknown,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
  };
  readonly resume = vi.fn(async () => undefined);
  readonly ensureRunning = vi.fn(async () => true);
  readonly setOutputDevice = vi.fn(async () => true);

  now(): number {
    return this.t;
  }
}

/** The recorder: remembers its start and returns a canned take on stop. */
export class FakeRecorder {
  readonly start = vi.fn(async (_songTimeS: number, _latencyS: number) => undefined);
  take: TakeRecording = {
    pcm: new Float32Array(4410),
    sampleRate: 44100,
    startedAtSongS: 0,
    startedAtContextS: 0,
    latencyS: 0,
    durationS: 0.1,
  };
  readonly stop = vi.fn(async () => this.take);
}

/** A lane that records what it was drawn with. */
export function fakeLane(): LaneSink & {
  setTime: ReturnType<typeof vi.fn>;
  pushFrame: ReturnType<typeof vi.fn>;
  clearFrames: ReturnType<typeof vi.fn>;
  setNotice: ReturnType<typeof vi.fn>;
  setReference: ReturnType<typeof vi.fn>;
  fitRangeToReference: ReturnType<typeof vi.fn>;
} {
  return {
    setTime: vi.fn(),
    pushFrame: vi.fn(),
    clearFrames: vi.fn(),
    setNotice: vi.fn(),
    setReference: vi.fn(),
    fitRangeToReference: vi.fn(),
  };
}

/** A whole session core on fake parts, with handles to every fake. */
export interface Harness {
  core: SessionCore;
  store: StateStore;
  settingsStore: KeyValueStore;
  takeStore: TakeStore;
  engine: FakeEngine;
  player: FakePlayer;
  mic: FakeMic;
  tracker: FakeTracker;
  recorder: FakeRecorder;
}

/**
 * Builds a SessionCore over fake parts; `saved` seeds the settings store and
 * `search` replaces what the song search reaches out with.
 */
export function makeHarness(saved?: Record<string, unknown>, search?: SearchOptions): Harness {
  const settingsStore = memoryStore();
  if (saved) settingsStore.set('settings', JSON.stringify(saved));
  const store = new StateStore();
  const takeStore = memoryTakeStore();
  const engine = new FakeEngine();
  const player = new FakePlayer();
  const mic = new FakeMic();
  const tracker = new FakeTracker();
  const recorder = new FakeRecorder();
  const parts = {
    engine,
    player,
    mic,
    capture: { load: vi.fn(async () => undefined) },
    tracker,
    recorder,
  } as unknown as SessionParts;
  const core = new SessionCore({
    store,
    settingsStore,
    settings: loadSettings(settingsStore),
    parts,
    takes: Promise.resolve(takeStore),
    trackerSupported: true,
    search,
  });
  return { core, store, settingsStore, takeStore, engine, player, mic, tracker, recorder };
}

/** A song to load into a fake transport. */
export function songInfo(name = 'song.mp3', hash = 'hash-song'): TrackInfo {
  return { name, durationS: 100, hash };
}
