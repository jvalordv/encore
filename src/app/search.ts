/**
 * Searching for a song, apart from the Session that does it: what the search
 * panel is told (`SearchState`: the chip, the words searched, where the search
 * stands, the results and one message) and the small pure rules around it, so
 * they are tested without a page. The search itself is src/search/; the
 * Session's SearchController (src/app/session/search.ts) runs it and writes
 * this state; the panel (src/app/panels/search.ts) draws it.
 */
import type { ResultKind, SearchErrorCode, SearchFilter, SearchResult } from '../search/types';
import type { PracticeMode } from './settings';

/** Where the last search stands: none yet, under way, answered, or failed. */
export type SearchPhase = 'idle' | 'searching' | 'done' | 'failed';

/** What the search panel shows. */
export interface SearchState {
  /** True once the person has asked for the search while a song is loaded. */
  open: boolean;
  /** The chip: karaoke versions or originals. */
  filter: SearchFilter;
  /** The words last searched, without the chip's own word. */
  query: string;
  phase: SearchPhase;
  results: SearchResult[];
  /** The code of the last failure; null while there is none. */
  errorCode: SearchErrorCode | null;
  /** One sentence about the last search: why it failed, or what it opened. */
  message: string;
  /** Whether a key is set; without one a search opens YouTube in a new tab. */
  hasKey: boolean;
  /** True once the key's quota was spent; searches then open YouTube too. */
  quotaSpent: boolean;
  /** The karaoke title a "Find the original" search began from; else null. */
  originalOf: string | null;
}

/**
 * The search result that became the song: what learning mode needs to know
 * about it (is it a karaoke track, and what to look for to find the original).
 */
export interface PickedResult {
  videoId: string;
  title: string;
  channel: string;
  kind: ResultKind;
}

/** The chip a practice mode starts on: karaoke asks for karaoke, learning for originals. */
export function filterForMode(mode: PracticeMode): SearchFilter {
  return mode === 'learning' ? 'original' : 'karaoke';
}

/** A fresh search state for a page with nothing searched. */
export function initialSearch(mode: PracticeMode, hasKey: boolean): SearchState {
  return {
    open: false,
    filter: filterForMode(mode),
    query: '',
    phase: 'idle',
    results: [],
    errorCode: null,
    message: '',
    hasKey,
    quotaSpent: false,
    originalOf: null,
  };
}

/** True when a search opens YouTube's own page instead of asking the API. */
export function searchesExternally(search: Pick<SearchState, 'hasKey' | 'quotaSpent'>): boolean {
  return !search.hasKey || search.quotaSpent;
}

/** The search is what the page shows with no song, and on request with one. */
export function searchVisible(hasSong: boolean, search: Pick<SearchState, 'open'>): boolean {
  return !hasSong || search.open;
}

/** The line above the results, naming what they are. */
export function describeResults(search: SearchState): string {
  if (search.phase === 'searching') return 'Searching…';
  if (search.phase !== 'done') return '';
  const what = search.filter === 'karaoke' ? 'karaoke versions' : 'originals';
  if (search.results.length === 0) return `No ${what} found for "${search.query}".`;
  if (search.originalOf !== null) return `Originals of "${search.originalOf}".`;
  return `${what[0]?.toUpperCase()}${what.slice(1)} for "${search.query}".`;
}
