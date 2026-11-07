/**
 * Tests for range and key (W6b): the range estimate and the suggested shift
 * on synthetic spans with known answers, the transposition seam (notes, lane
 * reference, scoring reference, key map, MIDI), the per-song persistence, and
 * the controller that ties them to playback and the lane.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampShift,
  estimateRange,
  melodyRange,
  suggestShift,
  transposeKey,
  transposeLane,
  transposeNotes,
  transposeScore,
} from '../src/analysis/key-shift';
import { buildScoreReference } from '../src/analysis/score';
import { loadShift, offeredSuggestion, saveShift, shiftLabel, whyNoShift } from '../src/app/key-shift';
import { memoryStore } from '../src/app/storage';
import { encodeMelodyMidi } from '../src/audio/midi-file';
import { ServiceClient } from '../src/service/client';
import type { KeyMap } from '../src/service/types';
import { fakeLane, makeHarness, songInfo } from './session-harness';

describe('estimateRange', () => {
  const span = (lowMidi: number, highMidi: number) => ({ lowMidi, highMidi });

  it('needs three takes with a range', () => {
    expect(estimateRange([span(50, 62), span(51, 63), null])).toBeNull();
    expect(estimateRange([])).toBeNull();
  });

  it('is the median of the lows and the median of the highs', () => {
    const r = estimateRange([span(50, 62), span(52, 66), span(48, 60), span(60, 80)]);
    expect(r).toEqual({ lowMidi: 51, highMidi: 64, takes: 4 });
  });

  it('shrugs off one odd take', () => {
    const r = estimateRange([span(50, 62), span(51, 63), span(30, 90)]);
    expect(r?.lowMidi).toBe(50);
    expect(r?.highMidi).toBe(63);
  });

  it('reads only the newest eight takes that have a range', () => {
    const newest = Array.from({ length: 8 }, () => span(50, 60));
    const r = estimateRange([null, ...newest, span(10, 20), span(10, 20)]);
    expect(r).toEqual({ lowMidi: 50, highMidi: 60, takes: 8 });
  });
});

describe('suggestShift', () => {
  const melody = { lowMidi: 60, highMidi: 72 };

  it('is null without a melody or a band', () => {
    expect(suggestShift(null, { lowMidi: 50, highMidi: 62 })).toBeNull();
    expect(suggestShift(melody, null)).toBeNull();
  });

  it('centres the melody in the band', () => {
    // Melody centre 66, band centre 60: down 6.
    expect(suggestShift(melody, { lowMidi: 54, highMidi: 66 })).toBe(-6);
    // Band centre 68: up 2.
    expect(suggestShift(melody, { lowMidi: 62, highMidi: 74 })).toBe(2);
    expect(suggestShift(melody, { lowMidi: 60, highMidi: 72 })).toBe(0);
  });

  it('holds the shift to -6..+6', () => {
    expect(suggestShift(melody, { lowMidi: 20, highMidi: 30 })).toBe(-6);
    expect(suggestShift(melody, { lowMidi: 90, highMidi: 100 })).toBe(6);
  });

  it('takes the smaller move on a tie', () => {
    // Melody centre 66; band centre 66.5: shifts 0 and +1 are both 0.5 away.
    expect(suggestShift(melody, { lowMidi: 60.5, highMidi: 72.5 })).toBe(0);
    // Centre 65.5: 0 and -1 tie again.
    expect(suggestShift(melody, { lowMidi: 59.5, highMidi: 71.5 })).toBe(0);
  });
});

describe('melodyRange and clampShift', () => {
  it('is the p10 to p90 of the notes', () => {
    const notes = Array.from({ length: 11 }, (_, i) => ({ midi: 60 + i }));
    expect(melodyRange(notes)).toEqual({ lowMidi: 61, highMidi: 69 });
    expect(melodyRange([])).toBeNull();
    expect(melodyRange(undefined)).toBeNull();
  });

  it('rounds, clamps and ignores NaN', () => {
    expect(clampShift(2.4)).toBe(2);
    expect(clampShift(9)).toBe(6);
    expect(clampShift(-9)).toBe(-6);
    expect(clampShift(Number.NaN)).toBe(0);
  });
});

describe('the transposition seam', () => {
  const lane = {
    hopS: 0.01,
    t0S: 0,
    f0Hz: [0, 440, 220],
    notes: [
      { onsetS: 0, offsetS: 1, midi: 69 },
      { onsetS: 1, offsetS: 2, midi: 57 },
    ],
    unpitchedS: [[2, 3]] as Array<readonly [number, number]>,
  };

  it('moves the lane notes and the contour, and leaves the rest', () => {
    const up = transposeLane(lane, 12);
    expect(up.notes?.map((n) => n.midi)).toEqual([81, 69]);
    expect(Array.from(up.f0Hz)).toEqual([0, 880, 440]);
    expect(up.unpitchedS).toBe(lane.unpitchedS);
    expect(lane.notes[0].midi).toBe(69);
    expect(transposeLane(lane, 0)).toBe(lane);
  });

  it('moves a contour by the exact ratio for a semitone', () => {
    const [hz] = Array.from(transposeLane({ ...lane, f0Hz: [440] }, 3).f0Hz);
    expect(hz).toBeCloseTo(440 * 2 ** (3 / 12), 9);
  });

  it('moves the scoring reference with its range', () => {
    const ref = buildScoreReference([{ onsetS: 0, offsetS: 1, midi: 60 }], [], { lowMidi: 55, highMidi: 65 });
    const moved = transposeScore(ref, -2);
    expect(moved.notes[0].midi).toBe(58);
    expect(moved.lowMidi).toBe(53);
    expect(moved.highMidi).toBe(63);
    expect(moved.highAtS).toBe(ref.highAtS);
  });

  it('moves each tonic, wrapping the octave, and leaves unclear stretches and the tuning', () => {
    const key: KeyMap = {
      tuning_cents: 12,
      segments: [
        { start_s: 0, end_s: 10, tonic: 10, mode: 'major', confidence: 0.9 },
        { start_s: 10, end_s: 20, tonic: null, mode: null, confidence: 0 },
        { start_s: 20, end_s: 30, tonic: 1, mode: 'minor', confidence: 0.8 },
      ],
    };
    const moved = transposeKey(key, 3);
    expect(moved.segments.map((s) => s.tonic)).toEqual([1, null, 4]);
    expect(moved.tuning_cents).toBe(12);
    expect(transposeKey(key, -3).segments.map((s) => s.tonic)).toEqual([7, null, 10]);
  });

  it('puts the shifted notes into the MIDI export', () => {
    const notes = [{ onsetS: 0, offsetS: 0.5, midi: 60 }];
    const plain = encodeMelodyMidi(notes);
    const moved = encodeMelodyMidi(transposeNotes(notes, 2));
    const keys = (bytes: Uint8Array): number[] => {
      const out: number[] = [];
      for (let i = 0; i < bytes.length - 2; i++) if (bytes[i] === 0x90 && bytes[i + 2] === 96) out.push(bytes[i + 1]);
      return out;
    };
    expect(keys(plain)).toEqual([60]);
    expect(keys(moved)).toEqual([62]);
  });
});

describe('per-song persistence', () => {
  it('saves and loads a shift by the song hash, and forgets zero', () => {
    const store = memoryStore();
    saveShift(store, 'a', 3);
    saveShift(store, 'b', -2);
    expect(loadShift(store, 'a')).toBe(3);
    expect(loadShift(store, 'b')).toBe(-2);
    expect(loadShift(store, 'c')).toBe(0);
    saveShift(store, 'a', 0);
    expect(store.get('shift.a')).toBeNull();
  });

  it('never trusts what it finds', () => {
    const store = memoryStore();
    store.set('shift.x', 'banana');
    store.set('shift.y', '40');
    expect(loadShift(store, 'x')).toBe(0);
    expect(loadShift(store, 'y')).toBe(6);
  });
});

describe('the words', () => {
  it('labels a shift with its sign', () => {
    expect(shiftLabel(2)).toBe('+2');
    expect(shiftLabel(-3)).toBe('-3');
    expect(shiftLabel(0)).toBe('0');
  });

  it('offers a suggestion only when it would change something', () => {
    const base = { shift: 0, suggested: 2, canShift: true, band: null, bandTakes: 0 };
    expect(offeredSuggestion(base)).toBe(2);
    expect(offeredSuggestion({ ...base, shift: 2 })).toBeNull();
    expect(offeredSuggestion({ ...base, suggested: 0 })).toBeNull();
    expect(offeredSuggestion({ ...base, suggested: null })).toBeNull();
  });

  it('says why a YouTube song cannot move, and nothing when it can', () => {
    expect(whyNoShift(true)).toBe('');
    expect(whyNoShift(false)).toContain("YouTube's own player");
  });
});

describe('the key controller', () => {
  beforeEach(() => {
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NOTES = [
    { onsetS: 0, offsetS: 1, midi: 60 },
    { onsetS: 1, offsetS: 2, midi: 64 },
  ];
  const LANE = { hopS: 0.01, t0S: 0, f0Hz: [261.63], notes: NOTES };

  async function ready() {
    const h = makeHarness();
    h.player.setSong(songInfo());
    const lane = fakeLane();
    h.core.lane = lane;
    const score = buildScoreReference(NOTES, [], { lowMidi: 60, highMidi: 64 });
    (h.core.stems as unknown as { showReference: (...a: unknown[]) => void }).showReference(
      LANE,
      { phase: 'ready', notes: 2, message: '' },
      score,
    );
    await settle();
    return { h, lane };
  }

  /** Lets the controller's queued work run. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it('moves playback, the lane, scoring and the export together', async () => {
    const { h, lane } = await ready();
    h.core.keys.setShift(2);
    await settle();
    expect(h.player.setShift).toHaveBeenLastCalledWith(2);
    expect(h.store.state.keyShift.shift).toBe(2);
    expect(h.core.stems.melodyNotes()?.map((n) => n.midi)).toEqual([62, 66]);
    expect(h.core.stems.contour()?.notes?.map((n) => n.midi)).toEqual([62, 66]);
    expect(lane.setReference).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.any(Array) }));
    const shown = lane.setReference.mock.lastCall?.[0] as { notes: Array<{ midi: number }> };
    expect(shown.notes.map((n) => n.midi)).toEqual([62, 66]);
    expect(h.core.keys.score(buildScoreReference(NOTES, [], { lowMidi: 60, highMidi: 64 }))?.notes[0].midi).toBe(62);
    h.core.keys.reset();
    await settle();
    expect(h.core.stems.melodyNotes()?.map((n) => n.midi)).toEqual([60, 64]);
  });

  it('steps by a semitone, stops at six, and keeps the choice for the song', async () => {
    const { h } = await ready();
    for (let i = 0; i < 8; i++) h.core.keys.step(1);
    await settle();
    expect(h.store.state.keyShift.shift).toBe(6);
    expect(loadShiftFor(h)).toBe(6);
    // Another song starts in its own key, and this one comes back as left.
    h.player.setSong(songInfo('other.mp3', 'hash-other'));
    await settle();
    expect(h.store.state.keyShift.shift).toBe(0);
    h.player.setSong(songInfo());
    await settle();
    expect(h.store.state.keyShift.shift).toBe(6);
  });

  it('suggests from the singer\'s range and applies it on request', async () => {
    const { h } = await ready();
    // Three learning takes with a range around G3..D4 (melody sits 60..64).
    const voice = { summary: { range: { lowMidi: 55, highMidi: 62 } } };
    for (let i = 0; i < 3; i++) {
      await h.takeStore.save({
        songHash: `s${i}`,
        songName: 's',
        createdAt: i,
        durationS: 1,
        latencyS: 0,
        sampleRate: 48000,
        frames: [],
        wav: new Blob([]),
        report: { voice } as never,
      });
    }
    await h.core.keys.refreshRange();
    expect(h.store.state.keyShift.band).toEqual({ lowMidi: 55, highMidi: 62 });
    expect(h.store.state.keyShift.suggested).toBe(-3);
    expect(h.core.lane?.setSingerRange).toHaveBeenLastCalledWith(expect.objectContaining({ lowMidi: 55 }));
    h.core.keys.useSuggested();
    await settle();
    expect(h.store.state.keyShift.shift).toBe(-3);
  });

  it('has no band, and says so, until three takes have a range', async () => {
    const { h } = await ready();
    await h.core.keys.refreshRange();
    expect(h.store.state.keyShift.band).toBeNull();
    expect(h.store.state.keyShift.suggested).toBeNull();
  });

  it('does not move a song on the embedded player, and still holds the choice', async () => {
    const { h } = await ready();
    h.core.keys.setShift(2);
    await settle();
    h.store.patch({ clock: 'embed' });
    await settle();
    expect(h.store.state.keyShift.canShift).toBe(false);
    expect(h.store.state.keyShift.shift).toBe(0);
    expect(h.core.stems.melodyNotes()?.map((n) => n.midi)).toEqual([60, 64]);
    h.core.keys.setShift(5);
    await settle();
    expect(h.store.state.keyShift.shift).toBe(0);
    h.store.patch({ clock: 'engine' });
    await settle();
    expect(h.store.state.keyShift.shift).toBe(2);
  });

  it('leaves a take its own shift when it is scored again', async () => {
    const { h } = await ready();
    h.core.keys.setShift(2);
    await settle();
    const ref = buildScoreReference(NOTES, [], { lowMidi: 60, highMidi: 64 });
    expect(h.core.keys.score(ref, 0)?.notes[0].midi).toBe(60);
    expect(h.core.keys.score(ref, 5)?.notes[0].midi).toBe(65);
    expect(h.core.keys.score(ref)?.notes[0].midi).toBe(62);
  });
});

describe('the key while recording and replaying', () => {
  beforeEach(() => {
    vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DELAY = 0.049;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  async function ready() {
    const h = makeHarness();
    h.player.setSong(songInfo());
    h.core.lane = fakeLane();
    h.player.shiftDelayS = DELAY;
    await h.core.input.chooseInput('usb');
    await settle();
    return h;
  }

  /** Records a few frames and returns the first published frame's song time. */
  async function firstFrameT(h: Awaited<ReturnType<typeof ready>>): Promise<number> {
    const times: number[] = [];
    h.core.bus.subscribe(({ frame }) => times.push(frame.t));
    await h.core.takes.toggleRecord();
    h.engine.t = 2;
    h.player.positionS = 2;
    h.tracker.emit({ t: 2, f0: 440, clarity: 0.95, rms: 0.2 });
    return times[0];
  }

  it('offsets the recorder and the frames by the shifter delay only while shifted', async () => {
    const off = await ready();
    // The shifter is not in the graph without a shift.
    off.player.shiftDelayS = 0;
    const tOff = await firstFrameT(off);
    expect(off.recorder.start.mock.lastCall?.[1]).toBeCloseTo(0);
    const on = await ready();
    on.core.keys.setShift(2);
    await settle();
    const tOn = await firstFrameT(on);
    expect(on.recorder.start.mock.lastCall?.[1]).toBeCloseTo(DELAY);
    expect(tOff - tOn).toBeCloseTo(DELAY);
  });

  it('has no offset while shelved (delay 0) or on the embed clock', async () => {
    const h = await ready();
    h.core.keys.setShift(2);
    await settle();
    expect(h.core.songs.embedOffsetNow()).toBeCloseTo(DELAY);
    // A shelved player reports no delay, as the real one does.
    h.player.shiftDelayS = 0;
    expect(h.core.songs.embedOffsetNow()).toBe(0);
    h.store.patch({ clock: 'embed' });
    await settle();
    expect(h.core.songs.embedOffsetNow()).toBe(h.core.songs.active?.clock === 'embed' ? h.core.current.embedOffsetS : 0);
  });

  it('refuses a shift change while recording', async () => {
    const h = await ready();
    await h.core.takes.toggleRecord();
    expect(h.store.state.recording).toBe(true);
    h.core.keys.setShift(3);
    await settle();
    expect(h.player.setShift).not.toHaveBeenCalledWith(3);
    expect(h.store.state.keyShift.shift).toBe(0);
    expect(h.store.state.status.kind).toBe('warn');
  });

  it("replays a take in its own key, the voice placed after the shifter's delay", async () => {
    const h = await ready();
    h.core.keys.setShift(2);
    await settle();
    await h.core.takes.toggleRecord();
    h.engine.t = 1;
    h.player.positionS = 1;
    h.tracker.emit({ t: 1, f0: 440, clarity: 0.95, rms: 0.2 });
    await h.core.takes.toggleRecord();
    const take = await h.takeStore.get(h.store.state.takes[0].id);
    expect(take?.shiftSemitones).toBe(2);
    h.core.keys.setShift(-1);
    await settle();
    h.player.addStem.mockClear();
    await h.core.takes.playTake(h.store.state.takes[0].id);
    expect(h.player.setShift).toHaveBeenLastCalledWith(2);
    expect(h.player.addStem.mock.lastCall?.[2]).toBeCloseTo(DELAY);
    expect(h.store.state.keyShift.shift).toBe(2);
    h.core.takes.stopTake();
    await settle();
    expect(h.player.setShift).toHaveBeenLastCalledWith(-1);
    expect(h.store.state.keyShift.shift).toBe(-1);
  });
});

function loadShiftFor(h: ReturnType<typeof makeHarness>): number {
  return loadShift(h.settingsStore, 'hash-song');
}
