/**
 * Asks YouTube's oEmbed endpoint, before a player is built, whether a video
 * can be shown outside youtube.com. The endpoint answers 401 when the owner
 * blocks embedding and 404 when no such video exists; the player's own error
 * (101/150) cannot tell the two apart. The endpoint allows cross-origin
 * reads, so the browser asks it directly. It is advice only: any other
 * answer, or a failure to ask, means "unknown" and never blocks a load.
 */

/** What the check learned about a video. */
export type EmbedVerdict = 'ok' | 'blocked' | 'missing' | 'unknown';

/** The fetch the check needs, so tests can supply their own. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>;

const OEMBED = 'https://www.youtube.com/oembed';
const TIMEOUT_MS = 4000;

/** Maps an oEmbed HTTP status to a verdict. */
export function verdictForStatus(status: number): EmbedVerdict {
  if (status === 200) return 'ok';
  if (status === 401 || status === 403) return 'blocked';
  if (status === 404) return 'missing';
  return 'unknown';
}

/** Asks whether a video can be embedded; 'unknown' on any failure. */
export async function checkEmbeddable(
  videoId: string,
  fetcher: FetchLike | null = typeof fetch === 'function' ? (u, i) => fetch(u, i) : null,
): Promise<EmbedVerdict> {
  if (!fetcher) return 'unknown';
  const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const url = `${OEMBED}?url=${encodeURIComponent(watch)}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const reply = await fetcher(url, { signal: controller.signal });
    return verdictForStatus(reply.status);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/** The plain message for a verdict that stops the load, or null. */
export function describeVerdict(verdict: EmbedVerdict): string | null {
  if (verdict === 'blocked') {
    return (
      "The owner of that video blocks playing it outside YouTube. Try another upload of the song (karaoke channels usually allow it), or set a search key so Search shows only videos that play here (README, 'Run it')."
    );
  }
  if (verdict === 'missing') return 'That video does not exist. Check the link.';
  return null;
}
