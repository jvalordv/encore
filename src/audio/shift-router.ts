/**
 * Where the Player's stems feed while a song is transposed. With no shift the
 * stems go straight to the engine's master gain, as they always did. With a
 * shift, they go to a bus that feeds the pitch shifter worklet (shift-node.ts)
 * and its output goes to the master, so the sound is moved by the shift and
 * delayed by the shifter's fixed latency; set back to 0 the shifter leaves the
 * path and the delay with it. The worklet loads on the first shift. A stem
 * that must keep its own pitch (a replayed take) is sent to the master
 * whatever the shift. DOM-free.
 */
import type { AudioEngine } from './engine';
import { SHIFT_MAX_SEMITONES, shiftLatencyS } from './pitch-shift';
import { createShiftNode, setNodeShift, shiftSupported } from './shift-node';

/** Routes stems through the pitch shifter when a shift is on. */
export class ShiftRouter {
  private semitones = 0;
  private bus: GainNode | null = null;
  private node: AudioWorkletNode | null = null;
  private loading: Promise<boolean> | null = null;

  constructor(private readonly engine: AudioEngine) {}

  /** The shift asked for, in whole semitones. */
  get value(): number {
    return this.semitones;
  }

  /** True while the shifter is in the path (a shift is on and it has loaded). */
  get inGraph(): boolean {
    return this.semitones !== 0 && this.node !== null;
  }

  /** The delay the shifter adds while it is in the path, in seconds. */
  get delayS(): number {
    return this.inGraph ? shiftLatencyS(this.engine.context.sampleRate) : 0;
  }

  /** The node a stem's gain should feed: the bus when it is to be shifted, else the master. */
  output(shifted: boolean, suspended = false): AudioNode {
    return shifted && !suspended && this.bus && this.inGraph ? this.bus : this.engine.master;
  }

  /**
   * Sets the shift (rounded and held to -6..+6), loading the shifter on first
   * use. Resolves false, with no shift, when the browser has no AudioWorklet
   * or the module cannot load. The caller re-routes its stems afterwards.
   */
  async set(semitones: number): Promise<boolean> {
    this.semitones = Math.max(-SHIFT_MAX_SEMITONES, Math.min(SHIFT_MAX_SEMITONES, Math.round(semitones) || 0));
    if (this.semitones !== 0 && !this.node) {
      const loading = (this.loading ??= this.build());
      const loaded = await loading;
      this.loading = null;
      if (!loaded || !this.node) {
        this.semitones = 0;
        return false;
      }
    }
    if (this.node) setNodeShift(this.node, this.semitones);
    return true;
  }

  private async build(): Promise<boolean> {
    if (!shiftSupported()) return false;
    try {
      const ctx = this.engine.context;
      const node = await createShiftNode(ctx);
      const bus = ctx.createGain();
      bus.connect(node);
      node.connect(this.engine.master);
      this.bus = bus;
      this.node = node;
      return true;
    } catch {
      return false;
    }
  }
}
