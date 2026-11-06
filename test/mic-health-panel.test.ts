/**
 * Tests for the words and the mark under the mic meter
 * (src/app/panels/mic-health.ts): which line each state gets, the bleed line
 * only in speaker mode, and where the floor mark sits.
 */
import { describe, expect, it } from 'vitest';
import {
  BLEED_LINE,
  CANNOT_CHECK_LINE,
  describeMicHealth,
  floorMarkFraction,
  HEARING_LINE,
  NOTHING_LINE,
  QUIET_LINE,
} from '../src/app/panels/mic-health';
import { initialState } from '../src/app/state';
import type { InputState } from '../src/app/state';

const open = (p: Partial<InputState>): InputState => ({ ...initialState().input, open: true, ...p });

describe('describeMicHealth', () => {
  it('says nothing with no mic open', () => {
    expect(describeMicHealth({ ...initialState().input, micState: 'hearing' })).toEqual({
      state: '',
      bleed: '',
      bleedKind: 'info',
    });
  });

  it('names each state in plain words', () => {
    expect(describeMicHealth(open({ micState: 'hearing' })).state).toBe(HEARING_LINE);
    expect(describeMicHealth(open({ micState: 'quiet' })).state).toBe(QUIET_LINE);
    expect(describeMicHealth(open({ micState: 'nothing' })).state).toBe(NOTHING_LINE);
  });

  it('warns about the speakers only in speaker mode', () => {
    const suspected = { state: 'suspected', reason: 'measured' } as const;
    const speakers = describeMicHealth(open({ requestedAec: true, bleed: suspected }));
    expect(speakers.bleed).toBe(BLEED_LINE);
    expect(speakers.bleedKind).toBe('warn');
    expect(describeMicHealth(open({ requestedAec: false, bleed: suspected })).bleed).toBe('');
  });

  it('says it cannot check when there is no melody, in speaker mode', () => {
    const view = describeMicHealth(open({ requestedAec: true, bleed: { state: 'unknown', reason: 'no_reference' } }));
    expect(view.bleed).toBe(CANNOT_CHECK_LINE);
    expect(view.bleedKind).toBe('info');
  });

  it('says nothing about bleed while collecting, when ok or when unarmed', () => {
    for (const reason of ['collecting', 'no_vocal', 'off'] as const) {
      const bleed = { state: 'unknown', reason } as const;
      expect(describeMicHealth(open({ requestedAec: true, bleed })).bleed, reason).toBe('');
    }
    const ok = { state: 'ok', reason: 'measured' } as const;
    expect(describeMicHealth(open({ requestedAec: true, bleed: ok })).bleed).toBe('');
  });
});

describe('floorMarkFraction', () => {
  it('is hidden while the floor is not measured', () => {
    expect(floorMarkFraction(-120)).toBeNull();
  });

  it('sits on the meter scale, a little to the right to allow for peak over RMS', () => {
    expect(floorMarkFraction(-33)).toBeCloseTo(0.5, 6);
    expect(floorMarkFraction(-63)).toBe(0);
    expect(floorMarkFraction(5)).toBe(1);
  });
});
