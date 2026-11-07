/**
 * Tests for the lyrics pieces: the LRC parser and the line lookup, the title
 * cleaner, the per-song cache (memory and IndexedDB backed by fake-indexeddb),
 * the LRCLIB client on a fake fetch, and the controller that joins them.
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { LyricsController, lyricsShown } from '../src/lyrics/controller';
import { lineIndexAt, parseLrc, parsePlain, viewAt } from '../src/lyrics/lrc';
import { LyricsError, createLrclibClient } from '../src/lyrics/lrclib';
import { idbLyricsStore, lazyLyricsStore, memoryLyricsStore } from '../src/lyrics/store';
import type { LyricsRecord, LyricsStore } from '../src/lyrics/store';
import { cleanTitle, guessTitle } from '../src/lyrics/title';

const LRC = `[ar:Someone]
[ti:Song]
[00:01.00]First
[00:03.50]Second
[00:05.00]
[00:06.25][00:12.5]Chorus
`;

describe('parseLrc', () => {
  it('reads stamps, ignores metadata and keeps empty lines as breaks', () => {
    expect(parseLrc(LRC)).toEqual([
      { t: 1, text: 'First' },
      { t: 3.5, text: 'Second' },
      { t: 5, text: '' },
      { t: 6.25, text: 'Chorus' },
      { t: 12.5, text: 'Chorus' },
    ]);
  });

  it('sorts lines that arrive out of order', () => {
    const lines = parseLrc('[00:09.00]b\n[00:02.00]a\n');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('applies the offset tag: positive comes sooner, never below zero', () => {
    const lines = parseLrc('[offset:+500]\n[00:00.20]x\n[00:02.00]y\n');
    expect(lines[0].t).toBe(0);
    expect(lines[1].t).toBeCloseTo(1.5, 6);
    expect(parseLrc('[offset:-250]\n[00:01.00]z')[0].t).toBeCloseTo(1.25, 6);
  });

  it('reads minutes, CRLF line ends and fractions of any width', () => {
    const lines = parseLrc('[01:02.5]a\r\n[02:00]b\r\n[00:01.123]c');
    expect(lines.map((l) => l.t)).toEqual([1.123, 62.5, 120]);
  });

  it('returns nothing for text without stamps', () => {
    expect(parseLrc('just words\nmore words')).toEqual([]);
  });
});

describe('parsePlain', () => {
  it('trims, collapses blank runs and drops them at the ends', () => {
    expect(parsePlain('\n  one \n\n\n two\n\n')).toEqual(['one', '', 'two']);
  });
});

describe('lineIndexAt and viewAt', () => {
  const lines = parseLrc(LRC);

  it('finds the line by binary search at and between stamps', () => {
    expect(lineIndexAt(lines, 0)).toBe(-1);
    expect(lineIndexAt(lines, 1)).toBe(0);
    expect(lineIndexAt(lines, 3.49)).toBe(0);
    expect(lineIndexAt(lines, 3.5)).toBe(1);
    expect(lineIndexAt(lines, 99)).toBe(4);
    expect(lineIndexAt([], 5)).toBe(-1);
  });

  it('agrees with a linear scan on many times', () => {
    for (let t = 0; t < 14; t += 0.37) {
      let want = -1;
      lines.forEach((l, i) => {
        if (l.t <= t) want = i;
      });
      expect(lineIndexAt(lines, t)).toBe(want);
    }
  });

  it('shows the current and the next words, skipping breaks', () => {
    expect(viewAt(lines, 0.5)).toEqual({ current: '', next: 'First' });
    expect(viewAt(lines, 2)).toEqual({ current: 'First', next: 'Second' });
    expect(viewAt(lines, 4)).toEqual({ current: 'Second', next: 'Chorus' });
    expect(viewAt(lines, 5.5)).toEqual({ current: '', next: 'Chorus' });
    expect(viewAt(lines, 20)).toEqual({ current: 'Chorus', next: '' });
  });
});

describe('cleanTitle and guessTitle', () => {
  it('strips video noise and channel suffixes', () => {
    expect(cleanTitle('Queen - Bohemian Rhapsody (Karaoke Version)')).toBe('Queen - Bohemian Rhapsody');
    expect(cleanTitle('Adele - Hello [Official Video]')).toBe('Adele - Hello');
    expect(cleanTitle('Adele - Hello (Lyrics) | Some Channel')).toBe('Adele - Hello');
    expect(cleanTitle('Adele - Hello Lyrics')).toBe('Adele - Hello');
    expect(cleanTitle('Artist - Song - Topic')).toBe('Artist - Song');
    expect(cleanTitle('ArtistVEVO')).toBe('Artist');
  });

  it('keeps brackets that are part of the title', () => {
    expect(cleanTitle('Band - Song (Reprise)')).toBe('Band - Song (Reprise)');
  });

  it('drops file extensions, underscores and track numbers', () => {
    expect(cleanTitle('03 - Artist_Name - Title.mp3')).toBe('Artist Name - Title');
    expect(cleanTitle('04. Some Song.wav')).toBe('Some Song');
  });

  it('splits artist and title, or leaves the artist blank', () => {
    expect(guessTitle('Queen - Bohemian Rhapsody (Karaoke Version)')).toEqual({
      title: 'Bohemian Rhapsody',
      artist: 'Queen',
    });
    expect(guessTitle('Just A Title.mp3')).toEqual({ title: 'Just A Title', artist: '' });
    expect(guessTitle('Karaoke - Hello')).toEqual({ title: 'Hello', artist: '' });
  });
});

function record(over: Partial<LyricsRecord> = {}): LyricsRecord {
  return {
    songHash: 'h1',
    text: LRC,
    synced: true,
    source: 'lrclib',
    title: 'Song',
    artist: 'Someone',
    nudgeS: 0,
    ...over,
  };
}

const stores: [string, () => Promise<LyricsStore>][] = [
  ['memoryLyricsStore', async () => memoryLyricsStore()],
  ['idbLyricsStore', () => idbLyricsStore(new IDBFactory())],
  ['lazyLyricsStore', async () => lazyLyricsStore(async () => memoryLyricsStore())],
];

describe.each(stores)('%s', (_name, open) => {
  it('keeps lyrics by song hash and forgets them on remove', async () => {
    const store = await open();
    expect(await store.get('h1')).toBeNull();
    await store.put(record());
    await store.put(record({ songHash: 'h2', text: 'plain', synced: false }));
    expect((await store.get('h1'))?.text).toBe(LRC);
    expect((await store.get('h2'))?.synced).toBe(false);
    await store.put(record({ nudgeS: 0.3, shown: false }));
    expect(await store.get('h1')).toMatchObject({ nudgeS: 0.3, shown: false });
    await store.remove('h1');
    expect(await store.get('h1')).toBeNull();
    expect(await store.get('h2')).not.toBeNull();
  });
});

it('idbLyricsStore keeps lyrics across a reopen', async () => {
  const factory = new IDBFactory();
  await (await idbLyricsStore(factory)).put(record());
  expect((await (await idbLyricsStore(factory)).get('h1'))?.title).toBe('Song');
});

interface Call {
  url: string;
}

/** A fetch that answers each URL path from `routes`, recording the calls. */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown }>, calls: Call[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const route = routes[new URL(url).pathname.replace('/api', '')] ?? { status: 404 };
    const status = route.status ?? 200;
    return { ok: status < 400, status, json: async () => route.body } as Response;
  }) as typeof fetch;
}

describe('createLrclibClient', () => {
  const query = { title: 'Song', artist: 'Someone', durationS: 120 };

  it('asks /get with the track, artist and rounded duration, no more', async () => {
    const calls: Call[] = [];
    const client = createLrclibClient({
      fetch: fakeFetch({ '/get': { body: { syncedLyrics: LRC, plainLyrics: 'p', trackName: 'Song', artistName: 'S' } } }, calls),
    });
    const found = await client.find({ ...query, durationS: 120.4 });
    expect(found).toMatchObject({ synced: LRC, plain: 'p', title: 'Song' });
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe('https://lrclib.net/api/get');
    expect([...url.searchParams.keys()].sort()).toEqual(['artist_name', 'duration', 'track_name']);
    expect(url.searchParams.get('duration')).toBe('120');
  });

  it('falls back to plain lyrics when nothing is synced', async () => {
    const client = createLrclibClient({ fetch: fakeFetch({ '/get': { body: { syncedLyrics: null, plainLyrics: 'words' } } }) });
    expect(await client.find(query)).toMatchObject({ synced: null, plain: 'words' });
  });

  it('searches when the exact lookup has nothing, preferring synced and the nearest length', async () => {
    const calls: Call[] = [];
    const rows = [
      { trackName: 'A', duration: 118, plainLyrics: 'plain only' },
      { trackName: 'B', duration: 300, syncedLyrics: '[00:01.00]far' },
      { trackName: 'C', duration: 125, syncedLyrics: '[00:01.00]near' },
      { trackName: 'D', duration: 121, syncedLyrics: '[00:01.00]nearest' },
    ];
    const client = createLrclibClient({ fetch: fakeFetch({ '/search': { body: rows } }, calls) });
    const found = await client.find(query);
    expect(found?.title).toBe('D');
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/get', '/api/search']);
    expect(new URL(calls[1].url).searchParams.get('q')).toBe('Someone Song');
  });

  it('tries /search after a plain-only exact hit and prefers a synced row', async () => {
    const calls: Call[] = [];
    const rows = [
      { trackName: 'Far', duration: 400, syncedLyrics: '[00:01.00]far' },
      { trackName: 'Twin', duration: 121, syncedLyrics: '[00:01.00]twin' },
    ];
    const client = createLrclibClient({
      fetch: fakeFetch({ '/get': { body: { plainLyrics: 'words', trackName: 'Hit' } }, '/search': { body: rows } }, calls),
    });
    expect((await client.find(query))?.title).toBe('Twin');
    expect(calls).toHaveLength(2);
    const plainOnly = createLrclibClient({
      fetch: fakeFetch({ '/get': { body: { plainLyrics: 'words', trackName: 'Hit' } }, '/search': { body: [{ trackName: 'P', plainLyrics: 'x' }] } }),
    });
    expect(await plainOnly.find(query)).toMatchObject({ title: 'Hit', plain: 'words' });
    const searchDown = createLrclibClient({
      fetch: fakeFetch({ '/get': { body: { plainLyrics: 'words', trackName: 'Hit' } }, '/search': { status: 500 } }),
    });
    expect((await searchDown.find(query))?.title).toBe('Hit');
  });

  it('returns null when nothing usable exists, and skips /get without an artist', async () => {
    const calls: Call[] = [];
    const client = createLrclibClient({ fetch: fakeFetch({ '/search': { body: [{ trackName: 'X' }] } }, calls) });
    expect(await client.find({ title: 'Song', artist: '' })).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('turns failures into plain sentences', async () => {
    const down = createLrclibClient({ fetch: fakeFetch({ '/get': { status: 500 } }) });
    await expect(down.find(query)).rejects.toThrow(/500/);
    const offline = createLrclibClient({
      fetch: (async () => {
        throw new TypeError('network');
      }) as typeof fetch,
    });
    await expect(offline.find(query)).rejects.toThrow(/Could not reach/);
    await expect(offline.find({ title: ' ', artist: '' })).rejects.toBeInstanceOf(LyricsError);
  });

  it('times out a request that never answers', async () => {
    const hang = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const client = createLrclibClient({ fetch: hang, timeoutMs: 20 });
    await expect(client.find(query)).rejects.toThrow(/did not answer in time/);
  });
});

describe('lyricsShown', () => {
  it('is off on a karaoke track and on elsewhere, unless the singer chose', () => {
    expect(lyricsShown(null, false)).toBe(false);
    expect(lyricsShown(record(), false)).toBe(true);
    expect(lyricsShown(record(), true)).toBe(false);
    expect(lyricsShown(record({ shown: true }), true)).toBe(true);
    expect(lyricsShown(record({ shown: false }), false)).toBe(false);
    expect(lyricsShown(record({ synced: false }), false)).toBe(false);
  });
});

describe('LyricsController', () => {
  const song = { hash: 'h1', name: 'Someone - Song (Karaoke Version).mp3', durationS: 120 };
  const client = (synced: string | null, plain: string | null = null) => ({
    find: async () => ({ synced, plain, title: 'Song', artist: 'Someone' }),
  });

  it('guesses the query, finds lyrics, caches them and follows the nudge', async () => {
    const cache = memoryLyricsStore();
    const c = new LyricsController(cache, client(LRC));
    await c.select(song);
    expect(c.state.query).toEqual({ title: 'Song', artist: 'Someone' });
    await c.find();
    expect(c.state.phase).toBe('ready');
    expect(c.viewAt(2).current).toBe('First');
    await c.nudge(0.1);
    expect(c.viewAt(3.45).current).toBe('Second');
    expect((await cache.get('h1'))?.nudgeS).toBe(0.1);
  });

  it('reads the cache when the song comes back, with no lookup', async () => {
    const cache = memoryLyricsStore();
    await cache.put(record({ nudgeS: -0.2 }));
    const c = new LyricsController(cache, { find: async () => Promise.reject(new Error('no network')) });
    await c.select(song);
    expect(c.state.record?.nudgeS).toBe(-0.2);
    expect(c.viewAt(1.1).current).toBe('');
  });

  it('keeps plain lyrics without timing and imports pasted text', async () => {
    const c = new LyricsController(memoryLyricsStore(), client(null, 'one\ntwo'));
    await c.select(song);
    await c.find();
    expect(c.state.record?.synced).toBe(false);
    expect(c.plainLines()).toEqual(['one', 'two']);
    await c.importText('[00:01.00]hi');
    expect(c.state.record).toMatchObject({ synced: true, source: 'pasted' });
    expect(c.viewAt(1).current).toBe('hi');
  });

  it('falls back to plain when the synced text has no parsable lines', async () => {
    const c = new LyricsController(memoryLyricsStore(), client('just words, no stamps', 'plain words'));
    await c.select(song);
    await c.find();
    expect(c.state.record).toMatchObject({ synced: false, text: 'plain words' });
  });

  it('takes a later duration and name on the same song without resetting', async () => {
    const c = new LyricsController(memoryLyricsStore(), client(LRC));
    await c.select({ ...song, durationS: 0 });
    await c.find();
    await c.select({ ...song, name: 'Better Name.mp3', durationS: 200 });
    expect(c.state.song).toMatchObject({ name: 'Better Name.mp3', durationS: 200 });
    expect(c.state.record).not.toBeNull();
    expect(c.state.phase).toBe('ready');
  });

  it('keeps a hidden line hidden when lyrics are found again or imported', async () => {
    const c = new LyricsController(memoryLyricsStore(), client(LRC));
    await c.select(song);
    await c.find();
    await c.setShown(false);
    await c.find();
    expect(c.state.record?.shown).toBe(false);
    await c.importText('[00:01.00]hi');
    expect(c.state.record?.shown).toBe(false);
  });

  it('says plainly when nothing is found or the lookup fails', async () => {
    const none = new LyricsController(memoryLyricsStore(), { find: async () => null });
    await none.select(song);
    await none.find();
    expect(none.state.phase).toBe('missing');
    const bad = new LyricsController(memoryLyricsStore(), {
      find: async () => Promise.reject(new LyricsError('LRCLIB did not answer in time.')),
    });
    await bad.select(song);
    await bad.find();
    expect(bad.state).toMatchObject({ phase: 'error', message: 'LRCLIB did not answer in time.' });
  });

  it('forgets lyrics on clear and ignores a late answer for another song', async () => {
    const cache = memoryLyricsStore();
    let release: () => void = () => undefined;
    const slow = {
      find: () =>
        new Promise<{ synced: string; plain: null; title: string; artist: string }>((resolve) => {
          release = () => resolve({ synced: LRC, plain: null, title: 'T', artist: 'A' });
        }),
    };
    const c = new LyricsController(cache, slow);
    await c.select(song);
    const pending = c.find();
    await c.select({ hash: 'h2', name: 'Other', durationS: 10 });
    release();
    await pending;
    expect(c.state.record).toBeNull();
    await cache.put(record({ songHash: 'h2' }));
    await c.select(null);
    await c.select({ hash: 'h2', name: 'Other', durationS: 10 });
    expect(c.state.record).not.toBeNull();
    await c.clear();
    expect(c.state.record).toBeNull();
    expect(await cache.get('h2')).toBeNull();
  });
});
