/**
 * The search seam. `createSearchProvider` is the only place that reads which
 * provider the settings name; everything else holds a `SearchProvider` and
 * asks it. A provider that calls a server holding the key (for a public app)
 * would be one more case here and nothing else would change. Re-exports the
 * pieces the app uses.
 */
import type { SearchProvider, SearchSettings } from './types';
import { createYouTubeSearch } from './youtube';

export { classifyResult, isKaraokeChannel } from './classify';
export { formatDuration, parseIsoDuration } from './duration';
export { MAX_KEY_CHARS, normalizeApiKey } from './key';
export { buildQuery, findOriginalQuery, youtubeResultsUrl } from './query';
export { SEARCH_PROVIDER_IDS } from './types';
export type {
  ResultKind,
  SearchError,
  SearchErrorCode,
  SearchFailure,
  SearchFilter,
  SearchOutcome,
  SearchProvider,
  SearchProviderId,
  SearchRequest,
  SearchResult,
  SearchSettings,
} from './types';

/** Builds the provider the settings name, with the fetch to use if not the page's. */
export function createSearchProvider(
  settings: SearchSettings,
  fetchFn?: typeof fetch,
): SearchProvider {
  switch (settings.searchProvider) {
    case 'youtube':
      return createYouTubeSearch({ apiKey: settings.youtubeApiKey, fetch: fetchFn });
  }
}
