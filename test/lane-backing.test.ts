/**
 * The backing layer (W0g): the lane's layer order and the colour choice (as
 * data, not pixels), the windowing and lit-key logic with chords and notes
 * that overlap, the shift seam, and the session wiring: notes arrive from the
 * service's answer, the toggle hides them without forgetting, and the key
 * shift moves them with the song.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountKaraokePanel } from '../src/app/panels/karaoke';
import {
  backingColour,
  backingWindow,
  laneBackingOf,
  litBackingKeys,
  scrollingLayers,
  transposeBacking,
} from '../src/render/lane-backing';
import type { LaneStyle } from '../src/render/lane-style';
import { ServiceClient, settledThrough } from '../src/service/client';
import type { SongStatus, SongSteps, StepState, StepStatus } from '../src/service/types';
import { isBackingNotes } from '../src/service/wire';
import { StateStore } from '../src/app/state';
import { byTestId, fakeHost } from './fake-dom';
import { fakeLane, makeHarness, songInfo } from './session-harness';

const note = (onset_s: number, offset_s: number, midi: number) => ({ onset_s, offset_s, midi, velocity: 80 });

// A C major chord held for two seconds, then an F major chord, with a long
// pedal note under both that ends after every other note does.
const CHORDS = [
  note(0, 2, 48),
  note(0, 2, 60),
  note(0, 2, 64),
  note(0, 2, 67),
  note(2, 4, 53),
  note(2, 4, 57),
  note(2, 4, 60),
  note(0.5, 9, 36),
];

describe('the lane layers', () => {
  it('paints the backing first, under the melody, the free bands and the ribbons', () => {
    expect(scrollingLayers({ backing: true })).toEqual([
      'backing',
      'reference',
      'free',
      'ribbon-0',
      'ribbon-1',
      'grades-0',
      'grades-1',
    ]);
  });

  it('has no backing layer when there is no backing to show', () => {
    expect(scrollingLayers({ backing: false })).not.toContain('backing');
    expect(scrollingLayers({ backing: false })[0]).toBe('reference');
  });

  it('draws the backing in the neutral grey, never a melody or grade colour', () => {
    const style = {
      caption: '#888888',
      reference: '#ff00aa',
      hit: '#00ff00',
      okay: '#ffff00',
      miss: '#ff0000',
      free: '#00ffff',
      accent: '#0000ff',
      singers: ['#111111', '#222222'],
    } as unknown as LaneStyle;
    const colour = backingColour(style);
    expect(colour).toBe(style.caption);
    for (const other of [style.reference, style.hit, style.okay, style.miss, style.free, style.accent, ...style.singers]) {
      expect(colour).not.toBe(other);
    }
  });
});

describe('laneBackingOf', () => {
  it('is null for no notes, and sorts by onset then pitch with the longest length', () => {
    expect(laneBackingOf([])).toBeNull();
    const backing = laneBackingOf([note(1, 2, 62), note(0, 1, 64), note(0, 3, 60)]);
    expect(backing?.notes.map((n) => [n.onsetS, n.midi])).toEqual([
      [0, 60],
      [0, 64],
      [1, 62],
    ]);
    expect(backing?.maxDurS).toBe(3);
  });
});

describe('backingWindow', () => {
  const backing = laneBackingOf(CHORDS)!;

  it('finds a note that began long before the window and still sounds', () => {
    const inWindow = backingWindow(backing, 6, 7);
    expect(inWindow.map((n) => n.midi)).toEqual([36]);
  });

  it('takes every chord note that overlaps the span, in onset order', () => {
    expect(backingWindow(backing, 1.9, 2.1).map((n) => n.midi)).toEqual([48, 60, 64, 67, 36, 53, 57, 60]);
  });

  it('is empty past the last note', () => {
    expect(backingWindow(backing, 20, 30)).toEqual([]);
  });
});

describe('litBackingKeys', () => {
  const backing = laneBackingOf(CHORDS);

  it('lights every key of a chord at once, ascending', () => {
    expect(litBackingKeys(backing, 0.25)).toEqual([48, 60, 64, 67]);
    expect(litBackingKeys(backing, 1)).toEqual([36, 48, 60, 64, 67]);
  });

  it('changes chord on the boundary: an offset is not still sounding', () => {
    expect(litBackingKeys(backing, 2)).toEqual([36, 53, 57, 60]);
  });

  it('lights a pitch once however many notes share it, and none without notes', () => {
    const doubled = laneBackingOf([note(0, 1, 60), note(0, 2, 60.2)]);
    expect(litBackingKeys(doubled, 0.5)).toEqual([60]);
    expect(litBackingKeys(null, 0.5)).toEqual([]);
    expect(litBackingKeys(backing, 50)).toEqual([]);
  });
});

describe('transposeBacking', () => {
  it('moves every note with the song and keeps the windowing valid', () => {
    const backing = laneBackingOf(CHORDS)!;
    expect(transposeBacking(backing, 0)).toBe(backing);
    const up = transposeBacking(backing, 2);
    expect(litBackingKeys(up, 0.25)).toEqual([50, 62, 66, 69]);
    expect(up.maxDurS).toBe(backing.maxDurS);
  });
});

describe('isBackingNotes', () => {
  it('accepts the service body and turns away a malformed one', () => {
    expect(isBackingNotes({ notes: [note(0, 1, 60)] })).toBe(true);
    expect(isBackingNotes({ notes: [] })).toBe(true);
    expect(isBackingNotes({ notes: [{ onset_s: 0, offset_s: 1 }] })).toBe(false);
    expect(isBackingNotes({ notes: [note(2, 1, 60)] })).toBe(false);
    expect(isBackingNotes({})).toBe(false);
    expect(isBackingNotes(null)).toBe(false);
  });
});

describe('the session and the backing notes', () => {
  beforeEach(() => {
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  function ready() {
    const h = makeHarness();
    h.player.setSong(songInfo());
    const lane = fakeLane();
    const setBacking = vi.fn();
    const setBackingShown = vi.fn();
    h.core.lane = Object.assign(lane, { setBacking, setBackingShown });
    return { h, lane, setBacking, setBackingShown };
  }

  it('shows notes on the lane with the toggle on, and says so in the state', () => {
    const { h, setBacking, setBackingShown } = ready();
    h.core.backing.set({ notes: CHORDS });
    expect(h.store.state.backing).toEqual({ phase: 'ready', notes: CHORDS.length, shown: true });
    const shown = setBacking.mock.lastCall?.[0] as ReturnType<typeof laneBackingOf>;
    expect(shown?.notes).toHaveLength(CHORDS.length);
    expect(setBackingShown).toHaveBeenLastCalledWith(true);
  });

  it('hides without forgetting, and brings the same notes back', () => {
    const { h, setBacking, setBackingShown } = ready();
    h.core.backing.set({ notes: CHORDS });
    h.core.backing.setShown(false);
    expect(setBackingShown).toHaveBeenLastCalledWith(false);
    expect(h.store.state.backing.shown).toBe(false);
    expect(h.core.backing.notesForExport()).toHaveLength(CHORDS.length);
    h.core.backing.setShown(true);
    expect(setBackingShown).toHaveBeenLastCalledWith(true);
    expect(setBacking).toHaveBeenCalledTimes(1);
  });

  it('applies the key shift to the lane and the export, like the melody', async () => {
    const { h, setBacking } = ready();
    h.core.backing.set({ notes: CHORDS });
    h.core.keys.setShift(2);
    await settle();
    const shown = setBacking.mock.lastCall?.[0] as NonNullable<ReturnType<typeof laneBackingOf>>;
    expect(litBackingKeys(shown, 0.25)).toEqual([50, 62, 66, 69]);
    expect(h.core.backing.notesForExport()?.map((n) => n.midi).slice(0, 4)).toEqual([50, 62, 66, 69]);
    h.core.keys.reset();
    await settle();
    expect(h.core.backing.notesForExport()?.[0].midi).toBe(48);
  });

  it('forgets the notes for a new song and turns the toggle back on', () => {
    const { h, setBacking } = ready();
    h.core.backing.set({ notes: CHORDS });
    h.core.backing.setShown(false);
    h.core.backing.reset();
    expect(h.store.state.backing).toEqual({ phase: 'none', notes: 0, shown: true });
    expect(setBacking).toHaveBeenLastCalledWith(null);
    expect(h.core.backing.notesForExport()).toBeNull();
  });

  it('works with a lane that has no backing methods', () => {
    const h = makeHarness();
    h.core.lane = fakeLane();
    expect(() => h.core.backing.set({ notes: CHORDS })).not.toThrow();
  });
});

describe('the backing toggle in the karaoke panel', () => {
  function mount() {
    const store = new StateStore();
    const session = {
      setMix: vi.fn(),
      setGuideLevel: vi.fn(),
      melodyForExport: vi.fn(() => null),
      setBackingShown: vi.fn(),
    };
    const host = fakeHost();
    mountKaraokePanel(host, { store, session });
    return { store, session, host };
  }

  it('is hidden without backing and on when notes arrive', () => {
    const { store, host } = mount();
    expect(byTestId(host, 'backing').hidden).toBe(true);
    store.patch({ backing: { phase: 'ready', notes: 12, shown: true } });
    expect(byTestId(host, 'backing').hidden).toBe(false);
    expect(byTestId(host, 'backing-toggle').checked).toBe(true);
  });

  it('tells the session when it is switched and follows the state', () => {
    const { store, session, host } = mount();
    store.patch({ backing: { phase: 'ready', notes: 12, shown: true } });
    const box = byTestId(host, 'backing-toggle');
    box.checked = false;
    box.fire('change');
    expect(session.setBackingShown).toHaveBeenCalledWith(false);
    store.patch({ backing: { phase: 'ready', notes: 12, shown: true } });
    expect(box.checked).toBe(true);
  });
});

describe('settledThrough backing', () => {
  const step = (state: StepState): StepStatus => ({ state, progress: state === 'done' ? 1 : 0 });
  const song = (steps: Partial<SongSteps>): SongStatus => ({
    song_id: 'x',
    source: 'file',
    steps: {
      fetch: step('skipped'),
      separation: step('done'),
      key: step('done'),
      reference: step('done'),
      lyrics: step('skipped'),
      ...steps,
    },
  });

  it('waits for a queued or running backing step after the melody', () => {
    expect(settledThrough(song({ backing: step('queued') }), 'backing')).toBe(false);
    expect(settledThrough(song({ backing: step('running') }), 'backing')).toBe(false);
  });

  it('is settled when the backing is done, skipped or failed', () => {
    for (const state of ['done', 'skipped', 'failed'] as const) {
      expect(settledThrough(song({ backing: step(state) }), 'backing')).toBe(true);
    }
  });

  it('has nothing to wait for from a service with no backing step', () => {
    expect(settledThrough(song({}), 'backing')).toBe(true);
  });

  it('still waits for the melody first, and gives up when separation failed', () => {
    expect(settledThrough(song({ reference: step('running'), backing: step('done') }), 'backing')).toBe(false);
    expect(settledThrough(song({ separation: step('failed'), reference: step('queued') }), 'backing')).toBe(true);
  });

  it('leaves the other through targets as they were', () => {
    expect(settledThrough(song({ backing: step('running') }), 'reference')).toBe(true);
  });
});