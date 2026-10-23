/**
 * Small string key-value store used for settings, calibration and the other
 * per-device conveniences. The interface exists so a native shell can swap in
 * its own backing store later (see "Built to become an app" in
 * docs/ARCHITECTURE.md), and so logic that reads settings can be tested with
 * an in-memory store. The localStorage-backed store never throws: private
 * windows, blocked site data and full quotas degrade to memory.
 */

/** Synchronous string store. Missing keys read as null. */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The slice of the Web Storage API this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Key prefix matching the existing `encore.skin` setting. */
const DEFAULT_PREFIX = 'encore.';

/** In-memory store; also the fallback when persistent storage fails. */
export function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    remove: (key) => void values.delete(key),
  };
}

/** Looks up `localStorage`, which can throw on access, so it is not cached. */
function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Store backed by `localStorage` under `prefix`. Every call is guarded. A
 * write or delete that storage refuses is remembered in memory (a null entry
 * means "deleted"), and memory wins on read, so the value the caller last set
 * is what they get back even when an older one is still persisted. `storage`
 * is injectable so tests need no DOM.
 */
export function localStorageStore(
  prefix: string = DEFAULT_PREFIX,
  storage: () => StorageLike | null = browserStorage,
): KeyValueStore {
  const unsaved = new Map<string, string | null>();
  return {
    get(key) {
      if (unsaved.has(key)) return unsaved.get(key) ?? null;
      try {
        return storage()?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        const store = storage();
        if (!store) throw new Error('storage unavailable');
        store.setItem(prefix + key, value);
        unsaved.delete(key);
      } catch {
        unsaved.set(key, value);
      }
    },
    remove(key) {
      try {
        const store = storage();
        if (!store) throw new Error('storage unavailable');
        store.removeItem(prefix + key);
        unsaved.delete(key);
      } catch {
        unsaved.set(key, null);
      }
    },
  };
}
