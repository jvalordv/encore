/**
 * Pure pitch-estimation maths for the live tracker: McLeod's normalised square
 * difference function (NSDF), key-maximum peak picking, parabolic refinement,
 * and the Hz / MIDI / cents conversions the rest of the app speaks. Nothing
 * here touches the DOM or Web Audio, so the AudioWorklet in pitch-worklet.ts
 * is a thin shell around estimatePitch and every number can be checked
 * against synthetic signals in test/pitch.test.ts. The service re-runs a
 * stronger tracker after each take; this one only has to be fast and good
 * enough (about 5 cents) for the lane and for live streaks.
 */
import { autocorrelation } from './fft';

/** One analysis result; `t` is the context time at the window centre. */
export interface PitchFrame {
  /** Context time, in seconds, at the centre of the analysed window. */
  t: number;
  /** Fundamental in Hz; 0 when unvoiced. */
  f0: number;
  /** NSDF peak height, 0 to 1; how periodic the window is. */
  clarity: number;
  /** Root mean square level of the window, 0 to 1 for full-scale audio. */
  rms: number;
}

/** Samples per analysis window: 42.7 ms at 48 kHz, 3+ periods at 82 Hz. */
export const PITCH_WINDOW = 2048;
/** Samples between windows: 10 ms at 48 kHz, the project-wide f0 hop. */
export const PITCH_HOP = 480;
/** Lowest f0 searched for, Hz; just under a bass singer's floor. */
export const MIN_F0 = 60;
/** Highest f0 searched for, Hz; covers soprano whistle-adjacent notes. */
export const MAX_F0 = 1200;
/** Clarity needed to call a frame voiced, per docs/ARCHITECTURE.md. */
export const DEFAULT_CLARITY = 0.9;

/** Default fraction of the best peak a shorter-lag peak must reach. */
const DEFAULT_K = 0.9;

/** Below this RMS a window counts as digital silence (about -120 dBFS). */
const SILENCE_RMS = 1e-6;

/**
 * McLeod NSDF, n'(t) = 2 r'(t) / m'(t), for lags 0..N/2 inclusive (length
 * N/2 + 1). r' is the autocorrelation and m' the summed energy of the two
 * overlapping segments, so a perfectly periodic signal peaks at exactly 1
 * whatever its level. m' is advanced with a running sum instead of being
 * recomputed, which keeps the whole thing O(N log N). Silence gives zeros.
 */
export function nsdf(frame: Float32Array): Float32Array {
  const n = frame.length;
  const lags = (n >> 1) + 1;
  const out = new Float32Array(lags);
  if (n === 0) return out;
  const r = autocorrelation(frame);
  let m = 0;
  for (let j = 0; j < n; j++) m += frame[j] * frame[j];
  m *= 2;
  // Subtracting leaves rounding dust once the overlap holds almost no energy;
  // dividing by it would turn that dust into a spurious perfect peak.
  const floor = m * 1e-9;
  for (let tau = 0; tau < lags; tau++) {
    if (tau > 0) {
      // Drop the sample that leaves the head segment and the one that leaves
      // the tail segment as the overlap shrinks by one.
      const head = frame[n - tau];
      const tail = frame[tau - 1];
      m -= head * head + tail * tail;
    }
    out[tau] = m > floor ? (2 * r[tau]) / m : 0;
  }
  return out;
}

/** Vertex of the parabola through arr[i-1], arr[i], arr[i+1]; x is a lag. */
export function parabolicInterpolate(arr: Float32Array, i: number): { x: number; y: number } {
  if (i <= 0 || i >= arr.length - 1) return { x: i, y: arr[i] };
  const a = arr[i - 1];
  const b = arr[i];
  const c = arr[i + 1];
  const denom = a - 2 * b + c;
  if (denom === 0) return { x: i, y: b };
  const shift = (0.5 * (a - c)) / denom;
  return { x: i + shift, y: b - 0.25 * (a - c) * shift };
}

/**
 * McLeod peak picking. Each positive lobe of the NSDF (positive-going zero
 * crossing to the next negative-going one) contributes its highest point as a
 * candidate. The first candidate within `k` of the tallest is chosen, so a
 * harmonic-rich voice is not read an octave low just because its second period
 * peak is a hair taller. `lag` is fractional (parabolic refinement) and
 * `clarity` the refined height, capped at 1. Null when no lobe qualifies.
 */
export function pickPeak(
  n: Float32Array,
  minLag: number,
  maxLag: number,
  k: number = DEFAULT_K,
): { lag: number; clarity: number } | null {
  const last = Math.min(Math.floor(maxLag), n.length - 1);
  const first = Math.max(Math.ceil(minLag), 1);
  if (last <= first) return null;

  // Skip the lobe around lag 0, which is always positive and always 1.
  let i = 1;
  while (i <= last && n[i] > 0) i++;

  const lags: number[] = [];
  let best = -Infinity;
  while (i <= last) {
    // Past the negative stretch, up to the next positive-going crossing.
    while (i <= last && n[i] <= 0) i++;
    if (i > last) break;
    let peak = i;
    while (i <= last && n[i] > 0) {
      if (n[i] > n[peak]) peak = i;
      i++;
    }
    // A lobe cut off by the search limit only counts if it visibly turned
    // over; otherwise its "peak" is just wherever the search stopped.
    const closed = i <= last || (peak < last && n[peak + 1] < n[peak]);
    if (closed && peak >= first) {
      lags.push(peak);
      if (n[peak] > best) best = n[peak];
    }
  }
  if (lags.length === 0) return null;

  const threshold = k * best;
  for (const lag of lags) {
    if (n[lag] >= threshold) {
      const refined = parabolicInterpolate(n, lag);
      return { lag: refined.x, clarity: Math.min(refined.y, 1) };
    }
  }
  return null;
}

/** Root mean square of a block of samples; 0 for an empty block. */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** Reused for DC removal so the audio thread allocates no window per hop. */
let centred = new Float32Array(0);

/**
 * Estimates f0 of one window. The mean is removed first, because a mic's DC
 * offset would otherwise keep the NSDF positive at every lag and read as
 * strong periodicity. `f0` is 0 when no peak qualifies or clarity is below 0;
 * deciding whether a nonzero f0 counts as voiced is the caller's, using
 * `clarity`. `rms` is of the mean-removed window.
 */
export function estimatePitch(
  frame: Float32Array,
  sampleRate: number,
  opts: { minF0?: number; maxF0?: number; k?: number } = {},
): { f0: number; clarity: number; rms: number } {
  const minF0 = opts.minF0 ?? MIN_F0;
  const maxF0 = opts.maxF0 ?? MAX_F0;
  const n = frame.length;
  if (centred.length !== n) centred = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += frame[i];
  mean = n > 0 ? mean / n : 0;
  for (let i = 0; i < n; i++) centred[i] = frame[i] - mean;

  const level = rms(centred);
  if (level < SILENCE_RMS) return { f0: 0, clarity: 0, rms: level };

  const curve = nsdf(centred);
  const peak = pickPeak(curve, sampleRate / maxF0, sampleRate / minF0, opts.k ?? DEFAULT_K);
  if (!peak || peak.clarity < 0 || peak.lag <= 0) return { f0: 0, clarity: 0, rms: level };
  return { f0: sampleRate / peak.lag, clarity: peak.clarity, rms: level };
}

/** MIDI note number (fractional) of a frequency; NaN unless hz is positive. */
export function hzToMidi(hz: number): number {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : NaN;
}

/** Frequency of a (possibly fractional) MIDI note number. */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Signed cents from hzA up to hzB (positive when B is higher). */
export function centsBetween(hzA: number, hzB: number): number {
  return hzA > 0 && hzB > 0 ? 1200 * Math.log2(hzB / hzA) : NaN;
}
