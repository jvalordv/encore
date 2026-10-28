/**
 * Controller tests for the two scoring styles on the fake-parts harness: the
 * setting (kept, and clearing the lane's old grades), the live grades in Open
 * and inside free phrases, the report an Open take gets (a karaoke track and a
 * song with no melody included), and the phrases marked free: kept per song,
 * drawn as bands in learning mode only, and re-scoring a take from the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScoreReference } from '../src/analysis/score';
import { loadFreePhrases } from '../src/app/free-store';
import { openReport } from '../src/app/learning';
import { loadSettings } from '../src/app/settings';
import { ServiceClient } from '../src/service/client';
import type { KeyMap } from '../src/service/types';
import { fakeLane, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Two phrases: A4 from 1.0 to 1.2 s (the one the takes sing) and B4 from 3.0 to 3.2 s. */
const TWO = buildScoreReference(
  [
    { onsetS: 1, offsetS: 1.2, midi: 69 },
    { onsetS: 3, offsetS: 3.2, midi: 71 },
  ],
  [],
  { lowMidi: 69, highMidi: 71 },
);

/** C major over the whole song, as the service would report it. */
const C_MAJOR: KeyMap = {
  tuning_cents: 0,
  segments: [{ start_s: 0, end_s: 60, tonic: 0, mode: 'major', confidence: 0.9 }],
};
const KEY_READY = { phase: 'ready', message: '' } as const;
const KARAOKE_SKIP = { phase: 'skipped', notes: 0, message: 'No singing found: only 3%.' } as const;

/** Hz of the note `semis` semitones above A4. */
const hz = (semis: number): number => 440 * 2 ** (semis / 12);

async function ready(saved?: Record<string, unknown>) {
  const h = makeHarness(saved);
  h.player.setSong(songInfo());
  const lane = fakeLane();
  h.core.lane = lane;
  await h.core.input.chooseInput('usb');
  return { h, lane };
}

function sing(h: Harness, t: number, f0: number): void {
  h.engine.t = t;
  h.player.positionS = t;
  h.tracker.emit({ t, f0, clarity: 0.95, rms: 0.2 });
}

/** Sings 20 frames of `f0` from 1.0 s and saves the take. */
async function recordTake(h: Harness, f0: number): Promise<void> {
  await h.core.takes.toggleRecord();
  for (let i = 0; i < 20; i++) sing(h, 1 + i * 0.01, f0);
  await h.core.takes.toggleRecord();
}

const lastGrade = (lane: ReturnType<typeof fakeLane>) => lane.pushFrame.mock.calls.at(-1)?.[0].grade;

describe('the scoring style', () => {
  it('starts Strict, and switches, remembers it and clears the lane\'s old grades', async () => {
    const { h, lane } = await ready({ mode: 'learning' });
    expect(h.store.state.scoring).toBe('strict');
    h.core.scoring.setScoring('open');
    expect(h.store.state.scoring).toBe('open');
    expect(loadSettings(h.settingsStore).scoring).toBe('open');
    expect(lane.clearFrames).toHaveBeenCalledTimes(1);
    h.core.scoring.setScoring('open');
    expect(lane.clearFrames).toHaveBeenCalledTimes(1);
    h.core.scoring.setScoring('strict');
    expect(loadSettings(h.settingsStore).scoring).toBe('strict');
  });

  it('comes back as it was saved', () => {
    const h = makeHarness({ mode: 'learning', scoring: 'open' });
    expect(h.store.state.scoring).toBe('open');
    expect(h.core.current.scoring).toBe('open');
  });

  it('scores nothing in karaoke mode, whatever the style', async () => {
    const { h, lane } = await ready({ scoring: 'open' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.setKey(C_MAJOR);
    h.core.playback.play();
    sing(h, 1.05, hz(12));
    sing(h, 2, hz(4));
    for (const [frame] of lane.pushFrame.mock.calls) expect('grade' in frame).toBe(false);
    await recordTake(h, 440);
    expect('report' in h.store.state.takes[0]).toBe(false);
  });
});

describe('Open: grading frames for the lane', () => {
  async function playing() {
    const { h, lane } = await ready({ mode: 'learning', scoring: 'open' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.setKey(C_MAJOR, KEY_READY);
    h.core.playback.play();
    return { h, lane };
  }

  it('grades the melody note at any octave with the wider windows', async () => {
    const { h, lane } = await playing();
    sing(h, 1.05, 880);
    expect(lastGrade(lane)).toBe('hit');
    sing(h, 1.06, hz(0.8));
    expect(lastGrade(lane)).toBe('okay');
  });

  it('paints freestyle free, and a note far from the key a miss', async () => {
    const { h, lane } = await playing();
    // 2 s is between the phrases. D5 is in C major; C#5 is not.
    sing(h, 2, hz(5));
    expect(lastGrade(lane)).toBe('free');
    sing(h, 2.01, hz(4));
    expect(lastGrade(lane)).toBe('miss');
  });

  it('grades a frame with no key as free, never as a miss', async () => {
    const { h, lane } = await playing();
    h.core.scoring.setKey(null);
    sing(h, 2, hz(4));
    expect(lastGrade(lane)).toBe('free');
  });

  it('scores a karaoke track, which Strict leaves alone, as freestyle', async () => {
    const { h, lane } = await playing();
    h.store.patch({ reference: KARAOKE_SKIP });
    sing(h, 1.05, hz(4));
    expect(lastGrade(lane)).toBe('miss');
    sing(h, 1.06, hz(5));
    expect(lastGrade(lane)).toBe('free');
  });
});

describe('Open: the report of a take', () => {
  it('has the share on the melody and a freestyle block, and its card opens', async () => {
    const { h } = await ready({ mode: 'learning', scoring: 'open' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.setKey(C_MAJOR, KEY_READY);
    await recordTake(h, 880);
    const report = h.store.state.takes[0].report;
    expect(report).toMatchObject({ style: 'open', melodyShare: 1, notesSung: 1 });
    expect(report?.freestyle).toMatchObject({ inKey: 0, offKey: 0 });
    expect(openReport(h.store.state)?.take.id).toBe(h.store.state.takes[0].id);
  });

  it('scores a karaoke track on its key where Strict would not, and shows the card', async () => {
    const { h } = await ready({ mode: 'learning', scoring: 'open' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.setKey(C_MAJOR, KEY_READY);
    h.store.patch({ reference: KARAOKE_SKIP });
    await recordTake(h, hz(5));
    const report = h.store.state.takes[0].report;
    expect(report).toMatchObject({ style: 'open', noMelody: true, melodyShare: 0 });
    expect(report?.freestyle).toMatchObject({ inKey: 1, offKey: 0, keyStatus: 'clear' });
    expect(openReport(h.store.state)).not.toBeNull();
  });

  it('scores a song with no melody at all as freestyle, and says the key is missing', async () => {
    const { h } = await ready({ mode: 'learning', scoring: 'open' });
    await recordTake(h, 440);
    expect(h.store.state.takes[0].report).toMatchObject({ noMelody: true });
    expect(h.store.state.takes[0].report?.freestyle).toMatchObject({ unclear: 1, keyStatus: 'none' });
  });

  it('is what Strict makes of the same singing, without freestyle: a miss', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    await recordTake(h, hz(5));
    const report = h.store.state.takes[0].report;
    expect(report?.style).toBe('strict');
    expect(report?.freestyle).toBeUndefined();
    expect(report?.inTuneRate).toBe(0);
  });
});

describe('free phrases', () => {
  const lastBands = (lane: ReturnType<typeof fakeLane>) => lane.setFreePhrases.mock.calls.at(-1)?.[0];

  it('are marked and unmarked from the lane, kept for the song, and drawn as bands', async () => {
    const { h, lane } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.togglePhrase([1, 1.2]);
    expect(h.store.state.freePhrases).toEqual([[1, 1.2]]);
    expect(loadFreePhrases(h.settingsStore, 'hash-song')).toEqual([[1, 1.2]]);
    expect(lastBands(lane)).toEqual([[1, 1.2]]);
    h.core.scoring.togglePhrase([3, 3.2]);
    expect(h.store.state.freePhrases).toEqual([
      [1, 1.2],
      [3, 3.2],
    ]);
    h.core.scoring.togglePhrase([1, 1.2]);
    expect(h.store.state.freePhrases).toEqual([[3, 3.2]]);
    expect(loadFreePhrases(h.settingsStore, 'hash-song')).toEqual([[3, 3.2]]);
  });

  it('are read back for the song when it loads, and left behind when another takes over', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.togglePhrase([1, 1.2]);
    h.store.patch({ song: songInfo('other.mp3', 'hash-other') });
    expect(h.store.state.freePhrases).toEqual([]);
    h.store.patch({ song: songInfo('song.mp3', 'hash-song') });
    expect(h.store.state.freePhrases).toEqual([[1, 1.2]]);
  });

  it('cannot be marked in karaoke mode, and draw no band there', async () => {
    const { h, lane } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.togglePhrase([1, 1.2]);
    h.core.scoring.setMode('karaoke');
    expect(lastBands(lane)).toEqual([]);
    h.core.scoring.togglePhrase([3, 3.2]);
    expect(h.store.state.freePhrases).toEqual([[1, 1.2]]);
    h.core.scoring.setMode('learning');
    expect(lastBands(lane)).toEqual([[1, 1.2]]);
  });

  it('hands a lane attached later the bands and the Shift+click listener', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.togglePhrase([1, 1.2]);
    const late = fakeLane();
    h.core.lane = late;
    h.core.scoring.syncLane();
    expect(late.setFreePhrases).toHaveBeenLastCalledWith([[1, 1.2]]);
    const listener = late.setPhraseClick.mock.calls.at(-1)?.[0] as (span: [number, number]) => void;
    listener([3, 3.2]);
    expect(h.store.state.freePhrases).toEqual([
      [1, 1.2],
      [3, 3.2],
    ]);
  });

  it('grade Strict singing as Open inside the phrase only', async () => {
    const { h, lane } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.setKey(C_MAJOR, KEY_READY);
    h.core.scoring.togglePhrase([1, 1.2]);
    h.core.playback.play();
    // An octave up: Open's rule in the free phrase, a miss in the other.
    sing(h, 1.05, 880);
    expect(lastGrade(lane)).toBe('hit');
    sing(h, 3.05, 2 * hz(2));
    expect(lastGrade(lane)).toBe('miss');
  });

  it('re-score the shown take from its frames, in the style it was scored in', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(TWO);
    h.core.scoring.setKey(C_MAJOR, KEY_READY);
    // C5, three semitones over the written A4: a miss in Strict, in key in a free phrase.
    await recordTake(h, hz(3));
    const id = h.store.state.takes[0].id;
    expect(h.store.state.takes[0].report?.inTuneRate).toBe(0);

    await h.core.scoring.setPhraseFree(id, [1, 1.2], true);
    const freed = h.store.state.takes[0].report;
    expect(freed?.style).toBe('strict');
    expect(freed?.notes.map((n) => n.index)).toEqual([]);
    expect(freed?.freestyle).toMatchObject({ inKey: 1, offKey: 0 });
    expect(freed?.freeSpans).toEqual([[1, 1.2]]);
    expect((await h.takeStore.get(id))?.report).toEqual(freed);
    expect(h.store.state.freePhrases).toEqual([[1, 1.2]]);

    await h.core.scoring.setPhraseFree(id, [1, 1.2], false);
    const back = h.store.state.takes[0].report;
    expect(back?.inTuneRate).toBe(0);
    expect(back?.freestyle).toBeUndefined();
    expect(h.store.state.freePhrases).toEqual([]);
  });

  it('re-score an Open take in Open, whatever the style is now', async () => {
    const { h } = await ready({ mode: 'learning', scoring: 'open' });
    h.core.scoring.setReference(TWO);
    await recordTake(h, 880);
    const id = h.store.state.takes[0].id;
    h.core.scoring.setScoring('strict');
    await h.core.scoring.setPhraseFree(id, [1, 1.2], true);
    expect(h.store.state.takes[0].report?.style).toBe('open');
  });
});
