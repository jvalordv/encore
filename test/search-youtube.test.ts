/**
 * Unit tests for the direct YouTube search provider (src/search/youtube.ts)
 * against fixture responses and a fake fetch: the request it makes, the
 * mapping of both responses into results, HTML entities in titles, and every
 * error kind in plain words. The key must reach only the request address and
 * never a message.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSearchProvider } from '../src/search';
import {
  SEARCH_MESSAGES,
  createYouTubeSearch,
  decodeEntities,
  describeApiFailure,
  readResults,
} from '../src/search/youtube';

const KEY = 'AIzaSy-test_key-0123456789';

const SEARCH_BODY = {
  items: [
    {
      id: { videoId: 'abcDEF12345' },
      snippet: {
        title: 'Adele - Hello (Karaoke Version) &amp; more &#39;fun&#39;',
        channelTitle: 'Sing King',
        thumbnails: { medium: { url: 'https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg' } },
      },
    },
    {
      id: { videoId: 'zzzYYY99999' },
      snippet: {
        title: 'Adele - Hello (Official Music Video)',
        channelTitle: 'Adele',
        thumbnails: { default: { url: 'http://insecure.example/x.jpg' } },
      },
    },
    { id: { channelId: 'not-a-video' }, snippet: { title: 'A channel' } },
    { id: {}, snippet: {} },
  ],
};

const VIDEOS_BODY = {
  items: [
    { id: 'abcDEF12345', contentDetails: { duration: 'PT3M42S' } },
    { id: 'zzzYYY99999', contentDetails: { duration: 'PT6M7S' } },
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function errorBody(reason: string, message = 'x'): unknown {
  return { error: { code: 403, message, errors: [{ reason, message }] } };
}

describe('decodeEntities', () => {
  it('undoes the escapes the API puts in titles', () => {
    expect(decodeEntities('Rock &amp; Roll &lt;3 &quot;hi&quot;')).toBe('Rock & Roll <3 "hi"');
    expect(decodeEntities('Don&#39;t &#x41;&#66;')).toBe("Don't AB");
  });

  it('leaves an unknown or broken entity as it was', () => {
    expect(decodeEntities('a &bogus; b &#99999999999; c &')).toBe('a &bogus; b &#99999999999; c &');
  });
});

describe('readResults', () => {
  it('maps items to results with decoded titles, lengths and badges', () => {
    expect(readResults(SEARCH_BODY, VIDEOS_BODY)).toEqual([
      {
        videoId: 'abcDEF12345',
        title: "Adele - Hello (Karaoke Version) & more 'fun'",
        channel: 'Sing King',
        durationS: 222,
        thumbnailUrl: 'https://i.ytimg.com/vi/abcDEF12345/mqdefault.jpg',
        kind: 'karaoke',
      },
      {
        videoId: 'zzzYYY99999',
        title: 'Adele - Hello (Official Music Video)',
        channel: 'Adele',
        durationS: 367,
        thumbnailUrl: '',
        kind: 'original',
      },
    ]);
  });

  it('leaves the length null when the second answer is missing it', () => {
    const results = readResults(SEARCH_BODY);
    expect(results.map((r) => r.durationS)).toEqual([null, null]);
  });

  it('gives nothing for a body without items', () => {
    expect(readResults(null)).toEqual([]);
    expect(readResults({})).toEqual([]);
    expect(readResults({ items: 'no' })).toEqual([]);
  });
});

describe('describeApiFailure', () => {
  it('names a spent quota', () => {
    for (const reason of ['quotaExceeded', 'dailyLimitExceeded']) {
      const out = describeApiFailure(403, errorBody(reason));
      expect(out.error, reason).toEqual({ code: 'quota', message: SEARCH_MESSAGES.quota });
    }
  });

  it('names a key that is not valid', () => {
    const body = {
      error: {
        code: 400,
        message: 'API key not valid. Please pass a valid API key.',
        errors: [{ reason: 'badRequest' }],
        details: [{ reason: 'API_KEY_INVALID' }],
      },
    };
    expect(describeApiFailure(400, body).error.code).toBe('bad-key');
    expect(describeApiFailure(400, errorBody('keyInvalid')).error.code).toBe('bad-key');
  });

  it('names a key restricted away from this page or this API', () => {
    for (const reason of ['ipRefererBlocked', 'accessNotConfigured', 'API_KEY_HTTP_REFERRER_BLOCKED']) {
      expect(describeApiFailure(403, errorBody(reason)).error.code, reason).toBe('restricted');
    }
    expect(describeApiFailure(403, errorBody('other', 'Requests from referer <empty> are blocked.')).error.code).toBe(
      'restricted',
    );
  });

  it('asks for a moment when searches come too fast', () => {
    const out = describeApiFailure(403, errorBody('rateLimitExceeded'));
    expect(out.error).toEqual({ code: 'failed', message: SEARCH_MESSAGES.tooFast });
    expect(describeApiFailure(429, null).error.message).toBe(SEARCH_MESSAGES.tooFast);
  });

  it('falls back on the status, then on a plain failure', () => {
    expect(describeApiFailure(401, null).error.code).toBe('bad-key');
    expect(describeApiFailure(403, null).error.code).toBe('restricted');
    expect(describeApiFailure(500, null).error).toEqual({ code: 'failed', message: SEARCH_MESSAGES.failed });
  });
});

describe('createYouTubeSearch', () => {
  it('makes the search request, then the lengths request, and maps both', async () => {
    const send = vi.fn(async (url: string) => json(url.includes('/search?') ? SEARCH_BODY : VIDEOS_BODY));
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'adele hello', filter: 'karaoke' });
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.results).toHaveLength(2);

    expect(send).toHaveBeenCalledTimes(2);
    const first = new URL(String(send.mock.calls[0]?.[0]));
    expect(first.origin + first.pathname).toBe('https://www.googleapis.com/youtube/v3/search');
    expect(Object.fromEntries(first.searchParams)).toEqual({
      part: 'snippet',
      type: 'video',
      videoEmbeddable: 'true',
      maxResults: '12',
      q: 'adele hello karaoke',
      key: KEY,
    });
    const second = new URL(String(send.mock.calls[1]?.[0]));
    expect(second.pathname).toBe('/youtube/v3/videos');
    expect(second.searchParams.get('part')).toBe('contentDetails');
    expect(second.searchParams.get('id')).toBe('abcDEF12345,zzzYYY99999');
  });

  it('sends the originals chip as a minus word', async () => {
    const send = vi.fn(async (_url: string) => json({ items: [] }));
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    await provider.search({ text: 'adele hello', filter: 'original' });
    expect(new URL(String(send.mock.calls[0]?.[0])).searchParams.get('q')).toBe('adele hello -karaoke');
    // No results, so no second request.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('asks for no key before any request', async () => {
    const send = vi.fn();
    const provider = createYouTubeSearch({ apiKey: '  ', fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'hello', filter: 'karaoke' });
    expect(outcome).toEqual({ ok: false, error: { code: 'no-key', message: SEARCH_MESSAGES.noKey } });
    expect(send).not.toHaveBeenCalled();
  });

  it('searches for nothing when the text is blank', async () => {
    const send = vi.fn();
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    expect(await provider.search({ text: ' ', filter: 'karaoke' })).toEqual({ ok: true, results: [] });
    expect(send).not.toHaveBeenCalled();
  });

  it('turns an API error response into its typed error', async () => {
    const send = vi.fn(async () => json(errorBody('quotaExceeded'), 403));
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'hello', filter: 'karaoke' });
    expect(outcome).toEqual({ ok: false, error: { code: 'quota', message: SEARCH_MESSAGES.quota } });
  });

  it('reads an error page that is not JSON by its status', async () => {
    const send = vi.fn(async () => new Response('<html>nope</html>', { status: 403 }));
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'hello', filter: 'karaoke' });
    expect(!outcome.ok && outcome.error.code).toBe('restricted');
  });

  it('reports a network failure', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'hello', filter: 'karaoke' });
    expect(outcome).toEqual({ ok: false, error: { code: 'network', message: SEARCH_MESSAGES.network } });
  });

  it('still returns results, without lengths, when the lengths request fails', async () => {
    const send = vi.fn(async (url: string) => {
      if (url.includes('/search?')) return json(SEARCH_BODY);
      throw new TypeError('Failed to fetch');
    });
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'hello', filter: 'karaoke' });
    expect(outcome.ok && outcome.results.map((r) => r.durationS)).toEqual([null, null]);
  });

  it('ends an aborted search quietly', async () => {
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const provider = createYouTubeSearch({ apiKey: KEY, fetch: send as unknown as typeof fetch });
    const outcome = await provider.search({ text: 'hello', filter: 'karaoke' }, controller.signal);
    expect(!outcome.ok && outcome.error.code).toBe('aborted');
  });

  it('never puts the key in a message', () => {
    for (const message of Object.values(SEARCH_MESSAGES)) expect(message).not.toContain(KEY);
  });
});

describe('createSearchProvider', () => {
  it('builds the provider the settings name, with their key', async () => {
    const send = vi.fn(async (_url: string) => json({ items: [] }));
    const provider = createSearchProvider(
      { searchProvider: 'youtube', youtubeApiKey: KEY },
      send as unknown as typeof fetch,
    );
    await provider.search({ text: 'hello', filter: 'karaoke' });
    expect(String(send.mock.calls[0]?.[0])).toContain(`key=${KEY}`);
  });
});
