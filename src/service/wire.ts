/**
 * Checks on what the service sends back for a song's stems, melody and key,
 * apart from the client that asks: the header that carries the stems' gain and
 * the shape tests for a reference melody and a key map. Pure, so they are
 * tested against plain values (test/service-client.test.ts) and a body the app
 * cannot use is turned away at the door instead of failing further in.
 */
import type { KeyMap, Reference, TakeAnalysis } from './types';

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

/** True when `value` is a key map this app can judge singing against. */
export function isKeyMap(value: unknown): value is KeyMap {
  if (!isRecord(value) || typeof value.tuning_cents !== 'number' || !Number.isFinite(value.tuning_cents)) {
    return false;
  }
  if (!Array.isArray(value.segments)) return false;
  return value.segments.every((segment: unknown) => {
    if (!isRecord(segment) || !numbers([segment.start_s, segment.end_s, segment.confidence])) return false;
    const { tonic, mode } = segment;
    if (tonic === null) return mode === null;
    const tonicOk = typeof tonic === 'number' && Number.isInteger(tonic) && tonic >= 0 && tonic <= 11;
    return tonicOk && (mode === 'major' || mode === 'minor');
  });
}

const VALUE_KEYS = [
  'draw_margin_db',
  'clarity_threshold',
  'bleed_match_cents',
  'bleed_min_match',
  'bleed_max_median_cents',
  'latency_s',
] as const;

function strings(list: unknown): boolean {
  return Array.isArray(list) && list.every((s) => typeof s === 'string');
}

/** True when `value` is a take analysis this app can show and apply. */
export function isTakeAnalysis(value: unknown): value is TakeAnalysis {
  if (!isRecord(value) || typeof value.report_text !== 'string') return false;
  if (!strings(value.findings) || !strings(value.notes) || !Array.isArray(value.sections)) return false;
  const sectionOk = (s: unknown): boolean =>
    isRecord(s) &&
    typeof s.label === 'string' &&
    (s.kind === 'silent' || s.kind === 'sing') &&
    typeof s.verdict === 'string' &&
    numbers([s.start_s, s.end_s]);
  if (!value.sections.every(sectionOk)) return false;
  const { current, recommended } = value;
  if (!isRecord(current) || !isRecord(recommended)) return false;
  return VALUE_KEYS.every((key) => {
    const c = current[key];
    const r = recommended[key];
    const cOk = key === 'latency_s' ? c === null || typeof c === 'number' : typeof c === 'number';
    return cOk && (r === null || (typeof r === 'number' && Number.isFinite(r)));
  });
}
