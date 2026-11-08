/**
 * The mic's tunable rules, kept per device pair: how far above the noise floor
 * a frame must sit to be drawn, how clear it must be, and what the speaker
 * bleed check counts as a match. Defaults are the constants the app shipped
 * with; the Mic check measures the room and offers values that fit it. Pure,
 * no DOM: settings.ts stores the sanitised objects, the gate and the bleed
 * detector read them. Checked in test/mic-tuning.test.ts.
 */
import { DRAW_MARGIN_DB } from './mic-level';
import { DEFAULT_CLARITY } from './pitch';

/** The five numbers a device pair can tune. */
export interface MicTuning {
  /** dB above the noise floor a frame needs to be drawn or scored. */
  drawMarginDb: number;
  /** Clarity at or above which a frame counts as voiced, 0..1. */
  clarityThreshold: number;
  /** A frame this close to the reference, in cents, "matches" it (bleed). */
  bleedMatchCents: number;
  /** Share of frames that must match to suspect bleed. */
  bleedMinMatch: number;
  /** Median error, in cents, under which the match is suspiciously tight. */
  bleedMaxMedianCents: number;
}

/** The names of the tuned values, in the order the result card lists them. */
export const TUNING_KEYS = [
  'drawMarginDb',
  'clarityThreshold',
  'bleedMatchCents',
  'bleedMinMatch',
  'bleedMaxMedianCents',
] as const;

/** Name of one tuned value. */
export type TuningKey = (typeof TUNING_KEYS)[number];

/** Today's values, used by every pair that has not been tuned. */
export const DEFAULT_TUNING: Readonly<MicTuning> = Object.freeze({
  drawMarginDb: DRAW_MARGIN_DB,
  clarityThreshold: DEFAULT_CLARITY,
  bleedMatchCents: 30,
  bleedMinMatch: 0.6,
  bleedMaxMedianCents: 15,
});

/** Inclusive limits of each value; a stored or offered number is clamped. */
export const TUNING_RANGES: Readonly<Record<TuningKey, readonly [number, number]>> = Object.freeze({
  drawMarginDb: [4, 20],
  clarityThreshold: [0.5, 0.98],
  bleedMatchCents: [10, 60],
  bleedMinMatch: [0.3, 0.9],
  bleedMaxMedianCents: [5, 30],
});

/** `value` limited to the range of `key`; NaN reads as the default. */
export function clampTuning(key: TuningKey, value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TUNING[key];
  const [low, high] = TUNING_RANGES[key];
  return Math.min(high, Math.max(low, value));
}

/**
 * A tuning from anything stored: each value on its own, clamped into range,
 * with the default (or `fallback`) for a missing or non-numeric one.
 */
export function sanitizeTuning(value: unknown, fallback: Readonly<MicTuning> = DEFAULT_TUNING): MicTuning {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const out = { ...fallback };
  for (const key of TUNING_KEYS) {
    const v = raw[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clampTuning(key, v);
  }
  return out;
}

/**
 * The tuning stored for a pair, or the defaults (with the global clarity
 * setting standing in for the default clarity) when there is none.
 */
export function tuningForPair(
  byPair: Readonly<Record<string, MicTuning>>,
  key: string,
  defaultClarity: number = DEFAULT_TUNING.clarityThreshold,
): MicTuning {
  const stored = Object.prototype.hasOwnProperty.call(byPair, key) ? byPair[key] : undefined;
  if (stored) return { ...stored };
  // Not clamped: the hand-set clarity setting allows the whole 0..1.
  return { ...DEFAULT_TUNING, clarityThreshold: defaultClarity };
}

/**
 * `base` with the values `change` names; a null in `change` keeps the base
 * value (the service's "keep current"). Results are clamped.
 */
export function applyTuningChange(
  base: Readonly<MicTuning>,
  change: Partial<Record<TuningKey, number | null>>,
): MicTuning {
  const out = { ...base };
  for (const key of TUNING_KEYS) {
    const v = change[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = clampTuning(key, v);
  }
  return out;
}
