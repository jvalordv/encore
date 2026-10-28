/**
 * The frame bus: where a pitch frame, once put on song time, is announced to
 * whoever wants it. Each message carries the singer it belongs to (0 for the
 * only mic today) so a second mic can join without the input controller
 * knowing about it. Today the take recorder and the live scorer subscribe (the
 * scorer grades each frame and feeds the lane); subscribers are called in the
 * order they joined.
 */
import type { PitchFrame } from '../../analysis/pitch';

/** One pitch frame on song time, tagged with the singer it came from. */
export interface SingerFrame {
  singer: number;
  frame: PitchFrame;
}

/** Fan-out of singer frames to subscribers, in subscription order. */
export class FrameBus {
  private readonly subscribers = new Set<(message: SingerFrame) => void>();

  /** Registers a subscriber; returns the function that removes it. */
  subscribe(cb: (message: SingerFrame) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Hands the message to every subscriber. */
  publish(message: SingerFrame): void {
    for (const cb of [...this.subscribers]) cb(message);
  }
}
