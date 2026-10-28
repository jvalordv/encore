/**
 * Unit tests for take storage. The same behavioural suite runs against the
 * in-memory store and the IndexedDB store (backed by fake-indexeddb, one fresh
 * factory per case), then the IndexedDB-specific parts are checked: schema,
 * persistence across reopen, and the fallback paths of openTakeStore.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PitchFrame } from '../src/analysis/pitch';
import { idbTakeStore, memoryTakeStore, newTakeId, openTakeStore, takeClockOf } from '../src/app/takes';
import type { TakeRecord, TakeStore } from '../src/app/takes';
import type { TakeReport } from '../src/analysis/score';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function frames(n: number): PitchFrame[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 0.01, f0: 220 + i, clarity: 0.95, rms: 0.2 }));
}

/** A take as the shell would hand it over, minus the id. */
function make(over: Partial<Omit<TakeRecord, 'id'>> = {}): Omit<TakeRecord, 'id'> {
  return {
    songHash: 'aaaa',
    songName: 'Song A',
    createdAt: 1000,
    durationS: 3,
    latencyS: 0.12,
    sampleRate: 48000,
    startedAtSongS: 4.5,
    frames: frames(5),
    wav: new Blob([Uint8Array.of(1, 2, 3, 4)], { type: 'audio/wav' }),
    ...over,
  };
}

const stores: [string, () => Promise<TakeStore>][] = [
  ['memoryTakeStore', async () => memoryTakeStore()],
  ['idbTakeStore', () => idbTakeStore(new IDBFactory())],
];

describe.each(stores)('%s', (_name, open) => {
  it('saves under a fresh id and reads the whole take back', async () => {
    const store = await open();
    const take = make();
    const id = await store.save(take);
    expect(id).toBeTruthy();
    const got = await store.get(id);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({ ...take, id, wav: expect.any(Blob) });
    expect(got?.frames).toEqual(take.frames);
    expect(got?.wav.type).toBe('audio/wav');
    expect(Array.from(new Uint8Array(await got!.wav.arrayBuffer()))).toEqual([1, 2, 3, 4]);
  });

  it('gives each save its own id', async () => {
    const store = await open();
    const ids = await Promise.all([store.save(make()), store.save(make()), store.save(make())]);
    expect(new Set(ids).size).toBe(3);
  });

  it('lists newest first, without frames or audio', async () => {
    const store = await open();
    const old = await store.save(make({ createdAt: 100, songName: 'old' }));
    const newest = await store.save(make({ createdAt: 300, songName: 'newest' }));
    const mid = await store.save(make({ createdAt: 200, songName: 'mid' }));
    const list = await store.list();
    expect(list.map((t) => t.id)).toEqual([newest, mid, old]);
    for (const summary of list) {
      expect(Object.keys(summary).sort()).toEqual(
        ['createdAt', 'durationS', 'id', 'latencyS', 'sampleRate', 'songHash', 'songName', 'startedAtSongS'].sort(),
      );
    }
    expect(list[0]).toMatchObject({ songName: 'newest', durationS: 3, latencyS: 0.12, sampleRate: 48000 });
  });

  it('filters the list by song hash', async () => {
    const store = await open();
    const a1 = await store.save(make({ songHash: 'aaaa', createdAt: 1 }));
    await store.save(make({ songHash: 'bbbb', createdAt: 2 }));
    const a2 = await store.save(make({ songHash: 'aaaa', createdAt: 3 }));
    expect((await store.list('aaaa')).map((t) => t.id)).toEqual([a2, a1]);
    expect((await store.list('bbbb')).length).toBe(1);
    expect(await store.list('nope')).toEqual([]);
    expect((await store.list()).length).toBe(3);
  });

  it('omits startedAtSongS from the summary of a take saved without it', async () => {
    const store = await open();
    const { startedAtSongS: _drop, ...bare } = make();
    const id = await store.save(bare);
    const [summary] = await store.list();
    expect(summary.id).toBe(id);
    expect('startedAtSongS' in summary).toBe(false);
  });

  it('replaces a take’s report and leaves the rest of it alone', async () => {
    const store = await open();
    const id = await store.save(make({ createdAt: 5 }));
    const report = { style: 'open', notesCovered: 2 } as unknown as TakeReport;
    await store.setReport(id, report);
    expect((await store.get(id))?.report).toEqual(report);
    expect((await store.list())[0].report).toEqual(report);
    expect((await store.get(id))?.frames).toEqual(make().frames);
    await store.setReport('no-such-take', report);
    expect(await store.get('no-such-take')).toBeNull();
  });

  it('keeps the clock a take was recorded on, in the list and in the full take', async () => {
    const store = await open();
    const engine = await store.save(make({ clock: 'engine', createdAt: 1 }));
    const embed = await store.save(make({ clock: 'embed', createdAt: 2 }));
    const list = await store.list();
    expect(list.map((t) => [t.id, t.clock])).toEqual([
      [embed, 'embed'],
      [engine, 'engine'],
    ]);
    expect((await store.get(embed))?.clock).toBe('embed');
    expect((await store.get(engine))?.clock).toBe('engine');
  });

  it('leaves the clock out of the summary of a take saved without one', async () => {
    const store = await open();
    const id = await store.save(make());
    const [summary] = await store.list();
    expect(summary.id).toBe(id);
    expect('clock' in summary).toBe(false);
    // Takes from before the embed existed read as engine takes.
    expect(takeClockOf(summary)).toBe('engine');
  });

  it('keeps analysis when present', async () => {
    const store = await open();
    const id = await store.save(make({ analysis: { score: 87, notes: [1, 2] } }));
    expect((await store.get(id))?.analysis).toEqual({ score: 87, notes: [1, 2] });
  });

  it('returns null for an unknown id', async () => {
    const store = await open();
    expect(await store.get('missing')).toBeNull();
  });

  it('removes a take, and removing an unknown id is harmless', async () => {
    const store = await open();
    const keep = await store.save(make({ createdAt: 1 }));
    const gone = await store.save(make({ createdAt: 2 }));
    await store.remove(gone);
    await store.remove('never-existed');
    expect(await store.get(gone)).toBeNull();
    expect((await store.list()).map((t) => t.id)).toEqual([keep]);
  });

  it('is not changed by later edits to what was saved or returned', async () => {
    const store = await open();
    const take = make();
    const id = await store.save(take);
    take.frames[0].f0 = 9999;
    const first = await store.get(id);
    first!.frames[1].f0 = 8888;
    const second = await store.get(id);
    expect(second?.frames[0].f0).toBe(220);
    expect(second?.frames[1].f0).toBe(221);
  });
});

describe('idbTakeStore storage layout', () => {
  it('creates db encore v1 with a takes store keyed by id and a songHash index', async () => {
    const factory = new IDBFactory();
    await idbTakeStore(factory);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open('encore');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.version).toBe(1);
    expect(Array.from(db.objectStoreNames)).toEqual(['takes']);
    const store = db.transaction('takes').objectStore('takes');
    expect(store.keyPath).toBe('id');
    expect(Array.from(store.indexNames)).toEqual(['songHash']);
    expect(store.index('songHash').keyPath).toBe('songHash');
    db.close();
  });

  it('keeps takes across a reopen of the same database', async () => {
    const factory = new IDBFactory();
    const first = await idbTakeStore(factory);
    const id = await first.save(make({ songName: 'persisted' }));
    const second = await idbTakeStore(factory);
    expect((await second.get(id))?.songName).toBe('persisted');
    expect((await second.list()).length).toBe(1);
  });
});

describe('openTakeStore', () => {
  it('uses IndexedDB when present and stays quiet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    const store = await openTakeStore();
    const id = await store.save(make());
    // A second store on the same factory sees it, so it really is IndexedDB.
    expect((await (await idbTakeStore(factory)).get(id))?.songName).toBe('Song A');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to memory with exactly one warning when IndexedDB is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', undefined);
    const store = await openTakeStore();
    expect(warn).toHaveBeenCalledTimes(1);
    const id = await store.save(make());
    expect((await store.get(id))?.songName).toBe('Song A');
  });

  it('falls back to memory with one warning when the database will not open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('indexedDB', {
      open() {
        const request: { onerror?: () => void; error: Error } = { error: new Error('blocked by policy') };
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    });
    const store = await openTakeStore();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await store.list()).toEqual([]);
  });

  it('falls back to memory when reading indexedDB throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      const store = await openTakeStore();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(await store.list()).toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, 'indexedDB');
    }
  });
});

describe('takeClockOf', () => {
  it('reads the embed clock as embed and everything else as the engine', () => {
    expect(takeClockOf({ clock: 'embed' })).toBe('embed');
    expect(takeClockOf({ clock: 'engine' })).toBe('engine');
    expect(takeClockOf({})).toBe('engine');
    expect(takeClockOf({ clock: 'sundial' as never })).toBe('engine');
  });
});

describe('newTakeId', () => {
  it('uses randomUUID when the platform has it', () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-from-platform' });
    expect(newTakeId()).toBe('uuid-from-platform');
  });

  it('builds time plus random hex when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {});
    vi.spyOn(Date, 'now').mockReturnValue(0x1234abcd);
    const id = newTakeId();
    expect(id).toMatch(/^1234abcd-[0-9a-f]{16}$/);
    expect(new Set(Array.from({ length: 50 }, newTakeId)).size).toBe(50);
  });

  it('still works with no crypto object at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(newTakeId()).toMatch(/^[0-9a-f]+-[0-9a-f]{16}$/);
  });

  it('gives distinct ids from the real source', () => {
    expect(new Set(Array.from({ length: 100 }, newTakeId)).size).toBe(100);
  });
});

describe('memoryTakeStore ordering', () => {
  it('lists the take saved last first when timestamps tie', async () => {
    const store = memoryTakeStore();
    const first = await store.save(make({ createdAt: 5 }));
    const second = await store.save(make({ createdAt: 5 }));
    expect((await store.list()).map((t) => t.id)).toEqual([second, first]);
  });
});
