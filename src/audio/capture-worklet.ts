/**
 * Audio-thread half of PCM capture. A processor registered as
 * 'encore-capture' copies its input into fixed-size Float32Array chunks and
 * posts each one to the main thread with the context time of its first
 * sample, so the recorder and the latency measurer can place audio on the
 * song's clock. The chunking itself lives in ChunkAssembler, a plain class
 * with no worklet dependency, so it can be unit-tested; the processor
 * registration is guarded so importing this module on the main thread or under
 * test is harmless. capture.ts loads this file through Vite's `?worker&url`.
 */

/** Name the processor registers under; AudioWorkletNode asks for it by this. */
export const CAPTURE_PROCESSOR_NAME = 'encore-capture';

/** Samples per posted chunk: about 43 ms at 48 kHz. */
export const CAPTURE_CHUNK_SIZE = 2048;

/** What the processor posts to the main thread. */
export type CaptureMessage =
  | { type: 'chunk'; t: number; samples: Float32Array }
  | { type: 'done' };

/** What the main thread posts to the processor. */
export interface CaptureCommand {
  type: 'stop';
}

/** Render quantum length assumed when the node reports none. */
const DEFAULT_QUANTUM = 128;

/**
 * Cuts a stream of sample blocks into equal chunks and stamps each with the
 * time of its first sample. Owns no timers and no ports: whatever receives the
 * chunks decides how to ship them.
 */
export class ChunkAssembler {
  private buffer: Float32Array;
  private fill = 0;
  private startT = 0;

  constructor(
    private readonly size: number,
    private readonly emit: (t: number, samples: Float32Array) => void,
  ) {
    this.buffer = new Float32Array(size);
  }

  /** Appends `frames`, whose first sample is at context time `t`. */
  push(frames: Float32Array, t: number, rate: number): void {
    let read = 0;
    while (read < frames.length) {
      // Stamp from the sample that opens the chunk, not the block, so a block
      // that straddles two chunks still gives the second one the right time.
      if (this.fill === 0) this.startT = t + read / rate;
      const n = Math.min(frames.length - read, this.size - this.fill);
      this.buffer.set(frames.subarray(read, read + n), this.fill);
      this.fill += n;
      read += n;
      if (this.fill === this.size) {
        this.emit(this.startT, this.buffer);
        // The emitted array is transferred away and unusable here.
        this.buffer = new Float32Array(this.size);
        this.fill = 0;
      }
    }
  }

  /** Emits the partly filled chunk, trimmed to length, if there is one. */
  flush(): void {
    if (this.fill === 0) return;
    const partial = this.buffer.slice(0, this.fill);
    this.fill = 0;
    this.emit(this.startT, partial);
  }
}

// Only the worklet scope defines AudioWorkletProcessor; elsewhere this file is
// just the helpers above.
if (typeof AudioWorkletProcessor !== 'undefined') {
  /** Zeros stand in for a missing input so sample index still maps to time. */
  let silence = new Float32Array(DEFAULT_QUANTUM);
  const silenceOf = (n: number): Float32Array => {
    if (silence.length !== n) silence = new Float32Array(n);
    return silence;
  };

  class CaptureProcessor extends AudioWorkletProcessor {
    private stopped = false;
    private readonly assembler = new ChunkAssembler(CAPTURE_CHUNK_SIZE, (t, samples) => {
      const message: CaptureMessage = { type: 'chunk', t, samples };
      this.port.postMessage(message, [samples.buffer]);
    });

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent<CaptureCommand>) => {
        if (event.data?.type !== 'stop' || this.stopped) return;
        this.stopped = true;
        this.assembler.flush();
        const done: CaptureMessage = { type: 'done' };
        this.port.postMessage(done);
      };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      // Returning false lets the browser drop the processor once stopped.
      if (this.stopped) return false;
      const quantum = outputs[0]?.[0]?.length ?? DEFAULT_QUANTUM;
      // The node is mono, so channel 0 is already the graph's down-mix.
      const frames = inputs[0]?.[0] ?? silenceOf(quantum);
      this.assembler.push(frames, currentTime, sampleRate);
      return true;
    }
  }

  registerProcessor(CAPTURE_PROCESSOR_NAME, CaptureProcessor);
}
