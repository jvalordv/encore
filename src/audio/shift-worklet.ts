/**
 * Audio-thread shell of the pitch shifter. A processor registered as
 * 'encore-shift' feeds each render quantum's stereo input through a
 * PitchShifter (pitch-shift.ts, where the method and the latency are
 * described) and writes the result; the main thread sets the shift by
 * posting `{ semitones }`. The registration is guarded so importing this
 * module on the main thread or under test is harmless. shift-node.ts loads
 * this file through Vite's `?worker&url`, which bundles pitch-shift.ts in.
 */
import { PitchShifter } from './pitch-shift';

/** Name the processor registers under; AudioWorkletNode asks for it by this. */
export const SHIFT_PROCESSOR_NAME = 'encore-shift';

/** A message to the processor: the shift to apply, in semitones. */
export interface ShiftMessage {
  semitones: number;
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class ShiftProcessor extends AudioWorkletProcessor {
    private readonly shifter = new PitchShifter(2);

    constructor(options: AudioWorkletNodeOptions) {
      super(options);
      this.port.onmessage = (event: MessageEvent<ShiftMessage>) => this.shifter.setSemitones(event.data.semitones);
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      // Kept running with silence when nothing is connected, so the delay
      // stays the same and the next sound is not clipped at its start.
      this.shifter.process(inputs[0] ?? [], outputs[0]);
      return true;
    }
  }
  registerProcessor(SHIFT_PROCESSOR_NAME, ShiftProcessor);
}
