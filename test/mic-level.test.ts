/**
 * Checks the mic level diagnostics (src/analysis/mic-level.ts) against
 * synthetic level streams with known answers: a steady hiss, a voice over it,
 * a dead mic, and the thresholds' hysteresis.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyLevel,
  DRAW_MARGIN_DB,
  FLOOR_CEILING_DB,
  FLOOR_MIN_FRAMES,
  FLOOR_RISE_DB_PER_S,
  HEARING_OFF_DB,
  HEARING_ON_DB,
  isDrawable,
  MicLevel,
  NOTHING_OFF_DB,
  NOTHING_ON_DB,
  PEAK_HOLD_FRAMES,
  rmsToDb,
  SILENCE_DB,
} from '../src/analysis/mic-level';

/** RMS (0..1) that reads as `db`. */
const rmsOf = (db: number): number => 10 ** (db / 20);

/** Pushes `frames` frames at `db`. */
function feed(level: MicLevel, db: number, frames: number): void {
  for (let i = 0; i < frames; i++) level.push(rmsOf(db));
}

describe('rmsToDb', () => {
  it('reads full scale as 0 dB and halves as -6 dB', () => {
    expect(rmsToDb(1)).toBeCloseTo(0, 9);
    expect(rmsToDb(0.5)).toBeCloseTo(-6.02, 2);
  });

  it('reads silence and junk as the silence level', () => {
    for (const bad of [0, -1, Number.NaN]) expect(rmsToDb(bad)).toBe(SILENCE_DB);
    expect(rmsToDb(1e-9)).toBe(SILENCE_DB);
  });
});

describe('MicLevel floor', () => {
  it('reports no floor and "nothing" before enough frames', () => {
    const level = new MicLevel();
    feed(level, -50, FLOOR_MIN_FRAMES - 1);
    expect(level.ready).toBe(false);
    expect(level.floorDb).toBe(SILENCE_DB);
    expect(level.state).toBe('nothing');
  });

  it('settles on the level of steady hiss', () => {
    const level = new MicLevel();
    feed(level, -55, 100);
    expect(level.ready).toBe(true);
    expect(level.floorDb).toBeCloseTo(-55, 6);
    expect(level.state).toBe('nothing');
  });

  it('does not count a voice as floor: singing with gaps leaves the hiss as the floor', () => {
    const level = new MicLevel();
    feed(level, -55, 100);
    // Five seconds of phrases: 0.8 s at -20 dB, 0.2 s of hiss between them.
    for (let phrase = 0; phrase < 5; phrase++) {
      feed(level, -20, 80);
      feed(level, -55, 20);
    }
    expect(level.floorDb).toBeCloseTo(-55, 6);
  });

  it('rises slowly when the room gets louder', () => {
    const level = new MicLevel();
    feed(level, -60, 100);
    // Window full of -45: the percentile jumps once the old frames are gone,
    // but the floor may only climb at the slow rate.
    feed(level, -45, 500);
    const climbed = level.floorDb - -60;
    expect(climbed).toBeGreaterThan(0);
    expect(climbed).toBeLessThanOrEqual(FLOOR_RISE_DB_PER_S * 5 + 1e-6);
    feed(level, -45, 2000);
    expect(level.floorDb).toBeCloseTo(-45, 6);
  });

  it('falls at once when the room gets quieter', () => {
    const level = new MicLevel();
    feed(level, -45, 200);
    feed(level, -65, 60);
    expect(level.floorDb).toBeCloseTo(-65, 6);
  });

  it('never rises above the ceiling, however loud the steady signal', () => {
    const level = new MicLevel();
    feed(level, -10, 3000);
    expect(level.floorDb).toBe(FLOOR_CEILING_DB);
    expect(level.state).toBe('hearing');
  });

  it('forgets everything on reset', () => {
    const level = new MicLevel();
    feed(level, -55, 100);
    level.reset();
    expect(level.ready).toBe(false);
    expect(level.floorDb).toBe(SILENCE_DB);
    expect(level.state).toBe('nothing');
  });
});

describe('MicLevel state', () => {
  it('hears a voice well above the floor, and holds it through a short gap', () => {
    const level = new MicLevel();
    feed(level, -55, 100);
    feed(level, -25, 50);
    expect(level.state).toBe('hearing');
    // A 1 s pause between words is inside the peak hold.
    feed(level, -55, 100);
    expect(level.state).toBe('hearing');
    expect(PEAK_HOLD_FRAMES).toBeGreaterThan(100);
  });

  it('goes back to "nothing" once the hold has passed', () => {
    const level = new MicLevel();
    feed(level, -55, 100);
    feed(level, -25, 50);
    feed(level, -55, PEAK_HOLD_FRAMES + 5);
    expect(level.state).toBe('nothing');
  });

  it('calls a level above the floor but below voice "quiet"', () => {
    const level = new MicLevel();
    feed(level, -55, 100);
    feed(level, -55 + 8, 50);
    expect(level.state).toBe('quiet');
  });

  it('reads a dead mic as "nothing"', () => {
    const level = new MicLevel();
    feed(level, -200, 200);
    expect(level.floorDb).toBe(SILENCE_DB);
    expect(level.state).toBe('nothing');
  });
});

describe('classifyLevel hysteresis', () => {
  const floor = -50;

  it('enters hearing at the on margin and leaves below the off margin', () => {
    expect(classifyLevel('quiet', floor + HEARING_ON_DB - 0.1, floor)).toBe('quiet');
    expect(classifyLevel('quiet', floor + HEARING_ON_DB, floor)).toBe('hearing');
    expect(classifyLevel('hearing', floor + HEARING_OFF_DB, floor)).toBe('hearing');
    expect(classifyLevel('hearing', floor + HEARING_OFF_DB - 0.1, floor)).toBe('quiet');
  });

  it('enters nothing at the low margin and leaves above the higher one', () => {
    expect(classifyLevel('quiet', floor + NOTHING_ON_DB - 0.1, floor)).toBe('nothing');
    expect(classifyLevel('nothing', floor + NOTHING_ON_DB + 0.5, floor)).toBe('nothing');
    expect(classifyLevel('nothing', floor + NOTHING_OFF_DB, floor)).toBe('quiet');
  });

  it('drops from hearing to nothing when the level falls to the floor', () => {
    expect(classifyLevel('hearing', floor, floor)).toBe('nothing');
  });
});

describe('isDrawable', () => {
  const floor = -50;
  const loud = rmsOf(floor + DRAW_MARGIN_DB + 1);
  const faint = rmsOf(floor + DRAW_MARGIN_DB - 1);

  it('passes a voiced, clear, loud-enough frame', () => {
    expect(isDrawable({ f0: 220, clarity: 0.95, rms: loud }, floor, 0.9)).toBe(true);
  });

  it('fails an unvoiced frame', () => {
    expect(isDrawable({ f0: 0, clarity: 0.95, rms: loud }, floor, 0.9)).toBe(false);
  });

  it('fails a frame under the clarity threshold, and passes at it', () => {
    expect(isDrawable({ f0: 220, clarity: 0.89, rms: loud }, floor, 0.9)).toBe(false);
    expect(isDrawable({ f0: 220, clarity: 0.9, rms: loud }, floor, 0.9)).toBe(true);
  });

  it('fails a frame too close to the floor', () => {
    expect(isDrawable({ f0: 220, clarity: 0.95, rms: faint }, floor, 0.9)).toBe(false);
  });

  it('passes anything voiced and clear while no floor is known', () => {
    expect(isDrawable({ f0: 220, clarity: 0.95, rms: 1e-4 }, SILENCE_DB, 0.9)).toBe(true);
  });
});
