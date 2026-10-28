/**
 * Unit tests for the settings object: defaults, field-by-field validation of
 * whatever storage hands back, the save/load round trip and the behaviour on
 * the real localStorage adapter when storage is broken. Stores are in-memory
 * or a fake Storage, so no DOM is needed.
 */
import { describe, expect, it } from 'vitest';
import {
  clampEmbedOffsetS,
  DEFAULT_SETTINGS,
  loadSettings,
  MAX_EMBED_OFFSET_S,
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
      monitor: 'headphones',
      serviceUrl: 'http://localhost:8765',
      autoPrepareLinks: false,
      clarityThreshold: 0.9,
      octaveInvariant: false,
      latencyByDevicePair: {},
      embedOffsetS: 0,
      mode: 'karaoke',
      guideLevel: 0.5,
      searchProvider: 'youtube',
      youtubeApiKey: '',
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
          monitor: 'loudspeakers',
          serviceUrl: 'ftp://nope',
          autoPrepareLinks: 'yes',
          clarityThreshold: 0.75,
          octaveInvariant: 'yes',
          latencyByDevicePair: { 'latency.a|b': 0.12 },
          embedOffsetS: 'later',
        }),
      ),
    );
    expect(s).toEqual({
      inputDeviceId: 'mic-1',
      outputDeviceId: null,
      monitor: 'headphones',
      serviceUrl: DEFAULT_SETTINGS.serviceUrl,
      autoPrepareLinks: false,
      clarityThreshold: 0.75,
      octaveInvariant: false,
      latencyByDevicePair: { 'latency.a|b': 0.12 },
      embedOffsetS: 0,
      mode: 'karaoke',
      guideLevel: 0.5,
      searchProvider: 'youtube',
      youtubeApiKey: '',
    });
  });

  it('turns an empty device id into null', () => {
    const s = sanitizeSettings({ inputDeviceId: '', outputDeviceId: '' });
    expect(s.inputDeviceId).toBeNull();
    expect(s.outputDeviceId).toBeNull();
  });

  it('accepts the two monitor modes and falls back to headphones for the rest', () => {
    expect(sanitizeSettings({ monitor: 'speakers' }).monitor).toBe('speakers');
    expect(sanitizeSettings({ monitor: 'headphones' }).monitor).toBe('headphones');
    for (const bad of ['Speakers', '', 'both', 1, true, null, undefined, {}]) {
      expect(sanitizeSettings({ monitor: bad }).monitor, String(bad)).toBe('headphones');
    }
  });

  it('reads settings saved before speaker mode existed as headphones', () => {
    const old = JSON.stringify({ inputDeviceId: 'mic-1', clarityThreshold: 0.8 });
    expect(loadSettings(storeWith(old)).monitor).toBe('headphones');
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

  it('keeps an embed offset within plus or minus half a second', () => {
    expect(MAX_EMBED_OFFSET_S).toBe(0.5);
    expect(sanitizeSettings({ embedOffsetS: 0.12 }).embedOffsetS).toBe(0.12);
    expect(sanitizeSettings({ embedOffsetS: -0.3 }).embedOffsetS).toBe(-0.3);
    expect(sanitizeSettings({ embedOffsetS: 0.5 }).embedOffsetS).toBe(0.5);
    expect(sanitizeSettings({ embedOffsetS: -0.5 }).embedOffsetS).toBe(-0.5);
    expect(sanitizeSettings({ embedOffsetS: 0 }).embedOffsetS).toBe(0);
  });

  it('clamps an embed offset that is out of range instead of dropping it', () => {
    expect(sanitizeSettings({ embedOffsetS: 0.9 }).embedOffsetS).toBe(0.5);
    expect(sanitizeSettings({ embedOffsetS: -7 }).embedOffsetS).toBe(-0.5);
    expect(sanitizeSettings({ embedOffsetS: 0.5000001 }).embedOffsetS).toBe(0.5);
  });

  it('falls back to no offset for an embed offset that is not a finite number', () => {
    for (const bad of ['0.2', null, undefined, NaN, Infinity, -Infinity, {}, [0.1], true]) {
      expect(sanitizeSettings({ embedOffsetS: bad }).embedOffsetS, String(bad)).toBe(0);
    }
  });

  it('keeps automatic preparing off unless the stored value is exactly true', () => {
    expect(DEFAULT_SETTINGS.autoPrepareLinks).toBe(false);
    expect(sanitizeSettings({ autoPrepareLinks: true }).autoPrepareLinks).toBe(true);
    expect(sanitizeSettings({ autoPrepareLinks: false }).autoPrepareLinks).toBe(false);
    for (const bad of ['true', 'yes', 1, 0, null, undefined, {}, [true]]) {
      expect(sanitizeSettings({ autoPrepareLinks: bad }).autoPrepareLinks, String(bad)).toBe(false);
    }
  });

  it('reads settings saved before preparing existed as off', () => {
    const old = JSON.stringify({ inputDeviceId: 'mic-1', embedOffsetS: 0.04 });
    expect(loadSettings(storeWith(old)).autoPrepareLinks).toBe(false);
  });

  it('reads settings saved before the embed existed as no offset', () => {
    const old = JSON.stringify({ inputDeviceId: 'mic-1', monitor: 'speakers' });
    expect(loadSettings(storeWith(old)).embedOffsetS).toBe(0);
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

describe('clampEmbedOffsetS', () => {
  it('keeps values in range and limits the rest', () => {
    expect(clampEmbedOffsetS(0.2)).toBe(0.2);
    expect(clampEmbedOffsetS(-0.2)).toBe(-0.2);
    expect(clampEmbedOffsetS(0.75)).toBe(0.5);
    expect(clampEmbedOffsetS(-0.75)).toBe(-0.5);
    expect(clampEmbedOffsetS(Infinity)).toBe(0.5);
    expect(clampEmbedOffsetS(-Infinity)).toBe(-0.5);
  });

  it('reads NaN as no offset', () => {
    expect(clampEmbedOffsetS(NaN)).toBe(0);
  });
});

describe('saveSettings', () => {
  const custom: Settings = {
    inputDeviceId: 'in-1',
    outputDeviceId: 'out-1',
    monitor: 'speakers',
    serviceUrl: 'http://127.0.0.1:9999',
    autoPrepareLinks: true,
    clarityThreshold: 0.8,
    octaveInvariant: true,
    latencyByDevicePair: { 'latency.out-1|in-1': 0.143 },
    embedOffsetS: -0.06,
    mode: 'learning',
    guideLevel: 0.25,
    searchProvider: 'youtube',
    youtubeApiKey: 'AIzaSyExample_key-123',
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

  it('round-trips the automatic-prepare choice both ways', () => {
    for (const autoPrepareLinks of [true, false]) {
      const store = memoryStore();
      saveSettings(store, { ...custom, autoPrepareLinks });
      expect(JSON.parse(store.get('settings') ?? 'null').autoPrepareLinks).toBe(autoPrepareLinks);
      expect(loadSettings(store).autoPrepareLinks).toBe(autoPrepareLinks);
    }
  });

  it('never persists an automatic-prepare value that is not a boolean', () => {
    const store = memoryStore();
    saveSettings(store, { ...custom, autoPrepareLinks: 'yes' as unknown as boolean });
    expect(JSON.parse(store.get('settings') ?? 'null').autoPrepareLinks).toBe(false);
  });

  it('writes a clamped embed offset, never a wild one', () => {
    const store = memoryStore();
    saveSettings(store, { ...custom, embedOffsetS: 3 });
    expect(JSON.parse(store.get('settings') ?? 'null').embedOffsetS).toBe(0.5);
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

describe('practice mode', () => {
  it('defaults to karaoke', () => {
    expect(DEFAULT_SETTINGS.mode).toBe('karaoke');
    expect(loadSettings(memoryStore()).mode).toBe('karaoke');
  });

  it('keeps a stored learning mode', () => {
    expect(sanitizeSettings({ mode: 'learning' }).mode).toBe('learning');
    expect(loadSettings(storeWith(JSON.stringify({ mode: 'learning' }))).mode).toBe('learning');
  });

  it('falls back to karaoke for anything else', () => {
    for (const mode of ['Learning', 'coach', '', 7, null, true, {}, ['learning']]) {
      expect(sanitizeSettings({ mode }).mode, String(mode)).toBe('karaoke');
    }
  });

  it('never saves a mode that load would reject', () => {
    const store = memoryStore();
    saveSettings(store, { ...DEFAULT_SETTINGS, mode: 'loud' as unknown as 'karaoke' });
    expect(JSON.parse(store.get('settings') ?? 'null').mode).toBe('karaoke');
  });
});

describe('guide level', () => {
  it('defaults to half', () => {
    expect(DEFAULT_SETTINGS.guideLevel).toBe(0.5);
    expect(loadSettings(memoryStore()).guideLevel).toBe(0.5);
  });

  it('keeps a stored level from 0 to 1', () => {
    for (const level of [0, 0.2, 1]) {
      expect(sanitizeSettings({ guideLevel: level }).guideLevel).toBe(level);
    }
  });

  it('falls back to the default for anything else', () => {
    for (const level of [-0.1, 1.5, NaN, Infinity, '0.3', null, true, {}]) {
      expect(sanitizeSettings({ guideLevel: level }).guideLevel, String(level)).toBe(0.5);
    }
  });

  it('never saves a level that load would reject', () => {
    const store = memoryStore();
    saveSettings(store, { ...DEFAULT_SETTINGS, guideLevel: 7 });
    expect(JSON.parse(store.get('settings') ?? 'null').guideLevel).toBe(0.5);
  });
});

describe('song search settings', () => {
  it('defaults to the direct YouTube provider with no key', () => {
    expect(DEFAULT_SETTINGS.searchProvider).toBe('youtube');
    expect(DEFAULT_SETTINGS.youtubeApiKey).toBe('');
  });

  it('keeps a stored key that has the shape of one, trimmed', () => {
    expect(sanitizeSettings({ youtubeApiKey: ' AIzaSy_abc-123 ' }).youtubeApiKey).toBe('AIzaSy_abc-123');
  });

  it('drops a stored key that cannot be one', () => {
    for (const key of ['has space', 'semi;colon', 'x'.repeat(200), 7, null, {}]) {
      expect(sanitizeSettings({ youtubeApiKey: key }).youtubeApiKey, String(key)).toBe('');
    }
  });

  it('reads an unknown provider as the default one', () => {
    for (const id of ['bing', '', 3, null]) {
      expect(sanitizeSettings({ searchProvider: id }).searchProvider, String(id)).toBe('youtube');
    }
  });

  it('never saves a key that load would reject', () => {
    const store = memoryStore();
    saveSettings(store, { ...DEFAULT_SETTINGS, youtubeApiKey: 'not a key' });
    expect(JSON.parse(store.get('settings') ?? 'null').youtubeApiKey).toBe('');
  });
});
