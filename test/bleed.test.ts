/**
 * Tests for the speaker-bleed check (src/analysis/bleed.ts) on synthetic
 * contours with known answers: an echo that follows the reference to within a
 * few cents, singers with vibrato and drift, too few frames, unvoiced stretches
 * of the reference, the warning's release, a seek, and when the check is armed.
 */
import { describe, expect, it } from 'vitest';
import {
  BLEED_MAX_MEDIAN_CENTS,
  BLEED_MIN_FRAMES,
  BLEED_OFF,
  BLEED_RELEASE_MATCH,
  BLEED_WINDOW_S,
  bleedCheck,
  BleedDetector,
  referenceMidiAt,
  vocalInOutput,
} from '../src/analysis/bleed';
import type { BleedContour } from '../src/analysis/bleed';
import { midiToHz } from '../src/analysis/pitch';

const HOP = 0.01;
/** A 20 s melody gliding about a whole tone either side of C4. */
const midiAt = (t: number): number => 60 + 2 * Math.sin(t * 0.8);
const contour: BleedContour = {
  hopS: HOP,
  t0S: 0,
  f0Hz: Array.from({ length: 2000 }, (_, i) => midiToHz(midiAt(i * HOP))),
};

/** Feeds `seconds` of a mic whose pitch is the reference plus `offsetCents(t)`. */
function sing(
  detector: BleedDetector,
  from: number,
  seconds: number,
  offsetCents: (t: number) => number,
  withContour: BleedContour = contour,
): number {
  const frames = Math.round(seconds / HOP);
  for (let i = 0; i < frames; i++) {
    const t = from + i * HOP;
    detector.push(t, midiToHz(midiAt(t) + offsetCents(t) / 100), withContour);
  }
  return from + frames * HOP;
}

/** The speakers' echo: a few cents of deterministic wobble about the reference. */
const echo = (t: number): number => 8 * Math.sin(t * 37);
/** A singer with a 5.5 Hz vibrato of +-25 c. */
const vibrato = (t: number): number => 25 * Math.sin(2 * Math.PI * 5.5 * t);
/** A singer who drifts 60 c sharp and flat over a few seconds. */
const drifting = (t: number): number => 60 * Math.sin(t * 1.3);

describe('referenceMidiAt', () => {
  it('reads the contour at the nearest frame', () => {
    expect(referenceMidiAt(contour, 5)).toBeCloseTo(midiAt(5), 6);
  });

  it('is null outside the contour and where it is unvoiced', () => {
    expect(referenceMidiAt(contour, -1)).toBeNull();
    expect(referenceMidiAt(contour, 25)).toBeNull();
    const gappy: BleedContour = { hopS: HOP, t0S: 0, f0Hz: [220, 0, 220] };
    expect(referenceMidiAt(gappy, HOP)).toBeNull();
  });
});

describe('BleedDetector', () => {
  it('suspects an echo that follows the reference within a few cents', () => {
    const d = new BleedDetector();
    sing(d, 0, 4, echo);
    expect(d.state).toBe('suspected');
  });

  it('does not suspect a singer with vibrato, whose error is not tight', () => {
    const d = new BleedDetector();
    sing(d, 0, 5, vibrato);
    // Every frame is within the match window, but the typical error is wider
    // than an echo's; both halves of the rule are needed.
    expect(BLEED_MAX_MEDIAN_CENTS).toBeLessThan(25 * Math.SQRT1_2 + 0.1);
    expect(d.state).toBe('ok');
  });

  it('does not suspect a singer who drifts off the melody', () => {
    const d = new BleedDetector();
    sing(d, 0, 5, drifting);
    expect(d.state).toBe('ok');
  });

  it('does not suspect a singer an octave below, who never matches exactly', () => {
    const d = new BleedDetector();
    sing(d, 0, 4, () => -1200);
    expect(d.state).toBe('ok');
  });

  it('says nothing before enough frames have been compared', () => {
    const d = new BleedDetector();
    sing(d, 0, (BLEED_MIN_FRAMES - 20) * HOP, echo);
    expect(d.state).toBe('unknown');
    sing(d, 1.5, 0.5, echo);
    expect(d.state).toBe('suspected');
  });

  it('skips frames where the reference is unvoiced', () => {
    const d = new BleedDetector();
    const silent: BleedContour = { hopS: HOP, t0S: 0, f0Hz: new Array<number>(2000).fill(0) };
    sing(d, 0, 4, echo, silent);
    expect(d.compared).toBe(0);
    expect(d.state).toBe('unknown');
  });

  it('ignores unvoiced mic frames', () => {
    const d = new BleedDetector();
    for (let i = 0; i < 400; i++) d.push(i * HOP, 0, contour);
    expect(d.compared).toBe(0);
  });

  it('lets the warning go once the mic stops following the song', () => {
    const d = new BleedDetector();
    let t = sing(d, 0, 4, echo);
    expect(d.state).toBe('suspected');
    // The singer takes over; after a window the echo has aged out.
    t = sing(d, t, BLEED_WINDOW_S + 0.5, drifting);
    expect(d.state).toBe('ok');
    expect(BLEED_RELEASE_MATCH).toBeLessThan(0.6);
  });

  it('keeps only the last window of frames', () => {
    const d = new BleedDetector();
    sing(d, 0, 12, echo);
    expect(d.compared).toBeLessThanOrEqual(Math.round(BLEED_WINDOW_S / HOP) + 1);
  });

  it('starts over when the song position jumps back', () => {
    const d = new BleedDetector();
    sing(d, 10, 4, echo);
    expect(d.state).toBe('suspected');
    sing(d, 1, 0.3, echo);
    expect(d.state).toBe('unknown');
    expect(d.compared).toBeLessThan(40);
  });

  it('forgets everything on reset', () => {
    const d = new BleedDetector();
    sing(d, 0, 4, echo);
    d.reset();
    expect(d.state).toBe('unknown');
    expect(d.compared).toBe(0);
  });
});

describe('vocalInOutput', () => {
  it('is true for the original mix and for a video playing its own sound', () => {
    expect(vocalInOutput({ clock: 'engine', choice: 'original', guideLevel: 0 })).toBe(true);
    expect(vocalInOutput({ clock: 'embed', choice: 'karaoke', guideLevel: 0 })).toBe(true);
  });

  it('is true for the guide mix only when the guide is up', () => {
    expect(vocalInOutput({ clock: 'engine', choice: 'guide', guideLevel: 0.5 })).toBe(true);
    expect(vocalInOutput({ clock: 'engine', choice: 'guide', guideLevel: 0 })).toBe(false);
  });

  it('is false for the karaoke stem alone', () => {
    expect(vocalInOutput({ clock: 'engine', choice: 'karaoke', guideLevel: 1 })).toBe(false);
  });
});

describe('bleedCheck', () => {
  const armed = { speakers: true, hasSong: true, vocalOut: true, hasReference: true };

  it('is off with headphones or with no song', () => {
    const d = new BleedDetector();
    expect(bleedCheck(d, { ...armed, speakers: false })).toEqual(BLEED_OFF);
    expect(bleedCheck(d, { ...armed, hasSong: false })).toEqual(BLEED_OFF);
  });

  it('says it cannot compare without the reference, before anything else', () => {
    const d = new BleedDetector();
    expect(bleedCheck(d, { ...armed, hasReference: false, vocalOut: false })).toEqual({
      state: 'unknown',
      reason: 'no_reference',
    });
  });

  it('is unarmed when the speakers carry no vocal', () => {
    const d = new BleedDetector();
    sing(d, 0, 4, echo);
    expect(bleedCheck(d, { ...armed, vocalOut: false })).toEqual({ state: 'unknown', reason: 'no_vocal' });
  });

  it('collects, then reports the detector', () => {
    const d = new BleedDetector();
    expect(bleedCheck(d, armed)).toEqual({ state: 'unknown', reason: 'collecting' });
    sing(d, 0, 4, echo);
    expect(bleedCheck(d, armed)).toEqual({ state: 'suspected', reason: 'measured' });
    d.reset();
    sing(d, 0, 5, drifting);
    expect(bleedCheck(d, armed)).toEqual({ state: 'ok', reason: 'measured' });
  });
});
