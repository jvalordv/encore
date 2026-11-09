/**
 * Unit tests for the Library store (src/app/library.ts). One behavioural suite
 * runs against the in-memory store and the IndexedDB store (fake-indexeddb, a
 * fresh factory per case); then the repair of old records, the merge a load
 * makes and the fallback paths of openLibraryStore.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanTitle,
  entryAfterLoad,
  idbLibraryStore,
  memoryLibraryStore,
  openLibraryStore,
  sanitiseEntry,
  youtubeSongId,
} from '../src/app/library';
import type { LibraryEntry, LibraryStore, LoadedSong } from '../src/app/library';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const VIDEO = 'dQw4w9WgXcQ';

function link(over: Partial<LoadedSong> = {}): LoadedSong {
  return {
    id: youtubeSongId(VIDEO),
    source: 'youtube',
    title: 'A song',
    videoId: VIDEO,
    fileName: null,
    durationS: 200,
    ...over,
  };
}

function upload(over: Partial<LoadedSong> = {}): LoadedSong {
  return { id: 'f'.repeat(64), source: 'file', title: 'My take', videoId: null, fileName: 'my take.mp3', durationS: 90, ...over };
}

const stores: [string, () => Promise<LibraryStore>][] = [
  ['memoryLibraryStore', async () => memoryLibraryStore()],
  ['idbLibraryStore', () => idbLibraryStore(new IDBFactory())],
];

describe.each(stores)('%s', (_name, open) => {
  it('adds an entry and reads it back', async () => {
    const store = await open();
    const entry = entryAfterLoad(null, link(), 1000);
    await store.put(entry);
    expect(await store.get(entry.id)).toEqual(entry);
    expect(await store.get('nope')).toBeNull();
  });

  it('lists the most recently played first', async () => {
    const store = await open();
    await store.put(entryAfterLoad(null, link(), 1000));
    await store.put(entryAfterLoad(null, upload(), 3000));
    await store.put(entryAfterLoad(null, link({ id: 'yt-aaaaaaaaaaa', videoId: 'aaaaaaaaaaa' }), 2000));
    expect((await store.list()).map((e) => e.lastPlayedAt)).toEqual([3000, 2000, 1000]);
  });

  it('dedupes by source: putting the same id replaces the entry', async () => {
    const store = await open();
    await store.put(entryAfterLoad(null, link(), 1000));
    await store.put(entryAfterLoad(await store.get(youtubeSongId(VIDEO)), link({ title: 'Renamed' }), 5000));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ title: 'Renamed', addedAt: 1000, lastPlayedAt: 5000 });
  });

  it('removes an entry, and an unknown id is not an error', async () => {
    const store = await open();
    const entry = entryAfterLoad(null, upload(), 1);
    await store.put(entry);
    await store.remove(entry.id);
    await store.remove('never there');
    expect(await store.list()).toEqual([]);
  });

  it('writes many entries at once', async () => {
    const store = await open();
    const a = entryAfterLoad(null, link(), 1);
    const b = entryAfterLoad(null, upload(), 2);
    await store.putMany([a, b]);
    expect(await store.list()).toHaveLength(2);
  });
});

describe('entryAfterLoad', () => {
  it('makes a fresh entry that is not a favorite and not prepared', () => {
    expect(entryAfterLoad(null, upload(), 7)).toEqual({
      id: 'f'.repeat(64),
      source: 'file',
      title: 'My take',
      videoId: null,
      fileName: 'my take.mp3',
      durationS: 90,
      addedAt: 7,
      lastPlayedAt: 7,
      stems: false,
      melody: false,
      key: false,
      favorite: false,
      order: 0,
    });
  });

  it('keeps favorite, order, preparation and first-added time on a repeat', () => {
    const before: LibraryEntry = {
      ...entryAfterLoad(null, link(), 10),
      favorite: true,
      order: 3,
      stems: true,
      melody: true,
    };
    const after = entryAfterLoad(before, link({ title: 'New title', durationS: 0 }), 99);
    expect(after).toMatchObject({ favorite: true, order: 3, stems: true, melody: true, addedAt: 10 });
    expect(after.lastPlayedAt).toBe(99);
    expect(after.title).toBe('New title');
    // A load that does not know the length keeps the one it had.
    expect(after.durationS).toBe(200);
  });
});

describe('sanitiseEntry', () => {
  it('repairs a record from an older version that lacks later fields', () => {
    const old = { id: 'yt-dQw4w9WgXcQ', title: 'Old', addedAt: 5 };
    expect(sanitiseEntry(old)).toEqual({
      id: 'yt-dQw4w9WgXcQ',
      source: 'youtube',
      title: 'Old',
      videoId: VIDEO,
      fileName: null,
      durationS: 0,
      addedAt: 5,
      lastPlayedAt: null,
      stems: false,
      melody: false,
      key: false,
      favorite: false,
      order: 0,
    });
  });

  it('keeps the key flag only when it is exactly true', () => {
    expect(sanitiseEntry({ id: 'yt-dQw4w9WgXcQ', key: true })?.key).toBe(true);
    expect(sanitiseEntry({ id: 'yt-dQw4w9WgXcQ', key: 'yes' })?.key).toBe(false);
  });

  it('treats an unmarked non-link id as an upload and titles it from the name', () => {
    const entry = sanitiseEntry({ id: 'abc', fileName: 'x.mp3' });
    expect(entry).toMatchObject({ source: 'file', title: 'x.mp3', fileName: 'x.mp3', videoId: null });
  });

  it('drops what cannot be repaired', () => {
    for (const bad of [null, 3, 'text', {}, { id: '' }, { id: 7 }, { id: 'yt-short', source: 'youtube' }]) {
      expect(sanitiseEntry(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('replaces junk field values with defaults', () => {
    const entry = sanitiseEntry({ id: 'f1', durationS: 'long', addedAt: -4, stems: 'yes', favorite: 1, order: NaN });
    expect(entry).toMatchObject({ durationS: 0, addedAt: 0, stems: false, favorite: false, order: 0 });
  });

  it('reads old records out of IndexedDB through the same repair', async () => {
    const factory = new IDBFactory();
    const store = await idbLibraryStore(factory, 'lib');
    // Reach under the store for a record shaped like an earlier version.
    const raw = await new Promise<IDBDatabase>((resolve) => {
      const request = factory.open('lib', 1);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve) => {
      const tx = raw.transaction('songs', 'readwrite');
      tx.objectStore('songs').put({ id: 'yt-dQw4w9WgXcQ', title: 'Old', addedAt: 3 });
      tx.objectStore('songs').put({ nonsense: true, id: 'yt-bad' });
      tx.oncomplete = () => resolve();
    });
    raw.close();
    const all = await store.list();
    expect(all.map((e) => e.id)).toEqual(['yt-dQw4w9WgXcQ']);
    expect(all[0]?.favorite).toBe(false);
  });
});

describe('cleanTitle', () => {
  it('trims, cuts at 200 characters and falls back when blank', () => {
    expect(cleanTitle('  hi  ', 'x')).toBe('hi');
    expect(cleanTitle('a'.repeat(300), 'x')).toHaveLength(200);
    expect(cleanTitle('   ', 'x')).toBe('x');
    expect(cleanTitle(5, 'x')).toBe('x');
  });
});

describe('idbLibraryStore persistence', () => {
  it('keeps entries across a reopen of the same factory', async () => {
    const factory = new IDBFactory();
    await (await idbLibraryStore(factory)).put(entryAfterLoad(null, link(), 1));
    expect(await (await idbLibraryStore(factory)).list()).toHaveLength(1);
  });
});

describe('openLibraryStore', () => {
  it('falls back to memory, with one warning, when IndexedDB is absent', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await openLibraryStore();
    await store.put(entryAfterLoad(null, link(), 1));
    expect(await store.list()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to memory when the database will not open', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('blocked');
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await openLibraryStore();
    expect(await store.list()).toEqual([]);
  });
});
