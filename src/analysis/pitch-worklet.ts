/**
 * Audio-thread half of the live pitch tracker. A processor registered as
 * 'encore-pitch' keeps the latest PITCH_WINDOW samples of input channel 0 and,
 * every PITCH_HOP samples, runs estimatePitch on them and posts a PitchFrame
 * to the main thread. The windowing lives in PitchWindower, a plain class with
 * no worklet dependency, so hop timing and frame stamps can be unit-tested; the
 * processor registration is guarded so importing this module on the main
 * thread or under test is harmless. pitch-tracker.ts loads this file through
 * Vite's `?worker&url`, which bundles pitch.ts and fft.ts into it.
 */
import { PITCH_HOP, PITCH_WINDOW, estimatePitch } from './pitch';
import type { PitchFrame } from './pitch';

/** Name the processor registers under; AudioWorkletNode asks for it by this. */
export const PITCH_PROCESSOR_NAME = 'encore-pitch';

/** Search range and peak-picking tolerance, passed as processorOptions. */
export interface PitchProcessorOptions {
  minF0?: number;
  maxF0?: number;
  k?: number;
}

/** Render quantum length assumed when the node reports none. */
const DEFAULT_QUANTUM = 128;

/**
 * Slides a PITCH_WINDOW-sample window over a stream of blocks and reports a
 * pitch frame each time PITCH_HOP new samples have arrived. Owns no ports and
 * no timers: whoever supplies the blocks decides where the frames go.
 */
export class PitchWindower {
  private readonly ring: Float32Array;
  private readonly ordered: Float32Array;
  private write = 0;
  private filled = 0;
  private sinceLast = 0;

  constructor(
    private readonly rate: number,
    private readonly emit: (frame: PitchFrame) => void,
    private readonly opts: PitchProcessorOptions = {},
    private readonly size: number = PITCH_WINDOW,
    private readonly hop: number = PITCH_HOP,
  ) {
    this.ring = new Float32Array(size);
    this.ordered = new Float32Array(size);
  }

  /** Appends `block`, whose first sample is at context time `blockT`. */
  push(block: Float32Array, blockT: number): void {
    for (let i = 0; i < block.length; i++) {
      this.ring[this.write] = block[i];
      this.write = this.write + 1 === this.size ? 0 : this.write + 1;
      if (this.filled < this.size) this.filled++;
      this.sinceLast++;
      if (this.filled === this.size && this.sinceLast >= this.hop) {
        this.sinceLast = 0;
        // Sample i is the newest in the window, so the window opens at
        // i + 1 - size and its centre sits half a window after that.
        const t = blockT + (i + 1 - this.size / 2) / this.rate;
        this.analyse(t);
      }
    }
  }

  /** Forgets all buffered audio, e.g. after the input source changes. */
  reset(): void {
    this.ring.fill(0);
    this.write = 0;
    this.filled = 0;
    this.sinceLast = 0;
  }

  private analyse(t: number): void {
    // Unroll the ring into time order; the oldest sample is at `write`.
    const head = this.size - this.write;
    this.ordered.set(this.ring.subarray(this.write), 0);
    this.ordered.set(this.ring.subarray(0, this.write), head);
    const { f0, clarity, rms } = estimatePitch(this.ordered, this.rate, this.opts);
    this.emit({ t, f0, clarity, rms });
  }
}

// Only the worklet scope defines AudioWorkletProcessor; elsewhere this file is
// just the helpers above.
if (typeof AudioWorkletProcessor !== 'undefined') {
  /** Zeros stand in for a missing input so the frame stream never stalls. */
  let silence = new Float32Array(DEFAULT_QUANTUM);
  const silenceOf = (n: number): Float32Array => {
    if (silence.length !== n) silence = new Float32Array(n);
    return silence;
  };

  class PitchProcessor extends AudioWorkletProcessor {
    private readonly windower: PitchWindower;

    constructor(options: AudioWorkletNodeOptions) {
      super(options);
      const opts = (options?.processorOptions ?? {}) as PitchProcessorOptions;
      this.windower = new PitchWindower(sampleRate, (frame) => this.port.postMessage(frame), opts);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const quantum = outputs[0]?.[0]?.length ?? DEFAULT_QUANTUM;
      // A disconnected input arrives as an empty list; keep time flowing with
      // silence so the consumer still sees a steady stream of unvoiced frames.
      const samples = inputs[0]?.[0] ?? silenceOf(quantum);
      this.windower.push(samples, currentTime);
      return true;
    }
  }

  registerProcessor(PITCH_PROCESSOR_NAME, PitchProcessor);
}
