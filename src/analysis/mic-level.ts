/**
 * Mic level diagnostics: how loud the room is when nobody sings (the noise
 * floor), whether the mic is hearing a voice, and whether one pitch frame is
 * clear enough to draw or score. Pure arithmetic over frame RMS in decibels,
 * with no DOM or audio, so the Session can feed it the tracker's frames and
 * the tests can feed it synthetic ones with known answers.
 *
 * The floor is a low percentile of the last few seconds of frame levels. It
 * falls as soon as the mic gets quieter and rises slowly, so a held note
 * cannot drag it up, and it never rises above `FLOOR_CEILING_DB`: a mic that
 * is always louder than that is hearing the voice or the song, not noise.
 * The state (hearing, quiet, nothing) is read off the loudest recent frame
 * against the floor, with hysteresis so the line on screen does not flicker.
 */

/** Seconds between tracker frames (the project-wide 10 ms hop). */
export const FRAME_S = 0.01;
/** Frames the floor looks back over: 5 s, long enough to span a phrase's gaps. */
export const FLOOR_WINDOW_FRAMES = 500;
/** Share of the window's frames that sit below the floor (a low percentile). */
export const FLOOR_PERCENTILE = 0.1;
/** Frames needed before a floor is reported; 0.3 s of listening. */
export const FLOOR_MIN_FRAMES = 30;
/** Fastest the floor may rise, in dB per second: slow, so singing cannot lift it. */
export const FLOOR_RISE_DB_PER_S = 1.5;
/** The floor never rises above this: quiet rooms sit near -60, noisy ones -40. */
export const FLOOR_CEILING_DB = -35;
/** What a frame of digital silence reads as, and the floor before it is known. */
export const SILENCE_DB = -120;

/** Frames the loudest-recent hold spans: 1.5 s bridges the gap between words. */
export const PEAK_HOLD_FRAMES = 150;

/** dB above the floor at which the mic is hearing a voice (entering). */
export const HEARING_ON_DB = 12;
/** dB above the floor below which a voice is lost again (leaving). */
export const HEARING_OFF_DB = 9;
/** dB above the floor at or below which the mic hears nothing (entering). */
export const NOTHING_ON_DB = 4;
/** dB above the floor above which the mic hears something again (leaving). */
export const NOTHING_OFF_DB = 6;

/** dB above the floor a frame needs to be drawn or scored; under HEARING_ON_DB. */
export const DRAW_MARGIN_DB = 8;

/**
 * dB above the floor a faint frame needs to be drawn. Far under DRAW_MARGIN_DB
 * on purpose: with the song in the room the voice sits only a few dB over the
 * level of the music, so the full margin would hide most of the faint trace.
 */
export const FAINT_DRAW_MARGIN_DB = 0;

/**
 * The faint margin to use. Headphones keep FAINT_DRAW_MARGIN_DB. With speakers
 * the floor sits near the music's level, so a faint frame at the floor can be
 * the backing bass or guitar; half the tuned drawing margin keeps most of the
 * voice and drops that.
 */
export function faintMarginFor(speakers: boolean, drawMarginDb: number): number {
  return speakers ? drawMarginDb / 2 : FAINT_DRAW_MARGIN_DB;
}

/** What the mic is doing, in the words the meter's line uses. */
export type MicState = 'hearing' | 'quiet' | 'nothing';

/** A frame's level in dB (re full scale); silence and junk read as SILENCE_DB. */
export function rmsToDb(rms: number): number {
  if (!(rms > 0)) return SILENCE_DB;
  return Math.max(SILENCE_DB, 20 * Math.log10(rms));
}

/**
 * The state after a frame, given the one before. `peakDb` is the loudest
 * recent level and `floorDb` the noise floor; the thresholds differ on the way
 * in and the way out so a level sitting on a line does not flip-flop.
 */
export function classifyLevel(previous: MicState, peakDb: number, floorDb: number): MicState {
  const above = peakDb - floorDb;
  if (previous === 'hearing') {
    if (above >= HEARING_OFF_DB) return 'hearing';
    return above < NOTHING_ON_DB ? 'nothing' : 'quiet';
  }
  if (above >= HEARING_ON_DB) return 'hearing';
  if (previous === 'quiet') return above < NOTHING_ON_DB ? 'nothing' : 'quiet';
  return above >= NOTHING_OFF_DB ? 'quiet' : 'nothing';
}

/** The slice of a pitch frame the gate reads. */
export interface GateFrame {
  f0: number;
  clarity: number;
  rms: number;
}

/**
 * True when a frame may be drawn and scored: voiced, clear enough, and loud
 * enough above the floor to be a voice rather than hiss or a faint echo.
 */
export function isDrawable(
  frame: GateFrame,
  floorDb: number,
  clarityThreshold: number,
  drawMarginDb: number = DRAW_MARGIN_DB,
): boolean {
  if (!(frame.f0 > 0) || !(frame.clarity >= clarityThreshold)) return false;
  return rmsToDb(frame.rms) >= floorDb + drawMarginDb;
}

/**
 * True when a frame carries a faint pitch (`faintF0`, f0 still 0) and is above
 * the noise floor, so the lane may draw it as a hint. Never feeds scoring.
 */
export function isFaintDrawable(
  frame: { f0: number; faintF0?: number; rms: number },
  floorDb: number,
  marginDb: number = FAINT_DRAW_MARGIN_DB,
): boolean {
  if (frame.f0 > 0 || !((frame.faintF0 ?? 0) > 0)) return false;
  return rmsToDb(frame.rms) >= floorDb + marginDb;
}

/** Tracks the noise floor, the recent peak and the state over a stream of frames. */
export class MicLevel {
  private readonly ring = new Float64Array(FLOOR_WINDOW_FRAMES);
  private count = 0;
  private head = 0;
  private floor = SILENCE_DB;
  private known = false;
  private peak = SILENCE_DB;
  private current: MicState = 'nothing';

  /** Takes one frame's RMS (0..1 for full-scale audio). */
  push(rms: number): void {
    const db = rmsToDb(rms);
    this.ring[this.head] = db;
    this.head = (this.head + 1) % FLOOR_WINDOW_FRAMES;
    if (this.count < FLOOR_WINDOW_FRAMES) this.count++;
    this.updatePeak();
    if (this.count < FLOOR_MIN_FRAMES) return;
    const low = Math.min(this.percentile(), FLOOR_CEILING_DB);
    if (!this.known) {
      this.floor = low;
      this.known = true;
    } else {
      // Down at once, up only at the slow rate.
      this.floor = Math.min(low, this.floor + FLOOR_RISE_DB_PER_S * FRAME_S);
    }
    this.current = classifyLevel(this.current, this.peak, this.floor);
  }

  /** The noise floor in dB; SILENCE_DB until enough frames have been heard. */
  get floorDb(): number {
    return this.floor;
  }

  /** The loudest level of the last 1.5 s, in dB. */
  get levelDb(): number {
    return this.peak;
  }

  /** What the mic is doing; 'nothing' until a floor is known. */
  get state(): MicState {
    return this.current;
  }

  /** True once a floor has been measured. */
  get ready(): boolean {
    return this.known;
  }

  /** Forgets everything, as when the mic is closed or changed. */
  reset(): void {
    this.count = 0;
    this.head = 0;
    this.floor = SILENCE_DB;
    this.known = false;
    this.peak = SILENCE_DB;
    this.current = 'nothing';
  }

  private updatePeak(): void {
    const n = Math.min(PEAK_HOLD_FRAMES, this.count);
    let max = SILENCE_DB;
    for (let i = 1; i <= n; i++) {
      const v = this.ring[(this.head - i + FLOOR_WINDOW_FRAMES) % FLOOR_WINDOW_FRAMES];
      if (v > max) max = v;
    }
    this.peak = max;
  }

  private percentile(): number {
    const sorted = Array.from(this.ring.subarray(0, this.count)).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(FLOOR_PERCENTILE * sorted.length))];
  }
}
