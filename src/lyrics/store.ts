/**
 * Lyrics cached per song, keyed by the song hash the takes use, in a small
 * IndexedDB database of its own so nothing else's schema is touched. What is
 * kept is the text as found or pasted (LRC or plain), where it came from, the
 * singer's nudge and their show/hide choice for the song. When IndexedDB is
 * out the memory store stands in and one console warning says so.
 */

/** Everything remembered about one song's lyrics. */
export interface LyricsRecord {
  songHash: string;
  /** LRC text when `synced`, else plain lyrics. */
  text: string;
  synced: boolean;
  source: 'lrclib' | 'pasted';
  title: string;
  artist: string;
  /** Seconds the lines are moved sooner (+) or later (-), per song. */
  nudgeS: number;
  /** The singer's own show or hide; absent means the default for the song. */
  shown?: boolean;
}

/** Lyrics by song hash. */
export interface LyricsStore {
  get(songHash: string): Promise<LyricsRecord | null>;
  put(record: LyricsRecord): Promise<void>;
  remove(songHash: string): Promise<void>;
}

const DB_NAME = 'encore-lyrics';
const STORE = 'lyrics';

/** In-memory store: the fallback when IndexedDB is out, and the test double. */
export function memoryLyricsStore(): LyricsStore {
  const records = new Map<string, LyricsRecord>();
  return {
    async get(songHash) {
      const found = records.get(songHash);
      return found ? { ...found } : null;
    },
    async put(record) {
      records.set(record.songHash, { ...record });
    },
    async remove(songHash) {
      records.delete(songHash);
    },
  };
}

function resultOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Lyrics storage transaction aborted'));
  });
}

/** Store on an IndexedDB factory; tests pass a fresh in-memory one. */
export function idbLyricsStore(factory: IDBFactory, name: string = DB_NAME): Promise<LyricsStore> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'songHash' });
      }
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Lyrics database is blocked by another tab'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve({
        async get(songHash) {
          const tx = db.transaction(STORE, 'readonly');
          const found = (await resultOf(tx.objectStore(STORE).get(songHash))) as LyricsRecord | undefined;
          return found ?? null;
        },
        async put(record) {
          const tx = db.transaction(STORE, 'readwrite');
          const done = committed(tx);
          tx.objectStore(STORE).put(record);
          await done;
        },
        async remove(songHash) {
          const tx = db.transaction(STORE, 'readwrite');
          const done = committed(tx);
          tx.objectStore(STORE).delete(songHash);
          await done;
        },
      });
    };
  });
}

/** Opens the lyrics cache: IndexedDB when it works, otherwise memory. */
export async function openLyricsStore(): Promise<LyricsStore> {
  let factory: IDBFactory | null = null;
  try {
    factory = globalThis.indexedDB ?? null;
  } catch {
    factory = null;
  }
  if (!factory) {
    console.warn('Encore: IndexedDB is unavailable; lyrics stay in memory and are lost on reload.');
    return memoryLyricsStore();
  }
  try {
    return await idbLyricsStore(factory);
  } catch (error) {
    console.warn('Encore: lyrics database would not open; lyrics stay in memory.', error);
    return memoryLyricsStore();
  }
}

/** A store that opens the cache on first use, so mounting costs nothing. */
export function lazyLyricsStore(open: () => Promise<LyricsStore> = openLyricsStore): LyricsStore {
  let opened: Promise<LyricsStore> | null = null;
  const ready = (): Promise<LyricsStore> => (opened ??= open());
  return {
    get: async (songHash) => (await ready()).get(songHash),
    put: async (record) => (await ready()).put(record),
    remove: async (songHash) => (await ready()).remove(songHash),
  };
}
