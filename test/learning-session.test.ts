/**
 * Controller tests for learning mode on the fake-parts harness: the mode
 * toggle (kept, and the search chip set to match), the grade each frame carries
 * to the lane, the report a finished take gets (and that karaoke mode and a
 * karaoke track get none), the pick that remembers its badge, and a take
 * replayed from a moment in it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { midiToHz } from '../src/analysis/pitch';
import { buildScoreReference } from '../src/analysis/score';
import { openReport } from '../src/app/learning';
import { loadSettings } from '../src/app/settings';
import { ServiceClient } from '../src/service/client';
import { fakeLane, FakeTransport, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A melody of one short A4 (440 Hz) from 1.0 to 1.2 s. */
const MELODY = buildScoreReference([{ onsetS: 1, offsetS: 1.2, midi: 69 }], [], { lowMidi: 69, highMidi: 69 });

/** A harness with a song loaded and the mic open, the lane faked. */
async function ready(saved?: Record<string, unknown>) {
  const h = makeHarness(saved);
  h.player.setSong(songInfo());
  const lane = fakeLane();
  h.core.lane = lane;
  await h.core.input.chooseInput('usb');
  return { h, lane };
}

/** Puts a frame of `hz` on the bus at song time `t` (the song is playing). */
function sing(h: Harness, t: number, hz: number): void {
  h.engine.t = t;
  h.player.positionS = t;
  h.tracker.emit({ t, f0: hz, clarity: 0.95, rms: 0.2 });
}

/** Sings 20 frames of `hz` over the melody's note and saves the take. */
async function recordTake(h: Harness, hz: number): Promise<void> {
  await h.core.takes.toggleRecord();
  for (let i = 0; i < 20; i++) sing(h, 1 + i * 0.01, hz);
  await h.core.takes.toggleRecord();
}

describe('the mode toggle', () => {
  it('starts in karaoke mode with the search on karaoke versions', () => {
    const h = makeHarness();
    expect(h.store.state.mode).toBe('karaoke');
    expect(h.store.state.search.filter).toBe('karaoke');
  });

  it('switches, remembers the choice and sets the search to originals and back', () => {
    const h = makeHarness();
    h.core.scoring.setMode('learning');
    expect(h.store.state.mode).toBe('learning');
    expect(h.store.state.search.filter).toBe('original');
    expect(loadSettings(h.settingsStore).mode).toBe('learning');
    h.core.scoring.setMode('karaoke');
    expect(h.store.state.mode).toBe('karaoke');
    expect(h.store.state.search.filter).toBe('karaoke');
    expect(loadSettings(h.settingsStore).mode).toBe('karaoke');
  });

  it('comes back as it was saved', () => {
    const h = makeHarness({ mode: 'learning' });
    expect(h.store.state.mode).toBe('learning');
    expect(h.core.current.mode).toBe('learning');
  });

  it('clears the lane, whose frames carry the old mode\'s grades', async () => {
    const { h, lane } = await ready();
    h.core.scoring.setMode('learning');
    expect(lane.clearFrames).toHaveBeenCalledTimes(1);
    h.core.scoring.setMode('learning');
    expect(lane.clearFrames).toHaveBeenCalledTimes(1);
  });
});

describe('grading frames for the lane', () => {
  /** Plays at 10 s with the melody loaded, so frames land on song time. */
  async function playing(saved?: Record<string, unknown>) {
    const { h, lane } = await ready(saved);
    h.core.scoring.setReference(MELODY);
    h.core.playback.play();
    return { h, lane };
  }
  const lastFrame = (lane: ReturnType<typeof fakeLane>) => lane.pushFrame.mock.calls.at(-1)?.[0];

  it('puts a grade on each frame in learning mode: hit, okay, miss', async () => {
    const { h, lane } = await playing({ mode: 'learning' });
    sing(h, 1.05, 440);
    expect(lastFrame(lane)).toMatchObject({ t: 1.05, grade: 'hit' });
    sing(h, 1.06, 440 * 2 ** (0.3 / 12));
    expect(lastFrame(lane).grade).toBe('okay');
    sing(h, 1.07, 440 * 2 ** (0.6 / 12));
    expect(lastFrame(lane).grade).toBe('miss');
  });

  it('puts no grade on a frame outside any note, or an unvoiced one', async () => {
    const { h, lane } = await playing({ mode: 'learning' });
    sing(h, 3, 440);
    expect('grade' in lastFrame(lane)).toBe(false);
    sing(h, 1.05, 0);
    expect('grade' in lastFrame(lane)).toBe(false);
  });

  it('puts no grade on any frame in karaoke mode', async () => {
    const { h, lane } = await playing();
    sing(h, 1.05, 440);
    sing(h, 1.06, 440 * 2 ** (0.6 / 12));
    expect(lane.pushFrame).toHaveBeenCalledTimes(2);
    for (const [frame] of lane.pushFrame.mock.calls) expect('grade' in frame).toBe(false);
  });

  it('puts none on a karaoke track, which has no singer to compare with', async () => {
    const { h, lane } = await playing({ mode: 'learning' });
    h.store.patch({ reference: { phase: 'skipped', notes: 0, message: 'No singing found: only 3% of this track.' } });
    sing(h, 1.05, 440);
    expect('grade' in lastFrame(lane)).toBe(false);
  });

  it('grades the octave above as a hit only when the setting folds octaves', async () => {
    const strict = await playing({ mode: 'learning' });
    sing(strict.h, 1.05, 880);
    expect(lastFrame(strict.lane).grade).toBe('miss');
    const folded = await playing({ mode: 'learning', octaveInvariant: true });
    sing(folded.h, 1.05, 880);
    expect(lastFrame(folded.lane).grade).toBe('hit');
  });

  it('leaves the lane to a replaying take', async () => {
    const { h, lane } = await playing({ mode: 'learning' });
    h.store.patch({ playingTakeId: 'take-1' });
    sing(h, 1.05, 440);
    expect(lane.pushFrame).not.toHaveBeenCalled();
  });
});

describe('the report of a take', () => {
  it('is stored with a take recorded in learning mode over a melody, and its card opens', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(MELODY);
    await recordTake(h, 440 * 2 ** (0.3 / 12));
    const [summary] = h.store.state.takes;
    expect(summary.report).toMatchObject({ notesCovered: 1, notesSung: 1, inTuneRate: 1 });
    expect(summary.report?.notes[0].meanCents).toBeCloseTo(30, 3);
    expect(summary.report?.frames).toEqual({ hit: 0, okay: 20, miss: 0 });
    const stored = await h.takeStore.get(summary.id);
    expect(stored?.report).toEqual(summary.report);
    expect(h.store.state.reportTakeId).toBe(summary.id);
    expect(openReport(h.store.state)?.take.id).toBe(summary.id);
  });

  it('is not computed or stored for a take recorded in karaoke mode', async () => {
    const { h } = await ready();
    h.core.scoring.setReference(MELODY);
    await recordTake(h, 440);
    expect(h.store.state.takes).toHaveLength(1);
    expect('report' in h.store.state.takes[0]).toBe(false);
    expect(h.store.state.reportTakeId).toBeNull();
    const stored = await h.takeStore.get(h.store.state.takes[0].id);
    expect(stored && 'report' in stored).toBe(false);
  });

  it('is not shown in karaoke mode even for a take that has one', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(MELODY);
    await recordTake(h, 440);
    expect(openReport(h.store.state)).not.toBeNull();
    h.core.scoring.setMode('karaoke');
    expect(openReport(h.store.state)).toBeNull();
    h.core.scoring.setMode('learning');
    expect(openReport(h.store.state)).not.toBeNull();
  });

  it('is not made without a melody, nor for a karaoke track', async () => {
    const none = await ready({ mode: 'learning' });
    await recordTake(none.h, 440);
    expect('report' in none.h.store.state.takes[0]).toBe(false);

    const karaoke = await ready({ mode: 'learning' });
    karaoke.h.core.scoring.setReference(MELODY);
    karaoke.h.store.patch({ reference: { phase: 'skipped', notes: 0, message: 'No singing found: only 3%.' } });
    await recordTake(karaoke.h, 440);
    expect('report' in karaoke.h.store.state.takes[0]).toBe(false);
    expect(karaoke.h.store.state.reportTakeId).toBeNull();
  });

  it('closes when another song takes over, and opens and closes on request', async () => {
    const { h } = await ready({ mode: 'learning' });
    h.core.scoring.setReference(MELODY);
    await recordTake(h, 440);
    h.core.scoring.showReport(null);
    expect(h.store.state.reportTakeId).toBeNull();
    const id = h.store.state.takes[0].id;
    h.core.scoring.showReport(id);
    expect(h.store.state.reportTakeId).toBe(id);
    h.store.patch({ song: songInfo('other.mp3', 'hash-other') });
    expect(h.store.state.reportTakeId).toBeNull();
  });

  it('still loads a take saved before learning mode, which has no report', async () => {
    const { h } = await ready({ mode: 'learning' });
    await h.takeStore.save({
      songHash: 'hash-song',
      songName: 'song.mp3',
      createdAt: 1,
      durationS: 1,
      latencyS: 0,
      sampleRate: 44100,
      frames: [],
      wav: new Blob(),
    });
    await h.core.takes.refreshTakes();
    expect(h.store.state.takes).toHaveLength(1);
    h.core.scoring.showReport(h.store.state.takes[0].id);
    expect(openReport(h.store.state)).toBeNull();
  });
});

describe('picking a search result', () => {
  it('remembers the badge and the channel of what became the song', async () => {
    const h = makeHarness();
    vi.spyOn(h.core.songs, 'loadLink').mockImplementation(async () => {
      h.store.patch({ song: songInfo('Hello', 'yt-abc') });
    });
    h.store.patch({
      search: {
        ...h.store.state.search,
        results: [
          { videoId: 'abc', title: 'Hello (Karaoke)', channel: 'Sing King', durationS: 200, thumbnailUrl: '', kind: 'karaoke' },
        ],
      },
    });
    await h.core.search.pick('abc');
    expect(h.store.state.pickedResult).toEqual({
      videoId: 'abc',
      title: 'Hello (Karaoke)',
      channel: 'Sing King',
      kind: 'karaoke',
    });
  });

  it('remembers nothing when the video did not load', async () => {
    const h = makeHarness();
    vi.spyOn(h.core.songs, 'loadLink').mockResolvedValue(undefined);
    await h.core.search.pick('abc');
    expect(h.store.state.pickedResult).toBeNull();
  });
});

describe('replaying a take from a moment', () => {
  /** A take saved over a song at 0 s, ready to replay. */
  async function saved() {
    const { h } = await ready();
    await recordTake(h, 440);
    return { h, id: h.store.state.takes[0].id };
  }

  it('starts a lead-in before that moment under the song, and at the start without one', async () => {
    const { h, id } = await saved();
    h.player.calls.length = 0;
    await h.core.takes.playTake(id, 5);
    expect(h.player.calls).toContain('seek 4');
    h.core.takes.stopTake();
    h.player.calls.length = 0;
    await h.core.takes.playTake(id);
    expect(h.player.calls).toContain('seek 0');
  });

  it('never starts before the take itself', async () => {
    const { h, id } = await saved();
    h.player.calls.length = 0;
    await h.core.takes.playTake(id, 0.2);
    expect(h.player.calls).toContain('seek 0');
  });

  it('places a replay right when the take started late in the song with a latency', async () => {
    const { h } = await ready();
    h.recorder.take = { ...h.recorder.take, startedAtSongS: 10, latencyS: 0.1 };
    await recordTake(h, 440);
    const id = h.store.state.takes[0].id;
    // The take's first sample sits at song time 10 - 0.1; a replay from 12
    // starts a lead-in before it, at 11.
    h.player.calls.length = 0;
    await h.core.takes.playTake(id, 12);
    expect(h.player.calls).toContain('seek 11');
    h.core.takes.stopTake();

    class FakeEmbed extends FakeTransport {
      override clock = 'embed' as const;
    }
    const embed = new FakeEmbed();
    embed.setSong(songInfo());
    h.core.songs.active = embed;
    h.engine.t = 20;
    await h.core.takes.playTake(id, 12);
    expect(h.core.songs.currentPosition()).toBeCloseTo(11, 6);
    h.engine.t = 22;
    expect(h.core.songs.currentPosition()).toBeCloseTo(13, 6);
  });

  it('puts the playhead of a take played by itself at that moment', async () => {
    const { h, id } = await saved();
    class FakeEmbed extends FakeTransport {
      override clock = 'embed' as const;
    }
    const embed = new FakeEmbed();
    embed.setSong(songInfo());
    h.core.songs.active = embed;
    h.engine.t = 10;
    await h.core.takes.playTake(id, 5);
    expect(h.core.songs.currentPosition()).toBe(4);
    h.engine.t = 12;
    expect(h.core.songs.currentPosition()).toBe(6);
  });
});
