/**
 * Unit tests for the settings object: defaults, field-by-field validation of
 * whatever storage hands back, the save/load round trip and the behaviour on
 * the real localStorage adapter when storage is broken. Stores are in-memory
 * or a fake Storage, so no DOM is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  MAX_LATENCY_S,
  sanitizeSettings,
  saveSettings,
  SETTINGS_KEY,
} from '../src/app/settings';
import type { Settings } from '../src/app/settings';
import { localStorageStore, memoryStore } from '../src/app/storage';
import type { StorageLike } from '../src/app/storage';

function storeWith(json: string) {
  const store = memoryStore();
  store.set(SETTINGS_KEY, json);
  return store;
}

describe('DEFAULT_SETTINGS', () => {
  it('has the documented values', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      inputDeviceId: null,
      outputDeviceId: null,
      serviceUrl: 'http://localhost:8765',
      clarityThreshold: 0.9,
      octaveInvariant: false,
      latencyByDevicePair: {},
    });
  });

  it('is frozen, so a stray write cannot change later defaults', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.latencyByDevicePair)).toBe(true);
  });
});

describe('loadSettings', () => {
  it('returns the defaults for an empty store', () => {
    expect(loadSettings(memoryStore())).toEqual(DEFAULT_SETTINGS);
  });

  it('returns a fresh object whose latency map can be edited', () => {
    const a = loadSettings(memoryStore());
    a.latencyByDevicePair['latency.x|y'] = 0.1;
    expect(loadSettings(memoryStore()).latencyByDevicePair).toEqual({});
    expect(DEFAULT_SETTINGS.latencyByDevicePair).toEqual({});
  });

  it('merges stored fields over the defaults', () => {
    const s = loadSettings(storeWith(JSON.stringify({ serviceUrl: 'https://svc.example:9000' })));
    expect(s).toEqual({ ...DEFAULT_SETTINGS, serviceUrl: 'https://svc.example:9000' });
  });

  it('falls back to the defaults on corrupt or non-object JSON', () => {
    for (const text of ['{oops', '', '42', 'null', '[]', '"text"', 'true']) {
      expect(loadSettings(storeWith(text)), text).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('judges each field alone, keeping the good ones', () => {
    const s = loadSettings(
      storeWith(
        JSON.stringify({
          inputDeviceId: 'mic-1',
          outputDeviceId: 7,
          serviceUrl: 'ftp://nope',
          clarityThreshold: 0.75,
          octaveInvariant: 'yes',
          latencyByDevicePair: { 'latency.a|b': 0.12 },
        }),
      ),
    );
    expect(s).toEqual({
      inputDeviceId: 'mic-1',
      outputDeviceId: null,
      serviceUrl: DEFAULT_SETTINGS.serviceUrl,
      clarityThreshold: 0.75,
      octaveInvariant: false,
      latencyByDevicePair: { 'latency.a|b': 0.12 },
    });
  });

  it('turns an empty device id into null', () => {
    const s = sanitizeSettings({ inputDeviceId: '', outputDeviceId: '' });
    expect(s.inputDeviceId).toBeNull();
    expect(s.outputDeviceId).toBeNull();
  });

  it('accepts only http(s) URLs and strips whitespace and trailing slashes', () => {
    expect(sanitizeSettings({ serviceUrl: ' http://localhost:1234/// ' }).serviceUrl).toBe(
      'http://localhost:1234',
    );
    expect(sanitizeSettings({ serviceUrl: 'https://a.b/api/' }).serviceUrl).toBe('https://a.b/api');
    for (const bad of ['', 'localhost:8765', 'not a url', 'file:///etc/passwd', 'tauri://localhost', 5, null]) {
      expect(sanitizeSettings({ serviceUrl: bad }).serviceUrl, String(bad)).toBe(
        DEFAULT_SETTINGS.serviceUrl,
      );
    }
  });

  it('accepts a clarity threshold in 0..1 and nothing else', () => {
    expect(sanitizeSettings({ clarityThreshold: 0 }).clarityThreshold).toBe(0);
    expect(sanitizeSettings({ clarityThreshold: 1 }).clarityThreshold).toBe(1);
    for (const bad of [-0.1, 1.01, 5, NaN, Infinity, '0.5', null, undefined]) {
      expect(sanitizeSettings({ clarityThreshold: bad }).clarityThreshold, String(bad)).toBe(0.9);
    }
  });

  it('keeps plausible latencies and drops the rest', () => {
    const s = sanitizeSettings({
      latencyByDevicePair: {
        ok: 0.08,
        zero: 0,
        max: MAX_LATENCY_S,
        negative: -0.01,
        tooLong: MAX_LATENCY_S + 0.001,
        text: '0.1',
        nothing: null,
        nan: NaN,
      },
    });
    expect(s.latencyByDevicePair).toEqual({ ok: 0.08, zero: 0, max: MAX_LATENCY_S });
  });

  it('ignores a latency map that is not an object', () => {
    for (const bad of [[0.1], 'x', 3, null]) {
      expect(sanitizeSettings({ latencyByDevicePair: bad }).latencyByDevicePair).toEqual({});
    }
  });

  it('keeps a "__proto__" key from touching the prototype', () => {
    const s = loadSettings(
      storeWith('{"latencyByDevicePair":{"__proto__":1,"a":0.1}}'),
    );
    expect(Object.getPrototypeOf(s.latencyByDevicePair)).toBe(Object.prototype);
    expect(s.latencyByDevicePair.a).toBe(0.1);
    expect(({} as Record<string, unknown>).constructor).toBe(Object);
  });
});

describe('saveSettings', () => {
  const custom: Settings = {
    inputDeviceId: 'in-1',
    outputDeviceId: 'out-1',
    serviceUrl: 'http://127.0.0.1:9999',
    clarityThreshold: 0.8,
    octaveInvariant: true,
    latencyByDevicePair: { 'latency.out-1|in-1': 0.143 },
  };

  it('round-trips through a store', () => {
    const store = memoryStore();
    saveSettings(store, custom);
    expect(loadSettings(store)).toEqual(custom);
  });

  it('writes one JSON object under the "settings" key', () => {
    const store = memoryStore();
    saveSettings(store, custom);
    expect(JSON.parse(store.get('settings') ?? 'null')).toEqual(custom);
  });

  it('never persists values that load would reject', () => {
    const store = memoryStore();
    saveSettings(store, {
      ...custom,
      clarityThreshold: 7,
      serviceUrl: 'junk',
      latencyByDevicePair: { good: 0.1, bad: -1 },
    });
    expect(loadSettings(store)).toEqual({
      ...custom,
      clarityThreshold: 0.9,
      serviceUrl: DEFAULT_SETTINGS.serviceUrl,
      latencyByDevicePair: { good: 0.1 },
    });
  });

  it('works through the localStorage adapter under the encore. prefix', () => {
    const data = new Map<string, string>();
    const storage: StorageLike = {
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
    const store = localStorageStore('encore.', () => storage);
    saveSettings(store, custom);
    expect([...data.keys()]).toEqual(['encore.settings']);
    expect(loadSettings(localStorageStore('encore.', () => storage))).toEqual(custom);
  });

  it('survives storage that refuses writes', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = localStorageStore('encore.', () => storage);
    expect(() => saveSettings(store, custom)).not.toThrow();
    // The store remembers the write in memory, so this session still sees it.
    expect(loadSettings(store)).toEqual(custom);
  });
});
