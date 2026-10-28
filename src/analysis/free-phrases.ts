/**
 * Free phrases: stretches of a song the singer has marked as theirs to
 * ad-lib (docs/COACHING.md, "Scoring styles"). A free phrase is a phrase from
 * the one splitter in phrases.ts, kept as a plain `[startS, endS]` span so it
 * can be stored per song and compared by value. In Strict, singing inside a
 * free phrase is judged as in Open. This module holds the pure side: finding
 * the phrase at a time, toggling a span, and reading spans back from storage.
 * Pure, no DOM; tested in test/free-phrases.test.ts.
 */
import { splitPhrases } from './phrases';
import type { Phrase, PhraseNote } from './phrases';

/** A stretch of song time: start and end in seconds. */
export type Span = readonly [number, number];

/** Two spans are the same phrase when their ends agree within a millisecond. */
const SAME_SPAN_S = 0.001;

/** The phrases of a melody, from the one splitter. */
export function phrasesOf(notes: readonly PhraseNote[]): Phrase[] {
  return splitPhrases(notes);
}

/** The phrase that contains song time `t` (ends included), or null in a gap. */
export function phraseAt(phrases: readonly Phrase[], t: number): Phrase | null {
  return phrases.find((p) => t >= p.startS && t <= p.endS) ?? null;
}

/** True when two spans mark the same phrase. */
export function sameSpan(a: Span, b: Span): boolean {
  return Math.abs(a[0] - b[0]) < SAME_SPAN_S && Math.abs(a[1] - b[1]) < SAME_SPAN_S;
}

/** True when `t` lies inside any of the spans (ends included). */
export function inSpans(spans: readonly Span[], t: number): boolean {
  return spans.some((s) => t >= s[0] && t <= s[1]);
}

/** True when `span` is among the marked ones. */
export function isMarked(spans: readonly Span[], span: Span): boolean {
  return spans.some((s) => sameSpan(s, span));
}

/** True when a note lies wholly inside a span. */
export function noteInSpan(note: PhraseNote, span: Span): boolean {
  return note.onsetS >= span[0] - SAME_SPAN_S && note.offsetS <= span[1] + SAME_SPAN_S;
}

/**
 * The spans with `span` marked or unmarked: `free` true marks it, false
 * unmarks it, omitted flips it. Always a fresh array in time order.
 */
export function withSpan(spans: readonly Span[], span: Span, free?: boolean): Array<[number, number]> {
  const marked = isMarked(spans, span);
  const want = free ?? !marked;
  const kept = spans.filter((s) => !sameSpan(s, span));
  if (want) kept.push(span);
  return kept.map((s): [number, number] => [s[0], s[1]]).sort((a, b) => a[0] - b[0]);
}

/**
 * Spans read from stored text: every pair of finite numbers with the start
 * before the end, in time order; anything else (a hand-edited or corrupt
 * blob) is dropped, never thrown.
 */
export function parseSpans(text: string | null): Array<[number, number]> {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const spans: Array<[number, number]> = [];
  for (const item of raw as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [start, end] = item as unknown[];
    if (typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && start < end) {
      spans.push([start, end]);
    }
  }
  return spans.sort((a, b) => a[0] - b[0]);
}
