/**
 * The Library: every song the singer has loaded, a YouTube link or an
 * uploaded file, kept in the browser so it can be loaded again with a click
 * and so favorites survive a reload. One record per song, keyed by the same
 * hash the takes use (`yt-<video id>` for a link, the file's sha256 for an
 * upload), which is also what dedupes: loading a song twice updates its
 * record. Records live in their own IndexedDB database, behind the small
 * LibraryStore interface, so tests run on the memory version and a native
 * shell can swap the store; without IndexedDB the Library lasts until the
 * page closes. Reading is forgiving: a record from an older version, or one
 * edited by hand, is repaired field by field and a record that cannot be
 * repaired is dropped, never thrown on.
 */

/** Where a song came from. */
export type LibrarySource = 'youtube' | 'file';

/** One song in the Library. */
export interface LibraryEntry {
  /** The song hash (see above); the dedupe key. */
  id: string;
  source: LibrarySource;
  title: string;
  /** The video, for a link; null for a file. */
  videoId: string | null;
  /** The file's name, for an upload; null for a link. */
  fileName: string | null;
  /** Length in seconds; 0 where it was not known. */
  durationS: number;
  /** Epoch milliseconds when the song was first loaded. */
  addedAt: number;
  /** Epoch milliseconds when it was last loaded, or null. */
  lastPlayedAt: number | null;
  /** True once the karaoke stems were made and loaded for it. */
  stems: boolean;
  /** True once a melody was read for it: its own, or an aligned original's. */
  melody: boolean;
  /** True once the service read a key from the song. */
  key: boolean;
  favorite: boolean;
  /** Place among the favorites, ascending; meaningful only when favorite. */
  order: number;
}

/** Async persistence for the Library. */
export interface LibraryStore {
  /** Every entry, most recently played (or added) first. */
  list(): Promise<LibraryEntry[]>;
  /** The entry, or null when the id is unknown. */
  get(id: string): Promise<LibraryEntry | null>;
  /** Adds or replaces an entry. */
  put(entry: LibraryEntry): Promise<void>;
  /** Replaces many entries in one go (a reorder). */
  putMany(entries: readonly LibraryEntry[]): Promise<void>;
  /** Deletes an entry; an unknown id is not an error. */
  remove(id: string): Promise<void>;
}

const DB_NAME = 'encore-library';
const DB_VERSION = 1;
const STORE = 'songs';
const TITLE_MAX = 200;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** The song hash of a YouTube video. */
export function youtubeSongId(videoId: string): string {
  return `yt-${videoId}`;
}

/** True when `text` is shaped like a YouTube video id. */
export function isVideoId(text: unknown): text is string {
  return typeof text === 'string' && VIDEO_ID.test(text);
}

/** A clean title: a string, trimmed and cut short; the fallback if blank. */
export function cleanTitle(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim().slice(0, TITLE_MAX).trim() : '';
  return text !== '' ? text : fallback;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Repairs a stored record into an entry, or null when there is no telling
 * what song it was. Missing fields take their defaults, so a record written
 * by an earlier version still loads.
 */
export function sanitiseEntry(raw: unknown): LibraryEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '' || r.id.length > 100) return null;
  const id = r.id;
  const source: LibrarySource =
    r.source === 'file' || r.source === 'youtube' ? r.source : id.startsWith('yt-') ? 'youtube' : 'file';
  let videoId: string | null = null;
  if (source === 'youtube') {
    videoId = isVideoId(r.videoId) ? r.videoId : id.startsWith('yt-') ? id.slice(3) : null;
    if (!isVideoId(videoId)) return null;
  }
  const fileName = source === 'file' && typeof r.fileName === 'string' ? r.fileName.slice(0, TITLE_MAX) : null;
  const addedAt = Math.max(0, finiteOr(r.addedAt, 0));
  const lastPlayed = typeof r.lastPlayedAt === 'number' && Number.isFinite(r.lastPlayedAt);
  return {
    id,
    source,
    title: cleanTitle(r.title, fileName ?? videoId ?? id),
    videoId,
    fileName,
    durationS: Math.max(0, finiteOr(r.durationS, 0)),
    addedAt,
    lastPlayedAt: lastPlayed ? (r.lastPlayedAt as number) : null,
    stems: r.stems === true,
    melody: r.melody === true,
    key: r.key === true,
    favorite: r.favorite === true,
    order: finiteOr(r.order, 0),
  };
}

/** What a successful load tells the Library about a song. */
export interface LoadedSong {
  id: string;
  source: LibrarySource;
  title: string;
  videoId: string | null;
  fileName: string | null;
  durationS: number;
}

/**
 * The entry a load leaves behind: a new one, or the old one with its title,
 * length and last-played time refreshed. Favorite, order, and what has been
 * prepared are the song's own and carry over.
 */
export function entryAfterLoad(existing: LibraryEntry | null, song: LoadedSong, now: number): LibraryEntry {
  const title = cleanTitle(song.title, song.fileName ?? song.videoId ?? song.id);
  const durationS = song.durationS > 0 ? song.durationS : (existing?.durationS ?? 0);
  if (existing) return { ...existing, title, durationS, lastPlayedAt: now };
  return {
    id: song.id,
    source: song.source,
    title,
    videoId: song.videoId,
    fileName: song.fileName,
    durationS,
    addedAt: now,
    lastPlayedAt: now,
    stems: false,
    melody: false,
    key: false,
    favorite: false,
    order: 0,
  };
}

/** Most recently played (or added) first; ties keep their incoming order. */
export function newestFirst(entries: LibraryEntry[]): LibraryEntry[] {
  const when = (e: LibraryEntry): number => e.lastPlayedAt ?? e.addedAt;
  return entries.sort((a, b) => when(b) - when(a));
}

/** In-memory store: the fallback when IndexedDB is out, and the test double. */
export function memoryLibraryStore(): LibraryStore {
  const records = new Map<string, LibraryEntry>();
  return {
    async list() {
      return newestFirst([...records.values()].reverse().map((e) => ({ ...e })));
    },
    async get(id) {
      const found = records.get(id);
      return found ? { ...found } : null;
    },
    async put(entry) {
      records.set(entry.id, { ...entry });
    },
    async putMany(entries) {
      for (const entry of entries) records.set(entry.id, { ...entry });
    },
    async remove(id) {
      records.delete(id);
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
    tx.onabort = () => reject(tx.error ?? new Error('Library transaction aborted'));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Library database is blocked by another tab'));
  });
}

/**
 * Library store on an IndexedDB factory. Exported so tests can pass a fresh
 * in-memory factory per case; the app goes through `openLibraryStore`.
 */
export async function idbLibraryStore(factory: IDBFactory, name: string = DB_NAME): Promise<LibraryStore> {
  const db = await openDatabase(factory, name);
  async function write(entries: readonly LibraryEntry[]): Promise<void> {
    const tx = db.transaction(STORE, 'readwrite');
    const done = committed(tx);
    for (const entry of entries) tx.objectStore(STORE).put(entry);
    await done;
  }
  return {
    async list() {
      const tx = db.transaction(STORE, 'readonly');
      const all = (await resultOf(tx.objectStore(STORE).getAll())) as unknown[];
      const entries: LibraryEntry[] = [];
      for (const raw of all) {
        const entry = sanitiseEntry(raw);
        if (entry) entries.push(entry);
      }
      return newestFirst(entries);
    },
    async get(id) {
      const tx = db.transaction(STORE, 'readonly');
      return sanitiseEntry(await resultOf(tx.objectStore(STORE).get(id)));
    },
    put: (entry) => write([entry]),
    putMany: (entries) => write(entries),
    async remove(id) {
      const tx = db.transaction(STORE, 'readwrite');
      const done = committed(tx);
      tx.objectStore(STORE).delete(id);
      await done;
    },
  };
}

/**
 * Opens the Library: IndexedDB `encore-library` when available, otherwise a
 * memory store and one console warning.
 */
export async function openLibraryStore(): Promise<LibraryStore> {
  let factory: IDBFactory | null = null;
  try {
    factory = globalThis.indexedDB ?? null;
  } catch {
    factory = null;
  }
  if (!factory) {
    console.warn('Encore: IndexedDB is unavailable; the Library stays in memory and is lost on reload.');
    return memoryLibraryStore();
  }
  try {
    return await idbLibraryStore(factory);
  } catch (error) {
    console.warn('Encore: library database would not open; the Library stays in memory.', error);
    return memoryLibraryStore();
  }
}
