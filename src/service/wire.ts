/**
 * Checks on what the service sends back for a song's stems and melody, apart
 * from the client that asks: the header that carries the stems' gain and the
 * shape test for a reference melody. Pure, so they are tested against plain
 * values (test/service-client.test.ts) and a body the app cannot draw is
 * turned away at the door instead of failing inside the lane.
 */
import type { Reference } from './types';

/** The header that carries the factor the stems were scaled by. */
export const STEM_GAIN_HEADER = 'X-Stem-Gain';

/** A stem as the service serves it: the file's bytes and the gain it carries. */
export interface StemDownload {
  bytes: ArrayBuffer;
  /** The factor the song was multiplied by to make the stems; at most 1. */
  gain: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numbers(list: unknown): boolean {
  return Array.isArray(list) && list.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/** The gain header as a factor the song can be multiplied by; 1 if unusable. */
export function parseStemGain(header: string | null): number {
  const gain = header === null ? Number.NaN : Number(header);
  return Number.isFinite(gain) && gain > 0 ? gain : 1;
}

/** True when `value` is a reference melody this app can draw. */
export function isReference(value: unknown): value is Reference {
  if (!isRecord(value) || !isRecord(value.contour) || !isRecord(value.range)) return false;
  const { contour, range } = value;
  if (!(typeof contour.hop_s === 'number' && contour.hop_s > 0)) return false;
  if (typeof contour.t0_s !== 'number' || !numbers(contour.f0_hz)) return false;
  if (typeof range.low_midi !== 'number' || typeof range.high_midi !== 'number') return false;
  if (!Array.isArray(value.notes) || !Array.isArray(value.unpitched_regions)) return false;
  const noteOk = (note: unknown): boolean =>
    isRecord(note) && numbers([note.onset_s, note.offset_s, note.midi]);
  const regionOk = (region: unknown): boolean => numbers(region) && (region as unknown[]).length === 2;
  return value.notes.every(noteOk) && value.unpitched_regions.every(regionOk);
}
