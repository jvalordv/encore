/**
 * The shapes of searching for a song: what is asked, what comes back and how
 * a failure is told. A SearchProvider is the seam: the app asks it a question
 * and gets results or a typed error in plain words, and nothing else in the
 * app knows which provider answered (see `createSearchProvider` in
 * ./index.ts). Types only, so importing this touches no browser API.
 */

/** The providers that exist; a server-backed one would be added here. */
export type SearchProviderId = 'youtube';

/** The ids, for validating a stored setting. */
export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = ['youtube'];

/** What the app reads from its settings to build a provider. */
export interface SearchSettings {
  searchProvider: SearchProviderId;
  /** The person's own YouTube Data API key; empty when none is set. */
  youtubeApiKey: string;
}

/** Which kind of video is wanted: a karaoke track, or the song itself. */
export type SearchFilter = 'karaoke' | 'original';

/** What a result looks like to the title and channel classifier. */
export type ResultKind = 'karaoke' | 'original';

/** A search as the person typed it plus the chip beside it. */
export interface SearchRequest {
  /** The words typed, without the chip's word added. */
  text: string;
  filter: SearchFilter;
}

/** One video found. */
export interface SearchResult {
  videoId: string;
  title: string;
  channel: string;
  /** Length in seconds; null when the provider did not say. */
  durationS: number | null;
  /** An https picture, or empty when there is none. */
  thumbnailUrl: string;
  /** Karaoke or original, judged from the title and channel. */
  kind: ResultKind;
}

/**
 * Why a search failed. 'no-key': none is set. 'bad-key': the provider does
 * not accept it. 'restricted': the key is fine but limited away from this
 * page or this API. 'quota': the day's searches are spent. 'network': the
 * provider could not be reached. 'failed': anything else. 'aborted': the
 * search was overtaken or cancelled; nobody needs telling.
 */
export type SearchErrorCode =
  | 'no-key'
  | 'bad-key'
  | 'restricted'
  | 'quota'
  | 'network'
  | 'failed'
  | 'aborted';

/** A failure, with the sentence to show. It never contains the key. */
export interface SearchError {
  code: SearchErrorCode;
  message: string;
}

/** A search that did not produce results. */
export interface SearchFailure {
  ok: false;
  error: SearchError;
}

/** What a search ends in; it never throws. */
export type SearchOutcome = { ok: true; results: SearchResult[] } | SearchFailure;

/** Anything that can answer a search. */
export interface SearchProvider {
  /** Runs the search; an aborted signal ends it with the 'aborted' error. */
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchOutcome>;
}
