/**
 * A small client for LRCLIB (lrclib.net), a free lyrics database that needs
 * no key. `get` asks for one exact track by title, artist and duration;
 * `search` is the looser fallback. Synced lyrics (LRC text) are preferred and
 * plain lyrics are the fallback. Nothing about the person is sent: no
 * address, no id, only the song's title, artist and length. The fetch is
 * injected so tests run without a network, and every failure is one plain
 * sentence in a LyricsError.
 */

/** The song to look up. */
export interface LyricsQuery {
  title: string;
  artist: string;
  /** Song length in seconds, used to pick the right cut of a track. */
  durationS?: number;
}

/** What LRCLIB had for a song; either text may be null, not both. */
export interface LyricsFound {
  synced: string | null;
  plain: string | null;
  title: string;
  artist: string;
}

/** A lookup that failed, with the sentence to show. */
export class LyricsError extends Error {}

/** The client's two calls. */
export interface LrclibClient {
  /** The best match for the query, or null when LRCLIB has none. */
  find(query: LyricsQuery): Promise<LyricsFound | null>;
}

/** Options; each has a working default. */
export interface LrclibOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

interface Row {
  trackName?: string;
  artistName?: string;
  duration?: number;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
}

const DEFAULT_BASE = 'https://lrclib.net/api';
const DEFAULT_TIMEOUT_MS = 8000;
/** Hits within this many seconds of the length are preferred; a video may add an intro. */
const DURATION_SLACK_S = 8;

function foundFrom(row: Row, query: LyricsQuery): LyricsFound | null {
  const synced = row.syncedLyrics?.trim() ? row.syncedLyrics : null;
  const plain = row.plainLyrics?.trim() ? row.plainLyrics : null;
  if (synced === null && plain === null) return null;
  return { synced, plain, title: row.trackName ?? query.title, artist: row.artistName ?? query.artist };
}

/** The search row to use: synced first, then the nearest in length. */
function bestRow(rows: readonly Row[], query: LyricsQuery): Row | null {
  const usable = rows.filter((r) => foundFrom(r, query) !== null);
  const distance = (r: Row): number =>
    query.durationS === undefined || r.duration === undefined ? 0 : Math.abs(r.duration - query.durationS);
  const near = usable.filter((r) => distance(r) <= DURATION_SLACK_S);
  const pool = near.length > 0 ? near : usable;
  const synced = pool.filter((r) => r.syncedLyrics?.trim());
  const choices = synced.length > 0 ? synced : pool;
  choices.sort((a, b) => distance(a) - distance(b));
  return choices[0] ?? null;
}

/** Builds the client on `options.fetch` (default: the platform's). */
export function createLrclibClient(options: LrclibOptions = {}): LrclibClient {
  const base = options.baseUrl ?? DEFAULT_BASE;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(path: string, params: Record<string, string>): Promise<unknown> {
    const doFetch = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    if (!doFetch) throw new LyricsError('This browser cannot look up lyrics.');
    const url = `${base}${path}?${new URLSearchParams(params).toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, { signal: controller.signal });
      if (response.status === 404) return null;
      if (!response.ok) throw new LyricsError(`LRCLIB answered ${response.status}; try again in a moment.`);
      return await response.json();
    } catch (error) {
      if (error instanceof LyricsError) throw error;
      const timedOut = controller.signal.aborted;
      throw new LyricsError(
        timedOut ? 'LRCLIB did not answer in time.' : 'Could not reach LRCLIB; check the connection.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function searchBest(q: string, query: LyricsQuery, needSynced: boolean): Promise<LyricsFound | null> {
    const rows = (await request('/search', { q })) as Row[] | null;
    const row = Array.isArray(rows) ? bestRow(rows, query) : null;
    const found = row ? foundFrom(row, query) : null;
    return needSynced && !found?.synced ? null : found;
  }

  return {
    async find(query) {
      const title = query.title.trim();
      const artist = query.artist.trim();
      if (title === '') throw new LyricsError('Type a song title to look up.');
      if (artist !== '') {
        const params: Record<string, string> = { track_name: title, artist_name: artist };
        if (query.durationS !== undefined && query.durationS > 0) {
          params.duration = String(Math.round(query.durationS));
        }
        const exact = (await request('/get', params)) as Row | null;
        const hit = exact && !Array.isArray(exact) ? foundFrom(exact, query) : null;
        if (hit?.synced) return hit;
        // A plain-only exact hit may have a synced twin in the search rows.
        const found = await searchBest(`${artist} ${title}`.trim(), query, hit !== null).catch((e: unknown) => {
          if (hit === null) throw e;
          return null;
        });
        return found ?? hit;
      }
      return searchBest(title, query, false);
    },
  };
}
