/**
 * The microphone: choosing and opening an input, headphone or speaker mode,
 * pointing the pitch tracker at it, and turning each tracker frame into a
 * song-time frame announced on the frame bus. Owns the open/close tokens that
 * let a newer choice overtake a slow permission prompt, the level meter's
 * smoothed value and the latest frame the readout shows.
 */
import type { PitchFrame } from '../../analysis/pitch';
import { classifyMicError } from '../../audio/mic';
import type { MonitorMode } from '../../audio/mic';
import { describeMonitor } from '../state';
import type { AppState } from '../state';
import type { SessionCore } from './core';
import { frameToSongTime, messageOf, orderedFrameTime } from './helpers';
import type { SessionParts } from './types';

/** What openInput says once open: the plain line, the mode's line, or none. */
type Announce = 'ready' | 'monitor' | 'none';

/** How openInput ended; a failure has already put its reason on screen. */
export type OpenOutcome = 'open' | 'failed' | 'superseded';

/** Said when headphone mode opened a mic the browser still processes. */
const PROCESSING_KEPT_ON =
  'This browser kept voice processing on for that mic, which flattens dynamics. Try another input.';

/** Owns the mic, the tracker connection and the live frame stream. */
export class InputController {
  /** The newest tracker frame, for the readout; null with no mic open. */
  latestFrame: PitchFrame | null = null;
  /** The meter's smoothed peak, 0..1; the tick loop decays and shows it. */
  level = 0;
  // Song time of the last frame stamped, to keep an embed's stamps in order.
  private lastFrameT = Number.NEGATIVE_INFINITY;
  // Bumped by every open and close of the mic, so a slow permission prompt
  // that finishes after a newer choice cannot overwrite it.
  private inputToken = 0;
  private opening = false;

  constructor(private readonly core: SessionCore) {}

  /** Points the tracker's frames and the mic's end at this controller. */
  wire(parts: SessionParts): void {
    parts.tracker.onFrame((frame) => this.onFrame(parts, frame));
    parts.mic.onEnded(() => this.onMicEnded(parts));
  }

  /** Forgets the last frame stamp, as a new transport starts its own clock. */
  resetFrameClock(): void {
    this.lastFrameT = Number.NEGATIVE_INFINITY;
  }

  /**
   * Opens a microphone (null or '' for the system default) in the saved
   * monitor mode and points the pitch tracker at it. Call from a click or key
   * press.
   */
  async chooseInput(id: string | null): Promise<void> {
    if (!this.core.parts) return;
    await this.openInput(id === '' ? null : id, this.core.current.monitor, 'ready');
  }

  /**
   * Chooses how the singer hears the song: headphones (raw mic) or speakers
   * (the browser cancels the song out of the mic). The choice is saved; an
   * open mic is reopened with the new constraints and handed back to the
   * tracker the way a device change is. Reopening cuts the stream a recording
   * or a calibration is reading, so both refuse it.
   */
  async setMonitor(mode: MonitorMode): Promise<void> {
    const { parts, store, current } = this.core;
    if (!parts || (mode !== 'headphones' && mode !== 'speakers')) return;
    const { input, recording, calibrating } = store.state;
    if (recording || this.core.takes.startingRecord) {
      store.setStatus('Stop recording before changing the monitor mode.', 'warn');
      return;
    }
    if (calibrating) {
      store.setStatus('Wait for calibration to finish before changing the monitor mode.', 'warn');
      return;
    }
    if (mode === current.monitor) return;
    current.monitor = mode;
    this.core.persist();
    store.patchSection('input', { monitor: mode });
    if (!input.open && !this.opening) {
      store.setStatus(
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
  async openInput(deviceId: string | null, mode: MonitorMode, announce: Announce): Promise<OpenOutcome> {
    const { parts, store } = this.core;
    if (!parts) return 'failed';
    const token = ++this.inputToken;
    this.opening = true;
    store.patchSection('input', { deviceId });
    if (announce !== 'none') store.setStatus('Opening the microphone…');
    try {
      await parts.mic.open(deviceId, 1, mode);
    } catch (error) {
      if (token !== this.inputToken) return 'superseded';
      this.opening = false;
      this.markInputClosed();
      store.setStatus(classifyMicError(error).message, 'error');
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
    store.patchSection('input', {
      deviceId,
      label: parts.mic.label,
      open: true,
      processing,
      requestedAec: mode === 'speakers',
    });
    store.patch({ tracker: tracking });
    this.core.current.inputDeviceId = deviceId;
    this.core.persist();
    this.core.latency.refreshLatency();
    void this.core.devices.refreshDevices();
    if (announce !== 'none') this.announceOpen(parts, tracking, announce);
    return 'open';
  }

  /** Puts the outcome of an open on the status line. */
  private announceOpen(parts: SessionParts, tracking: AppState['tracker'], announce: Announce): void {
    const { store } = this.core;
    const { input } = store.state;
    const report = describeMonitor(input);
    if (report?.kind === 'warn') {
      store.setStatus(input.requestedAec ? report.text : PROCESSING_KEPT_ON, 'warn');
    } else if (tracking !== 'unsupported') {
      // A plain open names the mic; after a mode switch the mode's own line is
      // the answer to what the singer just did.
      const line = announce === 'monitor' || input.requestedAec ? report?.text : undefined;
      store.setStatus(line ?? `Microphone ready: ${parts.mic.label || 'default input'}.`);
    } else if (!this.core.trackerSupported) {
      // A failed worklet load has already said why; with no AudioWorklet at
      // all nothing has, and "Opening the microphone…" would stay up for ever.
      store.setStatus(
        'Microphone open, but this browser has no AudioWorklet, so live pitch and recording are off.',
        'warn',
      );
    }
  }

  /** Closes the microphone and the tracker, ending any recording first. */
  async closeInput(): Promise<void> {
    const { parts, store } = this.core;
    if (!parts) return;
    if (store.state.recording) await this.core.takes.finishRecording();
    this.inputToken++;
    this.opening = false;
    parts.tracker.disconnect();
    parts.mic.close();
    this.markInputClosed();
    store.setStatus('Microphone closed.');
  }

  /** Sets the clarity a frame needs to count as voiced (0..1). */
  setClarity(v: number): void {
    if (!Number.isFinite(v)) return;
    const clarity = Math.min(1, Math.max(0, v));
    if (this.core.parts) this.core.parts.tracker.clarityThreshold = clarity;
    this.core.current.clarityThreshold = clarity;
    this.core.persist();
  }

  /** Stops the tracker and closes the mic, for the Session's dispose. */
  dispose(): void {
    this.core.parts?.tracker.disconnect();
    this.core.parts?.mic.close();
  }

  private onFrame(parts: SessionParts, frame: PitchFrame): void {
    this.latestFrame = frame;
    const transport = this.core.songs.active;
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
      this.core.latency.latencyOrZero(),
      transport.loop,
      this.core.songs.embedOffsetNow(),
    );
    if (transport.clock === 'embed') t = orderedFrameTime(t, this.lastFrameT);
    this.lastFrameT = t;
    this.core.bus.publish({ singer: 0, frame: { t, f0: frame.f0, clarity: frame.clarity, rms: frame.rms } });
  }

  private onMicEnded(parts: SessionParts): void {
    this.inputToken++;
    this.opening = false;
    parts.tracker.disconnect();
    if (this.core.store.state.recording) void this.core.takes.finishRecording();
    this.markInputClosed();
    this.core.store.setStatus('The microphone was disconnected. Pick an input to continue.', 'warn');
  }

  private markInputClosed(): void {
    const { store } = this.core;
    this.latestFrame = null;
    this.level = 0;
    store.patchSection('input', {
      label: '',
      open: false,
      level: 0,
      processing: { aec: null, ns: null, agc: null },
      requestedAec: false,
    });
    store.patch({
      tracker: this.core.trackerSupported ? 'idle' : 'unsupported',
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
    if (!this.core.trackerSupported) return 'unsupported';
    try {
      await parts.tracker.load();
      if (token !== this.inputToken) return 'idle';
      parts.tracker.connect(source);
      // Warm the recorder's worklet so the first Record press starts at once.
      void parts.capture.load().catch(() => {});
      return 'running';
    } catch (error) {
      this.core.store.setStatus(`Live pitch is unavailable: ${messageOf(error)}`, 'error');
      return 'unsupported';
    }
  }

  /** Reopens the remembered mic from a gesture; nudges if there is none. */
  reopenSavedInput(): void {
    const { input } = this.core.store.state;
    if (input.open || this.opening) return;
    if (this.core.current.inputDeviceId !== null) void this.chooseInput(this.core.current.inputDeviceId);
    else this.core.store.setStatus('Pick a microphone to see your pitch live.');
  }

  /** True when a mic is open, opening the remembered one if it can. */
  async ensureInput(): Promise<boolean> {
    const { store, current } = this.core;
    if (store.state.input.open) return true;
    if (current.inputDeviceId === null) {
      store.setStatus('Pick a microphone first.', 'warn');
      return false;
    }
    await this.chooseInput(current.inputDeviceId);
    return store.state.input.open;
  }
}
