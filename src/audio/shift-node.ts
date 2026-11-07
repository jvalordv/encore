/**
 * The main-thread end of the pitch shifter: loads the 'encore-shift' worklet
 * into a context once and builds a stereo AudioWorkletNode from it. The
 * Player puts the node between the stems and the master gain while a song is
 * transposed (see Player.setShift); everything about the sound is in
 * pitch-shift.ts.
 */
import { SHIFT_PROCESSOR_NAME } from './shift-worklet';
import type { ShiftMessage } from './shift-worklet';
import workletUrl from './shift-worklet.ts?worker&url';

/** One addModule per context. */
const moduleLoads = new WeakMap<BaseAudioContext, Promise<void>>();

/** True when this browser has AudioWorklet (it needs a secure context). */
export function shiftSupported(): boolean {
  return (
    typeof AudioWorkletNode !== 'undefined' &&
    typeof BaseAudioContext !== 'undefined' &&
    'audioWorklet' in BaseAudioContext.prototype
  );
}

/** Loads the module (once per context) and builds a shifter node. */
export async function createShiftNode(context: BaseAudioContext): Promise<AudioWorkletNode> {
  let loading = moduleLoads.get(context);
  if (!loading) {
    if (!context.audioWorklet) throw new Error('AudioWorklet is not available (needs a secure context).');
    loading = context.audioWorklet.addModule(workletUrl);
    moduleLoads.set(context, loading);
    // A failed load must not be cached or the next attempt could never retry.
    loading.catch(() => moduleLoads.delete(context));
  }
  await loading;
  return new AudioWorkletNode(context, SHIFT_PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  });
}

/** Tells a shifter node how far to move the pitch, in semitones. */
export function setNodeShift(node: AudioWorkletNode, semitones: number): void {
  const message: ShiftMessage = { semitones };
  node.port.postMessage(message);
}
