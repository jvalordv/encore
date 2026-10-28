/**
 * Tests for the pure parts of the karaoke track: the level every stem plays at
 * for each mix (checked against known answers, including the stems' gain and a
 * take laid over the song), the wording and switches of the karaoke panel for
 * each phase, and the conversion of the service's melody to the lane's.
 */
import { describe, expect, it } from 'vitest';
import {
  CHECKING_SERVICE_NOTE,
  LOADING_STEMS_NOTE,
  MISSING_SERVICE_NOTE,
  describeKaraoke,
  describeMelody,
  initialKaraoke,
  karaokeLines,
} from '../src/app/karaoke';
import type { KaraokeState } from '../src/app/karaoke';
import { MIX_CHOICES, MIX_LABELS, clampLevel, initialMix, mixLevels } from '../src/app/mix';
import type { MixState } from '../src/app/mix';
import { initialReference, laneReferenceOf } from '../src/app/reference';
import type { ReferenceState } from '../src/app/reference';
import type { Reference, SongSteps, StepState, StepStatus } from '../src/service/types';

function step(state: StepState = 'queued', progress = 0, extra: Partial<StepStatus> = {}): StepStatus {
  return { state, progress, error: null, detail: null, ...extra };
}

function steps(others: Partial<SongSteps> = {}): SongSteps {
  return {
    fetch: step('skipped'),
    separation: step(),
    reference: step(),
    lyrics: step('running', 0.5),
    ...others,
  };
}

describe('mixLevels', () => {
  it('plays the original at the stems\' level and nothing else in the Original mix', () => {
    expect(mixLevels('original', 0.5, 0.8)).toEqual({ original: 0.8, no_vocals: 0, vocals: 0 });
  });

  it('plays the instrumental at unity and nothing else in the Karaoke mix', () => {
    expect(mixLevels('karaoke', 0.5, 0.8)).toEqual({ original: 0, no_vocals: 1, vocals: 0 });
  });

  it('adds the vocal at the slider\'s level in the guide mix', () => {
    expect(mixLevels('guide', 0.3, 0.8)).toEqual({ original: 0, no_vocals: 1, vocals: 0.3 });
    expect(mixLevels('guide', 0, 1).vocals).toBe(0);
    expect(mixLevels('guide', 1, 1).vocals).toBe(1);
  });

  it('never plays the original and the instrumental together', () => {
    for (const choice of MIX_CHOICES) {
      const levels = mixLevels(choice, 0.5, 0.7);
      expect(levels.original > 0 && levels.no_vocals > 0, choice).toBe(false);
    }
  });

  it('never scales a stem up: a stem gain over 1 or unusable reads as 1', () => {
    expect(mixLevels('original', 0.5, 1.4).original).toBe(1);
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(mixLevels('original', 0.5, bad).original, String(bad)).toBe(1);
    }
  });

  it('lowers the whole mix by the duck while a take plays over it', () => {
    expect(mixLevels('original', 0.5, 0.8, 0.6).original).toBeCloseTo(0.48, 9);
    expect(mixLevels('karaoke', 0.5, 0.8, 0.6)).toEqual({ original: 0, no_vocals: 0.6, vocals: 0 });
    const guide = mixLevels('guide', 0.5, 0.8, 0.6);
    expect(guide.no_vocals).toBe(0.6);
    expect(guide.vocals).toBeCloseTo(0.3, 9);
  });

  it('keeps every level inside 0 to 1, whatever the slider reports', () => {
    expect(mixLevels('guide', 7, 1).vocals).toBe(1);
    expect(mixLevels('guide', -2, 1).vocals).toBe(0);
    expect(mixLevels('guide', NaN, 1).vocals).toBe(0);
  });
});

describe('clampLevel, initialMix and the labels', () => {
  it('clamps to 0..1 and reads NaN as 0', () => {
    expect([clampLevel(-1), clampLevel(0.4), clampLevel(3), clampLevel(NaN)]).toEqual([0, 0.4, 1, 0]);
  });

  it('starts a song on the original with no stems, at the saved guide level', () => {
    expect(initialMix(0.25)).toEqual({ available: false, choice: 'original', guideLevel: 0.25 });
  });

  it('names every choice', () => {
    expect(MIX_CHOICES.map((c) => MIX_LABELS[c])).toEqual(['Original', 'Karaoke', 'Karaoke + vocal guide']);
  });
});

describe('karaokeLines', () => {
  it('says nothing before the service has spoken', () => {
    expect(karaokeLines(null)).toEqual([]);
  });

  it('shows the separation and the melody while they wait or run, and never the lyrics', () => {
    expect(karaokeLines(steps())).toEqual(['Separating the vocal: waiting', 'Reading the melody: waiting']);
    expect(karaokeLines(steps({ separation: step('running', 0.456) }))).toEqual([
      'Separating the vocal 46%',
      'Reading the melody: waiting',
    ]);
  });

  it('leaves out a step that is done, skipped or failed: the notes speak for those', () => {
    const all = steps({
      separation: step('done', 1),
      reference: step('skipped', 0, { detail: 'No singing found' }),
    });
    expect(karaokeLines(all)).toEqual([]);
    expect(karaokeLines(steps({ separation: step('failed', 0, { error: 'x' }) }))).toEqual([
      'Reading the melody: waiting',
    ]);
  });
});

describe('describeMelody', () => {
  const state = (fields: Partial<ReferenceState>): ReferenceState => ({ ...initialReference(), ...fields });

  it('counts the target notes, in the singular too', () => {
    expect(describeMelody(state({ phase: 'ready', notes: 42 }))).toBe('Melody: 42 target notes on the lane.');
    expect(describeMelody(state({ phase: 'ready', notes: 1 }))).toBe('Melody: 1 target note on the lane.');
  });

  it('gives the service\'s reason for a melody that is not there', () => {
    expect(describeMelody(state({ phase: 'skipped', message: 'No singing found in this track.' }))).toBe(
      'Melody skipped: No singing found in this track.',
    );
    expect(describeMelody(state({ phase: 'failed', message: 'Out of memory' }))).toBe(
      'Melody not available: Out of memory',
    );
  });

  it('says nothing while there is nothing to say', () => {
    expect(describeMelody(state({ phase: 'none' }))).toBe('');
  });
});

describe('describeKaraoke', () => {
  const mix = (fields: Partial<MixState> = {}): MixState => ({ ...initialMix(0.5), ...fields });
  const karaoke = (fields: Partial<KaraokeState>): KaraokeState => ({ ...initialKaraoke(), ...fields });
  const none = initialReference();

  it('is hidden with no song to make a track for', () => {
    expect(describeKaraoke(initialKaraoke(), none, mix())).toMatchObject({ visible: false, lines: [], note: '' });
  });

  it('says only that it is checking the service, with no mix on show', () => {
    expect(describeKaraoke(karaoke({ phase: 'checking' }), none, mix())).toMatchObject({
      visible: true,
      note: CHECKING_SERVICE_NOTE,
      mixVisible: false,
    });
  });

  it('gives one plain line when the service is away, and no mix', () => {
    const view = describeKaraoke(karaoke({ phase: 'unavailable' }), none, mix());
    expect(view).toMatchObject({ visible: true, lines: [], note: MISSING_SERVICE_NOTE, mixVisible: false });
    expect(MISSING_SERVICE_NOTE).toMatch(/^No karaoke track or melody without the service\./);
  });

  it('shows the upload at its whole percentage, with the mix waiting', () => {
    const view = describeKaraoke(karaoke({ phase: 'uploading', uploadProgress: 0.456 }), none, mix());
    expect(view.lines).toEqual(['Sending the song to the service 46%']);
    expect(view).toMatchObject({ mixVisible: true, mixEnabled: false });
    expect(describeKaraoke(karaoke({ phase: 'uploading', uploadProgress: 7 }), none, mix()).lines[0]).toMatch(/100%$/);
    expect(describeKaraoke(karaoke({ phase: 'uploading', uploadProgress: NaN }), none, mix()).lines[0]).toMatch(/ 0%$/);
  });

  it('shows the service\'s steps while it works and while the stems load', () => {
    const working = karaoke({ phase: 'preparing', steps: steps({ separation: step('running', 0.5) }) });
    expect(describeKaraoke(working, none, mix()).lines).toEqual([
      'Separating the vocal 50%',
      'Reading the melody: waiting',
    ]);
    const loading = karaoke({ phase: 'loading', steps: steps({ separation: step('done', 1) }) });
    expect(describeKaraoke(loading, none, mix())).toMatchObject({
      lines: ['Reading the melody: waiting'],
      note: LOADING_STEMS_NOTE,
    });
  });

  it('enables the mix once the stems are in, with the melody line beside it', () => {
    const ready = karaoke({ phase: 'ready', steps: steps({ separation: step('done', 1), reference: step('done', 1) }) });
    const melody: ReferenceState = { phase: 'ready', notes: 3, message: '' };
    const view = describeKaraoke(ready, melody, mix({ available: true, choice: 'karaoke' }));
    expect(view).toMatchObject({
      lines: [],
      melody: 'Melody: 3 target notes on the lane.',
      mixVisible: true,
      mixEnabled: true,
    });
  });

  it('shows a skipped melody\'s reason in the panel', () => {
    const skipped: ReferenceState = { phase: 'skipped', notes: 0, message: 'No singing found in this track.' };
    const view = describeKaraoke(karaoke({ phase: 'ready' }), skipped, mix({ available: true }));
    expect(view.melody).toBe('Melody skipped: No singing found in this track.');
  });

  it('gives the reason a track failed and keeps the mix away', () => {
    const view = describeKaraoke(karaoke({ phase: 'failed', message: 'Separating the vocal failed: no GPU' }), none, mix());
    expect(view).toMatchObject({ note: 'Separating the vocal failed: no GPU', mixVisible: false, mixEnabled: false });
  });

  it('keeps the mix on show when a later step fails after the stems are in', () => {
    const failed = karaoke({ phase: 'failed', message: 'The service stopped answering.' });
    const view = describeKaraoke(failed, none, mix({ available: true, choice: 'karaoke' }));
    expect(view).toMatchObject({
      note: 'The service stopped answering.',
      mixVisible: true,
      mixEnabled: true,
    });
  });
});

describe('laneReferenceOf', () => {
  const reference: Reference = {
    contour: { hop_s: 0.01, t0_s: 0.5, f0_hz: [0, 220, 220, 0], confidence: [0, 1, 1, 0] },
    notes: [
      { onset_s: 3, offset_s: 4, midi: 62, cents_mean: 0, cents_std: 0, scoop_cents: 0 },
      { onset_s: 1, offset_s: 2, midi: 57, cents_mean: 0, cents_std: 0, scoop_cents: 0 },
    ],
    range: { low_midi: 57, high_midi: 62 },
    unpitched_regions: [
      [5, 6],
      [2.5, 2.8],
    ],
  };

  it('carries the contour as it is', () => {
    const lane = laneReferenceOf(reference);
    expect(lane.hopS).toBe(0.01);
    expect(lane.t0S).toBe(0.5);
    expect(lane.f0Hz).toEqual([0, 220, 220, 0]);
  });

  it('renames the notes and puts them, and the unpitched regions, in time order', () => {
    const lane = laneReferenceOf(reference);
    expect(lane.notes).toEqual([
      { onsetS: 1, offsetS: 2, midi: 57 },
      { onsetS: 3, offsetS: 4, midi: 62 },
    ]);
    expect(lane.unpitchedS).toEqual([
      [2.5, 2.8],
      [5, 6],
    ]);
  });

  it('does not change the reference it was given', () => {
    laneReferenceOf(reference);
    expect(reference.notes[0].onset_s).toBe(3);
    expect(reference.unpitched_regions[0]).toEqual([5, 6]);
  });
});
