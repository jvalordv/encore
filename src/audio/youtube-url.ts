/**
 * Reads what the singer pastes. A YouTube link in any of the shapes the service
 * accepts (see "Song sources" in docs/ARCHITECTURE.md) becomes a video id and
 * an optional start time; anything else is null, so the page can tell a link
 * from a stray paste. The rules are the service's, step for step
 * (`parse_youtube_url` in service/encore_service/youtube.py), so a link means
 * the same on both sides, and they are narrow because the id ends up in an
 * iframe address: the text is trimmed, then capped at 2048 characters, and no
 * whitespace, control or other non-printing character may be left in it; https
 * or no scheme at all; one of six exact hosts, in ASCII (no look-alikes,
 * subdomains, user info, ports or trailing dots); a known path shape, where
 * /watch means exactly that; an id of exactly 11 characters from
 * [A-Za-z0-9_-], read from the raw text and never percent-decoded. No URL
 * parser is involved, so none can normalise a host or an id into a match. The
 * start time (`t=` or `start=`) is the one thing here the service does not
 * read. Pure, DOM-free and tested against the service's own accepted and
 * refused lists, plus more, in test/youtube-url.test.ts.
 */

/** A recognised link: the video, and where to start it when the link says. */
export interface ParsedYouTubeUrl {
  videoId: string;
  /** Whole seconds into the video; absent when the link has no start time. */
  startS?: number;
}

/** The only hosts a link may name, compared case-insensitively. */
const HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

/** Longest input looked at, once trimmed; a longer paste is not a link. */
const MAX_INPUT_CHARS = 2048;

/** A youtu.be path is the id alone, with an optional last slash. */
const SHORT_PATH = /^\/([^/]+)\/?$/;

/** /shorts/ID, /embed/ID, /live/ID and /v/ID, with an optional last slash. */
const ID_PATH = /^\/(?:shorts|embed|live|v)\/([^/]+)\/?$/;

/**
 * Ids that fit the id pattern but name a playlist or a channel's live stream
 * in an embed address, not a video.
 */
const PSEUDO_IDS: ReadonlySet<string> = new Set(['videoseries', 'live_stream']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Start times beyond this are treated as garbage (99 h 59 m 59 s). */
const MAX_START_S = 359_999;

/**
 * Characters in a Unicode "Other" or "Separator" category: control, format
 * (a zero-width space, a byte order mark), surrogate, private-use and
 * unassigned characters, and every kind of space. The service refuses a link
 * with one inside (Python's isprintable and isspace), because a URL parser
 * would drop some of them silently and accept what was not pasted.
 */
const NOT_PRINTABLE = /[\p{C}\p{Z}]/u;

/**
 * What Python's str.strip() takes off the ends, which is what the service
 * trims. Written with brace escapes so no invisible character sits in the
 * source.
 */
const SERVICE_SPACE =
  /[\t-\r\x1c-\x20\x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]/u;

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * The text without the whitespace the service would trim from its ends. This
 * is not String.trim(), which also takes off a byte order mark (the service
 * refuses one) and leaves a few control characters the service trims.
 */
function stripLikeService(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && SERVICE_SPACE.test(text[start])) start += 1;
  while (end > start && SERVICE_SPACE.test(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** The text after `https://`, or null for http, other schemes and `//host`. */
function afterScheme(input: string): string | null {
  if (/^https:\/\//i.test(input)) return input.slice('https://'.length);
  // A bare "youtube.com:80/..." also looks like a scheme here, which is right:
  // explicit ports are refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return null;
  if (input.startsWith('//')) return null;
  return input;
}

/** The raw value of the first `name=` in a query string, or null. */
function firstParam(query: string, name: string): string | null {
  // Not percent-decoded: an id is plain characters, so an escape never makes
  // one, and the service reads it the same way.
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=');
    if ((at < 0 ? pair : pair.slice(0, at)) === name) return at < 0 ? '' : pair.slice(at + 1);
  }
  return null;
}

/**
 * Seconds from `90`, `90s`, `1m30s` or `1h2m3s` (any in-order subset of the
 * units); undefined for anything else, for zero and for absurd values.
 */
function startSeconds(raw: string | null): number | undefined {
  if (raw === null || raw === '') return undefined;
  let total: number;
  const bare = /^(\d{1,6})s?$/.exec(raw);
  if (bare) {
    total = Number(bare[1]);
  } else {
    const parts = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s)?$/.exec(raw);
    if (!parts) return undefined;
    total = Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
  }
  return total > 0 && total <= MAX_START_S ? total : undefined;
}

/** True for a well-formed video id that is not a pseudo id. */
function isVideoId(id: string): boolean {
  return VIDEO_ID.test(id) && !PSEUDO_IDS.has(id);
}

/**
 * The video id and start time of a YouTube link, or null when the text is
 * anything else. `list=` and every other parameter are ignored, so a playlist
 * link plays its one video; a link with no video (a playlist, a channel, a
 * search) is null. When `v=` is given more than once the first one decides.
 */
export function parseYouTubeUrl(text: string): ParsedYouTubeUrl | null {
  if (typeof text !== 'string') return null;
  const input = stripLikeService(text);
  if (input === '' || input.length > MAX_INPUT_CHARS || NOT_PRINTABLE.test(input)) return null;

  const rest = afterScheme(input);
  if (rest === null) return null;
  const cut = rest.search(/[/?#]/);
  const rawHost = cut < 0 ? rest : rest.slice(0, cut);
  // ASCII only, judged before lower-casing: toLowerCase() maps a few other
  // characters, such as the Kelvin sign, onto ASCII letters and would let a
  // look-alike host through.
  if (!ASCII_ONLY.test(rawHost)) return null;
  const host = rawHost.toLowerCase();
  if (!HOSTS.has(host)) return null;

  const tail = cut < 0 ? '' : rest.slice(cut);
  const fragmentAt = tail.indexOf('#');
  const beforeFragment = fragmentAt < 0 ? tail : tail.slice(0, fragmentAt);
  const queryAt = beforeFragment.indexOf('?');
  const path = queryAt < 0 ? beforeFragment : beforeFragment.slice(0, queryAt);
  const query = queryAt < 0 ? '' : beforeFragment.slice(queryAt + 1);

  let videoId: string | null;
  if (host === 'youtu.be') videoId = SHORT_PATH.exec(path)?.[1] ?? null;
  else if (path === '/watch') videoId = firstParam(query, 'v');
  else videoId = ID_PATH.exec(path)?.[1] ?? null;
  if (videoId === null || !isVideoId(videoId)) return null;

  const startS = startSeconds(firstParam(query, 't') ?? firstParam(query, 'start'));
  return startS === undefined ? { videoId } : { videoId, startS };
}
