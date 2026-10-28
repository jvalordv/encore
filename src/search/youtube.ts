/**
 * The search provider that asks Google directly, with the person's own YouTube
 * Data API v3 key: `search.list` for twelve embeddable videos (100 quota
 * units), then one `videos.list` for their lengths (1 unit). The pure pieces
 * are exported and tested on their own: the reading of an error response into
 * a sentence (`describeApiFailure`), HTML entities in titles (`decodeEntities`)
 * and the mapping of both responses into results (`readResults`). The key goes
 * only into the request address; no message, result or log ever holds it.
 */
import { classifyResult } from './classify';
import { parseIsoDuration } from './duration';
import { buildQuery } from './query';
import type {
  SearchError,
  SearchFailure,
  SearchOutcome,
  SearchProvider,
  SearchRequest,
  SearchResult,
} from './types';

const API = 'https://www.googleapis.com/youtube/v3';

/** How many videos one search asks for. */
export const RESULT_COUNT = 12;

/** What the provider needs: the key, and a fetch to use in place of the page's. */
export interface YouTubeSearchOptions {
  apiKey: string;
  fetch?: typeof fetch;
}

/** The sentence for a failure; the strings are the app's wording, one place. */
export const SEARCH_MESSAGES = {
  noKey:
    'No YouTube API key is set. Paste one below to search here; until then the search opens on YouTube.',
  badKey: 'YouTube does not accept that API key. Check that it was pasted whole, with nothing around it.',
  restricted:
    'That key is limited so it cannot search from this page. In the Google Cloud console, allow the ' +
    'YouTube Data API v3 and this site address (for example http://localhost:5173/*) for the key.',
  quota:
    "Today's free searches on this key are used up (about 100 a day; they reset at midnight Pacific time). " +
    "Searching now opens YouTube's own search in a new tab; a pasted link still works.",
  tooFast: 'YouTube says searches are coming too fast. Wait a moment and try again.',
  network: 'Could not reach YouTube. Check the connection and try again.',
  failed: 'YouTube could not search just now. Try again in a moment.',
} as const;

function error(code: SearchError['code'], message: string): SearchFailure {
  return { ok: false, error: { code, message } };
}

/** The reasons Google lists in an error body, from both places it puts them. */
function reasonsOf(body: unknown): string[] {
  if (typeof body !== 'object' || body === null) return [];
  const err = (body as { error?: unknown }).error;
  if (typeof err !== 'object' || err === null) return [];
  const found: string[] = [];
  const { errors, details } = err as { errors?: unknown; details?: unknown };
  for (const list of [errors, details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const reason = (item as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string') found.push(reason);
    }
  }
  return found;
}

function messageOf(body: unknown): string {
  const err = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof err?.message === 'string' ? err.message : '';
}

const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg']);
const BAD_KEY_REASONS = new Set(['keyInvalid', 'API_KEY_INVALID', 'keyExpired', 'API_KEY_EXPIRED']);
const RESTRICTED_REASONS = new Set([
  'ipRefererBlocked',
  'accessNotConfigured',
  'forbidden',
  'API_KEY_HTTP_REFERRER_BLOCKED',
  'API_KEY_SERVICE_BLOCKED',
  'API_KEY_IP_ADDRESS_BLOCKED',
  'SERVICE_DISABLED',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
]);

/** Reads a failed API response (status and parsed body) into a typed error. */
export function describeApiFailure(status: number, body: unknown): SearchFailure {
  const reasons = reasonsOf(body);
  const has = (set: Set<string>): boolean => reasons.some((r) => set.has(r));
  const text = messageOf(body);
  if (has(QUOTA_REASONS)) return error('quota', SEARCH_MESSAGES.quota);
  if (reasons.includes('rateLimitExceeded') || status === 429) {
    return error('failed', SEARCH_MESSAGES.tooFast);
  }
  if (has(BAD_KEY_REASONS) || /api key not valid|api key expired/i.test(text)) {
    return error('bad-key', SEARCH_MESSAGES.badKey);
  }
  if (has(RESTRICTED_REASONS) || /referer|referrer|blocked|not been used|disabled/i.test(text)) {
    return error('restricted', SEARCH_MESSAGES.restricted);
  }
  if (status === 401) return error('bad-key', SEARCH_MESSAGES.badKey);
  if (status === 403) return error('restricted', SEARCH_MESSAGES.restricted);
  return error('failed', SEARCH_MESSAGES.failed);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Titles arrive HTML-escaped ("Rock &amp; Roll", "Don&#39;t"); this undoes it. */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (whole, dec, hex, name) => {
    if (name !== undefined) return NAMED_ENTITIES[String(name).toLowerCase()] ?? whole;
    const code = dec !== undefined ? Number(dec) : parseInt(String(hex), 16);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

interface SearchItem {
  id?: { videoId?: unknown };
  snippet?: {
    title?: unknown;
    channelTitle?: unknown;
    thumbnails?: Record<string, { url?: unknown } | undefined>;
  };
}

interface VideoItem {
  id?: unknown;
  contentDetails?: { duration?: unknown };
}

/** A picture address if it is a plain https one; empty otherwise. */
function thumbnailOf(snippet: SearchItem['snippet']): string {
  for (const size of ['medium', 'high', 'default']) {
    const url = snippet?.thumbnails?.[size]?.url;
    if (typeof url === 'string' && url.startsWith('https://')) return url;
  }
  return '';
}

/**
 * Results from a `search.list` body and, if there is one, a `videos.list`
 * body for the lengths. Items without a video id are dropped; a video missing
 * from the second body keeps a null length.
 */
export function readResults(searchBody: unknown, videosBody?: unknown): SearchResult[] {
  const items = (searchBody as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const lengths = new Map<string, number | null>();
  const videos = (videosBody as { items?: unknown } | null | undefined)?.items;
  if (Array.isArray(videos)) {
    for (const video of videos as VideoItem[]) {
      const duration = video?.contentDetails?.duration;
      if (typeof video?.id === 'string') {
        lengths.set(video.id, typeof duration === 'string' ? parseIsoDuration(duration) : null);
      }
    }
  }
  const results: SearchResult[] = [];
  for (const item of items as SearchItem[]) {
    const videoId = item?.id?.videoId;
    if (typeof videoId !== 'string' || !/^[\w-]{6,}$/.test(videoId)) continue;
    const title = decodeEntities(typeof item.snippet?.title === 'string' ? item.snippet.title : '');
    const channel = decodeEntities(
      typeof item.snippet?.channelTitle === 'string' ? item.snippet.channelTitle : '',
    );
    results.push({
      videoId,
      title: title || videoId,
      channel,
      durationS: lengths.get(videoId) ?? null,
      thumbnailUrl: thumbnailOf(item.snippet),
      kind: classifyResult(title, channel),
    });
  }
  return results;
}

/** A provider that calls the YouTube Data API v3 with the given key. */
export function createYouTubeSearch(options: YouTubeSearchOptions): SearchProvider {
  const key = options.apiKey.trim();
  const getJson = async (
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; body: unknown }> => {
    const query = new URLSearchParams({ ...params, key });
    const send = options.fetch ?? globalThis.fetch.bind(globalThis);
    const response = await send(`${API}/${path}?${query.toString()}`, { signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // An error page that is not JSON still has a status to go on.
    }
    return { status: response.status, ok: response.ok, body };
  };

  return {
    async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome> {
      if (key === '') return error('no-key', SEARCH_MESSAGES.noKey);
      const q = buildQuery(request);
      if (q === '') return { ok: true, results: [] };
      try {
        const found = await getJson(
          'search',
          {
            part: 'snippet',
            type: 'video',
            videoEmbeddable: 'true',
            maxResults: String(RESULT_COUNT),
            q,
          },
          signal,
        );
        if (!found.ok) return describeApiFailure(found.status, found.body);
        const ids = readResults(found.body).map((r) => r.videoId);
        if (ids.length === 0) return { ok: true, results: [] };
        // The lengths are a nicety: a failure here costs only the numbers.
        let lengths: unknown;
        try {
          const detail = await getJson('videos', { part: 'contentDetails', id: ids.join(',') }, signal);
          if (detail.ok) lengths = detail.body;
        } catch (cause) {
          if (signal?.aborted) throw cause;
        }
        return { ok: true, results: readResults(found.body, lengths) };
      } catch {
        if (signal?.aborted) return error('aborted', '');
        return error('network', SEARCH_MESSAGES.network);
      }
    },
  };
}
