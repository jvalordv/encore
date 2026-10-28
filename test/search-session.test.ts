/**
 * Unit tests for the song search as the Session runs it
 * (src/app/session/search.ts) and the small pure rules in src/app/search.ts:
 * where the chip starts, when the panel shows, the key, a search with a key, a
 * search without one (which opens YouTube in a new tab instead), a quota error
 * that turns the next search into the same, a newer search overtaking an older
 * one, "Find the original", and a pick loading like a pasted link. The
 * provider's own requests are checked in test/search-youtube.test.ts; here
 * fetch answers from a fixture.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  describeResults,
  filterForMode,
  initialSearch,
  searchesExternally,
  searchVisible,
} from '../src/app/search';
import type { SearchState } from '../src/app/search';
import { EMPTY_SEARCH, KEY_FORGOTTEN, KEY_SAVED, NOT_A_KEY, OPENED_ON_YOUTUBE } from '../src/app/session/search';
import { loadSettings } from '../src/app/settings';
import { SEARCH_MESSAGES } from '../src/search/youtube';
import { makeHarness, songInfo } from './session-harness';

const KEY = 'AIzaSy-test_key-0123456789';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const ITEMS = {
  items: [
    {
      id: { videoId: 'karaoke0001' },
      snippet: { title: 'Hello (Karaoke Version)', channelTitle: 'Sing King', thumbnails: {} },
    },
    {
      id: { videoId: 'original001' },
      snippet: { title: 'Hello', channelTitle: 'Adele', thumbnails: {} },
    },
  ],
};

/** A harness with a key whose fetch answers every search with ITEMS. */
function keyed(overrides: { fetch?: typeof fetch; saved?: Record<string, unknown> } = {}) {
  const send = vi.fn(async (url: string) =>
    json(String(url).includes('/search?') ? ITEMS : { items: [] }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const openTab = vi.fn();
  const harness = makeHarness(
    { youtubeApiKey: KEY, ...overrides.saved },
    { fetch: overrides.fetch ?? send, openTab },
  );
  return { ...harness, send, openTab, search: harness.core.search };
}

/** Lets the provider's promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('search rules', () => {
  it('starts the chip from the practice mode', () => {
    expect(filterForMode('karaoke')).toBe('karaoke');
    expect(filterForMode('learning')).toBe('original');
    expect(initialSearch('learning', true).filter).toBe('original');
  });

  it('shows with no song, and with one only on request', () => {
    const closed = { open: false };
    expect(searchVisible(false, closed)).toBe(true);
    expect(searchVisible(true, closed)).toBe(false);
    expect(searchVisible(true, { open: true })).toBe(true);
  });

  it('searches externally with no key or a spent quota', () => {
    expect(searchesExternally({ hasKey: false, quotaSpent: false })).toBe(true);
    expect(searchesExternally({ hasKey: true, quotaSpent: true })).toBe(true);
    expect(searchesExternally({ hasKey: true, quotaSpent: false })).toBe(false);
  });

  it('describes the results by chip and query', () => {
    const base: SearchState = { ...initialSearch('karaoke', true), phase: 'done', query: 'hello' };
    const found = [{ videoId: 'a' }] as SearchState['results'];
    expect(describeResults({ ...base, results: found })).toBe('Karaoke versions for "hello".');
    expect(describeResults({ ...base, results: found, filter: 'original' })).toBe('Originals for "hello".');
    expect(describeResults({ ...base, results: found, filter: 'original', originalOf: 'Hello (Karaoke)' })).toBe(
      'Originals of "Hello (Karaoke)".',
    );
    expect(describeResults(base)).toBe('No karaoke versions found for "hello".');
    expect(describeResults({ ...base, phase: 'searching' })).toBe('Searching…');
    expect(describeResults({ ...base, phase: 'idle' })).toBe('');
  });
});

describe('the search state at the start', () => {
  it('has the chip on karaoke, no key and nothing searched', () => {
    const { store } = makeHarness();
    expect(store.state.search).toEqual(initialSearch('karaoke', false));
  });

  it('starts the chip on originals in learning mode, and knows of a saved key', () => {
    const { store } = makeHarness({ mode: 'learning', youtubeApiKey: KEY });
    expect(store.state.search.filter).toBe('original');
    expect(store.state.search.hasKey).toBe(true);
  });
});

describe('the key', () => {
  it('keeps a key, saves it and starts a fresh quota', () => {
    const h = makeHarness();
    expect(h.store.state.search.hasKey).toBe(false);
    expect(h.core.search.setKey(` ${KEY} `)).toBe(true);
    expect(h.store.state.search).toMatchObject({ hasKey: true, quotaSpent: false, message: KEY_SAVED });
    expect(loadSettings(h.settingsStore).youtubeApiKey).toBe(KEY);
  });

  it('refuses text that cannot be a key and keeps the old one', () => {
    const h = keyed();
    expect(h.search.setKey('not a key')).toBe(false);
    expect(h.store.state.search).toMatchObject({ hasKey: true, errorCode: 'bad-key', message: NOT_A_KEY });
    expect(loadSettings(h.settingsStore).youtubeApiKey).toBe(KEY);
  });

  it('forgets the key when given a blank', () => {
    const h = keyed();
    expect(h.search.setKey('  ')).toBe(true);
    expect(h.store.state.search).toMatchObject({ hasKey: false, message: KEY_FORGOTTEN });
    expect(loadSettings(h.settingsStore).youtubeApiKey).toBe('');
  });
});

describe('searching with a key', () => {
  it('shows the results of a search', async () => {
    const h = keyed();
    h.search.search('hello');
    expect(h.store.state.search).toMatchObject({ phase: 'searching', query: 'hello', results: [] });
    await settle();
    const { search } = h.store.state;
    expect(search.phase).toBe('done');
    expect(search.results.map((r) => [r.videoId, r.kind])).toEqual([
      ['karaoke0001', 'karaoke'],
      ['original001', 'original'],
    ]);
    expect(h.openTab).not.toHaveBeenCalled();
  });

  it('sends the chip in the query', async () => {
    const h = keyed();
    h.search.search('hello');
    await settle();
    expect(new URL(String(h.send.mock.calls[0]?.[0])).searchParams.get('q')).toBe('hello karaoke');
    h.search.setFilter('original');
    h.search.search('hello');
    await settle();
    const lastSearch = h.send.mock.calls.map((c) => new URL(String(c[0]))).filter((u) => u.pathname.endsWith('/search'));
    expect(lastSearch.at(-1)?.searchParams.get('q')).toBe('hello -karaoke');
    expect(h.store.state.search.filter).toBe('original');
  });

  it('says so for a blank search and sends nothing', () => {
    const h = keyed();
    h.search.search('   ');
    expect(h.store.state.search.message).toBe(EMPTY_SEARCH);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.openTab).not.toHaveBeenCalled();
  });

  it('lets a newer search overtake an older one', async () => {
    let release: (response: Response) => void = () => undefined;
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const send = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/videos?')) return json({ items: [] });
      calls++;
      if (calls === 1) {
        const first = await slow;
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return first;
      }
      return json({
        items: [{ id: { videoId: 'newer000001' }, snippet: { title: 'Newer', channelTitle: 'X', thumbnails: {} } }],
      });
    }) as unknown as typeof fetch;
    const h = keyed({ fetch: send });
    h.search.search('first');
    h.search.search('second');
    release(json(ITEMS));
    await settle();
    expect(h.store.state.search.query).toBe('second');
    expect(h.store.state.search.results.map((r) => r.videoId)).toEqual(['newer000001']);
  });

  it('says why a search failed and remembers a spent quota', async () => {
    const send = vi.fn(async () =>
      json({ error: { code: 403, message: 'x', errors: [{ reason: 'quotaExceeded' }] } }, 403),
    ) as unknown as typeof fetch;
    const h = keyed({ fetch: send });
    h.search.search('hello');
    await settle();
    expect(h.store.state.search).toMatchObject({
      phase: 'failed',
      errorCode: 'quota',
      message: SEARCH_MESSAGES.quota,
      quotaSpent: true,
      results: [],
    });
    // The next search goes to YouTube's own page, in the click, with no request.
    const before = (send as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    h.search.search('hello');
    expect(h.openTab).toHaveBeenCalledWith('https://www.youtube.com/results?search_query=hello%20karaoke');
    expect((send as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    expect(h.store.state.search.message).toBe(OPENED_ON_YOUTUBE);
  });

  it('keeps a failure for a key YouTube does not accept', async () => {
    const send = vi.fn(async () =>
      json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, 400),
    ) as unknown as typeof fetch;
    const h = keyed({ fetch: send });
    h.search.search('hello');
    await settle();
    expect(h.store.state.search).toMatchObject({ phase: 'failed', errorCode: 'bad-key', quotaSpent: false });
  });
});

describe('searching without a key', () => {
  it("opens YouTube's own search in a new tab, at once, and asks the API nothing", () => {
    const send = vi.fn();
    const openTab = vi.fn();
    const h = makeHarness(undefined, { fetch: send as unknown as typeof fetch, openTab });
    h.core.search.search('adele hello');
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith('https://www.youtube.com/results?search_query=adele%20hello%20karaoke');
    expect(send).not.toHaveBeenCalled();
    expect(h.store.state.search).toMatchObject({ phase: 'idle', message: OPENED_ON_YOUTUBE, query: 'adele hello' });
  });

  it('uses the originals words when that chip is chosen', () => {
    const openTab = vi.fn();
    const h = makeHarness(undefined, { openTab });
    h.core.search.setFilter('original');
    h.core.search.search('adele hello');
    expect(openTab).toHaveBeenCalledWith('https://www.youtube.com/results?search_query=adele%20hello%20-karaoke');
  });

  it('goes back to searching here once a key is saved', () => {
    const openTab = vi.fn();
    const h = makeHarness(undefined, { openTab, fetch: vi.fn(async () => json({ items: [] })) as unknown as typeof fetch });
    h.core.search.setKey(KEY);
    h.core.search.search('hello');
    expect(openTab).not.toHaveBeenCalled();
    expect(h.store.state.search.phase).toBe('searching');
  });
});

describe('find the original', () => {
  it('searches the title without its karaoke words as originals and opens the panel', async () => {
    const h = keyed();
    h.store.patch({ song: songInfo('x', 'yt-abc') });
    h.search.findOriginal({ title: 'Adele - Hello (Karaoke Version)', channel: 'Sing King' });
    expect(h.store.state.search).toMatchObject({
      open: true,
      filter: 'original',
      query: 'Adele - Hello',
      originalOf: 'Adele - Hello (Karaoke Version)',
    });
    await settle();
    expect(new URL(String(h.send.mock.calls[0]?.[0])).searchParams.get('q')).toBe('Adele - Hello -karaoke');
    expect(h.store.state.search.phase).toBe('done');
  });
});

describe('picking a result', () => {
  it('loads it like a pasted link and closes the panel once it is the song', async () => {
    const h = keyed();
    const loadLink = vi.spyOn(h.core.songs, 'loadLink').mockImplementation(async () => {
      h.store.patch({ song: songInfo('Hello', 'yt-original001') });
    });
    h.store.patch({ song: songInfo('Other', 'yt-other') });
    h.search.setOpen(true);
    await h.search.pick('original001');
    expect(loadLink).toHaveBeenCalledWith('https://www.youtube.com/watch?v=original001');
    expect(h.store.state.search.open).toBe(false);
  });

  it('leaves the panel open when the video did not load', async () => {
    const h = keyed();
    vi.spyOn(h.core.songs, 'loadLink').mockResolvedValue(undefined);
    h.search.setOpen(true);
    await h.search.pick('original001');
    expect(h.store.state.search.open).toBe(true);
  });
});

describe('the panel and a song', () => {
  it('closes when a different song arrives, and not when the same one is renewed', () => {
    const h = keyed();
    h.store.patch({ song: songInfo('A', 'hash-a') });
    h.search.setOpen(true);
    h.store.patch({ song: songInfo('A', 'hash-a') });
    expect(h.store.state.search.open).toBe(true);
    h.store.patch({ song: songInfo('B', 'hash-b') });
    expect(h.store.state.search.open).toBe(false);
  });
});
