/**
 * Tests for the Library controller on fake parts (session/library.ts): a load
 * is remembered, favorites keep their order, the playlist advances when a song
 * ends and stops when another song is chosen, a stored upload is fetched back
 * from the service, removal keeps takes, and import reports what is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportFavorites } from '../src/app/library-share';
import { ServiceClient, ServiceError } from '../src/service/client';
import type { SongStatus, SongSummary } from '../src/service/types';
import { makeHarness } from './session-harness';
import type { Harness } from './session-harness';

const failedStatus = (id: string): SongStatus => {
  const step = { state: 'failed' as const, progress: 0, error: 'not in this test' };
  return {
    song_id: id,
    source: 'file',
    steps: { fetch: step, separation: step, key: step, reference: step, lyrics: step },
  };
};

beforeEach(() => {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Loads a file as the song and waits for the Library to note it. */
async function load(h: Harness, name: string): Promise<void> {
  const before = h.store.state.library.entries.length;
  const known = h.store.state.library.entries.some((e) => e.id === `hash-${name}`);
  await h.core.songs.loadSong(new File([new Uint8Array(4)], name));
  if (!known) await vi.waitFor(() => expect(h.store.state.library.entries.length).toBe(before + 1));
}

const titles = (h: Harness): string[] => h.store.state.library.entries.map((e) => e.title);

/** Makes the service answer for stored uploads, remembering what was asked. */
function serviceHolds(ids: string[]): void {
  vi.spyOn(ServiceClient.prototype, 'health').mockResolvedValue(true);
  vi.spyOn(ServiceClient.prototype, 'getSong').mockImplementation(async (id) => failedStatus(id));
  vi.spyOn(ServiceClient.prototype, 'fetchSongAudio').mockResolvedValue(new ArrayBuffer(8));
  vi.spyOn(ServiceClient.prototype, 'listSongs').mockResolvedValue(
    ids.map(
      (id): SongSummary => ({
        id,
        name: `held ${id}`,
        source: 'file',
        duration_s: 30,
        steps_done: ['separation'],
        has_audio: true,
        updated_at: 1,
      }),
    ),
  );
}

describe('noting loads', () => {
  it('adds each loaded file, and a repeat updates the entry instead of adding one', async () => {
    const h = makeHarness();
    await load(h, 'one.mp3');
    await load(h, 'two.mp3');
    expect(titles(h)).toEqual(['two', 'one']);
    expect(h.store.state.library.entries[0]).toMatchObject({ source: 'file', fileName: 'two.mp3', favorite: false });
    await load(h, 'one.mp3');
    await vi.waitFor(() => expect(titles(h)).toEqual(['one', 'two']));
    expect(h.store.state.library.entries).toHaveLength(2);
  });

  it('keeps the entries in the store, so a new session reads them back', async () => {
    const h = makeHarness();
    await load(h, 'one.mp3');
    expect((await h.libraryStore.list()).map((e) => e.id)).toEqual(['hash-one.mp3']);
  });

  it('marks the song prepared once its karaoke track is ready', async () => {
    const h = makeHarness();
    await load(h, 'one.mp3');
    h.store.patch({ karaoke: { ...h.store.state.karaoke, phase: 'ready' } });
    await vi.waitFor(() => expect(h.store.state.library.entries[0]?.stems).toBe(true));
    expect(h.store.state.library.entries[0]?.melody).toBe(false);
  });

  it('lists the saved takes as summaries', async () => {
    const h = makeHarness();
    await load(h, 'one.mp3');
    await h.takeStore.save({
      songHash: 'hash-one.mp3',
      songName: 'one',
      createdAt: 1,
      durationS: 1,
      latencyS: 0,
      sampleRate: 48000,
      frames: [],
      wav: new Blob([]),
    });
    h.core.library.setOpen(true);
    await vi.waitFor(() => expect(h.store.state.library.takes.map((t) => t.songHash)).toEqual(['hash-one.mp3']));
  });
});

describe('favorites and removal', () => {
  it('stars, orders and unstars', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await load(h, 'b.mp3');
    await h.core.library.toggleFavorite('hash-a.mp3');
    await h.core.library.toggleFavorite('hash-b.mp3');
    const order = () =>
      h.store.state.library.entries
        .filter((e) => e.favorite)
        .sort((x, y) => x.order - y.order)
        .map((e) => e.title);
    expect(order()).toEqual(['a', 'b']);
    await h.core.library.moveFavorite('hash-b.mp3', -1);
    expect(order()).toEqual(['b', 'a']);
    await h.core.library.toggleFavorite('hash-b.mp3');
    expect(order()).toEqual(['a']);
  });

  it('removes an entry and leaves its takes alone', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await h.takeStore.save({
      songHash: 'hash-a.mp3',
      songName: 'a',
      createdAt: 1,
      durationS: 1,
      latencyS: 0,
      sampleRate: 48000,
      frames: [],
      wav: new Blob([]),
    });
    await h.core.library.removeEntry('hash-a.mp3');
    expect(h.store.state.library.entries).toEqual([]);
    expect(await h.libraryStore.list()).toEqual([]);
    expect(await h.takeStore.list('hash-a.mp3')).toHaveLength(1);
    expect(h.store.state.library.notice).toContain('takes are kept');
  });
});

describe('takes in the Library', () => {
  const save = (h: Harness, songHash: string, createdAt: number): Promise<string> =>
    h.takeStore.save({
      songHash,
      songName: songHash,
      createdAt,
      durationS: 1,
      latencyS: 0,
      sampleRate: 48000,
      frames: [],
      wav: new Blob([]),
    });

  it('deletes one take of another song and updates the list', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await load(h, 'b.mp3');
    const keep = await save(h, 'hash-a.mp3', 1);
    const drop = await save(h, 'hash-a.mp3', 2);
    h.core.library.setOpen(true);
    await vi.waitFor(() => expect(h.store.state.library.takes).toHaveLength(2));
    await h.core.library.deleteTake(drop);
    expect(h.store.state.library.takes.map((t) => t.id)).toEqual([keep]);
    expect(await h.takeStore.list('hash-a.mp3')).toHaveLength(1);
  });

  it('deletes a take of the song in use and updates the list', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    const id = await save(h, 'hash-a.mp3', 1);
    h.core.library.setOpen(true);
    await vi.waitFor(() => expect(h.store.state.library.takes).toHaveLength(1));
    await h.core.library.deleteTake(id);
    expect(h.store.state.library.takes).toEqual([]);
  });

  it('will not replay another songs take, and says how to get there', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await load(h, 'b.mp3');
    const id = await save(h, 'hash-a.mp3', 1);
    h.core.library.setOpen(true);
    await vi.waitFor(() => expect(h.store.state.library.takes).toHaveLength(1));
    await h.core.library.replayTake(id);
    expect(h.store.state.playingTakeId).toBeNull();
    expect(h.store.state.library.notice).toContain('Open');
  });

  it('opens a take: loads its song; a take with no report has no card', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await load(h, 'b.mp3');
    const id = await save(h, 'hash-a.mp3', 1);
    serviceHolds([]);
    h.core.library.setOpen(true);
    await vi.waitFor(() => expect(h.store.state.library.takes).toHaveLength(1));
    expect(await h.core.library.openTake('hash-a.mp3', id)).toBe(true);
    expect(h.store.state.song?.hash).toBe('hash-a.mp3');
    // The take has no report, so there is no card to show.
    expect(h.store.state.reportTakeId).toBeNull();
  });
});

describe('stored uploads', () => {
  it('fetches the audio back from the service under the service id', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await load(h, 'b.mp3');
    serviceHolds([]);

    expect(await h.core.library.loadEntry('hash-a.mp3')).toBe(true);

    expect(ServiceClient.prototype.fetchSongAudio).toHaveBeenCalledWith('hash-a.mp3');
    expect(h.player.load).toHaveBeenLastCalledWith(expect.any(Blob), 'a.mp3', 'hash-a.mp3');
    expect(h.store.state.song?.hash).toBe('hash-a.mp3');
  });

  it('says the upload needs the service, and keeps the song in use, when it is away', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    await load(h, 'b.mp3');
    vi.spyOn(ServiceClient.prototype, 'getSong').mockRejectedValue(new ServiceError('unreachable', 'down'));

    expect(await h.core.library.loadEntry('hash-a.mp3')).toBe(false);

    expect(h.store.state.song?.hash).toBe('hash-b.mp3');
    expect(h.store.state.status.kind).toBe('error');
    expect(h.store.state.status.text).toMatch(/service/i);
  });

  it('lists uploads only the service holds, once the Library opens', async () => {
    const h = makeHarness();
    await load(h, 'a.mp3');
    serviceHolds(['hash-a.mp3', 'e'.repeat(64)]);
    h.core.library.setOpen(true);
    await vi.waitFor(() => expect(h.store.state.library.onService.map((s) => s.name)).toEqual([`held ${'e'.repeat(64)}`]));
  });
});

describe('the favorites playlist', () => {
  async function three(): Promise<Harness> {
    const h = makeHarness();
    for (const name of ['a.mp3', 'b.mp3', 'c.mp3']) {
      await load(h, name);
      await h.core.library.toggleFavorite(`hash-${name}`);
    }
    serviceHolds([]);
    return h;
  }
  const playing = (h: Harness): string | undefined => h.store.state.song?.hash;

  it('plays from the top and moves on when a song ends', async () => {
    const h = await three();
    await h.core.library.playFavorites();
    expect(playing(h)).toBe('hash-a.mp3');
    expect(h.player.calls).toContain('play');
    expect(h.store.state.library.playlist).toEqual({ active: true, currentId: 'hash-a.mp3' });

    h.player.emit('ended');
    await vi.waitFor(() => expect(playing(h)).toBe('hash-b.mp3'));
    expect(h.store.state.library.playlist.currentId).toBe('hash-b.mp3');
  });

  it('plays from a chosen entry', async () => {
    const h = await three();
    await h.core.library.playFavorites('hash-b.mp3');
    expect(playing(h)).toBe('hash-b.mp3');
  });

  it('does not move on when auto-advance is off, and remembers the choice', async () => {
    const h = await three();
    h.core.library.setAutoAdvance(false);
    expect(h.settingsStore.get('autoAdvance')).toBe('off');
    await h.core.library.playFavorites();
    h.player.emit('ended');
    await Promise.resolve();
    expect(playing(h)).toBe('hash-a.mp3');
  });

  it('steps with Next and Previous and says so at the ends', async () => {
    const h = await three();
    await h.core.library.playFavorites('hash-b.mp3');
    await h.core.library.next();
    expect(playing(h)).toBe('hash-c.mp3');
    await h.core.library.next();
    expect(playing(h)).toBe('hash-c.mp3');
    expect(h.store.state.status.text).toBe('That was the last favorite.');
    await h.core.library.previous();
    await h.core.library.previous();
    expect(playing(h)).toBe('hash-a.mp3');
    await h.core.library.previous();
    expect(h.store.state.status.text).toBe('This is the first favorite.');
  });

  it('stops when the singer loads some other song', async () => {
    const h = await three();
    await h.core.library.playFavorites();
    await load(h, 'other.mp3');
    expect(h.store.state.library.playlist.active).toBe(false);
    h.player.emit('ended');
    await Promise.resolve();
    expect(playing(h)).toBe('hash-other.mp3');
  });

  it('survives a Mic check borrowing the song', async () => {
    const h = await three();
    await h.core.library.playFavorites();
    const song = h.store.state.song!;
    h.store.patch({ song: { ...song, hash: 'mic-check' } });
    h.store.patch({ song });
    expect(h.store.state.library.playlist).toEqual({ active: true, currentId: 'hash-a.mp3' });
  });

  it('does not move on at the end of a loop pass', async () => {
    const h = await three();
    await h.core.library.playFavorites();
    h.player.setLoop({ startS: 1, endS: 2 });
    h.player.emit('ended');
    await Promise.resolve();
    expect(playing(h)).toBe('hash-a.mp3');
  });

  it('ends the playlist when another load wins during its own', async () => {
    const h = await three();
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    vi.spyOn(h.core.songs, 'loadStored').mockImplementation(() => gate);
    const started = h.core.library.playFavorites('hash-b.mp3');
    await load(h, 'other.mp3');
    release();
    await started;
    expect(h.store.state.library.playlist.active).toBe(false);
  });

  it('says so when there is nothing starred', async () => {
    const h = makeHarness();
    await h.core.library.playFavorites();
    expect(h.store.state.library.playlist.active).toBe(false);
    expect(h.store.state.status.text).toMatch(/Star some songs/);
  });
});

describe('importing favorites', () => {
  const held = 'a1'.repeat(32);
  const lost = 'b2'.repeat(32);
  const text = JSON.stringify({
    kind: 'encore-favorites',
    version: 1,
    items: [
      { source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'A link' },
      { source: 'file', id: held, fileName: 'held.mp3', title: 'Held' },
      { source: 'file', id: lost, fileName: 'lost.mp3', title: 'Lost' },
      { source: 'youtube', videoId: 'bad' },
    ],
  });

  it('adds them as favorites in file order and says which uploads are missing', async () => {
    const h = makeHarness();
    serviceHolds([held]);
    const message = await h.core.library.importText(text);

    expect(message).toContain('Imported 3 favorites.');
    expect(message).toContain('1 item was skipped.');
    expect(message).toContain('1 upload is not in this browser or on the service');
    const favorites = h.store.state.library.entries.filter((e) => e.favorite).sort((a, b) => a.order - b.order);
    expect(favorites.map((e) => e.title)).toEqual(['A link', 'Held', 'Lost']);
    expect(favorites.every((e) => e.lastPlayedAt === null)).toBe(true);
  });

  it('puts imports after the favorites already there and does not duplicate', async () => {
    const h = makeHarness();
    serviceHolds([held]);
    await load(h, 'mine.mp3');
    await h.core.library.toggleFavorite('hash-mine.mp3');
    await h.core.library.importText(text);
    await h.core.library.importText(text);
    const favorites = h.store.state.library.entries.filter((e) => e.favorite).sort((a, b) => a.order - b.order);
    expect(favorites.map((e) => e.title)).toEqual(['mine', 'A link', 'Held', 'Lost']);
  });

  it('refuses a file that is not a favorites list', async () => {
    const h = makeHarness();
    expect(await h.core.library.importText('{}')).toMatch(/not an Encore favorites/);
    expect(h.store.state.library.entries).toEqual([]);
  });

  it('exports what it imported', async () => {
    const h = makeHarness();
    serviceHolds([held]);
    await h.core.library.importText(text);
    const exported = h.core.library.exportText();
    expect(exported).toBe(exportFavorites(h.store.state.library.entries));
    expect(JSON.parse(exported ?? '{}').items).toHaveLength(3);
  });
});
