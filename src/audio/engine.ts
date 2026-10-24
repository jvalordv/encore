/**
 * The single Web Audio graph root. Owns the one AudioContext (48 kHz, low
 * latency hint) and a master gain that everything audible routes through, and
 * wraps output-device selection. The player, the latency calibrator and the
 * recorder all take an AudioEngine so they share one clock: song time and mic
 * frame stamps are both derived from `context.currentTime`. Nothing here
 * touches the DOM, and importing this file never throws when Web Audio is
 * missing; check `AudioEngine.isSupported()` before constructing.
 */

/** Context rate. 48 kHz matches the tracker's hop maths and most hardware. */
const ENGINE_SAMPLE_RATE = 48000;

/** How often `ensureRunning` looks at the context, milliseconds. */
const RUNNING_POLL_MS = 10;

/** Constructor shape for AudioContext, including old WebKit's prefix. */
type ContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** `AudioContext.setSinkId`, which TypeScript's DOM lib may not know yet. */
interface SinkCapable {
  setSinkId?: (sinkId: string) => Promise<void>;
}

/** The AudioContext constructor if the platform has one, else null. */
function contextCtor(): ContextCtor | null {
  const g = globalThis as { AudioContext?: ContextCtor; webkitAudioContext?: ContextCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** Owns the AudioContext and master gain shared by every audio component. */
export class AudioEngine {
  /** The one context; created suspended, resumed from a user gesture. */
  readonly context: AudioContext;
  /** Final gain stage feeding `context.destination`. */
  readonly master: GainNode;
  private sinkId: string | null = null;

  /** Creates the context. Throws if Web Audio is missing (see isSupported). */
  constructor() {
    const Ctor = contextCtor();
    if (!Ctor) throw new Error('Web Audio is not available in this environment');
    this.context = createContext(Ctor);
    // Browsers that allow autoplay hand back a running context; pin it to
    // suspended so every caller sees the same starting state.
    if (this.context.state === 'running') void this.context.suspend().catch(() => {});
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);
  }

  /** True when the platform has an AudioContext. */
  static isSupported(): boolean {
    return contextCtor() !== null;
  }

  /** Starts the context; most browsers require a user gesture for this. */
  async resume(): Promise<void> {
    if (this.context.state === 'closed') return;
    await this.context.resume();
  }

  /**
   * Starts the context and waits until its clock moves, true, or until
   * `timeoutMs` has passed, false. Starting is not instant: a context that was
   * suspended, or never started, can take up to about a second, and the state
   * can turn to running before the device has made the clock move. Everything
   * reads that clock, so something that must begin on it with another source
   * already going (a song handed over from a video) waits here first.
   */
  async ensureRunning(timeoutMs: number): Promise<boolean> {
    // Not awaited: a start the browser will not make yet never settles.
    let refused = false;
    void this.resume().catch(() => {
      refused = true;
    });
    // Real time, not a count of polls: a page whose timers are slowed down
    // (a hidden one) must not stretch the wait.
    const deadlineMs = performance.now() + timeoutMs;
    let seenS = this.now();
    while (!refused && performance.now() <= deadlineMs) {
      await new Promise<void>((resolve) => setTimeout(resolve, RUNNING_POLL_MS));
      const nowS = this.now();
      if (this.context.state === 'running' && nowS > seenS) return true;
      seenS = nowS;
    }
    return false;
  }

  /** Current context time in seconds; the master clock for everything. */
  now(): number {
    return this.context.currentTime;
  }

  /**
   * Routes output to a device, or back to the default with null. Resolves
   * false when `setSinkId` is missing (WebKit) or the device is refused.
   */
  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    const ctx = this.context as unknown as SinkCapable;
    if (typeof ctx.setSinkId !== 'function') return false;
    try {
      await ctx.setSinkId(deviceId ?? '');
      this.sinkId = deviceId;
      return true;
    } catch {
      return false;
    }
  }

  /** The device chosen with setOutputDevice, or null for the default. */
  get outputDeviceId(): string | null {
    return this.sinkId;
  }
}

/** Builds the context at 48 kHz, retrying without a rate if it is refused. */
function createContext(Ctor: ContextCtor): AudioContext {
  try {
    return new Ctor({ sampleRate: ENGINE_SAMPLE_RATE, latencyHint: 'interactive' });
  } catch {
    // Some engines reject a fixed rate; running at the hardware rate beats
    // having no audio, and downstream code reads sampleRate from the context.
    return new Ctor({ latencyHint: 'interactive' });
  }
}

/** Output devices (kind 'audiooutput'); empty when enumeration is missing. */
export async function listOutputDevices(): Promise<MediaDeviceInfo[]> {
  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    return (devices ?? []).filter((d) => d.kind === 'audiooutput');
  } catch {
    return [];
  }
}
