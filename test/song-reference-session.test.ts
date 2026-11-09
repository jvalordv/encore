/**
 * Controller tests for the Song reference on the fake-parts harness: Get the
 * melody arms the recording of the song's sound (nothing is downloaded), the
 * next Play or Record press starts it before the song does, the automatic
 * setting and "Not now" decide whether learning mode asks or arms by itself, a
 * melody that arrives scores earlier voice-only takes again, a key that arrives
 * alone scores earlier takes against it, and the Library's Melody and Key flags
 * follow what arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScoreReference } from '../src/analysis/score';
import { referenceBadge } from '../src/app/library-state';
import { initialCapture } from '../src/app/capture';
import { ARMED_NOTE, NO_RECORDING_NOTE } from '../src/app/song-reference';
import { loadSettings } from '../src/app/settings';
import type { YouTubeTransport } from '../src/audio/youtube-transport';
import { ServiceClient, ServiceError } from '../src/service/client';
import { FakeTransport, fakeLane, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';
import type { KeyMap } from '../src/service/types';

const hoisted = vi.hoisted(() => ({ adoptHeldSong: vi.fn() }));

vi.mock('../src/app/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/app/prepare')>()),
  adoptHeldSong: hoisted.adoptHeldSong,
}));
vi.mock('../src/audio/embed-follower', () => ({
  EmbedFollower: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
  // By default the service holds nothing for the video.
  vi.spyOn(ServiceClient.prototype, 'getSong').mockRejectedValue(new ServiceError('not-found', 'No such song.', 404));
});

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.adoptHeldSong.mockReset();
});

/** A stand-in for the linked video. */
class FakeEmbed extends FakeTransport {
  override clock = 'embed' as const;
  videoId = 'abc123';
  readonly mute = vi.fn();
  readonly destroy = vi.fn();
}

/** A harness whose song is a linked video the service check has passed. */
function linked(saved?: Record<string, unknown>) {
  const h = makeHarness(saved);
  const embed = new FakeEmbed();
  embed.setSong(songInfo('Video', 'yt-abc123'));
  h.core.songs.embed = embed as unknown as YouTubeTransport;
  h.core.songs.active = embed;
  h.store.patch({ song: songInfo('Video', 'yt-abc123'), prepare: { phase: 'ready', steps: null, message: '' } });
  return { h, embed };
}

/** Lets this browser record a tab, without a real share. */
function canRecord(h: Harness, supported = true): void {
  vi.spyOn(h.core.capture, 'supported', 'get').mockReturnValue(supported);
}

describe('Get the melody', () => {
  it('arms the recording and says so in plain words, with no download and no service text', async () => {
    const { h } = linked();
    canRecord(h);
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(true);
    expect(h.store.state.status).toEqual({ text: ARMED_NOTE, kind: 'info' });
    expect(hoisted.adoptHeldSong).not.toHaveBeenCalled();
    expect(h.store.state.prepare.phase).toBe('ready');
  });

  it('takes over a recording the service already holds, with no arming and no share prompt', async () => {
    const { h } = linked();
    canRecord(h);
    const done = { state: 'done', progress: 1, error: null, detail: null } as const;
    vi.spyOn(ServiceClient.prototype, 'getSong').mockResolvedValue({
      song_id: 'yt-abc123',
      title: 'Video',
      duration_s: 30,
      source: 'youtube',
      steps: { fetch: done, separation: done, key: done, reference: done, lyrics: { ...done, state: 'skipped' } },
    });
    hoisted.adoptHeldSong.mockResolvedValue({ kind: 'aborted' });
    await h.core.songReference.getMelody();
    expect(hoisted.adoptHeldSong).toHaveBeenCalledTimes(1);
    expect(h.store.state.songRef.armed).toBe(false);
  });

  it('arms the recording when the service holds the song but its fetch is not done', async () => {
    const { h } = linked();
    canRecord(h);
    const queued = { state: 'queued', progress: 0, error: null, detail: null } as const;
    vi.spyOn(ServiceClient.prototype, 'getSong').mockResolvedValue({
      song_id: 'yt-abc123',
      title: 'Video',
      duration_s: 30,
      source: 'youtube',
      steps: { fetch: queued, separation: queued, key: queued, reference: queued, lyrics: queued },
    });
    await h.core.songReference.getMelody();
    expect(hoisted.adoptHeldSong).not.toHaveBeenCalled();
    expect(h.store.state.songRef.armed).toBe(true);
  });

  it('clears a finished recording attempt, so its words do not outlast the next try', async () => {
    const { h } = linked();
    canRecord(h);
    h.store.patch({ capture: { ...initialCapture(), phase: 'failed', message: 'The share was cancelled.' } });
    await h.core.songReference.getMelody();
    expect(h.store.state.capture.phase).toBe('idle');
    expect(h.store.state.songRef.armed).toBe(true);
  });

  it('arms nothing, and says so, when this browser cannot record a tab', async () => {
    const { h } = linked();
    canRecord(h, false);
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(false);
    expect(h.store.state.status).toEqual({ text: NO_RECORDING_NOTE, kind: 'warn' });
  });

  it('does nothing while the service is away or a recording is under way', async () => {
    const { h } = linked();
    canRecord(h);
    h.store.patch({ prepare: { phase: 'unavailable', steps: null, message: '' } });
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(false);
    h.store.patch({ prepare: { phase: 'ready', steps: null, message: '' } });
    h.store.patch({ capture: { ...initialCapture(), phase: 'capturing' } });
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(false);
  });

  it('clears the arm when the song is replaced', async () => {
    const { h } = linked();
    canRecord(h);
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(true);
    h.core.prepare.endPrepared();
    expect(h.store.state.songRef).toMatchObject({ armed: false });
  });
});

describe('the next Play or Record press', () => {
  it('starts the recording first, and the video after the share has been answered', async () => {
    const { h, embed } = linked();
    canRecord(h);
    await h.core.songReference.getMelody();
    let answered!: () => void;
    const start = vi.spyOn(h.core.capture, 'start').mockReturnValue(
      new Promise<void>((resolve) => {
        answered = resolve;
      }),
    );
    h.core.playback.play();
    expect(start).toHaveBeenCalledTimes(1);
    expect(embed.calls).not.toContain('play');
    expect(h.store.state.songRef.armed).toBe(false);
    answered();
    await vi.waitFor(() => expect(embed.calls).toContain('play'));
    // Once spent, the next press only plays.
    h.core.playback.pause();
    h.core.playback.play();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('starts it on Record too, before the take begins', async () => {
    const { h } = linked();
    canRecord(h);
    h.core.lane = fakeLane();
    await h.core.input.chooseInput('usb');
    await h.core.songReference.getMelody();
    const start = vi.spyOn(h.core.capture, 'start').mockResolvedValue(undefined);
    await h.core.takes.toggleRecord();
    expect(start).toHaveBeenCalledTimes(1);
    expect(h.store.state.songRef.armed).toBe(false);
    await vi.waitFor(() => expect(h.store.state.recording).toBe(true));
  });

  it('opens the mic before the share, so a refused mic leaves the video alone', async () => {
    const { h, embed } = linked();
    canRecord(h);
    await h.core.songReference.getMelody();
    vi.spyOn(h.core.input, 'ensureInput').mockResolvedValue(false);
    const start = vi.spyOn(h.core.capture, 'start').mockResolvedValue(undefined);
    await h.core.takes.toggleRecord();
    expect(start).not.toHaveBeenCalled();
    expect(embed.calls).not.toContain('play');
    expect(h.store.state.songRef.armed).toBe(true);
  });

  it('does nothing extra when nothing is armed', () => {
    const { h, embed } = linked();
    const start = vi.spyOn(h.core.capture, 'start');
    h.core.playback.play();
    expect(start).not.toHaveBeenCalled();
    expect(embed.calls).toContain('play');
  });
});

describe('the prompt, the automatic setting and Not now', () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('arms the recording by itself in learning mode when the setting is on', async () => {
    const { h } = linked({ mode: 'learning' });
    canRecord(h);
    h.core.songReference.setAutoReference(true);
    expect(loadSettings(h.settingsStore).autoReference).toBe(true);
    await vi.waitFor(() => expect(h.store.state.songRef.armed).toBe(true));
    expect(hoisted.adoptHeldSong).not.toHaveBeenCalled();
  });

  it('arms when learning mode is turned on with a song already loaded', async () => {
    const { h } = linked();
    canRecord(h);
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(h.store.state.songRef.armed).toBe(false);
    h.core.scoring.setMode('learning');
    await vi.waitFor(() => expect(h.store.state.songRef.armed).toBe(true));
  });

  it('never arms by itself for a karaoke track, though the setting is on', async () => {
    const { h } = linked({ mode: 'learning' });
    canRecord(h);
    h.store.patch({ song: songInfo('Video (Karaoke Version)', 'yt-abc123') });
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(h.store.state.songRef.armed).toBe(false);
  });

  it('never arms by itself in karaoke mode', async () => {
    const { h } = linked({ mode: 'karaoke' });
    canRecord(h);
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(h.store.state.songRef.armed).toBe(false);
  });

  it('never arms by itself in a browser that cannot record a tab', async () => {
    const { h } = linked({ mode: 'learning' });
    canRecord(h, false);
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(h.store.state.songRef.armed).toBe(false);
    expect(h.store.state.status.kind).not.toBe('warn');
  });

  it('does not arm without the setting; the card asks instead', async () => {
    const { h } = linked({ mode: 'learning' });
    canRecord(h);
    await settle();
    expect(h.store.state.songRef.armed).toBe(false);
    expect(h.store.state.songRef.declined).toBe(false);
  });

  it('remembers Not now for that song, for the session, and not for another', () => {
    const { h } = linked({ mode: 'learning' });
    h.core.songReference.notNow();
    expect(h.store.state.songRef.declined).toBe(true);
    h.core.prepare.endPrepared();
    h.store.patch({ song: songInfo('Other', 'yt-other123456') });
    expect(h.store.state.songRef.declined).toBe(false);
    h.store.patch({ song: songInfo('Video', 'yt-abc123') });
    expect(h.store.state.songRef.declined).toBe(true);
  });

  it('arms once for a load, and does not arm again after the recording has been taken', async () => {
    const { h } = linked({ mode: 'learning' });
    canRecord(h);
    vi.spyOn(h.core.capture, 'start').mockResolvedValue(undefined);
    h.core.songReference.setAutoReference(true);
    await vi.waitFor(() => expect(h.store.state.songRef.armed).toBe(true));
    await h.core.songReference.takeArmed();
    expect(h.store.state.songRef.armed).toBe(false);
    await settle();
    expect(h.store.state.songRef.armed).toBe(false);
  });
});

describe('scoring earlier takes when the melody arrives', () => {
  /** A melody of one short A4 (440 Hz) from 1.0 to 1.2 s. */
  const MELODY = buildScoreReference([{ onsetS: 1, offsetS: 1.2, midi: 69 }], [], { lowMidi: 69, highMidi: 69 });

  async function singing(saved: Record<string, unknown> = { mode: 'learning' }) {
    const h = makeHarness(saved);
    h.player.setSong(songInfo());
    h.core.lane = fakeLane();
    await h.core.input.chooseInput('usb');
    return h;
  }

  async function takeAt440(h: Harness): Promise<void> {
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 20; i++) {
      const t = 1 + i * 0.01;
      h.engine.t = t;
      h.player.positionS = t;
      h.tracker.emit({ t, f0: 440, clarity: 0.95, rms: 0.2 });
    }
    await h.core.takes.toggleRecord();
  }

  it('gives a take sung without a melody a report against it once it arrives', async () => {
    const h = await singing();
    await takeAt440(h);
    const [take] = h.store.state.takes;
    expect(take.report?.noMelody).toBe(true);
    h.core.scoring.setReference(MELODY);
    h.store.patch({ reference: { phase: 'ready', notes: 1, message: '' } });
    await vi.waitFor(() => expect(h.store.state.takes[0].report?.noMelody).not.toBe(true));
    const stored = await h.takeStore.get(take.id);
    expect(stored?.report).toMatchObject({ notesCovered: 1, notesSung: 1 });
    expect(stored?.report).toEqual(h.store.state.takes[0].report);
    expect(h.store.state.status.text).toBe('Your earlier take was scored again with the melody.');
  });

  it('scores again for a melody borrowed from the original too', async () => {
    const h = await singing();
    await takeAt440(h);
    h.core.scoring.setReference(MELODY);
    h.store.patch({ reference: { phase: 'ready', notes: 1, message: '', alignedFrom: 'yt-original1' } });
    await vi.waitFor(() => expect(h.store.state.takes[0].report?.noMelody).not.toBe(true));
  });

  it('leaves a take sung in karaoke mode without a report', async () => {
    const h = await singing({ mode: 'karaoke' });
    await takeAt440(h);
    expect(h.store.state.takes[0].report).toBeUndefined();
    h.core.scoring.setReference(MELODY);
    h.store.patch({ reference: { phase: 'ready', notes: 1, message: '' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.store.state.takes[0].report).toBeUndefined();
  });

  it('leaves a take already scored against a melody as it was', async () => {
    const h = await singing();
    h.core.scoring.setReference(MELODY);
    h.store.patch({ reference: { phase: 'ready', notes: 1, message: '' } });
    await takeAt440(h);
    const before = h.store.state.takes[0].report;
    expect(before?.noMelody).not.toBe(true);
    const count = await h.core.scoring.rescoreWithMelody();
    expect(count).toBe(0);
    expect(h.store.state.takes[0].report).toEqual(before);
  });

  it('scores nothing while there is still no melody', async () => {
    const h = await singing();
    await takeAt440(h);
    expect(await h.core.scoring.rescoreWithMelody()).toBe(0);
    expect(h.store.state.takes[0].report?.noMelody).toBe(true);
  });
});

describe('scoring earlier takes when only the key arrives', () => {
  /** A key of A major over the whole song. */
  const KEY_A: KeyMap = {
    tuning_cents: 0,
    segments: [{ start_s: 0, end_s: 30, tonic: 9, mode: 'major', confidence: 0.9 }],
  };

  async function singing(saved: Record<string, unknown> = { mode: 'learning' }) {
    const h = makeHarness(saved);
    h.player.setSong(songInfo());
    h.core.lane = fakeLane();
    await h.core.input.chooseInput('usb');
    return h;
  }

  /** A take of a steady A4 for half a second, with no melody and no key. */
  async function longTakeAt440(h: Harness): Promise<void> {
    await h.core.takes.toggleRecord();
    for (let i = 0; i < 50; i++) {
      const t = 1 + i * 0.01;
      h.engine.t = t;
      h.player.positionS = t;
      h.tracker.emit({ t, f0: 440, clarity: 0.95, rms: 0.2 });
    }
    await h.core.takes.toggleRecord();
  }

  it('judges a take sung without a key against the song\'s key once it arrives', async () => {
    const h = await singing();
    await longTakeAt440(h);
    const [take] = h.store.state.takes;
    expect(take.report?.voice).toBeDefined();
    expect(take.report?.voice?.reference).not.toBe('song_key');
    h.core.scoring.setKey(KEY_A, { phase: 'ready', message: '' });
    await vi.waitFor(() => expect(h.store.state.takes[0].report?.voice?.reference).toBe('song_key'));
    const stored = await h.takeStore.get(take.id);
    expect(stored?.report?.voice?.reference).toBe('song_key');
    expect(h.store.state.status.text).toBe('Your earlier take was scored again with the key.');
  });

  it('leaves a take sung in karaoke mode without a report', async () => {
    const h = await singing({ mode: 'karaoke' });
    await longTakeAt440(h);
    expect(h.store.state.takes[0].report).toBeUndefined();
    h.core.scoring.setKey(KEY_A, { phase: 'ready', message: '' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.store.state.takes[0].report).toBeUndefined();
    expect(await h.core.scoring.rescoreWithKey()).toBe(0);
  });

  it('leaves a take already judged on the song\'s key as it was', async () => {
    const h = await singing();
    h.core.scoring.setKey(KEY_A, { phase: 'ready', message: '' });
    await longTakeAt440(h);
    const before = h.store.state.takes[0].report;
    expect(before?.voice?.reference).toBe('song_key');
    expect(await h.core.scoring.rescoreWithKey()).toBe(0);
    expect(h.store.state.takes[0].report).toEqual(before);
  });

  it('scores nothing while there is no key', async () => {
    const h = await singing();
    await longTakeAt440(h);
    expect(await h.core.scoring.rescoreWithKey()).toBe(0);
    expect(h.store.state.takes[0].report?.voice?.reference).not.toBe('song_key');
  });
});

describe('the Library flags', () => {
  async function loaded() {
    const h = makeHarness();
    await h.core.songs.loadSong(new File([new Uint8Array(4)], 'one.mp3'));
    await vi.waitFor(() => expect(h.store.state.library.entries).toHaveLength(1));
    return h;
  }
  const entry = (h: Harness) => h.store.state.library.entries[0];

  it('starts with no badge, then Key for a key alone, then Melody once a melody arrives', async () => {
    const h = await loaded();
    expect(referenceBadge(entry(h))).toBeNull();
    h.store.patch({ key: { phase: 'ready', message: '' } });
    await vi.waitFor(() => expect(entry(h).key).toBe(true));
    expect(referenceBadge(entry(h))?.label).toBe('Key');
    h.store.patch({ reference: { phase: 'ready', notes: 4, message: '' } });
    await vi.waitFor(() => expect(entry(h).melody).toBe(true));
    expect(referenceBadge(entry(h))?.label).toBe('Melody');
  });

  it('marks an aligned original\'s melody as a melody', async () => {
    const h = await loaded();
    h.store.patch({ reference: { phase: 'ready', notes: 4, message: '', alignedFrom: 'yt-original1' } });
    await vi.waitFor(() => expect(entry(h).melody).toBe(true));
  });

  it('keeps the flag in the store, so a reload shows the badge', async () => {
    const h = await loaded();
    h.store.patch({ reference: { phase: 'ready', notes: 4, message: '' } });
    await vi.waitFor(() => expect(entry(h).melody).toBe(true));
    const saved = await h.libraryStore.get(entry(h).id);
    expect(saved).toMatchObject({ melody: true });
  });
});
