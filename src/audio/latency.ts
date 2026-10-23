/**
 * Round-trip latency calibration. The singer hears the song through the
 * output chain and sings into the mic chain; each adds delay the page cannot
 * see, so a mic frame stamped at context time t was really sung a little
 * earlier than t (see "Clock" in docs/ARCHITECTURE.md). This module measures
 * that delay: it plays a short chirp through the engine's master gain, records
 * the mic with the PCM capture worklet, finds the chirp in the recording by
 * normalised cross-correlation (FFT based, from analysis/fft.ts) and reports
 * how long the trip took. Three trials, median wins. The result is stored per
 * (output, input) device pair through the injectable key-value store, so a
 * different headset gets its own number.
 *
 * The maths (chirp, correlation, confidence, keys) is pure and unit-tested
 * against synthetic signals. measureLatency is the thin Web Audio glue around
 * it and takes everything by injection. Nothing here touches the DOM, and
 * importing the file never throws when Web Audio is missing.
 */
import { fft, ifft, nextPow2 } from '../analysis/fft';
import type { KeyValueStore } from '../app/storage';
import type { PcmCapture, PcmTake } from './capture';
import type { AudioEngine } from './engine';
import type { MicCapture } from './mic';

/** One calibration: the answer, the evidence and how far to trust it. */
export interface LatencyResult {
  /** Median round-trip delay from "chirp scheduled" to "mic heard it". */
  delayS: number;
  /** Every trial's delay, in the order they ran. */
  trialsS: number[];
  /** 0..1, the weakest trial's confidence; see confidenceFromRatio. */
  confidence: number;
}

/** Extra knobs beyond the contract, all optional. */
export interface MeasureOptions {
  /** How many chirps to play; the median of them is reported. Default 3. */
  trials?: number;
  /** Longest round trip the search will accept, in seconds. Default 0.5. */
  maxDelayS?: number;
  /** Quiet time after each trial so its tail cannot leak into the next. */
  gapS?: number;
  /** Called after each good trial so the UI can show "2 of 3". */
  onProgress?: (done: number, total: number) => void;
  /** Wall-clock pause in ms; injectable so tests can drive a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** Sweep limits: well inside what laptop speakers and headphones reproduce. */
const CHIRP_START_HZ = 500;
const CHIRP_END_HZ = 4000;
/** Quiet enough to be safe in headphones, loud enough to beat a room. */
const CHIRP_PEAK = 0.5;
const CHIRP_FADE_S = 0.005;
const DEFAULT_CHIRP_S = 0.1;

/** A second peak this close to the best is the same lobe, not a rival. */
const EXCLUDE_SAMPLES = 20;
/** Peak-to-rival ratio at which confidence saturates at 1. */
const RATIO_CAP = 10;
/** How many standard deviations of chance correlation a peak must clear. */
const NOISE_SIGMAS = 4;
/** Keeps near-silent windows from inflating the normalised score. */
const ENERGY_FLOOR = 1e-8;

/** Below this confidence the chirp is taken to have gone unheard. */
export const MIN_CONFIDENCE = 0.3;
/** Shown to the user when no trial heard the chirp. */
export const NO_ECHO_MESSAGE =
  'No echo detected: check that the speakers/headphones are audible to the ' +
  'mic, or enter latency manually. The chirp has to travel through the air ' +
  'to the mic, so with headphones hold an earcup against the mic and turn ' +
  'the volume up.';

const DEFAULT_TRIALS = 3;
const DEFAULT_MAX_DELAY_S = 0.5;
const DEFAULT_GAP_S = 0.2;
/** Head start so capture is certainly running before the chirp begins. */
const LEAD_S = 0.2;
/** How often the wait loop looks at the audio clock. */
const POLL_MS = 50;
/** Polls without the clock moving before we decide it is suspended. */
const STALL_POLLS = 40;
/** Larger than any real device pair; anything above is garbage in storage. */
const MAX_STORED_DELAY_S = 2;

/**
 * Linear chirp sweeping 500 to 4000 Hz with raised-cosine fades at both ends,
 * scaled so its largest sample is exactly 0.5. Needs a rate above 8 kHz so
 * the sweep stays under Nyquist.
 */
export function makeChirp(sampleRate: number, durationS: number = DEFAULT_CHIRP_S): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 2 * CHIRP_END_HZ) {
    throw new RangeError(`makeChirp: sample rate ${sampleRate} cannot carry a 4 kHz sweep`);
  }
  if (!Number.isFinite(durationS) || durationS <= 0) {
    throw new RangeError(`makeChirp: duration ${durationS} must be positive`);
  }
  const n = Math.max(2, Math.round(sampleRate * durationS));
  const sweepS = n / sampleRate;
  const slope = (CHIRP_END_HZ - CHIRP_START_HZ) / sweepS;
  const fade = Math.min(Math.round(CHIRP_FADE_S * sampleRate), Math.floor(n / 2));
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (CHIRP_START_HZ * t + 0.5 * slope * t * t);
    const edge = Math.min(i, n - 1 - i);
    const gain = edge < fade ? 0.5 * (1 - Math.cos((Math.PI * edge) / fade)) : 1;
    const v = Math.sin(phase) * gain;
    out[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // Measured rather than assumed: the sine rarely lands exactly on its crest.
  const scale = CHIRP_PEAK / peak;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

/**
 * Maps a peak-to-rival ratio to 0..1 on a log scale: 1 or less is chance (0),
 * 2 is the "heard it" line (about 0.3) and 10 or more is certain (1).
 */
export function confidenceFromRatio(ratio: number): number {
  if (!(ratio > 1)) return 0;
  return Math.min(1, Math.log10(Math.min(ratio, RATIO_CAP)));
}

/**
 * Finds where `reference` sits in `recorded`: the lag in samples (0 to
 * `maxLagSamples`, fractional via a parabola through the peak) that maximises
 * the normalised cross-correlation, plus a 0..1 confidence from how far that
 * peak stands above the best rival outside its own lobe. Polarity is ignored
 * so an inverting audio path still works. Only lags where the whole reference
 * fits inside the recording are searched.
 */
export function estimateDelay(
  reference: Float32Array,
  recorded: Float32Array,
  maxLagSamples: number,
): { lag: number; confidence: number } {
  const none = { lag: 0, confidence: 0 };
  const nRef = reference.length;
  const nRec = recorded.length;
  if (nRef === 0 || nRec < nRef || !(maxLagSamples >= 0)) return none;
  const lastLag = Math.min(Math.floor(maxLagSamples), nRec - nRef);

  let refEnergy = 0;
  for (let i = 0; i < nRef; i++) refEnergy += reference[i] * reference[i];
  if (refEnergy === 0) return none;

  // Running sum of squares gives the energy under each lag's window in O(1).
  const prefix = new Float64Array(nRec + 1);
  for (let i = 0; i < nRec; i++) prefix[i + 1] = prefix[i] + recorded[i] * recorded[i];

  const raw = crossCorrelate(reference, recorded);
  const scores = new Float64Array(lastLag + 1);
  let best = 0;
  for (let lag = 0; lag <= lastLag; lag++) {
    const windowEnergy = Math.max(0, prefix[lag + nRef] - prefix[lag]);
    const denom = Math.sqrt(refEnergy * (windowEnergy + ENERGY_FLOOR * refEnergy));
    scores[lag] = Math.min(1, Math.abs(raw[lag]) / denom);
    if (scores[lag] > scores[best]) best = lag;
  }

  let rival = 0;
  for (let lag = 0; lag <= lastLag; lag++) {
    if (Math.abs(lag - best) > EXCLUDE_SAMPLES && scores[lag] > rival) rival = scores[lag];
  }
  // With few or no rival lags to compare against, hold the peak to what
  // chance alone would reach: white noise scores about 1/sqrt(length) per lag.
  rival = Math.max(rival, NOISE_SIGMAS / Math.sqrt(nRef));
  const confidence = confidenceFromRatio(scores[best] / rival);

  let lag = best;
  if (best > 0 && best < lastLag) {
    const left = scores[best - 1];
    const right = scores[best + 1];
    const bend = left - 2 * scores[best] + right;
    if (bend < 0) lag += (0.5 * (left - right)) / bend;
  }
  return { lag, confidence };
}

/** Median; mean of the middle pair for even counts; NaN for no values. */
export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Plays the chirp `trials` times, records the mic and reports the median
 * round trip. Needs an open mic and a running (or resumable) context. Throws
 * a plain Error with a user-ready message when no trial hears the chirp.
 */
export async function measureLatency(
  engine: AudioEngine,
  mic: MicCapture,
  capture: PcmCapture,
  opts: MeasureOptions = {},
): Promise<LatencyResult> {
  const source = mic.source;
  if (!source) throw new Error('Open the microphone before measuring latency.');
  const trials = Math.max(1, Math.floor(opts.trials ?? DEFAULT_TRIALS) || DEFAULT_TRIALS);
  const maxDelayS = positive(opts.maxDelayS, DEFAULT_MAX_DELAY_S);
  const gapS = opts.gapS !== undefined && opts.gapS >= 0 ? opts.gapS : DEFAULT_GAP_S;
  const sleep = opts.sleep ?? defaultSleep;

  await engine.resume();
  await capture.load();
  const rate = engine.context.sampleRate;
  const chirp = makeChirp(rate);
  const buffer = engine.context.createBuffer(1, chirp.length, rate);
  buffer.getChannelData(0).set(chirp);

  const delays: number[] = [];
  let confidence = 1;
  for (let i = 0; i < trials; i++) {
    const settings = { maxDelayS, gapS, sleep };
    const trial = await runTrial(engine, capture, source, buffer, chirp, settings);
    // Fail on the first deaf trial: min() would reject the run anyway, and
    // the singer should not sit through two more chirps to learn that.
    if (trial.confidence < MIN_CONFIDENCE) throw new Error(NO_ECHO_MESSAGE);
    if (trial.delayS < 0) {
      throw new Error(
        'Measured a negative latency, so the mic and output clocks disagree. ' +
          'Enter latency manually.',
      );
    }
    delays.push(trial.delayS);
    confidence = Math.min(confidence, trial.confidence);
    opts.onProgress?.(i + 1, trials);
  }
  return { delayS: median(delays), trialsS: delays, confidence };
}

/** Storage key for a device pair; null and the browser's "default" agree. */
export function latencyKey(outputId: string | null, inputId: string | null): string {
  // encodeURIComponent escapes '|', so the separator cannot be forged by an id.
  const part = (id: string | null): string => (id ? encodeURIComponent(id) : 'default');
  return `latency.${part(outputId)}|${part(inputId)}`;
}

/** Stored delay in seconds, or null when absent or not a plausible number. */
export function loadLatency(store: KeyValueStore, key: string): number | null {
  const raw = store.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= MAX_STORED_DELAY_S ? value : null;
}

/** Stores a delay in seconds; values that load would reject are not written. */
export function saveLatency(store: KeyValueStore, key: string, delayS: number): void {
  if (!Number.isFinite(delayS) || delayS < 0 || delayS > MAX_STORED_DELAY_S) return;
  store.set(key, String(delayS));
}

/** Per-trial settings after defaults have been applied. */
interface TrialSettings {
  maxDelayS: number;
  gapS: number;
  sleep: (ms: number) => Promise<void>;
}

/** One chirp out, one recording back, one delay and its confidence. */
async function runTrial(
  engine: AudioEngine,
  capture: PcmCapture,
  source: AudioNode,
  buffer: AudioBuffer,
  chirp: Float32Array,
  settings: TrialSettings,
): Promise<{ delayS: number; confidence: number }> {
  const node = engine.context.createBufferSource();
  node.buffer = buffer;
  node.connect(engine.master);
  capture.start(source);
  // t0 is on the context clock, the same one that stamps the recording, so
  // the difference between them is the round trip with no wall-clock drift.
  const t0 = engine.now() + LEAD_S;
  let take: PcmTake;
  try {
    node.start(t0);
    const chirpS = chirp.length / engine.context.sampleRate;
    await waitUntil(engine, t0 + settings.maxDelayS + chirpS + settings.gapS, settings.sleep);
    take = await capture.stop();
  } catch (error) {
    await capture.stop().catch(() => undefined);
    throw error;
  } finally {
    try {
      node.disconnect();
    } catch {
      // Already disconnected; nothing left to silence.
    }
  }
  const rate = take.sampleRate;
  // Sample 0 of the take is at startedAtContextS, so a lag of L samples means
  // the chirp reached the mic at startedAtContextS + L / rate.
  const maxLag = Math.ceil((t0 - take.startedAtContextS + settings.maxDelayS) * rate);
  const { lag, confidence } = estimateDelay(chirp, take.pcm, maxLag);
  return { delayS: take.startedAtContextS + lag / rate - t0, confidence };
}

/** Sleeps until the context clock reaches `target`, or fails if it is stuck. */
async function waitUntil(
  engine: AudioEngine,
  target: number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let last = engine.now();
  let stalled = 0;
  while (last < target) {
    await sleep(Math.min(POLL_MS, Math.max(10, (target - last) * 1000)));
    const now = engine.now();
    stalled = now > last ? 0 : stalled + 1;
    if (stalled >= STALL_POLLS) {
      throw new Error('The audio clock is not running. Click the page and try again.');
    }
    last = now;
  }
}

/**
 * Raw cross-correlation raw[lag] = sum reference[n] * recorded[n + lag] for
 * lags 0 to recorded.length - reference.length, as a Float32Array that is
 * longer than that (the tail is wrap-around and must be ignored). The
 * transform is zero padded so the circular result is the linear one.
 */
function crossCorrelate(reference: Float32Array, recorded: Float32Array): Float32Array {
  const size = nextPow2(reference.length + recorded.length);
  const recRe = new Float32Array(size);
  const recIm = new Float32Array(size);
  const refRe = new Float32Array(size);
  const refIm = new Float32Array(size);
  recRe.set(recorded);
  refRe.set(reference);
  fft(recRe, recIm);
  fft(refRe, refIm);
  // rec * conj(ref): conjugating the reference turns convolution into
  // correlation, so index `lag` holds the sum with the reference slid by lag.
  for (let k = 0; k < size; k++) {
    const a = recRe[k];
    const b = recIm[k];
    const c = refRe[k];
    const d = refIm[k];
    recRe[k] = a * c + b * d;
    recIm[k] = b * c - a * d;
  }
  ifft(recRe, recIm);
  return recRe;
}

/** `value` if it is a positive finite number, else the fallback. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Real timer pause. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
