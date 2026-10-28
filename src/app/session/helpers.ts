/**
 * Pure helpers the session controllers share: the frame-to-song-time maths,
 * take-replay indexing and the loop button rule, plus the few tiny utilities
 * (error text, sleep, page origin) that more than one controller needs. None
 * of it touches Web Audio or the DOM, so it is tested without any audio
 * (test/state.test.ts); src/app/session.ts re-exports the pure part.
 */
import { normaliseLoop } from '../../audio/player';
import type { LoopRegion } from '../../audio/transport';

/** Length of the loop made by pressing A or B with no loop yet, seconds. */
export const DEFAULT_LOOP_S = 8;

/** A frame this close behind the one before it is clock jitter, not a seek. */
export const FRAME_JITTER_S = 0.05;
/** How far past the previous frame a jittered frame is placed. */
const FRAME_STEP_S = 1e-6;

/**
 * Song time of a pitch frame. The frame was stamped `frameT` on the context
 * clock; the song was at `positionNow` when the context read `contextNow`, and
 * the singer was reacting to audio that left the speakers `latencyS` before
 * the mic stamped it. `embedOffsetS` is extra delay for the path calibration
 * cannot measure (a YouTube video's own audio output); it is 0 for a file.
 * Inside a loop, a frame from just before a wrap is folded back into the
 * previous pass instead of landing before the loop's start.
 */
export function frameToSongTime(
  frameT: number,
  contextNow: number,
  positionNow: number,
  latencyS: number,
  loop: LoopRegion | null = null,
  embedOffsetS = 0,
): number {
  const songTime = positionNow - (contextNow - frameT) - latencyS - embedOffsetS;
  if (!loop || loop.endS <= loop.startS) return songTime;
  const inside = positionNow >= loop.startS && positionNow < loop.endS;
  if (!inside || songTime >= loop.startS) return songTime;
  const length = loop.endS - loop.startS;
  const into = (songTime - loop.startS) % length;
  return loop.startS + (into < 0 ? into + length : into);
}

/**
 * Keeps the stamps of an embedded video's frames in order. The video's clock
 * runs smoothly while the audio context's is read in steps of a buffer, about
 * 10 ms, so two frames can come out a few milliseconds the wrong way round. A
 * frame less than FRAME_JITTER_S behind the one before it is put just after
 * it; a bigger step back is a seek or a loop wrap and is left alone.
 */
export function orderedFrameTime(t: number, previousT: number): number {
  return t <= previousT && previousT - t < FRAME_JITTER_S ? previousT + FRAME_STEP_S : t;
}

/** Index of the first frame at or after `t`; frames must be sorted by t. */
export function firstFrameIndex(frames: ReadonlyArray<{ t: number }>, t: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The loop after the A or B button is pressed at `positionS`: A moves the
 * start (keeping the end if it is still ahead), B moves the end. With no loop
 * yet, the other end is a default stretch away. Null when the result is too
 * short or not a number.
 */
export function loopWithPoint(
  which: 'a' | 'b',
  positionS: number,
  current: LoopRegion | null,
  durationS: number,
): LoopRegion | null {
  const region =
    which === 'a'
      ? {
          startS: positionS,
          endS: current && current.endS > positionS ? current.endS : positionS + DEFAULT_LOOP_S,
        }
      : {
          startS:
            current && current.startS < positionS ? current.startS : positionS - DEFAULT_LOOP_S,
          endS: positionS,
        };
  return normaliseLoop(region, durationS);
}

/** An error's message, or its text when it has none. */
export function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** The page's origin, which the YouTube iframe wants; empty outside a page. */
export function pageOrigin(): string {
  return globalThis.location?.origin ?? '';
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
