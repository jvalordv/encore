/**
 * The words of the report card's "Your voice" section, from a take's voice
 * measurements (src/analysis/voice.ts), as pure functions so every sentence is
 * tested without a page. It speaks of the singing alone, with or without a
 * melody: what the notes were judged against (the song's key, a key estimated
 * from the notes and labelled so, or the nearest semitone), the intonation, the
 * steadiness of held notes, scoops, drift, vibrato, the range and the phrases.
 * Each line carries its number and nothing is softened or guessed. The worst
 * notes are listed to jump to and replay. Never shown in karaoke mode.
 */
import { STABILITY_NOTE_S } from '../analysis/voice';
import type { VoiceReport } from '../analysis/voice';
import { noteName } from '../render/lane-geometry';
import type { MomentView } from './report';
import { formatClock } from './state';

/** At most this many worst notes are listed; the rest are counted. */
export const MAX_WORST_NOTES = 6;
/** A note sits among the worst when more than this many cents from its tone. */
export const WORST_NOTE_CENTS = 25;

/** The section as text; each line is empty when it has nothing to say. */
export interface VoiceView {
  /** What the notes were judged against, in a sentence. */
  basis: string;
  intonation: string;
  stability: string;
  scoop: string;
  drift: string;
  vibrato: string;
  range: string;
  phrases: string;
  /** The notes furthest from their tone, worst first. */
  worstNotes: MomentView[];
  /** Off notes beyond the ones listed. */
  moreOff: number;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function whichWay(cents: number, up: string, down: string): string {
  return cents < 0 ? down : up;
}

/** Shortest note whose spread is reported, in ms, for the card's wording. */
const HELD_MS = Math.round(STABILITY_NOTE_S * 1000);

function basisLine(voice: VoiceReport): string {
  switch (voice.reference) {
    case 'song_key':
      return voice.keyName === null
        ? "Judged against the nearest note of the song's key."
        : `Judged against the nearest note of the song's key, ${voice.keyName}.`;
    case 'estimated_key':
      return (
        `Judged against the nearest note of ${voice.keyName ?? 'a key'}, a key estimated from your own notes ` +
        `(fit ${percent(voice.keyConfidence ?? 0)}) at A = 440 Hz; the song's key was not available.`
      );
    case 'chromatic':
      return 'No clear key in what you sang, so each note is judged against the nearest semitone at A = 440 Hz.';
  }
}

function worstNotes(voice: VoiceReport): { rows: MomentView[]; more: number } {
  const off = voice.notes
    .filter((n) => n.centsOff !== null && Math.abs(n.centsOff) > WORST_NOTE_CENTS)
    .sort((a, b) => Math.abs(b.centsOff ?? 0) - Math.abs(a.centsOff ?? 0));
  const rows = off.slice(0, MAX_WORST_NOTES).map((n): MomentView => {
    const cents = n.centsOff ?? 0;
    const tone = noteName(n.midi - cents / 100);
    return {
      text: `${noteName(n.midi)} at ${formatClock(n.onsetS)}: ${Math.round(Math.abs(cents))} c ${whichWay(cents, 'sharp', 'flat')} of ${tone}`,
      atS: n.onsetS,
    };
  });
  return { rows, more: Math.max(0, off.length - MAX_WORST_NOTES) };
}

/** The card's "Your voice" text for a take. */
export function describeVoice(voice: VoiceReport): VoiceView {
  const s = voice.summary;
  const empty: VoiceView = {
    basis: '',
    intonation: 'No notes were found in this take to measure.',
    stability: '',
    scoop: '',
    drift: '',
    vibrato: '',
    range: '',
    phrases: '',
    worstNotes: [],
    moreOff: 0,
  };
  if (voice.notes.length === 0 || s.judged === 0) return empty;
  const worst = worstNotes(voice);
  const bias = s.biasCents ?? 0;
  const biasText =
    Math.abs(bias) < 5 ? 'centred on the notes' : `a median ${Math.round(Math.abs(bias))} c ${whichWay(bias, 'sharp', 'flat')}`;
  const scoop = s.scoopCents;
  const drift = s.driftCps;
  return {
    basis: basisLine(voice),
    intonation:
      `Intonation: ${percent(s.within25 ?? 0)} of ${s.judged} notes within 25 c and ` +
      `${percent(s.within50 ?? 0)} within 50 c; ${biasText}.`,
    stability:
      s.stabilityCents === null
        ? `Held notes: none over ${HELD_MS} ms to measure.`
        : `Held notes: ${s.held} over ${HELD_MS} ms, a typical spread of ${Math.round(s.stabilityCents)} c ` +
          '(vibrato and drift taken out).',
    scoop:
      scoop === null
        ? ''
        : `Scoops: the first 150 ms of a note sat a median ${Math.round(Math.abs(scoop))} c ` +
          `${whichWay(scoop, 'under', 'over')} the rest of it.`,
    drift:
      drift === null
        ? ''
        : `Drift: over ${s.driftNotes} notes longer than 600 ms the median slope was ` +
          `${Math.round(Math.abs(drift))} c/s ${whichWay(drift, 'sharp', 'flat')}.`,
    vibrato:
      s.vibratoOf === 0
        ? ''
        : s.vibratoNotes === 0
          ? `Vibrato: none found on the ${s.vibratoOf} notes longer than 500 ms.`
          : `Vibrato: on ${s.vibratoNotes} of ${s.vibratoOf} notes longer than 500 ms, a median ` +
            `${(s.vibratoRateHz ?? 0).toFixed(1)} Hz, ${Math.round(s.vibratoExtentCents ?? 0)} c either side, ` +
            `${percent(s.vibratoRegularity ?? 0)} regular.`,
    range:
      s.range === null
        ? ''
        : `Range used (p10 to p90): ${noteName(s.range.lowMidi)} to ${noteName(s.range.highMidi)}.`,
    phrases:
      s.phraseCount === 0 || s.phraseMedianS === null
        ? ''
        : `Phrases: ${s.phraseCount}, a median ${s.phraseMedianS.toFixed(1)} s and the longest ` +
          `${(s.phraseLongestS ?? 0).toFixed(1)} s` +
          (s.breathMedianS === null
            ? '.'
            : `, with ${s.phraseCount - 1} breaths a median ${s.breathMedianS.toFixed(1)} s long.`),
    worstNotes: worst.rows,
    moreOff: worst.more,
  };
}
