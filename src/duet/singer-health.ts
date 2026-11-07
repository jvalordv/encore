/**
 * Mic health for singer B's own input: its noise floor, its level gate and
 * the state the meter shows. It is the same arithmetic as singer A's
 * (src/analysis/mic-level.ts) on its own `MicLevel`, so B's floor and gate
 * never borrow A's, and the rules come from B's own device pair (the Mic check
 * tuning is stored per input and output). Speaker bleed and the note guide stay
 * with singer A's mic. Pure of the DOM and of Web Audio; tested in
 * test/duet-health.test.ts.
 */
import { isDrawable, MicLevel, rmsToDb, SILENCE_DB } from '../analysis/mic-level';
import type { MicState } from '../analysis/mic-level';
import type { MicTuning } from '../analysis/mic-tuning';
import { centsBetween } from '../analysis/pitch';
import type { PitchFrame } from '../analysis/pitch';
import { gateReasonOf } from '../app/take-trace';
import type { GateReason } from '../app/take-trace';

/** Levels are published to the nearest half decibel, so hiss does not repaint. */
const DB_STEP = 0.5;

/** B's frame this far (dB) under A's simultaneous one may be A leaking in. */
export const LEAK_MARGIN_DB = 6;
/** ...when its pitch lies within this many cents of A's. */
export const LEAK_MATCH_CENTS = 50;

/**
 * True when `b` looks like singer A's voice reaching B's mic: both voiced, B's
 * level at least LEAK_MARGIN_DB under A's and the pitches within
 * LEAK_MATCH_CENTS. Only meant for speaker mode with two mics in one room;
 * a quieter B singing the same note as A is the cost, taken to keep A's
 * voice and the speakers out of B's report.
 */
export function isLeakOfA(
  b: Pick<PitchFrame, 'f0' | 'rms'>,
  a: Pick<PitchFrame, 'f0' | 'rms'>,
  marginDb: number = LEAK_MARGIN_DB,
  matchCents: number = LEAK_MATCH_CENTS,
): boolean {
  if (!(b.f0 > 0) || !(a.f0 > 0) || !(a.rms > 0)) return false;
  if (!(b.rms > 0)) return true;
  if (rmsToDb(b.rms) > rmsToDb(a.rms) - marginDb) return false;
  return Math.abs(centsBetween(b.f0, a.f0)) <= matchCents;
}

const roundDb = (db: number): number => Math.round(db / DB_STEP) * DB_STEP;

/** What the gate said of one frame. */
export interface GateVerdict {
  drawable: boolean;
  /** Why it failed; null when it passed. */
  reason: GateReason | null;
}

/** What the meter shows for the mic. */
export interface HealthReading {
  levelDb: number;
  floorDb: number;
  micState: MicState;
}

/** The floor, gate and state of one singer's mic. */
export class SingerHealth {
  private readonly level = new MicLevel();

  constructor(private readonly tuning: () => MicTuning) {}

  /** Takes one tracker frame and says whether it may be drawn and scored. */
  observe(frame: PitchFrame): GateVerdict {
    this.level.push(frame.rms);
    const { clarityThreshold, drawMarginDb } = this.tuning();
    const drawable = isDrawable(frame, this.level.floorDb, clarityThreshold, drawMarginDb);
    return {
      drawable,
      reason: drawable ? null : gateReasonOf(frame, this.level.floorDb, clarityThreshold, drawMarginDb),
    };
  }

  /** The noise floor in dB; SILENCE_DB until it is known. */
  get floorDb(): number {
    return this.level.floorDb;
  }

  /** The numbers the meter shows, rounded for publishing. */
  reading(): HealthReading {
    const ready = this.level.ready;
    return {
      levelDb: ready ? roundDb(this.level.levelDb) : SILENCE_DB,
      floorDb: ready ? roundDb(this.level.floorDb) : SILENCE_DB,
      micState: this.level.state,
    };
  }

  /** Forgets the floor, as when the mic is closed or changed. */
  reset(): void {
    this.level.reset();
  }
}
