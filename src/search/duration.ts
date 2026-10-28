/**
 * ISO 8601 durations as YouTube's `contentDetails.duration` writes them
 * ("PT4M13S", "PT1H2M", "P1DT2H"), read into seconds, and a length written
 * for a result card. Pure.
 */

/** Days, hours, minutes and seconds; years and months do not occur in video lengths. */
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** Seconds in an ISO 8601 duration, or null when the text is not one. */
export function parseIsoDuration(text: string): number | null {
  const match = DURATION.exec(text.trim());
  // A bare "P" or "PT" matches the pattern but names no length.
  if (!match || text.trim() === 'P' || text.trim().endsWith('T')) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Math.round(Number(seconds ?? 0))
  );
}

/** `m:ss`, or `h:mm:ss` from an hour up; empty for no length or a live stream (0). */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const ss = String(total % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}
