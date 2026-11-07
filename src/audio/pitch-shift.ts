/**
 * The pitch shifter's DSP core: a streaming, time-domain pitch shifter that
 * keeps the length of the sound. It is WSOLA-aligned granular resampling,
 * hand-written, with no FFT and no phase vocoder. The input is cut into
 * Hann-windowed grains of 1536 samples every 768; each grain is read from the
 * input at `ratio` samples per output sample (cubic interpolation), which
 * moves its pitch by the ratio, and the grains are overlap-added at the
 * unchanged hop, which keeps the song's timing. Before each grain, a search
 * of +/- 480 samples (10 ms at 48 kHz, a period of a 100 Hz voice) finds the
 * read position whose first half best continues the previous grain's second
 * half (normalised cross-correlation on the channel mix), so the overlap adds
 * in phase instead of beating. The grain's middle is held on the input's
 * middle, so no part of the sound drifts in time by more than a few ms.
 *
 * Latency is fixed whatever the shift, so the shift can change mid-song with
 * no jump: the longest read a grain makes at the largest shift (+6) plus the
 * search, 2338 samples, about 49 ms at 48 kHz. Quality is made for singing
 * along, not for mastering: a shifted voice keeps its words and gets a little
 * of the granular sheen at the extremes. The class takes plain arrays and has
 * no worklet dependency, so it is tested on synthetic sines (see
 * test/pitch-shift.test.ts); shift-worklet.ts is the audio-thread shell.
 */

/** Grain length and hop, in samples; the hop is half a grain (Hann sums to 1). */
export const SHIFT_GRAIN = 1536;
export const SHIFT_HOP = 768;
/** How far a grain's read position may move to line up with the last one. */
export const SHIFT_SEARCH = 480;
/** The largest shift in semitones either way; fixes the latency. */
export const SHIFT_MAX_SEMITONES = 6;

/** Fixed delay, in samples, of every sample through the shifter. */
export const SHIFT_LATENCY_SAMPLES =
  Math.ceil(SHIFT_GRAIN / 2 + (SHIFT_GRAIN * 2 ** (SHIFT_MAX_SEMITONES / 12)) / 2) + SHIFT_SEARCH + 4;

const RING = 8192;
const MASK = RING - 1;
/** Input is taken in pieces this long so the rings never fall behind. */
const CHUNK = 128;
/** The search looks at every this-many-th point of the overlap. */
const SEARCH_STRIDE = 4;

/** Delay of the shifter in seconds at a sample rate. */
export function shiftLatencyS(sampleRate: number): number {
  return SHIFT_LATENCY_SAMPLES / sampleRate;
}

/** Streams audio through the pitch shift; one instance per stereo (or mono) pair. */
export class PitchShifter {
  private readonly input: Float32Array[];
  private readonly output: Float32Array[];
  private readonly acc: Float32Array[];
  private readonly mono = new Float32Array(RING);
  private readonly window = new Float32Array(SHIFT_GRAIN);
  private readonly tail = new Float32Array(SHIFT_HOP);
  private hasTail = false;
  private inCount = 0;
  private outCount = 0;
  private grains = 0;
  private ratio = 1;

  constructor(private readonly channels = 2) {
    this.input = Array.from({ length: channels }, () => new Float32Array(RING));
    this.output = Array.from({ length: channels }, () => new Float32Array(RING));
    this.acc = Array.from({ length: channels }, () => new Float32Array(RING));
    for (let j = 0; j < SHIFT_GRAIN; j++) this.window[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / SHIFT_GRAIN);
  }

  /** Sets the shift, in semitones (clamped to +/- 6); takes effect at the next grain. */
  setSemitones(semitones: number): void {
    const s = Number.isFinite(semitones)
      ? Math.max(-SHIFT_MAX_SEMITONES, Math.min(SHIFT_MAX_SEMITONES, semitones))
      : 0;
    this.ratio = 2 ** (s / 12);
  }

  /**
   * Shifts one block. `input` and `output` hold one array per channel and
   * every array is the same length; a missing input channel repeats the first
   * (and none at all is silence). The output is the input delayed by
   * SHIFT_LATENCY_SAMPLES and shifted, the same length as the block.
   */
  process(input: ReadonlyArray<Float32Array | undefined>, output: Float32Array[]): void {
    const total = output[0]?.length ?? 0;
    for (let off = 0; off < total; off += CHUNK) {
      const len = Math.min(CHUNK, total - off);
      for (let i = 0; i < len; i++) {
        const at = (this.inCount + i) & MASK;
        let sum = 0;
        for (let c = 0; c < this.channels; c++) {
          const v = (input[c] ?? input[0])?.[off + i] ?? 0;
          this.input[c][at] = v;
          sum += v;
        }
        this.mono[at] = sum / this.channels;
      }
      this.inCount += len;
      while (this.inCount >= this.grains * SHIFT_HOP + SHIFT_LATENCY_SAMPLES) this.makeGrain(this.grains++);
      for (let i = 0; i < len; i++) {
        const m = this.outCount++ - SHIFT_LATENCY_SAMPLES;
        for (let c = 0; c < output.length; c++) {
          output[c][off + i] = m < 0 ? 0 : this.output[Math.min(c, this.channels - 1)][m & MASK];
        }
      }
    }
  }

  /** The channel mix at a fractional position, linearly interpolated; silence before 0. */
  private monoAt(pos: number): number {
    const i = Math.floor(pos);
    if (i < 0) return 0;
    const f = pos - i;
    return this.mono[i & MASK] * (1 - f) + this.mono[(i + 1) & MASK] * f;
  }

  /** Read offset (relative to the nominal one) that best continues the last grain. */
  private bestOffset(base: number, ratio: number): number {
    let energy = 0;
    for (let j = 0; j < SHIFT_HOP; j += SEARCH_STRIDE) energy += this.tail[j] * this.tail[j];
    if (!this.hasTail || energy < 1e-12) return 0;
    const score = (d: number): number => {
      let dot = 0;
      let norm = 1e-9;
      for (let j = 0; j < SHIFT_HOP; j += SEARCH_STRIDE) {
        const c = this.monoAt(base + d + j * ratio);
        dot += this.tail[j] * c;
        norm += c * c;
      }
      return dot / Math.sqrt(norm);
    };
    let best = 0;
    let bestScore = -Infinity;
    for (let d = -SHIFT_SEARCH; d <= SHIFT_SEARCH; d += SEARCH_STRIDE) {
      const s = score(d);
      if (s > bestScore) [best, bestScore] = [d, s];
    }
    const centre = best;
    for (let d = Math.max(-SHIFT_SEARCH, centre - SEARCH_STRIDE + 1); d < centre + SEARCH_STRIDE; d++) {
      if (d === centre || d > SHIFT_SEARCH) continue;
      const s = score(d);
      if (s > bestScore) [best, bestScore] = [d, s];
    }
    return best;
  }

  /** A channel's sample at a fractional position, Catmull-Rom interpolated. */
  private cubic(channel: number, pos: number): number {
    const i = Math.floor(pos);
    const t = pos - i;
    const buf = this.input[channel];
    const p0 = i - 1 < 0 ? 0 : buf[(i - 1) & MASK];
    const p1 = i < 0 ? 0 : buf[i & MASK];
    const p2 = i + 1 < 0 ? 0 : buf[(i + 1) & MASK];
    const p3 = buf[(i + 2) & MASK];
    return (
      0.5 *
      (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
    );
  }

  /** Builds grain `k` into the accumulator and finalises the hop it completes. */
  private makeGrain(k: number): void {
    const ratio = this.ratio;
    const base = k * SHIFT_HOP + (SHIFT_GRAIN / 2) * (1 - ratio);
    const start = base + this.bestOffset(base, ratio);
    for (let j = 0; j < SHIFT_GRAIN; j++) {
      const pos = start + j * ratio;
      const at = (k * SHIFT_HOP + j) & MASK;
      const w = this.window[j];
      for (let c = 0; c < this.channels; c++) this.acc[c][at] += this.cubic(c, pos) * w;
    }
    for (let j = 0; j < SHIFT_HOP; j++) this.tail[j] = this.monoAt(start + (SHIFT_HOP + j) * ratio);
    this.hasTail = true;
    // The hop at the grain's start has now had both of its grains added.
    for (let j = 0; j < SHIFT_HOP; j++) {
      const at = (k * SHIFT_HOP + j) & MASK;
      for (let c = 0; c < this.channels; c++) {
        this.output[c][at] = this.acc[c][at];
        this.acc[c][at] = 0;
      }
    }
  }
}
