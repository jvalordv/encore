/**
 * Main-thread face of the live pitch tracker. Loads the 'encore-pitch' worklet
 * into the engine's AudioContext, wires any AudioNode (normally the mic source
 * from mic.ts) into it, and fans the posted frames out to listeners, with the
 * voicing decision applied: a frame whose clarity is under the threshold is
 * delivered with f0 = 0, so consumers see one steady 100 Hz stream of voiced
 * and unvoiced frames and never have to guess at gaps. Frame times are raw
 * context times; shifting them by the calibrated latency is the caller's job.
 * The singer's voice is never routed to the speakers: the worklet's output is
 * silent and passes through a muted gain.
 */
import type { AudioEngine } from '../audio/engine';
import { DEFAULT_CLARITY } from './pitch';
import type { PitchFrame } from './pitch';
import { PITCH_PROCESSOR_NAME } from './pitch-worklet';
import type { PitchProcessorOptions } from './pitch-worklet';
import workletUrl from './pitch-worklet.ts?worker&url';

/** Construction options for PitchTracker. */
export interface PitchTrackerOptions extends PitchProcessorOptions {
  /** Clarity at or above which a frame counts as voiced. */
  clarityThreshold?: number;
}

/** One addModule per context, shared by every tracker built on it. */
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

/** Wall clock in milliseconds, monotonic where the platform offers it. */
function defaultClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Measures how many events arrive per second over a sliding window. The rate
 * is read against the current time, so it decays to 0 when events stop rather
 * than freezing at the last good value.
 */
export class RateMeter {
  private stamps: number[] = [];

  constructor(
    private readonly windowMs: number = 1000,
    private readonly clock: () => number = defaultClock,
  ) {}

  /** Records one event at the current time. */
  tick(): void {
    this.stamps.push(this.clock());
    this.trim(this.clock());
  }

  /** Events per second over the window; 0 until two events span 100 ms. */
  get rate(): number {
    const now = this.clock();
    this.trim(now);
    const n = this.stamps.length;
    if (n < 2) return 0;
    const span = this.stamps[n - 1] - this.stamps[0];
    // Too short a span makes a burst of queued messages look like a huge rate.
    return span >= 100 ? ((n - 1) * 1000) / span : 0;
  }

  /** Forgets all events. */
  reset(): void {
    this.stamps = [];
  }

  private trim(now: number): void {
    let drop = 0;
    while (drop < this.stamps.length && now - this.stamps[drop] > this.windowMs) drop++;
    if (drop > 0) this.stamps.splice(0, drop);
  }
}

/** Returns `frame` with f0 zeroed when it is under the voicing threshold. */
export function applyVoicing(frame: PitchFrame, threshold: number): PitchFrame {
  if (frame.f0 > 0 && frame.clarity >= threshold) return frame;
  return { t: frame.t, f0: 0, clarity: frame.clarity, rms: frame.rms };
}

/** Runs the pitch worklet on a source node and publishes gated frames. */
export class PitchTracker {
  private ready = false;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private input: AudioNode | null = null;
  private threshold: number;
  private readonly meter = new RateMeter();
  private readonly listeners = new Set<(frame: PitchFrame) => void>();

  constructor(
    private readonly engine: AudioEngine,
    private readonly opts: PitchTrackerOptions = {},
  ) {
    this.threshold = clampClarity(opts.clarityThreshold, DEFAULT_CLARITY);
  }

  /** True when this browser has AudioWorklet, which needs a secure context. */
  static isSupported(): boolean {
    return (
      typeof AudioWorkletNode !== 'undefined' &&
      typeof BaseAudioContext !== 'undefined' &&
      'audioWorklet' in BaseAudioContext.prototype
    );
  }

  /** Loads the worklet module into the engine's context; safe to repeat. */
  async load(): Promise<void> {
    const context = this.engine.context;
    let loading = moduleLoads.get(context);
    if (!loading) {
      if (!context.audioWorklet) {
        throw new Error('AudioWorklet is not available (needs a secure context).');
      }
      loading = context.audioWorklet.addModule(workletUrl);
      moduleLoads.set(context, loading);
      // A failed load must not be cached or the next attempt could never retry.
      loading.catch(() => moduleLoads.delete(context));
    }
    await loading;
    this.ready = true;
  }

  /** Feeds `source` to the tracker; a second call swaps the source. */
  connect(source: AudioNode): void {
    if (!this.ready) throw new Error('PitchTracker.connect() needs load() first.');
    const context = this.engine.context;
    let node = this.node;
    if (!node) {
      const processorOptions: PitchProcessorOptions = {
        minF0: this.opts.minF0,
        maxF0: this.opts.maxF0,
        k: this.opts.k,
      };
      // Mono and explicit: a stereo mic is mixed down by the graph, so channel
      // 0 inside the processor is the whole signal rather than just the left.
      node = new AudioWorkletNode(context, PITCH_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions,
      });
      // A node with no path to the destination is not guaranteed to be pulled
      // in every browser. The muted gain keeps it running; the processor
      // writes silence anyway, so nothing audible can leak.
      const sink = context.createGain();
      sink.gain.value = 0;
      node.port.onmessage = (event: MessageEvent<PitchFrame>) => this.receive(event.data);
      node.connect(sink);
      sink.connect(context.destination);
      this.node = node;
      this.sink = sink;
    } else if (this.input) {
      const previous = this.input;
      const current = node;
      safely(() => previous.disconnect(current));
    }
    source.connect(node);
    this.input = source;
    this.meter.reset();
  }

  /** Detaches from the source and tears the worklet node down. */
  disconnect(): void {
    const node = this.node;
    if (!node) return;
    const input = this.input;
    if (input) safely(() => input.disconnect(node));
    safely(() => node.disconnect());
    safely(() => this.sink?.disconnect());
    node.port.onmessage = null;
    node.port.close();
    this.node = null;
    this.sink = null;
    this.input = null;
    this.meter.reset();
  }

  /** Subscribes to frames; returns the function that unsubscribes. */
  onFrame(cb: (f: PitchFrame) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Frames per second actually arriving, for the status bar; 0 when idle. */
  get framesPerSecond(): number {
    return this.meter.rate;
  }

  /** Clarity at or above which a frame is delivered as voiced. */
  get clarityThreshold(): number {
    return this.threshold;
  }

  set clarityThreshold(v: number) {
    this.threshold = clampClarity(v, this.threshold);
  }

  private receive(data: PitchFrame): void {
    if (!data || typeof data.f0 !== 'number' || typeof data.clarity !== 'number') return;
    this.meter.tick();
    const frame = applyVoicing(data, this.threshold);
    for (const cb of [...this.listeners]) {
      try {
        cb(frame);
      } catch (error) {
        // Rethrown off this stack so one faulty listener cannot starve the
        // listeners after it or stall the stream.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}

/** Keeps a threshold inside 0..1, falling back when it is not a number. */
function clampClarity(v: number | undefined, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

/** Runs `fn`, ignoring the InvalidAccessError a repeat disconnect throws. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Already disconnected, which is the state we wanted.
  }
}
