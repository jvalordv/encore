/**
 * Controller tests for the Song reference on the fake-parts harness: a failed
 * download arms the recording of the song's sound (with the service's words
 * kept for Details), the next Play or Record press starts it before the song
 * does, the automatic setting and "Not now" decide whether learning mode asks,
 * a melody that arrives scores earlier voice-only takes again, and the
 * Library's Melody and Key flags follow what arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildScoreReference } from '../src/analysis/score';
import { referenceBadge } from '../src/app/library-state';
import { initialCapture } from '../src/app/capture';
import {
  BLOCKED_NOTE,
  BLOCKED_NO_RECORDING_NOTE,
  DOWNLOAD_ERROR_NOTE,
  DOWNLOAD_FAILED_NOTE,
} from '../src/app/song-reference';
import { loadSettings } from '../src/app/settings';
import type { YouTubeTransport } from '../src/audio/youtube-transport';
import { ServiceClient } from '../src/service/client';
import { FakeTransport, fakeLane, makeHarness, songInfo } from './session-harness';
import type { Harness } from './session-harness';

const hoisted = vi.hoisted(() => ({ prepareLink: vi.fn() }));

vi.mock('../src/app/prepare', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/app/prepare')>()),
  prepareLink: hoisted.prepareLink,
}));
vi.mock('../src/audio/embed-follower', () => ({
  EmbedFollower: class {
    start = vi.fn();
    stop = vi.fn();
  },
}));

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  hoisted.prepareLink.mockReset();
});

const BOT_CHECK =
  "Sign in to confirm you’re not a bot. This helps protect our community. Use --cookies-from-browser or --cookies for the authentication.";

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

/** Makes the download fail the way YouTube's bot check does. */
function downloadFails(message = BOT_CHECK): void {
  hoisted.prepareLink.mockResolvedValue({ kind: 'failed', message });
}

/** Lets this browser record a tab, without a real share. */
function canRecord(h: Harness, supported = true): void {
  vi.spyOn(h.core.capture, 'supported', 'get').mockReturnValue(supported);
}

describe('Get the melody, when the download fails', () => {
  it('arms the recording and says so in plain words, with the service text only in Details', async () => {
    const { h } = linked();
    canRecord(h);
    downloadFails();
    await h.core.songReference.getMelody();
    expect(h.store.state.prepare.phase).toBe('failed');
    expect(h.store.state.songRef.armed).toBe(true);
    expect(h.store.state.status).toEqual({ text: BLOCKED_NOTE, kind: 'warn' });
    expect(h.store.state.songRef.details).toContain('Sign in to confirm');
    expect(h.store.state.songRef.details).not.toMatch(/cookie/i);
  });

  it('arms it for YouTube turning the request away, not only the bot check', async () => {
    const { h } = linked();
    canRecord(h);
    downloadFails('Download failed: ERROR: HTTP Error 403: Forbidden.');
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(true);
    expect(h.store.state.status.text).toBe(BLOCKED_NOTE);
  });

  it('arms nothing for a failure a recording of the tab cannot mend', async () => {
    const { h } = linked();
    canRecord(h);
    for (const message of [
      'The service stopped answering. Check that it is running.',
      'The prepared audio could not be loaded: decode error',
    ]) {
      downloadFails(message);
      await h.core.songReference.getMelody();
      expect(h.store.state.songRef.armed).toBe(false);
      expect(h.store.state.status).toEqual({ text: DOWNLOAD_ERROR_NOTE, kind: 'warn' });
    }
  });

  it('clears a finished recording attempt, so its words do not outlast the next try', async () => {
    const { h } = linked();
    canRecord(h);
    h.store.patch({ capture: { ...initialCapture(), phase: 'failed', message: 'The share was cancelled.' } });
    downloadFails();
    await h.core.songReference.getMelody();
    expect(h.store.state.capture.phase).toBe('idle');
    expect(h.store.state.songRef.armed).toBe(true);
  });

  it('arms nothing when this browser cannot record a tab', async () => {
    const { h } = linked();
    canRecord(h, false);
    downloadFails();
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(false);
    expect(h.store.state.status.text).toBe(BLOCKED_NO_RECORDING_NOTE);
  });

  it('arms nothing after a download nobody asked for, such as an automatic send of the link', async () => {
    const { h } = linked();
    canRecord(h);
    downloadFails();
    await h.core.prepare.prepare();
    expect(h.store.state.prepare.phase).toBe('failed');
    expect(h.store.state.songRef.armed).toBe(false);
    expect(h.store.state.status).toEqual({ text: DOWNLOAD_FAILED_NOTE, kind: 'warn' });
    // Pressing the button now asks, and arms on a second failure.
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(true);
  });

  it('does not arm, nor touch the raw status, when the song downloads', async () => {
    const { h } = linked();
    hoisted.prepareLink.mockResolvedValue({
      kind: 'audio',
      bytes: new ArrayBuffer(8),
      status: { song_id: 'abc', source: 'url', steps: {} },
    });
    vi.spyOn(h.core.stems, 'follow').mockImplementation(() => undefined);
    await h.core.songReference.getMelody();
    expect(h.store.state.prepare.phase).toBe('prepared');
    expect(h.store.state.songRef.armed).toBe(false);
  });

  it('clears the arm when the song is replaced', async () => {
    const { h } = linked();
    canRecord(h);
    downloadFails();
    await h.core.songReference.getMelody();
    expect(h.store.state.songRef.armed).toBe(true);
    h.core.prepare.endPrepared();
    expect(h.store.state.songRef).toMatchObject({ armed: false, details: '' });
  });
});

describe('the next Play or Record press', () => {
  it('starts the recording first, and the video after the share has been answered', async () => {
    const { h, embed } = linked();
    canRecord(h);
    downloadFails();
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
    downloadFails();
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
    downloadFails();
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

  it('starts Get the melody by itself in learning mode when the setting is on', async () => {
    const { h } = linked({ mode: 'learning' });
    downloadFails();
    h.core.songReference.setAutoReference(true);
    expect(loadSettings(h.settingsStore).autoReference).toBe(true);
    await vi.waitFor(() => expect(hoisted.prepareLink).toHaveBeenCalledTimes(1));
  });

  it('starts when learning mode is turned on with a song already loaded', async () => {
    const { h } = linked();
    downloadFails();
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(hoisted.prepareLink).not.toHaveBeenCalled();
    h.core.scoring.setMode('learning');
    await vi.waitFor(() => expect(hoisted.prepareLink).toHaveBeenCalledTimes(1));
  });

  it('never starts by itself for a karaoke track, though the setting is on', async () => {
    const { h } = linked({ mode: 'learning' });
    h.store.patch({ song: songInfo('Video (Karaoke Version)', 'yt-abc123') });
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(hoisted.prepareLink).not.toHaveBeenCalled();
  });

  it('never starts by itself in karaoke mode', async () => {
    const { h } = linked({ mode: 'karaoke' });
    h.core.songReference.setAutoReference(true);
    await settle();
    expect(hoisted.prepareLink).not.toHaveBeenCalled();
  });

  it('does not start without the setting; the card asks instead', async () => {
    const { h } = linked({ mode: 'learning' });
    await settle();
    expect(hoisted.prepareLink).not.toHaveBeenCalled();
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

  it('does not start an auto run again for the same load, once it has failed', async () => {
    const { h } = linked({ mode: 'learning' });
    canRecord(h);
    downloadFails();
    h.core.songReference.setAutoReference(true);
    await vi.waitFor(() => expect(h.store.state.prepare.phase).toBe('failed'));
    await settle();
    expect(hoisted.prepareLink).toHaveBeenCalledTimes(1);
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
