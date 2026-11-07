/**
 * Puts blocks of captured tab audio at their video time. Capture while it
 * plays records the tab's output as it comes; the video is not always moving
 * (an ad, buffering, a pause) and the singer may seek, so the recording cannot
 * simply be appended. The caller stamps each block with the video position of
 * its first sample, taken from the embed clock, and only offers blocks heard
 * while the state was 'playing'. This module writes each block into a buffer
 * as long as the video, so a seek back writes over what was there and a seek
 * forward leaves a gap, and it reports how much of the video has been heard
 * and the longest stretch that has not. Pure: no Web Audio, no clock.
 */

/**
 * A block that starts within this of the end of the one before is its
 * continuation. The embed clock is good to about 14 ms (see embed-clock.ts), so
 * stamping every block from it alone would leave slivers of gap and overlap
 * where there is none; snapping keeps a run of playing blocks gapless.
 */
export const SNAP_S = 0.03;

/** The least share of the video a stopped capture may cover. */
export const MIN_STOP_COVERAGE = 0.9;

/** Audio of a whole video, filled in where the video played. */
export class CaptureAssembler {
  readonly sampleRate: number;
  /** Length of the video in samples. */
  private readonly total: number;
  private readonly samples: Float32Array;
  // Sorted, disjoint, non-touching [start, end) sample spans that hold audio.
  private spans: Array<[number, number]> = [];
  private lastEnd = -1;

  constructor(sampleRate: number, durationS: number) {
    if (!(sampleRate > 0)) throw new RangeError(`Sample rate must be positive, got ${sampleRate}`);
    if (!(durationS > 0)) throw new RangeError(`Duration must be positive, got ${durationS}`);
    this.sampleRate = sampleRate;
    this.total = Math.ceil(durationS * sampleRate);
    this.samples = new Float32Array(this.total);
  }

  /** The whole buffer, silent where nothing was captured. */
  get pcm(): Float32Array {
    return this.samples;
  }

  /** Length of the video in seconds as this buffer holds it. */
  get durationS(): number {
    return this.total / this.sampleRate;
  }

  /** Writes `block`, whose first sample sits at video time `startS`. */
  place(block: Float32Array, startS: number): void {
    if (block.length === 0 || !Number.isFinite(startS)) return;
    let start = Math.round(startS * this.sampleRate);
    if (this.lastEnd >= 0 && Math.abs(start - this.lastEnd) <= SNAP_S * this.sampleRate) {
      start = this.lastEnd;
    }
    this.lastEnd = start + block.length;
    // Cropped to the video: audio before 0 or after the end is not the song.
    const from = Math.max(0, start);
    const to = Math.min(this.total, start + block.length);
    if (to <= from) return;
    this.samples.set(block.subarray(from - start, to - start), from);
    this.cover(from, to);
  }

  /** Forgets where the last block ended, so the next one is placed by time. */
  breakRun(): void {
    this.lastEnd = -1;
  }

  /** Share of the video's length that has audio, 0 to 1. */
  get coverage(): number {
    let covered = 0;
    for (const [from, to] of this.spans) covered += to - from;
    return covered / this.total;
  }

  /** The longest stretch with no audio, in seconds, edges of the video included. */
  get largestGapS(): number {
    let largest = 0;
    let at = 0;
    for (const [from, to] of this.spans) {
      largest = Math.max(largest, from - at);
      at = to;
    }
    largest = Math.max(largest, this.total - at);
    return largest / this.sampleRate;
  }

  private cover(from: number, to: number): void {
    const merged: Array<[number, number]> = [];
    let start = from;
    let end = to;
    let placed = false;
    for (const span of this.spans) {
      if (span[1] < start) merged.push(span);
      else if (span[0] > end) {
        if (!placed) {
          merged.push([start, end]);
          placed = true;
        }
        merged.push(span);
      } else {
        start = Math.min(start, span[0]);
        end = Math.max(end, span[1]);
      }
    }
    if (!placed) merged.push([start, end]);
    this.spans = merged;
  }
}
