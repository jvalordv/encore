/**
 * Singer B's microphone: its own capture, pitch tracker, level gate and noise
 * floor (singer-health.ts), its own calibrated latency (stored per output and
 * input pair like singer A's) and its own tuning for that pair. Each tracker
 * frame is put on song time with B's latency and announced on the frame bus as
 * singer 1, so the take recorder, the live scorer and the lane treat it as one
 * more singer. B's meter state lives in `AppState.singers[1]`. The second mic
 * is opened only on request; it never reopens by itself.
 */
import { BLEED_OFF } from '../analysis/bleed';
import { SILENCE_DB } from '../analysis/mic-level';
import { tuningForPair } from '../analysis/mic-tuning';
import type { MicTuning } from '../analysis/mic-tuning';
import type { PitchFrame } from '../analysis/pitch';
import { classifyMicError } from '../audio/mic';
import { CalibrationError, describeLatency, latencyKey, measureLatency } from '../audio/latency';
import { isRunning } from '../audio/transport';
import type { SessionCore } from '../app/session/core';
import { frameToSongTime, messageOf, orderedFrameTime } from '../app/session/helpers';
import type { SecondParts } from '../app/session/types';
import { MAX_LATENCY_S } from '../app/settings';
import type { InputState } from '../app/state';
import { isLeakOfA, SingerHealth } from './singer-health';

/** Seconds of tracker time between health publications. */
const PUBLISH_EVERY_S = 0.1;
/** The meter falls to this share of its last value per tick. */
const LEVEL_DECAY = 0.8;
/** A's frame counts as simultaneous with B's within this many seconds. */
const LEAK_WINDOW_S = 0.05;

/** How open() ended; a failure has already put its reason on screen. */
export type SecondOutcome = 'open' | 'failed' | 'superseded';

/** The mic state of a singer with nothing open. */
function closedInput(core: SessionCore): InputState {
  return {
    deviceId: core.current.duet.inputDeviceIdB,
    label: '',
    open: false,
    level: 0,
    processing: { aec: null, ns: null, agc: null },
    monitor: core.current.monitor,
    requestedAec: false,
    levelDb: SILENCE_DB,
    floorDb: SILENCE_DB,
    micState: 'nothing',
    bleed: BLEED_OFF,
  };
}

/** Singer B's mic, tracker, gate and latency. */
export class SecondInput {
  private readonly health: SingerHealth;
  private tuned: MicTuning | null = null;
  private token = 0;
  private lastFrameT = Number.NEGATIVE_INFINITY;
  private lastPublishT = Number.NEGATIVE_INFINITY;
  private level = 0;
  /** The latest voiced, passing frame of singer A, for the leak rule. */
  private lastA: PitchFrame | null = null;

  constructor(
    private readonly core: SessionCore,
    private readonly parts: SecondParts,
  ) {
    this.health = new SingerHealth(() => this.tuning());
    parts.tracker.onFrame((frame) => this.onFrame(frame));
    parts.mic.onEnded(() => this.onEnded());
    core.bus.subscribe((m) => {
      if (m.singer === 0) this.lastA = m.gated ? null : m.frame;
    });
  }

  /** True while singer B's mic is open. */
  get open(): boolean {
    return this.core.store.state.singers[1]?.input.open === true;
  }

  /** The storage key of the output and singer B's input. */
  pairKey(): string {
    return latencyKey(this.core.store.state.output.deviceId, this.core.current.duet.inputDeviceIdB);
  }

  /** The gate and bleed rules for singer B's device pair. */
  tuning(): MicTuning {
    this.tuned ??= tuningForPair(
      this.core.current.micTuningByDevicePair,
      this.pairKey(),
      this.core.current.clarityThreshold,
    );
    return this.tuned;
  }

  /** Reads the pair's latency and rules again, as after the pair changed. */
  refresh(): void {
    this.tuned = null;
    this.parts.tracker.clarityThreshold = this.tuning().clarityThreshold;
    const latencyBS = this.core.current.latencyByDevicePair[this.pairKey()] ?? null;
    this.core.store.patch({
      duet: { ...this.core.store.state.duet, latencyBS, deviceIdB: this.core.current.duet.inputDeviceIdB },
    });
  }

  /** The latency in force for singer B, or zero when none is set. */
  latencyOrZero(): number {
    return this.core.store.state.duet.latencyBS ?? 0;
  }

  /**
   * Opens `deviceId` (null for the system default) in the saved monitor mode
   * and points B's tracker at it. A newer open or close overtakes this one.
   */
  async openDevice(deviceId: string | null, announce = true): Promise<SecondOutcome> {
    const { store, current } = this.core;
    const token = ++this.token;
    current.duet = { ...current.duet, inputDeviceIdB: deviceId };
    this.core.persist();
    this.refresh();
    if (announce) store.setStatus('Opening the second microphone…');
    try {
      await this.parts.mic.open(deviceId, 1, current.monitor);
    } catch (error) {
      if (token !== this.token) return 'superseded';
      this.markClosed();
      store.setStatus(classifyMicError(error).message, 'error');
      return 'failed';
    }
    if (token !== this.token) return 'superseded';
    const source = this.parts.mic.source;
    if (!source) {
      this.abandon();
      return 'failed';
    }
    try {
      await this.parts.tracker.load();
      if (token !== this.token) return 'superseded';
      this.parts.tracker.connect(source);
    } catch (error) {
      this.abandon();
      store.setStatus(`Live pitch is unavailable for the second mic: ${messageOf(error)}`, 'error');
      return 'failed';
    }
    this.health.reset();
    this.lastFrameT = Number.NEGATIVE_INFINITY;
    const { settings } = this.parts.mic;
    this.patch({
      deviceId,
      label: this.parts.mic.label,
      open: true,
      monitor: current.monitor,
      requestedAec: current.monitor === 'speakers',
      processing: {
        aec: settings?.echoCancellation ?? null,
        ns: settings?.noiseSuppression ?? null,
        agc: settings?.autoGainControl ?? null,
      },
    });
    if (announce) store.setStatus(`Second microphone ready: ${this.parts.mic.label || 'default input'}.`);
    return 'open';
  }

  /** Releases a mic that opened but could not be used, then marks B closed. */
  private abandon(): void {
    this.parts.tracker.disconnect();
    this.parts.mic.close();
    this.markClosed();
  }

  /** Closes singer B's mic and its tracker. */
  close(): void {
    this.token++;
    this.parts.tracker.disconnect();
    this.parts.mic.close();
    this.markClosed();
  }

  /** Decays and publishes B's meter; called from the tick loop. */
  tick(): void {
    if (!this.open) return;
    this.level = Math.max(this.parts.mic.level(), this.level * LEVEL_DECAY);
    if (this.level < 0.001) this.level = 0;
    this.patch({ level: Math.round(this.level * 100) / 100 });
  }

  /** Sets, or with null clears, singer B's latency for the current pair. */
  setLatency(s: number | null): void {
    const { store, current } = this.core;
    if (store.state.recording) {
      store.setStatus('Stop recording before changing latency.', 'warn');
      return;
    }
    if (s !== null && !(Number.isFinite(s) && s >= 0 && s <= MAX_LATENCY_S)) {
      store.setStatus(`Latency must be between 0 and ${MAX_LATENCY_S * 1000} ms.`, 'warn');
      return;
    }
    const map = { ...current.latencyByDevicePair };
    if (s === null) delete map[this.pairKey()];
    else map[this.pairKey()] = s;
    current.latencyByDevicePair = map;
    this.core.persist();
    this.refresh();
    // A's latency is read through the same map, so its own copy follows.
    this.core.latency.refreshLatency();
  }

  /** Measures singer B's round trip with chirps, as singer A's calibration does. */
  async calibrate(): Promise<void> {
    const { store, songs, takes } = this.core;
    const { capture } = this.parts;
    const state = store.state;
    if (state.calibrating || state.duet.calibratingB || state.recording || takes.startingRecord) return;
    if (!capture) {
      store.setStatus('This second mic cannot be calibrated.', 'warn');
      return;
    }
    if (!this.open || !this.core.parts) {
      store.setStatus('Open the second microphone first.', 'warn');
      return;
    }
    if (takes.solo) takes.stopTake();
    const transport = songs.active;
    const resume = transport !== null && isRunning(state.player);
    if (resume) transport.pause();
    this.setCalibrating(true);
    store.setStatus('Calibrating the second mic: keep quiet and listen for the chirps.');
    try {
      const result = await measureLatency(this.core.parts.engine, this.parts.mic, capture, {
        onProgress: (done, total) => store.setStatus(`Calibrating the second mic… ${done} of ${total}`),
      });
      this.setLatency(result.delayS);
      store.setStatus(describeLatency(result));
    } catch (error) {
      store.setStatus(messageOf(error), error instanceof CalibrationError ? 'warn' : 'error');
    } finally {
      this.setCalibrating(false);
      if (resume && transport === songs.active && transport.state === 'paused') transport.play();
    }
  }

  private setCalibrating(on: boolean): void {
    this.core.store.patch({ duet: { ...this.core.store.state.duet, calibratingB: on } });
  }

  private onFrame(frame: PitchFrame): void {
    const { store, songs, parts } = this.core;
    const transport = songs.active;
    const positionS = transport ? transport.positionS : 0;
    const playing = transport !== null && transport.state === 'playing';
    let t = playing
      ? frameToSongTime(frame.t, parts?.engine.now() ?? 0, positionS, this.latencyOrZero(), transport.loop, songs.embedOffsetNow())
      : 0;
    const verdict = this.health.observe(frame);
    if (frame.t - this.lastPublishT >= PUBLISH_EVERY_S || frame.t < this.lastPublishT) {
      this.lastPublishT = frame.t;
      this.patch(this.health.reading());
    }
    if (!playing) return;
    if (transport.clock === 'embed') t = orderedFrameTime(t, this.lastFrameT);
    this.lastFrameT = t;
    // With speakers a frame too quiet to be the voice is dropped before the
    // take and the scorer see it; with headphones only the lane skips it.
    // Two mics in one room also hear each other: a B frame well under A's
    // simultaneous level on A's pitch is A's voice reaching B's mic.
    const speakers = store.state.singers[1]?.input.requestedAec === true;
    const a = this.lastA;
    const leak = speakers && a !== null && Math.abs(a.t - t) <= LEAK_WINDOW_S && isLeakOfA(frame, a);
    const drawable = verdict.drawable && !leak;
    const reason = verdict.reason ?? (leak ? 'quiet' : null);
    const f0 = speakers && !drawable ? 0 : frame.f0;
    this.core.bus.publish({
      singer: 1,
      frame: { t, f0, clarity: frame.clarity, rms: frame.rms },
      gated: !drawable,
      ...(reason ? { gateReason: reason } : {}),
      rawF0: frame.f0,
    });
  }

  private onEnded(): void {
    this.token++;
    this.parts.tracker.disconnect();
    this.markClosed();
    this.core.store.setStatus('The second microphone was disconnected. Pick an input to continue.', 'warn');
  }

  private markClosed(): void {
    this.level = 0;
    this.health.reset();
    this.patch({ ...closedInput(this.core), deviceId: this.core.current.duet.inputDeviceIdB });
  }

  /** Writes B's mic state, creating the entry if it is the first. */
  private patch(p: Partial<InputState>): void {
    const { store } = this.core;
    const [first, second] = store.state.singers;
    const base = second?.input ?? closedInput(this.core);
    const next = { ...base, ...p };
    if (second && (Object.keys(next) as Array<keyof InputState>).every((k) => samePart(second.input[k], next[k]))) return;
    store.patch({ singers: [first, { id: 1, input: next }] });
  }
}

/** Equality for the plain values and small objects an InputState holds. */
function samePart(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}
