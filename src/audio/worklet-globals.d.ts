/**
 * Ambient declarations for the AudioWorkletGlobalScope. TypeScript's DOM lib
 * describes the main-thread half of the worklet API (AudioWorkletNode) but
 * not what a processor file sees on the audio thread, so every worklet
 * module in src/ (capture, pitch tracker) leans on this one file instead of
 * redeclaring them. The names are global to the whole project for the type
 * checker, but at runtime they exist only inside a worklet: guard with
 * `typeof AudioWorkletProcessor !== 'undefined'` in any module that must also
 * be imported on the main thread or under test.
 */

/** One entry in a processor's static `parameterDescriptors` list. */
interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

/** Audio-thread half of an AudioWorkletNode; its port pairs with the node's. */
interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

/**
 * A processor class as registerProcessor wants it. `process` is declared here
 * and not on AudioWorkletProcessor itself so a subclass can define it without
 * the `override` keyword that noImplicitOverride would otherwise demand.
 */
interface AudioWorkletProcessorConstructor {
  new (
    options: AudioWorkletNodeOptions,
  ): AudioWorkletProcessor & {
    process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>,
    ): boolean;
  };
  parameterDescriptors?: AudioParamDescriptor[];
}

/** Registers a processor class under the name AudioWorkletNode will ask for. */
declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void;

/** Index of the first frame of the render quantum being processed. */
declare const currentFrame: number;
/** Context time, in seconds, of the first frame of the render quantum. */
declare const currentTime: number;
/** Sample rate of the owning AudioContext, in Hz. */
declare const sampleRate: number;
