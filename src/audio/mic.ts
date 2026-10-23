/**
 * Microphone capture. Lists input devices, opens one with all of the
 * browser's voice processing switched off (echo cancellation, noise
 * suppression and auto gain flatten dynamics and smear pitch onsets, see
 * "Mic constraints" in docs/ARCHITECTURE.md), and exposes the live
 * MediaStream, a source node for the pitch worklet and recorder, and a cheap
 * peak meter. Failures come back as MicError with a code the status bar can
 * switch on, never as a raw DOMException. The source is never connected to the
 * destination: headphones carry the song, and speaker bleed would poison the
 * analysis. Nothing here throws at import time when the APIs are missing.
 */
import type { AudioEngine } from './engine';

/** One selectable microphone. */
export interface InputDevice {
  deviceId: string;
  /** Empty until the user has granted mic permission once. */
  label: string;
}

/** Constraints every mic open starts from: raw, mono, 48 kHz if offered. */
export const MIC_CONSTRAINTS: MediaTrackConstraints = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: Object.freeze({ ideal: 1 }),
  sampleRate: Object.freeze({ ideal: 48000 }),
});

/** Why a mic could not be opened, coarse enough to pick a status message. */
export type MicErrorCode = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'unknown';

/** A mic failure whose message is fit to show to the user as it stands. */
export class MicError extends Error {
  readonly code: MicErrorCode;

  constructor(code: MicErrorCode, message: string) {
    super(message);
    this.name = 'MicError';
    this.code = code;
  }
}

/** Largest window an AnalyserNode offers, so slow polling still sees peaks. */
const ANALYSER_SIZE = 32768;
/** Smallest level window: one render quantum, the analyser's granularity. */
const MIN_LEVEL_WINDOW = 128;

/** DOMException and legacy error names mapped to the code they mean here. */
const ERROR_CODES = new Map<string, MicErrorCode>([
  ['NotAllowedError', 'denied'],
  ['PermissionDeniedError', 'denied'],
  // Raised when the page or an iframe policy forbids user media outright.
  ['SecurityError', 'denied'],
  ['NotFoundError', 'not-found'],
  ['DevicesNotFoundError', 'not-found'],
  // Only the exact deviceId constraint can fail, so this means it is gone.
  ['OverconstrainedError', 'not-found'],
  ['ConstraintNotSatisfiedError', 'not-found'],
  ['NotReadableError', 'in-use'],
  ['TrackStartError', 'in-use'],
  ['NotSupportedError', 'unsupported'],
]);

const ERROR_MESSAGES: Record<Exclude<MicErrorCode, 'unknown'>, string> = {
  denied:
    'Microphone access is blocked. Allow it for this site in the browser, then pick the mic again.',
  'not-found': 'That microphone was not found. It may be unplugged; pick another input.',
  'in-use': 'The microphone could not be opened. Another app may be using it.',
  unsupported:
    'This browser cannot capture a microphone here. Use a current Chrome or Edge on localhost or https.',
};

/** MediaDevices if the platform has it (absent when insecure), else null. */
function mediaDevicesOrNull(): MediaDevices | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.mediaDevices ?? null;
}

/** Lists audio inputs (labels empty before permission); [] if unsupported. */
export async function listInputDevices(): Promise<InputDevice[]> {
  const devices = mediaDevicesOrNull();
  if (!devices || typeof devices.enumerateDevices !== 'function') return [];
  try {
    const all = await devices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

/** Calls `cb` when devices come or go; returns an unsubscribe function. */
export function onDeviceChange(cb: () => void): () => void {
  const devices = mediaDevicesOrNull();
  if (!devices || typeof devices.addEventListener !== 'function') return () => {};
  devices.addEventListener('devicechange', cb);
  return () => devices.removeEventListener('devicechange', cb);
}

/** Maps whatever getUserMedia threw to a MicError; passes MicErrors through. */
export function classifyMicError(e: unknown): MicError {
  if (e instanceof MicError) return e;
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined;
  const code = (typeof name === 'string' && ERROR_CODES.get(name)) || 'unknown';
  let message: string;
  if (code === 'unknown') {
    const detail = e instanceof Error && e.message ? e.message : String(e);
    message = `Could not open the microphone: ${detail}`;
  } else {
    message = ERROR_MESSAGES[code];
  }
  const error = new MicError(code, message);
  error.cause = e;
  return error;
}

/** Largest absolute sample value in `frame`; 0 for an empty frame. */
export function peak(frame: Float32Array): number {
  let max = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = Math.abs(frame[i]);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Constraints for opening `deviceId` (null for the system default) with 1 or
 * 2 channels. The device is `exact` so a missing mic fails loudly instead of
 * silently falling back to another one.
 */
export function buildMicConstraints(
  deviceId: string | null,
  channels: 1 | 2 = 1,
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    ...MIC_CONSTRAINTS,
    channelCount: { ideal: channels },
  };
  if (deviceId) constraints.deviceId = { exact: deviceId };
  return constraints;
}

/**
 * How many of the analyser's newest samples cover the time since the last
 * level() call: elapsed seconds at the context rate, kept within one render
 * quantum and the analyser's buffer.
 */
export function levelWindowSamples(elapsedS: number, sampleRate: number, max: number): number {
  const wanted = Math.ceil(elapsedS * sampleRate);
  if (!Number.isFinite(wanted)) return MIN_LEVEL_WINDOW;
  return Math.min(max, Math.max(MIN_LEVEL_WINDOW, wanted));
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/** An open microphone routed into the engine's context, ready to be tapped. */
export class MicCapture {
  private media: MediaStream | null = null;
  private track: MediaStreamTrack | null = null;
  private node: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private readonly scratch = new Float32Array(ANALYSER_SIZE);
  private id: string | null = null;
  private lastLevelAtS = 0;
  // Bumped by every open() and close() so a slow permission prompt that
  // resolves after a newer call cannot resurrect a stale stream.
  private generation = 0;
  private readonly endedListeners = new Set<() => void>();
  private readonly handleEnded = (): void => {
    for (const cb of [...this.endedListeners]) cb();
  };

  constructor(private readonly engine: AudioEngine) {}

  /** True when getUserMedia and Web Audio are both present. */
  static isSupported(): boolean {
    const devices = mediaDevicesOrNull();
    return (
      devices !== null &&
      typeof devices.getUserMedia === 'function' &&
      typeof AudioContext !== 'undefined'
    );
  }

  /**
   * Opens a mic (null for the system default), closing any previous one
   * first. Throws MicError. If a later open() or close() overtakes this call
   * while the permission prompt is up, the stale stream is stopped and this
   * resolves without effect; check `stream` afterwards if it matters.
   */
  async open(deviceId: string | null, channels: 1 | 2 = 1): Promise<void> {
    const devices = mediaDevicesOrNull();
    if (!devices || !MicCapture.isSupported()) {
      throw new MicError('unsupported', ERROR_MESSAGES.unsupported);
    }
    const generation = ++this.generation;
    // Some devices cannot be opened twice, and a stale stream keeps the
    // browser's recording light on.
    this.release();
    // Started before the prompt: the user activation that allows resuming can
    // lapse while the permission dialog is open.
    void this.engine.resume().catch(() => {});

    let stream: MediaStream;
    try {
      stream = await devices.getUserMedia({ audio: buildMicConstraints(deviceId, channels) });
    } catch (e) {
      throw classifyMicError(e);
    }
    if (generation !== this.generation) {
      stopTracks(stream);
      return;
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stopTracks(stream);
      throw new MicError('not-found', ERROR_MESSAGES['not-found']);
    }

    const context = this.engine.context;
    try {
      const node = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = ANALYSER_SIZE;
      node.connect(analyser);
      this.node = node;
      this.analyser = analyser;
    } catch (e) {
      stopTracks(stream);
      // Firefox refuses a mic whose native rate differs from the context's.
      const error = new MicError(
        'unsupported',
        'This browser cannot feed that microphone into the audio engine, often a sample-rate mismatch.',
      );
      error.cause = e;
      throw error;
    }
    this.media = stream;
    this.track = track;
    this.id = track.getSettings().deviceId ?? deviceId;
    this.lastLevelAtS = this.engine.now();
    track.addEventListener('ended', this.handleEnded);
  }

  /** Stops the mic and tears down its nodes; safe when nothing is open. */
  close(): void {
    this.generation++;
    this.release();
  }

  /** The live stream, or null when closed. */
  get stream(): MediaStream | null {
    return this.media;
  }

  /** Context-side source for the stream; never connected to the destination. */
  get source(): MediaStreamAudioSourceNode | null {
    return this.node;
  }

  /** Id of the device actually opened (the browser's pick for the default). */
  get deviceId(): string | null {
    return this.id;
  }

  /** The device's name as the browser reports it; empty when closed. */
  get label(): string {
    return this.track?.label ?? '';
  }

  /** What the browser really applied (echo cancellation, rate, channels). */
  get settings(): MediaTrackSettings | null {
    return this.track ? this.track.getSettings() : null;
  }

  /** Peak level 0..1 since the previous call; 0 when closed. */
  level(): number {
    const analyser = this.analyser;
    if (!analyser) return 0;
    const nowS = this.engine.now();
    const rate = this.engine.context.sampleRate;
    const n = levelWindowSamples(nowS - this.lastLevelAtS, rate, ANALYSER_SIZE);
    this.lastLevelAtS = nowS;
    analyser.getFloatTimeDomainData(this.scratch);
    // The analyser keeps its newest samples at the end of the buffer.
    return Math.min(1, peak(this.scratch.subarray(this.scratch.length - n)));
  }

  /**
   * Subscribes to the browser ending the track (device unplugged, permission
   * revoked). The capture stays open but silent until close() or open().
   */
  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => {
      this.endedListeners.delete(cb);
    };
  }

  private release(): void {
    this.track?.removeEventListener('ended', this.handleEnded);
    this.node?.disconnect();
    this.analyser?.disconnect();
    if (this.media) stopTracks(this.media);
    this.media = null;
    this.track = null;
    this.node = null;
    this.analyser = null;
    this.id = null;
  }
}
