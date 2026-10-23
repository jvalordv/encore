/**
 * Round-trip latency calibration. The singer hears the song through the
 * output chain and sings into the mic chain; each adds delay the page cannot
 * see, so a mic frame stamped at context time t was really sung a little
 * earlier than t (see "Clock" in docs/ARCHITECTURE.md). This module measures
 * that delay: it plays a 0.4 s chirp through the engine's master gain,
 * records the mic with the PCM capture worklet and finds the chirp in the
 * recording with GCC-PHAT (generalised cross-correlation with phase
 * transform, FFT based, from analysis/fft.ts).
 *
 * Why PHAT: speakers and a desk mic hear the direct sound and then a train of
 * reflections 1 to 15 ms later. A plain matched filter smears into a wide
 * lump and its second-best peak is nearly as tall as the best, so a confidence
 * built on "best over runner-up" rejects a correct lag. PHAT flattens the
 * spectrum so each arrival becomes a narrow spike, and the first spike tall
 * enough to matter is the direct path, which is the delay the singer lives
 * with. Confidence is the spike's height over the background it stands on.
 *
 * measureLatency also records what the mic heard before the chirp (its noise
 * floor) and how loud the chirp was, so "the mic never heard it" (turn the
 * speakers up) is told apart from "it heard it but the echo wobbles" (the
 * room or the device is unstable). Three trials must agree to a few
 * milliseconds. The result is stored per (output, input) device pair by the
 * session, so a different headset gets its own number.
 *
 * The maths (chirp, correlation, levels, agreement) is pure and unit-tested
 * against synthetic rooms. measureLatency is the thin Web Audio glue around
 * it and takes everything by injection. Nothing here touches the DOM, and
 * importing the file never throws when Web Audio is missing.
 */
import { fft, ifft, nextPow2 } from '../analysis/fft';
import type { KeyValueStore } from '../app/storage';
import type { PcmCapture, PcmTake } from './capture';
import type { AudioEngine } from './engine';
import type { MicCapture } from './mic';

/** One chirp's measurement, kept so the status line can show the evidence. */
export interface TrialResult {
  /** Seconds from "chirp scheduled" to "mic heard it" for this trial. */
  delayS: number;
  /** 0..1 from peakToBackground; see confidenceFromRatio. */
  confidence: number;
  /** Height of the chosen correlation peak over the background around it. */
  peakToBackground: number;
  /** RMS dB (re full scale) of the loudest chirp-length window after t0. */
  chirpLevelDb: number;
  /** RMS dB (re full scale) of the mic in the pre-roll before the chirp. */
  noiseFloorDb: number;
}

/** One calibration: the answer, the evidence and how far to trust it. */
export interface LatencyResult {
  /** Median round-trip delay of the trials that were used. */
  delayS: number;
  /** 0..1, the weakest used trial's confidence. */
  confidence: number;
  /** Largest minus smallest delay among the used trials, in seconds. */
  spreadS: number;
  /** The trials that counted, in the order they ran. */
  trials: TrialResult[];
  /** Their delays, kept for callers written before `trials` existed. */
  trialsS: number[];
}

/** Why a calibration was refused. The message carries the numbers. */
export type CalibrationCode = 'not-heard' | 'unstable' | 'low-confidence' | 'no-mic';

/** A calibration that ran but cannot be trusted, with the trials as proof. */
export class CalibrationError extends Error {
  readonly code: CalibrationCode;
  readonly trials: TrialResult[];

  constructor(code: CalibrationCode, message: string, trials: TrialResult[] = []) {
    super(message);
    this.name = 'CalibrationError';
    this.code = code;
    this.trials = trials;
  }
}

/** Extra knobs beyond the contract, all optional. */
export interface MeasureOptions {
  /** How many chirps to play; the median of the good ones is reported. 3. */
  trials?: number;
  /** Longest round trip the search will accept, in seconds. Default 0.6. */
  maxDelayS?: number;
  /** Listening time before each chirp, which sets the noise floor. 0.4. */
  preRollS?: number;
  /** Quiet time after each trial so its tail cannot leak into the next. 0.3. */
  gapS?: number;
  /** Largest max-minus-min delay the used trials may show. Default 0.005. */
  agreeS?: number;
  /** Called after each trial so the UI can show "2 of 3". */
  onProgress?: (done: number, total: number) => void;
  /** Wall-clock pause in ms; injectable so tests can drive a fake clock. */
  sleep?: (ms: number) => Promise<void>;
}

/** What estimateDelay found. */
export interface DelayEstimate {
  /** Samples from the start of `recorded` to the chirp; fractional. */
  lag: number;
  /** 0..1, how far to trust the lag; see confidenceFromRatio. */
  confidence: number;
  /** Chosen peak over the RMS of the correlation away from it. */
  peakToBackground: number;
  method: 'gcc-phat';
}

/** Tuning for estimateDelay; every field has a default. */
export interface DelayOptions {
  /** An arrival counts at this share of the strongest one's. Default 0.6. */
  firstArrivalRatio?: number;
  /** Half-width in ms of the zone around the chosen peak that the
   *  background leaves out. Default 2. */
  excludeMs?: number;
  /** Sample rate of both signals, to turn excludeMs into samples. 48000. */
  sampleRate?: number;
}

/**
 * Sweep limits. 300 Hz is where laptop speakers and desk mics start to carry
 * level, 6 kHz is where cheap ones stop; PHAT can only use what the path
 * passes, and the wider the sweep, the sharper the spike.
 */
const CHIRP_START_HZ = 300;
const CHIRP_END_HZ = 6000;
/** Loud enough to beat a room and a webcam mic without clipping a DAC. */
const CHIRP_PEAK = 0.8;
const CHIRP_FADE_S = 0.01;
/** Long enough to put real energy into every frequency a small speaker has. */
const DEFAULT_CHIRP_S = 0.4;

/** An arrival is any peak this share of the loudest (direct beats louder). */
const DEFAULT_FIRST_ARRIVAL_RATIO = 0.6;
/**
 * Spikes under this share of the tallest PHAT spike are ripple, not arrivals,
 * and are never weighed. Whitening shrinks a weak early arrival to roughly
 * 0.3 to 0.4 of the tallest, so the floor sits below that.
 */
const CANDIDATE_FLOOR = 0.2;
/** Samples either side of a spike where its raw strength is read. */
const STRENGTH_REACH = 2;
/** Around the chosen peak the correlation is the peak, not background. */
const DEFAULT_EXCLUDE_MS = 2;
const DEFAULT_RATE = 48000;
/**
 * Whitening divides the cross-spectrum by its magnitude plus this share of
 * the mean magnitude. Without it, bins the chirp never reached (below 300 Hz
 * or above 6 kHz, plus mains hum) would be boosted to full weight and bury
 * the peak in noise; with it they stay small.
 */
const PHAT_FLOOR = 0.05;
/** Fewest background lags worth dividing by; fewer means no judgement. */
const MIN_BACKGROUND_LAGS = 32;
/** Peak-to-background where confidence leaves 0, and where it reaches 1. */
const RATIO_FLOOR = 3;
const RATIO_SPAN = 12;
/** Caps the ratio when the background is numerically empty. */
const MAX_RATIO = 1e6;

/** Below this confidence a trial is dropped. */
export const MIN_CONFIDENCE = 0.3;
/** The chirp must reach this far over the noise floor to count as heard. */
export const MIN_HEARD_DB = 6;
/** Level reported for digital silence, so dB maths never sees -Infinity. */
const SILENCE_DB = -120;
/** Trials that must survive for an answer to be trusted. */
const MIN_AGREEING_TRIALS = 2;

const DEFAULT_TRIALS = 3;
const DEFAULT_MAX_DELAY_S = 0.6;
const DEFAULT_PRE_ROLL_S = 0.4;
const DEFAULT_GAP_S = 0.3;
const DEFAULT_AGREE_S = 0.005;
/** How often the wait loop looks at the audio clock. */
const POLL_MS = 50;
/** Polls without the clock moving before we decide it is suspended. */
const STALL_POLLS = 40;
/** Larger than any real device pair; anything above is garbage in storage. */
const MAX_STORED_DELAY_S = 2;

/**
 * Linear chirp sweeping 300 to 6000 Hz with 10 ms raised-cosine fades at both
 * ends, scaled so its largest sample is exactly 0.8. Needs a rate above 12 kHz
 * so the sweep stays under Nyquist. Defaults to 0.4 s.
 */
export function makeChirp(sampleRate: number, durationS: number = DEFAULT_CHIRP_S): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate <= 2 * CHIRP_END_HZ) {
    throw new RangeError(`makeChirp: sample rate ${sampleRate} cannot carry a 6 kHz sweep`);
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
 * Maps a peak-to-background ratio to 0..1, linearly from 3 (0) to 15 (1).
 * Measured on 48 kHz synthetic recordings: noise alone never beat 3.9 over 40
 * seeds (typically 2.5 to 3.5); the room of a direct path, three reflections,
 * noise at -20 dB and 50 Hz hum at -30 dB gives 37; a lone path under white
 * noise 24 dB louder than it still lands on the right lag at 6 to 9. So the
 * 0.3 line that drops a trial sits at a ratio of 6.6: clear of chance, and
 * short of what a bad room can still deliver.
 */
export function confidenceFromRatio(ratio: number): number {
  if (!(ratio > RATIO_FLOOR)) return 0;
  return Math.min(1, (ratio - RATIO_FLOOR) / RATIO_SPAN);
}

/**
 * Finds where `reference` sits in `recorded`: the lag in samples (0 to
 * `maxLagSamples`, fractional via a parabola through the peak) of the first
 * arrival in the GCC-PHAT correlation. The cross-spectrum Y * conj(X) is
 * whitened to unit magnitude, so every path becomes a narrow spike. The
 * earliest spike whose raw (unwhitened) strength is at least
 * `firstArrivalRatio` of the strongest spike wins, because the direct path
 * comes before any reflection even when a reflection is louder. (The textbook
 * X * conj(Y) puts the answer at negative lags; the roles are swapped here so
 * a delay is a positive index.) Polarity is ignored so an inverting audio
 * path still works. Only lags where the whole reference fits inside the
 * recording are searched.
 */
export function estimateDelay(
  reference: Float32Array,
  recorded: Float32Array,
  maxLagSamples: number,
  opts: DelayOptions = {},
): DelayEstimate {
  const none: DelayEstimate = { lag: 0, confidence: 0, peakToBackground: 0, method: 'gcc-phat' };
  const nRef = reference.length;
  const nRec = recorded.length;
  if (nRef === 0 || nRec < nRef || !(maxLagSamples >= 0)) return none;
  const lastLag = Math.min(Math.floor(maxLagSamples), nRec - nRef);
  const wanted = opts.firstArrivalRatio;
  const ratio =
    wanted !== undefined && wanted > 0 && wanted <= 1 ? wanted : DEFAULT_FIRST_ARRIVAL_RATIO;
  const excludeMs =
    opts.excludeMs !== undefined && opts.excludeMs >= 0 && Number.isFinite(opts.excludeMs)
      ? opts.excludeMs
      : DEFAULT_EXCLUDE_MS;
  const rate = positive(opts.sampleRate, DEFAULT_RATE);
  const exclude = Math.round((excludeMs * rate) / 1000);

  const both = correlate(reference, recorded, lastLag);
  if (!both) return none;
  const { corr, strength } = both;
  const n = corr.length;

  let tallest = 0;
  for (let lag = 0; lag < n; lag++) tallest = Math.max(tallest, corr[lag]);
  if (!(tallest > 0)) return none;

  // Arrivals are the local maxima of the sharp PHAT correlation (the edges
  // only have one neighbour to beat). Their loudness is read from the raw
  // correlation at the same lag, because whitening squeezes a weak early
  // arrival towards half its true share and would let a loud reflection
  // outvote the direct path.
  const arrivals: Array<{ lag: number; loudness: number }> = [];
  let loudest = 0;
  for (let lag = 0; lag < n; lag++) {
    const v = corr[lag];
    if (v < CANDIDATE_FLOOR * tallest) continue;
    const left = lag > 0 ? corr[lag - 1] : -Infinity;
    const right = lag < n - 1 ? corr[lag + 1] : -Infinity;
    if (!(v >= left && v > right)) continue;
    let loudness = 0;
    const lastNear = Math.min(n - 1, lag + STRENGTH_REACH);
    for (let j = Math.max(0, lag - STRENGTH_REACH); j <= lastNear; j++) {
      loudness = Math.max(loudness, strength[j]);
    }
    arrivals.push({ lag, loudness });
    loudest = Math.max(loudest, loudness);
  }
  const bar = ratio * loudest;
  const first = arrivals.find((a) => a.loudness >= bar);
  if (!first) return none;
  const best = first.lag;

  let lag = best;
  if (best > 0 && best < n - 1) {
    const left = corr[best - 1];
    const right = corr[best + 1];
    const bend = left - 2 * corr[best] + right;
    if (bend < 0) lag += (0.5 * (left - right)) / bend;
  }

  // Background is every lag outside the peak's own zone. Reflections stay in
  // it on purpose: a room that is all echo should read as less certain.
  const lo = Math.max(0, best - exclude);
  const hi = Math.min(n - 1, best + exclude);
  let outside = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    if (i >= lo && i <= hi) continue;
    energy += corr[i] * corr[i];
    outside++;
  }
  if (outside < MIN_BACKGROUND_LAGS) return { ...none, lag };
  const background = Math.max(Math.sqrt(energy / outside), corr[best] / MAX_RATIO);
  const peakToBackground = corr[best] / background;
  const confidence = confidenceFromRatio(peakToBackground);
  return { lag, confidence, peakToBackground, method: 'gcc-phat' };
}

/** Median; mean of the middle pair for even counts; NaN for no values. */
export function median(xs: number[]): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** RMS level of a block in dB re full scale; digital silence is -120. */
export function rmsDb(frame: Float32Array): number {
  if (frame.length === 0) return SILENCE_DB;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return dbOfPower(sum / frame.length);
}

/**
 * RMS dB of the loudest `windowS` stretch of `pcm` starting at or after
 * sample `fromSample`, stepping one sample at a time. A span shorter than the
 * window is measured whole; no span at all is -120. This is the chirp's level
 * without knowing where the chirp landed, which is the point: the level check
 * must not depend on the correlation it is there to second-guess.
 */
export function loudestWindowDb(
  pcm: Float32Array,
  sampleRate: number,
  windowS: number,
  fromSample: number,
): number {
  const from = Math.min(pcm.length, Math.max(0, Math.floor(fromSample) || 0));
  const available = pcm.length - from;
  if (available <= 0) return SILENCE_DB;
  const window = Math.max(1, Math.round(windowS * sampleRate));
  if (available <= window) return rmsDb(pcm.subarray(from));
  // Running sum of squares: each window's energy is a subtraction.
  const prefix = new Float64Array(available + 1);
  for (let i = 0; i < available; i++) prefix[i + 1] = prefix[i] + pcm[from + i] * pcm[from + i];
  let loudest = 0;
  for (let i = 0; i + window <= available; i++) {
    loudest = Math.max(loudest, prefix[i + window] - prefix[i]);
  }
  return dbOfPower(loudest / window);
}

/** True when the chirp reached MIN_HEARD_DB over the mic's noise floor. */
export function isHeard(trial: Pick<TrialResult, 'chirpLevelDb' | 'noiseFloorDb'>): boolean {
  return trial.chirpLevelDb >= trial.noiseFloorDb + MIN_HEARD_DB;
}

/** What agreeTrials decided about a set of trials. */
export interface TrialAgreement {
  /** Heard trials with enough confidence, in the order they ran. */
  kept: TrialResult[];
  /** Largest minus smallest delay among `kept`; 0 with fewer than two. */
  spreadS: number;
  /** Median delay of `kept`; NaN when none were kept. */
  delayS: number;
  /** Weakest confidence among `kept`; 0 when none were kept. */
  confidence: number;
  /** Null when the trials can be trusted, otherwise why not. */
  failure: { code: Exclude<CalibrationCode, 'no-mic'>; message: string } | null;
}

/**
 * Decides whether a set of trials makes an answer. Trials the mic did not
 * hear, or that locked on with under MIN_CONFIDENCE, are dropped. If nothing
 * was heard the failure is 'not-heard'; if fewer than two usable trials are
 * left, 'low-confidence'; if those disagree by more than `agreeS`, 'unstable'.
 * Every message states the numbers it judged by, so the singer knows which
 * knob to turn.
 */
export function agreeTrials(
  trials: readonly TrialResult[],
  agreeS: number = DEFAULT_AGREE_S,
): TrialAgreement {
  const heard = trials.filter(isHeard);
  const kept = heard.filter((t) => t.confidence >= MIN_CONFIDENCE);
  const delays = kept.map((t) => t.delayS);
  const spreadS = delays.length > 1 ? Math.max(...delays) - Math.min(...delays) : 0;
  const result: TrialAgreement = {
    kept,
    spreadS,
    delayS: median(delays),
    confidence: kept.length > 0 ? Math.min(...kept.map((t) => t.confidence)) : 0,
    failure: null,
  };
  const needed = Math.min(MIN_AGREEING_TRIALS, trials.length);
  if (heard.length === 0) {
    result.failure = { code: 'not-heard', message: notHeardMessage(trials) };
  } else if (kept.length < needed) {
    result.failure = { code: 'low-confidence', message: lowConfidenceMessage(trials, kept.length) };
  } else if (spreadS > agreeS + 1e-9) {
    result.failure = { code: 'unstable', message: unstableMessage(kept, spreadS, agreeS) };
  }
  return result;
}

/** The status line for a good calibration: the answer and the evidence. */
export function describeLatency(result: LatencyResult): string {
  const trials = result.trialsS.map((s) => Math.round(s * 1000)).join(', ');
  const ms = Math.round(result.delayS * 1000);
  return `Latency ${ms} ms (trials ${trials} ms; confidence ${result.confidence.toFixed(2)})`;
}

/**
 * Plays the chirp `trials` times, records the mic and reports the median
 * round trip of the trials that agree. Needs an open mic and a running (or
 * resumable) context. Throws a CalibrationError, whose message holds the
 * measured levels or delays, when the mic did not hear the chirp, the echo
 * was too unclear to time, or the trials disagree; any other Error means the
 * audio itself failed (for example a stopped clock).
 */
export async function measureLatency(
  engine: AudioEngine,
  mic: MicCapture,
  capture: PcmCapture,
  opts: MeasureOptions = {},
): Promise<LatencyResult> {
  const source = mic.source;
  if (!source) {
    throw new CalibrationError('no-mic', 'Open the microphone before measuring latency.');
  }
  const trials = Math.max(1, Math.floor(opts.trials ?? DEFAULT_TRIALS) || DEFAULT_TRIALS);
  const settings: TrialSettings = {
    maxDelayS: positive(opts.maxDelayS, DEFAULT_MAX_DELAY_S),
    preRollS: positive(opts.preRollS, DEFAULT_PRE_ROLL_S),
    gapS: opts.gapS !== undefined && opts.gapS >= 0 ? opts.gapS : DEFAULT_GAP_S,
    sleep: opts.sleep ?? defaultSleep,
  };
  const agreeS = positive(opts.agreeS, DEFAULT_AGREE_S);

  await engine.resume();
  await capture.load();
  const rate = engine.context.sampleRate;
  const chirp = makeChirp(rate);
  const buffer = engine.context.createBuffer(1, chirp.length, rate);
  buffer.getChannelData(0).set(chirp);

  // Every trial runs even when the first is deaf: the levels are the
  // diagnosis, and a lone trial could have caught a cough or a door.
  const results: TrialResult[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(await runTrial(engine, capture, source, buffer, chirp, settings));
    opts.onProgress?.(i + 1, trials);
  }
  const agreement = agreeTrials(results, agreeS);
  if (agreement.failure) {
    throw new CalibrationError(agreement.failure.code, agreement.failure.message, results);
  }
  return {
    delayS: agreement.delayS,
    confidence: agreement.confidence,
    spreadS: agreement.spreadS,
    trials: agreement.kept,
    trialsS: agreement.kept.map((t) => t.delayS),
  };
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
  preRollS: number;
  gapS: number;
  sleep: (ms: number) => Promise<void>;
}

/** One chirp out, one recording back, one delay with its evidence. */
async function runTrial(
  engine: AudioEngine,
  capture: PcmCapture,
  source: AudioNode,
  buffer: AudioBuffer,
  chirp: Float32Array,
  settings: TrialSettings,
): Promise<TrialResult> {
  const node = engine.context.createBufferSource();
  node.buffer = buffer;
  node.connect(engine.master);
  capture.start(source);
  // t0 is on the context clock, the same one that stamps the recording, so
  // the difference between them is the round trip with no wall-clock drift.
  // Scheduling it a pre-roll ahead leaves that stretch of the take as pure
  // room, whose level is the noise floor the chirp has to rise above.
  const t0 = engine.now() + settings.preRollS;
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
  // Sample 0 of the take is at startedAtContextS. The correlation sees only
  // the span from t0 on, so lag 0 means "no latency" and nothing before the
  // chirp was scheduled can be mistaken for it.
  const lead = Math.round((t0 - take.startedAtContextS) * rate);
  const from = Math.min(take.pcm.length, Math.max(0, lead));
  const spanStartS = take.startedAtContextS + from / rate;
  const maxLag = Math.ceil((t0 - spanStartS + settings.maxDelayS) * rate);
  const estimate = estimateDelay(chirp, take.pcm.subarray(from), maxLag, { sampleRate: rate });
  return {
    // The sub-sample part of t0 is added back so rounding `from` costs nothing.
    delayS: Math.max(0, spanStartS + estimate.lag / rate - t0),
    confidence: estimate.confidence,
    peakToBackground: estimate.peakToBackground,
    chirpLevelDb: loudestWindowDb(take.pcm, rate, chirp.length / rate, from),
    noiseFloorDb: rmsDb(take.pcm.subarray(0, from)),
  };
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
 * Two views of the correlation of `recorded` against `reference` for lags 0
 * to `lastLag`, as magnitudes: `corr` after PHAT whitening (sharp, one narrow
 * spike per arrival) and `strength` before it (the matched filter, whose
 * height follows how loud each arrival is). Null when the recording is
 * silent. The transform is zero padded so the circular result is the linear
 * one.
 */
function correlate(
  reference: Float32Array,
  recorded: Float32Array,
  lastLag: number,
): { corr: Float64Array; strength: Float64Array } | null {
  const size = nextPow2(reference.length + recorded.length);
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const refRe = new Float32Array(size);
  const refIm = new Float32Array(size);
  re.set(recorded);
  refRe.set(reference);
  fft(re, im);
  fft(refRe, refIm);
  // rec * conj(ref): conjugating the reference turns convolution into
  // correlation, so index `lag` holds the reference slid by lag.
  let total = 0;
  for (let k = 0; k < size; k++) {
    const a = re[k];
    const b = im[k];
    const c = refRe[k];
    const d = refIm[k];
    const pr = a * c + b * d;
    const pi = b * c - a * d;
    re[k] = pr;
    im[k] = pi;
    total += Math.sqrt(pr * pr + pi * pi);
  }
  if (!(total > 0)) return null;
  // The raw spectrum is no longer needed once copied into the spare pair.
  refRe.set(re);
  refIm.set(im);
  const floor = (PHAT_FLOOR * total) / size;
  for (let k = 0; k < size; k++) {
    const weight = 1 / (Math.sqrt(re[k] * re[k] + im[k] * im[k]) + floor);
    re[k] *= weight;
    im[k] *= weight;
  }
  ifft(re, im);
  ifft(refRe, refIm);
  const corr = new Float64Array(lastLag + 1);
  const strength = new Float64Array(lastLag + 1);
  for (let lag = 0; lag <= lastLag; lag++) {
    corr[lag] = Math.abs(re[lag]);
    strength[lag] = Math.abs(refRe[lag]);
  }
  return { corr, strength };
}

/** 10 log10 of a mean power, floored at -120 dB. */
function dbOfPower(power: number): number {
  return power > 0 ? Math.max(SILENCE_DB, 10 * Math.log10(power)) : SILENCE_DB;
}

/** `+3`, `-2` or `0`: a whole-dB difference with its sign. */
function signedDb(db: number): string {
  const whole = Math.round(db);
  return whole > 0 ? `+${whole}` : String(whole);
}

function notHeardMessage(trials: readonly TrialResult[]): string {
  if (trials.length === 0) return 'The mic recorded nothing, so no chirp was heard.';
  // The best trial is the fairest: it shows how close turning up got.
  const margin = Math.max(...trials.map((t) => t.chirpLevelDb - t.noiseFloorDb));
  return (
    `Chirp not heard. Mic heard ${signedDb(margin)} dB over its noise floor; ` +
    `needs about +${MIN_HEARD_DB} dB: turn the speakers up or move the mic closer.`
  );
}

function lowConfidenceMessage(trials: readonly TrialResult[], kept: number): string {
  const confidences = trials.map((t) => t.confidence.toFixed(2)).join(', ');
  return (
    `Echo too unclear to time: ${kept} of ${trials.length} trials locked on ` +
    `(confidence ${confidences}; each needs ${MIN_CONFIDENCE}). ` +
    'Try again somewhere quieter, or move the mic closer to the speakers.'
  );
}

function unstableMessage(kept: readonly TrialResult[], spreadS: number, agreeS: number): string {
  const delays = kept.map((t) => (t.delayS * 1000).toFixed(1)).join(', ');
  return (
    `Trials disagree by ${(spreadS * 1000).toFixed(1)} ms (${delays} ms; they ` +
    `must agree within ${(agreeS * 1000).toFixed(1)} ms). Try again, or type ` +
    'the latency by hand if it keeps happening.'
  );
}

/** `value` if it is a positive finite number, else the fallback. */
function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Real timer pause. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
