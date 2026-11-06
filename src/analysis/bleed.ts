/**
 * Speaker bleed: whether the mic is hearing the song's own vocal through the
 * speakers instead of (or as well as) the singer. A singer follows the melody
 * loosely, with their own vibrato and drift. The song's vocal, coming back
 * through the mic, follows the reference melody's contour almost exactly. So
 * over a few seconds of frames that pass the level gate, if most of them sit
 * within a few cents of the reference at the same song time, and the typical
 * error is far tighter than a person's, the mic is probably hearing the song.
 *
 * It can only judge where the browser has the reference contour (a prepared
 * song or an upload the service has processed), and only matters where the
 * speakers can carry the original vocal: the Original mix, the vocal guide
 * above zero, or a YouTube video playing its own sound. With the Karaoke
 * stem alone the melody is not in the room, so no warning is armed.
 *
 * Pure, no DOM. Checked against synthetic singers and echoes in
 * test/bleed.test.ts.
 */
import type { MixChoice } from '../app/mix';
import type { ClockKind } from '../audio/transport';
import { hzToMidi } from './pitch';

/** Seconds of frames the verdict looks at. */
export const BLEED_WINDOW_S = 5;
/** Comparable frames (10 ms apart) needed before any verdict: 1.5 s. */
export const BLEED_MIN_FRAMES = 150;
/** A frame this close to the reference, in cents and octave-exact, "matches". */
export const BLEED_MATCH_CENTS = 30;
/** Share of frames that must match to suspect bleed. */
export const BLEED_MIN_MATCH = 0.6;
/** Median absolute error, in cents, under which the match is suspiciously tight. */
export const BLEED_MAX_MEDIAN_CENTS = 15;
/** Once suspected, the warning stays until fewer than this share match... */
export const BLEED_RELEASE_MATCH = 0.4;
/** ...or the median error passes this many cents. */
export const BLEED_RELEASE_MEDIAN_CENTS = 22;
/** The release thresholds keep these ratios to the tuned entering ones. */
const RELEASE_MATCH_RATIO = BLEED_RELEASE_MATCH / BLEED_MIN_MATCH;
const RELEASE_MEDIAN_RATIO = BLEED_RELEASE_MEDIAN_CENTS / BLEED_MAX_MEDIAN_CENTS;
/** A seek or loop this far back in song time starts the window over. */
const BACKWARD_RESET_S = 0.5;
/** Frames between verdicts; the window changes slowly. */
const EVALUATE_EVERY = 10;

/** The three numbers of the verdict; the Mic check tunes them per device pair. */
export interface BleedRules {
  matchCents: number;
  minMatch: number;
  maxMedianCents: number;
}

/** The rules the app shipped with. */
export const DEFAULT_BLEED_RULES: BleedRules = {
  matchCents: BLEED_MATCH_CENTS,
  minMatch: BLEED_MIN_MATCH,
  maxMedianCents: BLEED_MAX_MEDIAN_CENTS,
};

/** The reference melody's pitch track, as the lane holds it. */
export interface BleedContour {
  hopS: number;
  t0S: number;
  /** Hz at `t0S + i * hopS`; 0 or less means unvoiced. */
  f0Hz: ArrayLike<number>;
}

/** 'suspected' when the mic follows the song; 'unknown' when it cannot tell. */
export type BleedState = 'ok' | 'suspected' | 'unknown';

/** Why the state is what it is, for the words under the meter. */
export type BleedReason = 'off' | 'no_vocal' | 'no_reference' | 'collecting' | 'measured';

/** The check as the state holds it. */
export interface BleedCheck {
  state: BleedState;
  reason: BleedReason;
}

/** The check of a mic that is not being watched. */
export const BLEED_OFF: BleedCheck = { state: 'unknown', reason: 'off' };

/** What decides whether the song's vocal can reach the mic. */
export interface OutputMix {
  clock: ClockKind;
  choice: MixChoice;
  guideLevel: number;
}

/** True when the speakers can carry the original vocal. */
export function vocalInOutput(mix: OutputMix): boolean {
  // A YouTube video plays its own, unseparated sound.
  if (mix.clock === 'embed') return true;
  if (mix.choice === 'original') return true;
  return mix.choice === 'guide' && mix.guideLevel > 0;
}

/** The reference pitch at song time `t` in MIDI, or null where it is unvoiced. */
export function referenceMidiAt(contour: BleedContour, t: number): number | null {
  const i = Math.round((t - contour.t0S) / contour.hopS);
  if (i < 0 || i >= contour.f0Hz.length) return null;
  const hz = contour.f0Hz[i];
  return hz > 0 ? hzToMidi(hz) : null;
}

/** Median of a non-empty list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compares the mic's pitch with the reference over a sliding window. */
export class BleedDetector {
  private errors: Array<{ t: number; cents: number }> = [];
  private sinceEvaluated = 0;
  private current: BleedState = 'unknown';

  /** `rules` is read at each verdict, so a retuned pair applies at once. */
  constructor(private readonly rules: () => BleedRules = () => DEFAULT_BLEED_RULES) {}

  /** The verdict: 'unknown' until enough frames have been compared. */
  get state(): BleedState {
    return this.current;
  }

  /** Frames compared so far in the window. */
  get compared(): number {
    return this.errors.length;
  }

  /**
   * Takes one frame that passed the level gate: song time `t`, the mic's
   * pitch `f0` in Hz and the reference contour. A frame where the reference
   * is unvoiced says nothing and is skipped.
   */
  push(t: number, f0: number, contour: BleedContour): void {
    if (!(f0 > 0)) return;
    const last = this.errors[this.errors.length - 1];
    if (last && t < last.t - BACKWARD_RESET_S) this.reset();
    const reference = referenceMidiAt(contour, t);
    if (reference === null) return;
    this.errors.push({ t, cents: Math.abs(hzToMidi(f0) - reference) * 100 });
    const from = t - BLEED_WINDOW_S;
    let drop = 0;
    while (drop < this.errors.length && this.errors[drop].t < from) drop++;
    if (drop > 0) this.errors.splice(0, drop);
    if (++this.sinceEvaluated >= EVALUATE_EVERY) {
      this.sinceEvaluated = 0;
      this.evaluate();
    }
  }

  /** Forgets the window, as when the song, the mic or the position jumps. */
  reset(): void {
    this.errors = [];
    this.sinceEvaluated = 0;
    this.current = 'unknown';
  }

  private evaluate(): void {
    if (this.errors.length < BLEED_MIN_FRAMES) {
      this.current = 'unknown';
      return;
    }
    const cents = this.errors.map((e) => e.cents);
    const rules = this.rules();
    const matching = cents.filter((c) => c <= rules.matchCents).length / cents.length;
    const typical = median(cents);
    if (this.current === 'suspected') {
      const released =
        matching < rules.minMatch * RELEASE_MATCH_RATIO ||
        typical > rules.maxMedianCents * RELEASE_MEDIAN_RATIO;
      this.current = released ? 'ok' : 'suspected';
    } else {
      const tight = matching >= rules.minMatch && typical < rules.maxMedianCents;
      this.current = tight ? 'suspected' : 'ok';
    }
  }
}

/**
 * What the check says, from what the session knows. `speakers` is whether
 * the open mic was asked for speaker mode; `hasSong` whether a song is
 * loaded; `hasReference` whether the browser has its contour.
 */
export function bleedCheck(
  detector: BleedDetector,
  inputs: { speakers: boolean; hasSong: boolean; vocalOut: boolean; hasReference: boolean },
): BleedCheck {
  if (!inputs.speakers || !inputs.hasSong) return BLEED_OFF;
  if (!inputs.hasReference) return { state: 'unknown', reason: 'no_reference' };
  if (!inputs.vocalOut) return { state: 'unknown', reason: 'no_vocal' };
  if (detector.state === 'unknown') return { state: 'unknown', reason: 'collecting' };
  return { state: detector.state, reason: 'measured' };
}
