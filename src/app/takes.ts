/**
 * Take storage. A take is one recorded attempt at a song: the WAV blob, the
 * live pitch frames, the latency it was recorded with, the clock its song time
 * came from (the audio engine's, or an embedded video's approximate one),
 * learning mode's report on it, when there was a melody to compare with, and,
 * later, the service's analysis. They live in IndexedDB (see "Storage" in
 * docs/ARCHITECTURE.md) because a WAV outgrows localStorage within a minute.
 * The store sits behind the small TakeStore interface so the shell can swap in
 * a native one, and so everything that lists or plays takes can be tested
 * against the in-memory version. When IndexedDB is missing or refuses to open
 * (private windows, blocked site data) the app keeps working on a memory store
 * and takes last until the page closes.
 */
import type { PitchFrame } from '../analysis/pitch';
import type { TakeReport } from '../analysis/score';

/**
 * The clock a take's song time came from: the audio engine's sample-accurate
 * one, or a YouTube embed's reported time, which is only approximate.
 */
export type TakeClock = 'engine' | 'embed';

/** The list-view slice of a take: everything except the heavy payloads. */
export interface TakeSummary {
  id: string;
  songHash: string;
  songName: string;
  /** Epoch milliseconds when the take was saved. */
  createdAt: number;
  durationS: number;
  /**
   * Total latency the take was aligned with: the calibrated round trip, plus
   * the embed offset when the clock is 'embed'.
   */
  latencyS: number;
  sampleRate: number;
  /**
   * Song time of the WAV's first sample before the latency shift (see
   * songTimeOfSample in audio/wav.ts). Optional only so a take saved without
   * it still loads; playback treats a missing value as 0.
   */
  startedAtSongS?: number;
  /** Absent on takes saved before embedded video; read it with takeClockOf. */
  clock?: TakeClock;
  /**
   * Learning mode's measurements of the take against the melody. Absent on a
   * take recorded in karaoke mode, without a melody, or before learning mode
   * existed; such a take has no card.
   */
  report?: TakeReport;
}

/** The clock of a take; takes saved without one came from the engine. */
export function takeClockOf(take: Pick<TakeSummary, 'clock'>): TakeClock {
  return take.clock === 'embed' ? 'embed' : 'engine';
}

/** A stored take with its payloads. */
export interface TakeRecord extends TakeSummary {
  frames: PitchFrame[];
  wav: Blob;
  /** Service analysis, shaped by the service client; opaque here. */
  analysis?: unknown;
}

/** Async persistence for takes. */
export interface TakeStore {
  /** Stores a take under a fresh id and resolves with that id. */
  save(take: Omit<TakeRecord, 'id'>): Promise<string>;
  /** Summaries, newest first; only one song's when `songHash` is given. */
  list(songHash?: string): Promise<TakeSummary[]>;
  /** The full take, or null when the id is unknown. */
  get(id: string): Promise<TakeRecord | null>;
  /** Deletes a take; an unknown id is not an error. */
  remove(id: string): Promise<void>;
  /** Replaces a take's report (a re-score); an unknown id is not an error. */
  setReport(id: string, report: TakeReport): Promise<void>;
}

/** Database name, version, store and index, fixed by the storage design. */
const DB_NAME = 'encore';
const DB_VERSION = 1;
const STORE = 'takes';
const SONG_INDEX = 'songHash';

/** Random hex digits, from the crypto source when the platform has one. */
function randomHex(digits: number): string {
  const bytes = new Uint8Array(Math.ceil(digits / 2));
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, digits);
}

/**
 * A fresh take id: a UUID where `crypto.randomUUID` exists (it needs a secure
 * context), otherwise the time in hex followed by random hex.
 */
export function newTakeId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `${Date.now().toString(16)}-${randomHex(16)}`;
}

/** Drops the payloads from a record, keeping only list-view fields. */
function toSummary(record: TakeRecord): TakeSummary {
  const summary: TakeSummary = {
    id: record.id,
    songHash: record.songHash,
    songName: record.songName,
    createdAt: record.createdAt,
    durationS: record.durationS,
    latencyS: record.latencyS,
    sampleRate: record.sampleRate,
  };
  if (record.startedAtSongS !== undefined) summary.startedAtSongS = record.startedAtSongS;
  if (record.clock !== undefined) summary.clock = record.clock;
  if (record.report !== undefined) summary.report = record.report;
  return summary;
}

/** Newest first. Ties keep their incoming order (the sort is stable). */
function newestFirst(summaries: TakeSummary[]): TakeSummary[] {
  return summaries.sort((a, b) => b.createdAt - a.createdAt);
}

/** Copies a record so the store and its callers never share frame objects. */
function cloneRecord(record: TakeRecord): TakeRecord {
  // The blob is immutable and shared on purpose; copying audio would double
  // the memory for nothing.
  return { ...record, frames: record.frames.map((f) => ({ ...f })) };
}

/** In-memory store: the fallback when IndexedDB is out, and the test double. */
export function memoryTakeStore(): TakeStore {
  const records = new Map<string, TakeRecord>();
  return {
    async save(take) {
      const id = newTakeId();
      records.set(id, cloneRecord({ ...take, id }));
      return id;
    },
    async list(songHash) {
      // Reversed so equal timestamps list the take saved last first.
      const all = [...records.values()].reverse();
      const wanted = songHash === undefined ? all : all.filter((r) => r.songHash === songHash);
      return newestFirst(wanted.map(toSummary));
    },
    async get(id) {
      const record = records.get(id);
      return record ? cloneRecord(record) : null;
    },
    async remove(id) {
      records.delete(id);
    },
    async setReport(id, report) {
      const record = records.get(id);
      if (record) records.set(id, { ...record, report });
    },
  };
}

/** Settles with a request's result, or rejects with its error. */
function resultOf<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Settles once a transaction has committed, so a save is really on disk. */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    // A quota failure aborts the transaction and may fire only this.
    tx.onabort = () => reject(tx.error ?? new Error('Take storage transaction aborted'));
  });
}

/** Opens (creating on first use) the take database on `factory`. */
function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex(SONG_INDEX, 'songHash');
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Let a future version upgrade proceed instead of waiting on this tab.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Take database is blocked by another tab'));
  });
}

/**
 * Take store on an IndexedDB factory. Exported so tests can pass a fresh
 * in-memory factory per case; the app goes through `openTakeStore`.
 */
export async function idbTakeStore(factory: IDBFactory, name: string = DB_NAME): Promise<TakeStore> {
  const db = await openDatabase(factory, name);
  return {
    async save(take) {
      const id = newTakeId();
      const tx = db.transaction(STORE, 'readwrite');
      const done = committed(tx);
      tx.objectStore(STORE).put({ ...take, id });
      await done;
      return id;
    },
    async list(songHash) {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      // A bare key means "only this key", and avoids the IDBKeyRange global,
      // which the injected factory may not share.
      const request = songHash === undefined ? store.openCursor() : store.index(SONG_INDEX).openCursor(songHash);
      const summaries: TakeSummary[] = [];
      // A cursor hands records over one at a time, so each frames array and
      // blob can be dropped as soon as its summary is taken.
      await new Promise<void>((resolve, reject) => {
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          summaries.push(toSummary(cursor.value as TakeRecord));
          cursor.continue();
        };
      });
      return newestFirst(summaries);
    },
    async get(id) {
      const tx = db.transaction(STORE, 'readonly');
      const record = (await resultOf(tx.objectStore(STORE).get(id))) as TakeRecord | undefined;
      return record ?? null;
    },
    async remove(id) {
      const tx = db.transaction(STORE, 'readwrite');
      const done = committed(tx);
      tx.objectStore(STORE).delete(id);
      await done;
    },
    async setReport(id, report) {
      const tx = db.transaction(STORE, 'readwrite');
      const done = committed(tx);
      const store = tx.objectStore(STORE);
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as TakeRecord | undefined;
        if (record) store.put({ ...record, report });
      };
      await done;
    },
  };
}

/** The platform's IndexedDB factory, or null if absent or access throws. */
function browserIndexedDb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens the take store: IndexedDB `encore` v1 when available, otherwise a
 * memory store and one console warning saying takes will not survive a reload.
 */
export async function openTakeStore(): Promise<TakeStore> {
  const factory = browserIndexedDb();
  if (!factory) {
    console.warn('Encore: IndexedDB is unavailable; takes stay in memory and are lost on reload.');
    return memoryTakeStore();
  }
  try {
    return await idbTakeStore(factory);
  } catch (error) {
    console.warn('Encore: take database would not open; takes stay in memory and are lost on reload.', error);
    return memoryTakeStore();
  }
}
