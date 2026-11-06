/**
 * Tests for the per-pair mic tuning (src/analysis/mic-tuning.ts): the
 * sanitiser clamps each value alone, a pair looks up its own entry and falls
 * back to the defaults, the settings keep the map, and the gate, the take
 * trace's gate reason and the bleed detector all read a non-default tuning.
 */
import { describe, expect, it } from 'vitest';
import { BleedDetector, DEFAULT_BLEED_RULES } from '../src/analysis/bleed';
import { DRAW_MARGIN_DB, isDrawable, rmsToDb } from '../src/analysis/mic-level';
import {
  applyTuningChange,
  clampTuning,
  DEFAULT_TUNING,
  sanitizeTuning,
  TUNING_RANGES,
  tuningForPair,
} from '../src/analysis/mic-tuning';
import { loadSettings, saveSettings } from '../src/app/settings';
import { memoryStore } from '../src/app/storage';
import { gateReasonOf } from '../src/app/take-trace';
import { latencyKey } from '../src/audio/latency';

describe('sanitizeTuning', () => {
  it('returns the defaults for anything that is not an object', () => {
    for (const bad of [null, undefined, 3, 'x', []]) expect(sanitizeTuning(bad)).toEqual(DEFAULT_TUNING);
  });

  it('clamps each value into its range on its own', () => {
    const t = sanitizeTuning({
      drawMarginDb: 99,
      clarityThreshold: 0.1,
      bleedMatchCents: 5,
      bleedMinMatch: 'no',
      bleedMaxMedianCents: Number.NaN,
    });
    expect(t.drawMarginDb).toBe(TUNING_RANGES.drawMarginDb[1]);
    expect(t.clarityThreshold).toBe(TUNING_RANGES.clarityThreshold[0]);
    expect(t.bleedMatchCents).toBe(TUNING_RANGES.bleedMatchCents[0]);
    expect(t.bleedMinMatch).toBe(DEFAULT_TUNING.bleedMinMatch);
    expect(t.bleedMaxMedianCents).toBe(DEFAULT_TUNING.bleedMaxMedianCents);
  });

  it('keeps in-range values exactly', () => {
    const mine = { drawMarginDb: 12, clarityThreshold: 0.8, bleedMatchCents: 20, bleedMinMatch: 0.5, bleedMaxMedianCents: 10 };
    expect(sanitizeTuning(mine)).toEqual(mine);
    expect(clampTuning('drawMarginDb', Number.NaN)).toBe(DRAW_MARGIN_DB);
  });
});

describe('tuningForPair', () => {
  const key = latencyKey('out-1', 'in-1');
  const mine = { ...DEFAULT_TUNING, drawMarginDb: 14 };

  it('finds the pair that was tuned and no other', () => {
    const map = { [key]: mine };
    expect(tuningForPair(map, key).drawMarginDb).toBe(14);
    expect(tuningForPair(map, latencyKey('out-2', 'in-1'))).toEqual(DEFAULT_TUNING);
  });

  it('uses the clarity setting as the default clarity, unclamped', () => {
    expect(tuningForPair({}, key, 1).clarityThreshold).toBe(1);
  });

  it('does not read a prototype key as an entry', () => {
    expect(tuningForPair({}, 'constructor')).toEqual(DEFAULT_TUNING);
  });

  it('applies a change, keeping the values the service left null', () => {
    const next = applyTuningChange(DEFAULT_TUNING, { drawMarginDb: 30, bleedMinMatch: null });
    expect(next.drawMarginDb).toBe(20);
    expect(next.bleedMinMatch).toBe(DEFAULT_TUNING.bleedMinMatch);
  });
});

describe('settings keep the tuning per pair', () => {
  it('round-trips and sanitises what it reads', () => {
    const store = memoryStore();
    const settings = loadSettings(store);
    settings.micTuningByDevicePair = { a: { ...DEFAULT_TUNING, drawMarginDb: 12 } };
    saveSettings(store, settings);
    expect(loadSettings(store).micTuningByDevicePair.a!.drawMarginDb).toBe(12);
    store.set('settings', JSON.stringify({ micTuningByDevicePair: { b: { drawMarginDb: 500 }, c: 4 } }));
    const read = loadSettings(store).micTuningByDevicePair;
    expect(read.b!.drawMarginDb).toBe(20);
    expect(read.c).toBeUndefined();
  });
});

describe('the gate reads the tuning', () => {
  const floor = -60;
  const rms = 10 ** ((floor + 10) / 20);
  const frame = { f0: 220, clarity: 0.95, rms };

  it('passes a frame 10 dB up at the default margin and fails it at 12', () => {
    expect(rmsToDb(rms)).toBeCloseTo(floor + 10, 5);
    expect(isDrawable(frame, floor, 0.9)).toBe(true);
    expect(isDrawable(frame, floor, 0.9, 12)).toBe(false);
    expect(gateReasonOf(frame, floor, 0.9, 12)).toBe('quiet');
    expect(gateReasonOf(frame, floor, 0.9)).toBeNull();
  });
});

describe('the bleed detector reads the tuning', () => {
  const contour = { hopS: 0.01, t0S: 0, f0Hz: new Float64Array(1000).fill(220) };
  /** Frames that sit `cents` off the reference for `seconds`. */
  function feed(d: BleedDetector, cents: number, seconds: number): void {
    const hz = 220 * 2 ** (cents / 1200);
    for (let i = 0; i < seconds * 100; i++) d.push(i * 0.01, hz, contour);
  }

  it('suspects an echo 20 cents off with the default rules only if it is within them', () => {
    const d = new BleedDetector();
    feed(d, 20, 3);
    expect(d.state).toBe('ok');
  });

  it('suspects the same frames once the tuned rules accept them', () => {
    const d = new BleedDetector(() => ({ ...DEFAULT_BLEED_RULES, matchCents: 40, maxMedianCents: 25 }));
    feed(d, 20, 3);
    expect(d.state).toBe('suspected');
  });

  it('holds the warning until the tuned release thresholds are passed', () => {
    const rules = { matchCents: 30, minMatch: 0.6, maxMedianCents: 15 };
    const d = new BleedDetector(() => rules);
    feed(d, 5, 3);
    expect(d.state).toBe('suspected');
    // Release median is 22/15 of the tuned 15: a tighter rule releases sooner.
    rules.maxMedianCents = 6;
    feed(d, 9, 3);
    expect(d.state).toBe('ok');
  });
});
