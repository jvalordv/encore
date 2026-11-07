/**
 * Singer B's mic health (its own floor and gate, from its own device pair's
 * rules), the duet settings' sanitising, and the Hands-Free label check.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TUNING } from '../src/analysis/mic-tuning';
import { HANDS_FREE_WARNING, isHandsFreeLabel } from '../src/duet/hands-free';
import { cleanColour, cleanName, defaultDuet, NAME_MAX, sanitizeDuet } from '../src/duet/settings';
import { isLeakOfA, SingerHealth } from '../src/duet/singer-health';

const HISS = 1e-4;
const VOICE = 0.2;

/** `n` frames of noise at `rms`, unvoiced, so a floor is known. */
function listen(health: SingerHealth, rms = HISS, n = 60): void {
  for (let i = 0; i < n; i++) health.observe({ t: i * 0.01, f0: 0, clarity: 0.1, rms });
}

describe('singer health', () => {
  it("gates a frame against its own floor, not another singer's", () => {
    const quiet = new SingerHealth(() => ({ ...DEFAULT_TUNING }));
    const noisy = new SingerHealth(() => ({ ...DEFAULT_TUNING }));
    listen(quiet);
    // B's room is noisier: its floor sits tens of dB higher than A's.
    listen(noisy, 0.02);
    const frame = { t: 1, f0: 220, clarity: 0.95, rms: 0.01 };
    expect(quiet.observe(frame).drawable).toBe(true);
    const verdict = noisy.observe(frame);
    expect(verdict.drawable).toBe(false);
    expect(verdict.reason).toBe('quiet');
    expect(noisy.floorDb).toBeGreaterThan(quiet.floorDb + 20);
  });

  it('uses the rules it was given, read each frame', () => {
    let tuning = { ...DEFAULT_TUNING, clarityThreshold: 0.99 };
    const health = new SingerHealth(() => tuning);
    listen(health);
    const frame = { t: 1, f0: 220, clarity: 0.95, rms: VOICE };
    expect(health.observe(frame).reason).toBe('unclear');
    tuning = { ...tuning, clarityThreshold: 0.9 };
    expect(health.observe(frame).drawable).toBe(true);
  });

  it('reads nothing until a floor is known, and forgets it on reset', () => {
    const health = new SingerHealth(() => ({ ...DEFAULT_TUNING }));
    expect(health.reading().micState).toBe('nothing');
    listen(health);
    expect(health.reading().floorDb).toBeLessThan(-60);
    health.reset();
    expect(health.reading().levelDb).toBe(-120);
  });
});

describe('the duet settings', () => {
  it('starts with singer B off and the default names', () => {
    expect(defaultDuet()).toEqual({
      secondSinger: false,
      names: ['Singer A', 'Singer B'],
      colours: [null, null],
      inputDeviceIdB: null,
    });
  });

  it('judges each field alone', () => {
    const s = sanitizeDuet({
      secondSinger: true,
      names: ['  Ann   Lee ', 42],
      colours: ['#AABBCC', 'red'],
      inputDeviceIdB: 'usb-1',
    });
    expect(s.secondSinger).toBe(true);
    expect(s.names).toEqual(['Ann Lee', 'Singer B']);
    expect(s.colours).toEqual(['#aabbcc', null]);
    expect(s.inputDeviceIdB).toBe('usb-1');
    expect(sanitizeDuet('junk')).toEqual(defaultDuet());
    expect(sanitizeDuet({ inputDeviceIdB: '' }).inputDeviceIdB).toBeNull();
  });

  it('cuts a long name and falls back for an empty one', () => {
    expect(cleanName('x'.repeat(40), 'f')).toHaveLength(NAME_MAX);
    expect(cleanName('   ', 'f')).toBe('f');
    expect(cleanColour('#12345')).toBeNull();
  });
});

describe('the Hands-Free label', () => {
  it('spots a Bluetooth call-profile mic by its label', () => {
    expect(isHandsFreeLabel('Headset (WH-1000XM4 Hands-Free AG Audio)')).toBe(true);
    expect(isHandsFreeLabel('Headset (Galaxy Buds Handsfree)')).toBe(true);
    expect(isHandsFreeLabel('Headset Microphone (HFP)')).toBe(true);
  });

  it('leaves ordinary mics alone', () => {
    expect(isHandsFreeLabel('Microphone (Realtek Audio)')).toBe(false);
    expect(isHandsFreeLabel('Blue Yeti Stereo Microphone')).toBe(false);
    expect(isHandsFreeLabel('')).toBe(false);
  });

  it('says what happens', () => {
    expect(HANDS_FREE_WARNING).toContain('call quality');
  });
});

describe('the Hands-Free label check', () => {
  it('matches Windows headset call-profile labels', () => {
    expect(isHandsFreeLabel('Headset (Foo Buds Hands-Free AG Audio)')).toBe(true);
    expect(isHandsFreeLabel('Headset (BT Handsfree)')).toBe(true);
    expect(isHandsFreeLabel('Headset (hands free)')).toBe(true);
    expect(isHandsFreeLabel('Headset Earphone (HFP)')).toBe(true);
  });

  it('leaves unrelated names alone', () => {
    expect(isHandsFreeLabel('Microphone (USB Audio Device)')).toBe(false);
    expect(isHandsFreeLabel('Microphone Array (Realtek(R) Audio)')).toBe(false);
    expect(isHandsFreeLabel('Headset (AirPods Stereo)')).toBe(false);
    expect(isHandsFreeLabel('Handsome Cam mic')).toBe(false);
    expect(isHandsFreeLabel('')).toBe(false);
  });

  it('also matches a generic speakerphone called hands-free, which is harmless', () => {
    expect(isHandsFreeLabel('Conference Speakerphone Hands-Free')).toBe(true);
  });
});

describe('the leak of A into B', () => {
  const a = { f0: 220, rms: 0.2 };

  it('gates a B frame 6 dB or more under A on A\'s pitch', () => {
    // 0.05 is about 12 dB under 0.2.
    expect(isLeakOfA({ f0: 221, rms: 0.05 }, a)).toBe(true);
    expect(isLeakOfA({ f0: 220 * 2 ** (49 / 1200), rms: 0.05 }, a)).toBe(true);
  });

  it('keeps a B frame less than 6 dB under, louder, or on another pitch', () => {
    expect(isLeakOfA({ f0: 220, rms: 0.12 }, a)).toBe(false);
    expect(isLeakOfA({ f0: 220, rms: 0.3 }, a)).toBe(false);
    expect(isLeakOfA({ f0: 220 * 2 ** (80 / 1200), rms: 0.05 }, a)).toBe(false);
  });

  it('says nothing about unvoiced frames', () => {
    expect(isLeakOfA({ f0: 0, rms: 0.05 }, a)).toBe(false);
    expect(isLeakOfA({ f0: 220, rms: 0.05 }, { f0: 0, rms: 0.2 })).toBe(false);
  });
});
