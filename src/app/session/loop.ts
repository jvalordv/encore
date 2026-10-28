/**
 * The per-frame loop: once started it moves the lane to the playhead, feeds a
 * replaying take's trace, and every 50 ms writes position, meter level and
 * tracker health into the state. It runs on requestAnimationFrame, or on a
 * 33 ms timer where there is none (tests, a hidden shell).
 */
import type { SessionCore } from './core';

/** How often the tick loop writes position, level and tracker health. */
const PATCH_INTERVAL_MS = 50;
/** The meter falls to this share of its last value per patch. */
const LEVEL_DECAY = 0.8;

/** Drives the lane and the state's moving numbers. */
export class TickLoop {
  private running = false;
  private rafId: number | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private lastPatchMs = -Infinity;

  constructor(private readonly core: SessionCore) {}

  /** Begins the loop; a second call while it runs does nothing. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const frame = (nowMs: number): void => {
      if (!this.running) return;
      this.tick(nowMs);
      this.schedule(frame);
    };
    this.schedule(frame);
  }

  /** Stops the loop. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) globalThis.cancelAnimationFrame(this.rafId);
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.rafId = this.timerId = null;
  }

  private schedule(frame: (nowMs: number) => void): void {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      this.rafId = globalThis.requestAnimationFrame(frame);
    } else {
      this.timerId = setTimeout(() => frame(Date.now()), 33);
    }
  }

  /** One pass of the loop at `nowMs`; public so tests can step it. */
  tick(nowMs: number): void {
    const { parts, songs, takes, input, store } = this.core;
    if (!parts || !songs.active) return;
    const position = songs.currentPosition();
    this.core.lane?.setTime(position);
    takes.feedReplay(position);
    if (nowMs - this.lastPatchMs < PATCH_INTERVAL_MS) return;
    this.lastPatchMs = nowMs;
    // The mic reports its peak since the last call; holding it briefly keeps
    // the meter readable at this slower rate.
    input.level = Math.max(parts.mic.level(), input.level * LEVEL_DECAY);
    if (input.level < 0.001) input.level = 0;
    store.patchSection('input', { level: Math.round(input.level * 100) / 100 });
    store.patch({
      positionS: position,
      framesPerSecond: Math.round(parts.tracker.framesPerSecond),
      lastFrame: input.latestFrame,
    });
  }
}
