/**
 * Reusable PCM capture node. Wires any AudioNode (normally the mic source from
 * mic.ts) into the 'encore-capture' worklet, keeps the Float32 chunks it posts
 * back, and hands out the concatenated take on stop. A live tap (onChunk) lets
 * the latency measurer listen without waiting for the take to end. The worklet
 * keeps a single mono channel and its output is muted: the singer's voice is
 * never routed to the speakers (see "Audio graph" in docs/ARCHITECTURE.md).
 */
import { CAPTURE_PROCESSOR_NAME } from './capture-worklet';
import type { CaptureCommand, CaptureMessage } from './capture-worklet';
import workletUrl from './capture-worklet.ts?worker&url';
import type { AudioEngine } from './engine';

/** A finished take: mono samples plus what is needed to place them in time. */
export interface PcmTake {
  pcm: Float32Array;
  sampleRate: number;
  /** Context time of pcm[0]. */
  startedAtContextS: number;
}

/** How long stop() waits for the worklet's flush before giving up on it. */
const STOP_TIMEOUT_MS = 1000;

/** One addModule per context, shared by every PcmCapture built on it. */
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

/** Joins chunks end to end into one array; no chunks gives an empty array. */
export function concatChunks(chunks: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Records PCM from an AudioNode through the capture worklet. */
export class PcmCapture {
  private ready = false;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private input: AudioNode | null = null;
  private chunks: Float32Array[] = [];
  private firstChunkT: number | null = null;
  private startedAtContextS = 0;
  private stopping: Promise<PcmTake> | null = null;
  private flushed: (() => void) | null = null;
  private readonly taps = new Set<(t: number, samples: Float32Array) => void>();

  constructor(private readonly engine: AudioEngine) {}

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

  /** Connects `source` to the capture worklet and starts keeping samples. */
  start(source: AudioNode): void {
    if (!this.ready) throw new Error('PcmCapture.start() needs load() first.');
    if (this.node) throw new Error('PcmCapture is already recording or stopping.');
    const context = this.engine.context;
    // Mono and explicit: a stereo mic is mixed down by the graph, so channel 0
    // inside the processor is the whole signal rather than just the left side.
    const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    // A node with no path to the destination is not guaranteed to be pulled in
    // every browser. The muted gain keeps it running; the processor writes
    // silence anyway, so nothing audible can leak.
    const sink = context.createGain();
    sink.gain.value = 0;
    this.chunks = [];
    this.firstChunkT = null;
    this.startedAtContextS = this.engine.now();
    node.port.onmessage = (event: MessageEvent<CaptureMessage>) => this.receive(event.data);
    source.connect(node);
    node.connect(sink);
    sink.connect(context.destination);
    this.node = node;
    this.sink = sink;
    this.input = source;
  }

  /** Ends the capture and resolves with everything recorded since start(). */
  stop(): Promise<PcmTake> {
    if (this.stopping) return this.stopping;
    const node = this.node;
    if (!node) return Promise.reject(new Error('PcmCapture.stop() while not recording.'));
    this.stopping = this.finish(node);
    return this.stopping;
  }

  /** Subscribes to live chunks; the arrays are shared, so do not edit them. */
  onChunk(cb: (t: number, samples: Float32Array) => void): () => void {
    this.taps.add(cb);
    return () => {
      this.taps.delete(cb);
    };
  }

  /** True between start() and stop(). */
  get recording(): boolean {
    return this.node !== null && this.stopping === null;
  }

  private receive(message: CaptureMessage): void {
    if (message.type === 'done') {
      this.flushed?.();
      return;
    }
    this.firstChunkT ??= message.t;
    this.chunks.push(message.samples);
    for (const tap of [...this.taps]) {
      try {
        tap(message.t, message.samples);
      } catch (error) {
        // Rethrown off this stack so one faulty tap cannot drop audio for the
        // recording or for the taps after it.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private async finish(node: AudioWorkletNode): Promise<PcmTake> {
    const flushed = new Promise<void>((resolve) => {
      this.flushed = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A suspended or closed context never answers; hand back what arrived
    // rather than leaving the caller waiting for ever.
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    const command: CaptureCommand = { type: 'stop' };
    node.port.postMessage(command);
    await Promise.race([flushed, gaveUp]);
    clearTimeout(timer);

    node.port.onmessage = null;
    node.port.close();
    // A mic closed or swapped mid-take has already cut these links, and a
    // second disconnect throws; that must not cost the singer the take.
    const { input, sink } = this;
    for (const cut of [() => input?.disconnect(node), () => node.disconnect(), () => sink?.disconnect()]) {
      try {
        cut();
      } catch {
        // Already disconnected, which is the state we wanted.
      }
    }
    const take: PcmTake = {
      pcm: concatChunks(this.chunks),
      sampleRate: this.engine.context.sampleRate,
      startedAtContextS: this.firstChunkT ?? this.startedAtContextS,
    };
    this.chunks = [];
    this.node = null;
    this.sink = null;
    this.input = null;
    this.flushed = null;
    this.stopping = null;
    return take;
  }
}
