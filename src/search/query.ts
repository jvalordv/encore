/**
 * The words sent to a search. Three pure pieces: the query for a chip (Karaoke
 * versions adds "karaoke", Originals asks for videos without it), the address
 * of YouTube's own results page for when the app cannot search by itself, and
 * "Find the original": a karaoke video's title with the karaoke words, the
 * bracketed tags and the channel's name taken out, so what is left is the
 * song. W3's learning mode calls the last when it is handed a karaoke track.
 */
import { KARAOKE_CHANNEL_NAMES, KARAOKE_WORDS, classifyResult } from './classify';
import type { SearchRequest } from './types';

/** Where YouTube's own search lives, for the fallback tab. */
const RESULTS_URL = 'https://www.youtube.com/results';

/** The longest search text sent on; YouTube cuts a query far below this. */
const MAX_QUERY_CHARS = 200;

/** The word the Karaoke chip adds. */
const KARAOKE_WORD = 'karaoke';

/** Words that trail a removed karaoke word ("Karaoke Version", "Instrumental Track"). */
const TRAILERS = 'version|track|tracks|cover|mix|edition|video|with lyrics|lyrics';

/** Matches a karaoke phrase and the trailers behind it, anywhere in a title. */
const KARAOKE_RUN = new RegExp(
  `${KARAOKE_WORDS.source}(?:[ \\-]+(?:${TRAILERS})(?![\\p{L}\\p{N}]))*`,
  'giu',
);

/** Matches a known karaoke channel's name anywhere in a title. */
const CHANNEL_RUN = new RegExp(KARAOKE_CHANNEL_NAMES.source, 'giu');

/** "(Originally Performed by Adele)" and its kin: the artist is worth keeping. */
const ORIGINALLY = /[([{]?\s*originally\s+(?:performed|made famous|recorded|sung)\s+by\s+([^)\]}]+)[)\]}]?/giu;

/** "(In the Style of Adele)": the same. */
const IN_THE_STYLE = /[([{]\s*in the style of\s+([^)\]}]+)[)\]}]/giu;

/** Anything in brackets. */
const BRACKETED = /[([{][^)\]}]*[)\]}]/gu;

/** Separators left dangling at either end once words are taken out. */
const DANGLING = /^[\s\-–—|:,;/]+|[\s\-–—|:,;/]+$/gu;

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The typed words, trimmed, squashed and kept to a length YouTube accepts. */
function typed(text: string): string {
  return squash(text).slice(0, MAX_QUERY_CHARS);
}

/**
 * The query for a request. Karaoke versions append "karaoke" unless the words
 * already say it; Originals exclude it with YouTube's minus operator, unless
 * the words ask for karaoke themselves. Blank text gives a blank query.
 */
export function buildQuery(request: SearchRequest): string {
  const text = typed(request.text);
  if (text === '') return '';
  const asksForKaraoke = KARAOKE_WORDS.test(text);
  if (request.filter === 'karaoke') return asksForKaraoke ? text : `${text} ${KARAOKE_WORD}`;
  return asksForKaraoke ? text : `${text} -${KARAOKE_WORD}`;
}

/** The address of YouTube's results page for the request, for a new tab. */
export function youtubeResultsUrl(request: SearchRequest): string {
  return `${RESULTS_URL}?search_query=${encodeURIComponent(buildQuery(request))}`;
}

/**
 * The song a karaoke video is a copy of, as search words: its title without
 * the karaoke words ("Karaoke Version"), bracketed tags, "|" suffixes and the
 * channel's name, and with an "Originally performed by" artist kept. A title
 * that is nothing but karaoke words comes back whole, trimmed, so there is
 * always something to search for.
 */
export function findOriginalQuery(title: string, channel = ''): string {
  let text = title.replace(ORIGINALLY, ' $1 ').replace(IN_THE_STYLE, ' $1 ');
  text = text.replace(BRACKETED, (tag) => (classifyResult(tag, '') === 'karaoke' ? ' ' : tag));
  // A "|" splits the song from the channel's tag line ("... | Sing King").
  text = text
    .split('|')
    .filter((part) => residue(part) !== '' && !sameName(part, channel))
    .join(' ');
  text = text.replace(KARAOKE_RUN, ' ').replace(CHANNEL_RUN, ' ');
  if (channel !== '' && classifyResult('', channel) === 'karaoke') {
    text = text.split(new RegExp(escapeRegExp(channel), 'iu')).join(' ');
  }
  // Brackets that held only karaoke words leave their empty shells behind.
  text = text.replace(/[([{]\s*[)\]}]/gu, ' ');
  const cleaned = squash(text).replace(DANGLING, '');
  const result = squash(cleaned);
  return result === '' ? squash(title) : typed(result);
}

/** What is left of a piece of title once karaoke words and channel names go. */
function residue(part: string): string {
  return squash(part.replace(KARAOKE_RUN, ' ').replace(CHANNEL_RUN, ' ')).replace(DANGLING, '');
}

function sameName(a: string, b: string): boolean {
  return b !== '' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
