/**
 * Finding a song to sing: runs the search the panel asks for and writes the
 * answer into `state.search`. A search goes to the provider the settings name
 * (src/search/), one at a time, a newer one overtaking an older. With no key,
 * or once the key's quota is spent, a search instead opens YouTube's own
 * results in a new tab, which has to happen in the click that asked for it,
 * so that check comes before anything is awaited. A pick loads like a pasted
 * link. "Find the original" turns a karaoke result's title into an Originals
 * search; learning mode (W3) calls it for a karaoke track. The search panel
 * shows this state and holds no logic of its own.
 */
import {
  buildQuery,
  createSearchProvider,
  findOriginalQuery,
  normalizeApiKey,
  youtubeResultsUrl,
} from '../../search';
import type { SearchFilter, SearchRequest, SearchResult } from '../../search';
import { initialSearch, searchesExternally } from '../search';
import type { SearchState } from '../search';
import type { SessionCore } from './core';

/** Where search can be seen to reach out: both replaceable in tests. */
export interface SearchOptions {
  /** The fetch the provider uses; the page's own by default. */
  fetch?: typeof fetch;
  /** Opens an address in a new tab; the default is `window.open`, no opener. */
  openTab?: (url: string) => void;
}

/** What is said when a search is sent to YouTube's own page. */
export const OPENED_ON_YOUTUBE =
  "Opened YouTube's own search in a new tab. Paste the link of what you pick into the link box.";
/** What is said for a blank search. */
export const EMPTY_SEARCH = 'Type the name of a song or an artist.';
/** What is said once a key is kept, and once it is forgotten. */
export const KEY_SAVED = 'Key saved in this browser. Searches now run here.';
export const KEY_FORGOTTEN = "Key forgotten. Searches now open YouTube's own search.";
/** What is said when the pasted key cannot be one. */
export const NOT_A_KEY =
  'That does not look like an API key: it is letters, digits, hyphens and underscores only.';

function defaultOpenTab(url: string): void {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
}

/** Owns the search state: the chip, the key, the running search and its results. */
export class SearchController {
  private abort: AbortController | null = null;
  private token = 0;
  private songHash: string | null = null;

  constructor(
    private readonly core: SessionCore,
    private readonly options: SearchOptions = {},
  ) {
    const { mode, youtubeApiKey } = core.current;
    core.store.patch({ search: initialSearch(mode, youtubeApiKey !== '') });
    // A song that arrives ends the wish to look for another.
    core.store.subscribe((state, changed) => {
      if (!changed.has('song')) return;
      const hash = state.song?.hash ?? null;
      if (hash !== this.songHash) this.setOpen(false);
      this.songHash = hash;
    });
  }

  private get state(): SearchState {
    return this.core.store.state.search;
  }

  private set(p: Partial<SearchState>): void {
    this.core.store.patch({ search: { ...this.state, ...p } });
  }

  /** Shows or hides the search while a song is loaded; with none it always shows. */
  setOpen(open: boolean): void {
    if (this.state.open !== open) this.set({ open });
  }

  /** Chooses karaoke versions or originals for the next search. */
  setFilter(filter: SearchFilter): void {
    if (this.state.filter !== filter) this.set({ filter });
  }

  /**
   * Keeps the pasted key (or forgets it when blank). A key that cannot be one
   * is refused with a note; a new key starts a fresh quota.
   */
  setKey(text: string): boolean {
    const key = normalizeApiKey(text);
    if (key === null) {
      this.set({ errorCode: 'bad-key', message: NOT_A_KEY });
      return false;
    }
    this.core.current.youtubeApiKey = key;
    this.core.persist();
    this.set({
      hasKey: key !== '',
      quotaSpent: false,
      errorCode: null,
      message: key === '' ? KEY_FORGOTTEN : KEY_SAVED,
    });
    return true;
  }

  /**
   * Searches for `text` under the chip (or `filter`). Without a key, or with
   * the quota spent, this opens YouTube's results in a new tab and must be
   * called straight from the click.
   */
  search(text: string, filter: SearchFilter = this.state.filter, originalOf: string | null = null): void {
    const request: SearchRequest = { text, filter };
    const query = buildQuery(request);
    if (query === '') {
      this.set({ message: EMPTY_SEARCH, errorCode: null });
      return;
    }
    const shown = text.replace(/\s+/g, ' ').trim();
    this.abort?.abort();
    this.abort = null;
    const token = ++this.token;
    if (searchesExternally(this.state)) {
      (this.options.openTab ?? defaultOpenTab)(youtubeResultsUrl(request));
      this.set({ filter, query: shown, phase: 'idle', results: [], errorCode: null, message: OPENED_ON_YOUTUBE, originalOf });
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    this.set({ filter, query: shown, phase: 'searching', results: [], errorCode: null, message: '', originalOf });
    const provider = createSearchProvider(this.core.current, this.options.fetch);
    void provider.search(request, abort.signal).then((outcome) => {
      if (token !== this.token) return;
      this.abort = null;
      if (outcome.ok) {
        this.set({ phase: 'done', results: outcome.results, errorCode: null, message: '' });
        return;
      }
      if (outcome.error.code === 'aborted') return;
      this.set({
        phase: 'failed',
        results: [],
        errorCode: outcome.error.code,
        message: outcome.error.message,
        ...(outcome.error.code === 'quota' ? { quotaSpent: true } : {}),
      });
    });
  }

  /**
   * Looks for the song behind a karaoke video: its title without the karaoke
   * words, searched as Originals. Opens the search if a song is loaded.
   */
  findOriginal(video: Pick<SearchResult, 'title' | 'channel'>): void {
    this.setOpen(true);
    this.search(findOriginalQuery(video.title, video.channel), 'original', video.title);
  }

  /** Loads a result as the song, the way a pasted link is loaded. */
  async pick(videoId: string): Promise<void> {
    await this.core.songs.loadLink(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    if (this.core.store.state.song?.hash === `yt-${videoId}`) this.setOpen(false);
  }

  /** Cancels a search under way. */
  dispose(): void {
    this.abort?.abort();
    this.abort = null;
    this.token++;
  }
}
