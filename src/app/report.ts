/**
 * The report card's words, from a take's report (src/analysis/score.ts), as
 * pure functions so every sentence is tested without a page. Direct and
 * specific: which notes were off, which way and by how many cents, early or
 * late in milliseconds, the three worst phrases and where the voice sits
 * against the song. Numbers come straight from the report; nothing is
 * guessed or softened, and nothing here is shown in karaoke mode (the panel
 * decides that, src/app/learning.ts). The windows follow the take's scoring
 * style. An Open take (and a Strict one with free phrases) adds the freestyle
 * block: how many free notes were in the song's key, each one that was not
 * with how far off it was, and a plain word when the key was unclear or missing
 * and those notes were judged on steadiness only.
 */
import type { Span } from '../analysis/free-phrases';
import { SCORING_STYLES } from '../analysis/score';
import type { FreestyleReport, NoteResult, OffKeyNote, PhraseResult, ScoringStyle, TakeReport } from '../analysis/score';
import { noteName } from '../render/lane-geometry';
import { formatClock } from './state';

/** Seconds of song heard before a jump or a replay lands on a phrase. */
export const JUMP_LEAD_S = 1;
/** A note entered this far from the reference's onset is named as early or late. */
export const OFF_TIMING_S = SCORING_STYLES.strict.onsetToleranceS;
/** A median onset delta within this is "on the beat". */
export const ON_BEAT_S = 0.03;
/** At most this many off notes are listed; the rest are counted. */
export const MAX_OFF_NOTES = 6;

/** Where a jump to song time `s` lands: a moment of lead-in before it. */
export function jumpTarget(s: number): number {
  return Math.max(0, s - JUMP_LEAD_S);
}

/** A note named with its place in the song: "A3 at 0:12". */
export function noteLabel(note: Pick<NoteResult, 'midi' | 'onsetS'>): string {
  return `${noteName(note.midi)} at ${formatClock(note.onsetS)}`;
}

/** One line of the card that can take the singer to a moment in the song. */
export interface MomentView {
  text: string;
  /** Song time of the moment itself; jumps and replays start a lead-in earlier. */
  atS: number;
}

/** A phrase row of the card: its words and the span Mark free and Free act on. */
export interface PhraseRowView extends MomentView {
  span: Span;
}

/** The card's freestyle block, as text. */
export interface FreestyleView {
  summary: string;
  /** Why the notes could not be judged against the key; empty when they could. */
  keyNote: string;
  offNotes: MomentView[];
  /** Off-key notes beyond the ones listed. */
  moreOff: number;
}

/** Everything the card shows, as text. */
export interface ReportView {
  style: ScoringStyle;
  /** False for a song with no melody: the melody's lines (timing, phrases, range) are left out. */
  hasMelody: boolean;
  headline: string;
  /** Open: the share of what was sung that was on the melody; empty otherwise. */
  melodyShare: string;
  coverage: string;
  frames: string;
  offNotes: MomentView[];
  /** Off notes beyond the ones listed. */
  moreOff: number;
  timing: string;
  phrases: MomentView[];
  /** The span of each of `phrases`, in the same order. */
  phraseSpans: Span[];
  noPhrases: string;
  range: string;
  /** Present when the take has freestyle notes to speak of. */
  freestyle: FreestyleView | null;
  /** Strict: the phrases left out of the measures as free, each to unmark. */
  freePhrases: PhraseRowView[];
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** One off note in words, or null when it was neither off in pitch nor in time. */
function offNote(n: NoteResult, style: ScoringStyle): { view: MomentView; severity: number } | null {
  const { okayCents, onsetToleranceS } = SCORING_STYLES[style];
  const parts: string[] = [];
  let severity = 0;
  if (n.meanCents !== null && Math.abs(n.meanCents) > okayCents) {
    parts.push(`${Math.round(Math.abs(n.meanCents))} c ${n.meanCents < 0 ? 'flat' : 'sharp'}`);
    severity = Math.abs(n.meanCents) / okayCents;
  }
  if (n.onsetDeltaS !== null && Math.abs(n.onsetDeltaS) > onsetToleranceS) {
    parts.push(`${Math.round(Math.abs(n.onsetDeltaS) * 1000)} ms ${n.onsetDeltaS < 0 ? 'early' : 'late'}`);
    severity = Math.max(severity, Math.abs(n.onsetDeltaS) / onsetToleranceS);
  }
  if (parts.length === 0) return null;
  return { view: { text: `${noteLabel(n)}: ${parts.join(', ')}`, atS: n.onsetS }, severity };
}

function phraseView(p: PhraseResult): MomentView {
  return {
    text:
      `${formatClock(p.startS)} to ${formatClock(p.endS)}: ${Math.round(p.meanAbsCents)} c off on average, ` +
      `${percent(p.missShare)} of it missed`,
    atS: p.startS,
  };
}

function timingLine(bias: number | null): string {
  if (bias === null) return 'Timing: too few notes were matched to say.';
  const ms = Math.round(Math.abs(bias) * 1000);
  if (Math.abs(bias) < ON_BEAT_S) return `Timing: on the beat (median ${ms} ms ${bias < 0 ? 'early' : 'late'}).`;
  return `Timing: you came in ${bias < 0 ? 'early' : 'late'}, a median of ${ms} ms.`;
}

function rangeLine(report: TakeReport): string {
  const { songRange, sungRange } = report;
  const song = `Song range ${noteName(songRange.lowMidi)} to ${noteName(songRange.highMidi)}.`;
  if (sungRange === null) return song;
  return `${song} Your range in this take: ${noteName(sungRange.lowMidi)} to ${noteName(sungRange.highMidi)}.`;
}

/** Why freestyle notes could not all be judged against the key, in words; empty when they could. */
function keyNoteLine(block: FreestyleReport): string {
  if (block.inKey + block.offKey + block.unclear === 0) return '';
  switch (block.keyStatus) {
    case 'clear':
      return '';
    case 'partly_unclear':
      return (
        "The song's key was unclear in places, so the free notes there " +
        `(${block.unclear}) were judged on steadiness only.`
      );
    case 'unclear':
      return "The song's key was unclear, so these notes were judged on steadiness only.";
    case 'none':
      return 'No key was available for this song, so these notes were judged on steadiness only.';
  }
}

/** One off-key note in words: where it was, how far from the key, which tone is nearest. */
function offKeyView(n: OffKeyNote): MomentView {
  const tone = noteName(n.midi - n.centsOff / 100);
  const way = n.centsOff < 0 ? 'below' : 'above';
  return {
    text: `${noteLabel(n)}: ${Math.round(Math.abs(n.centsOff))} c ${way} ${tone}, the nearest note of the key`,
    atS: n.onsetS,
  };
}

/** The card's freestyle block, or null when there is nothing sung off the melody to speak of. */
function describeFreestyle(block: FreestyleReport | undefined, style: ScoringStyle): FreestyleView | null {
  if (!block) return null;
  const judged = block.inKey + block.offKey;
  const sung = judged + block.unclear + block.passing;
  const parts: string[] = [];
  if (judged > 0) {
    parts.push(
      `Freestyle: ${percent(block.inKey / judged)} of your free notes were in the song's key ` +
        `(${block.inKey} of ${judged}).`,
    );
  }
  if (block.passing > 0) {
    const one = block.passing === 1;
    parts.push(`${block.passing} passing note${one ? '' : 's'} under 150 ms ${one ? 'was' : 'were'} not judged.`);
  }
  if (sung === 0) {
    parts.push(
      style === 'open'
        ? 'Freestyle: nothing was sung off the melody in this take.'
        : 'Freestyle: nothing was sung off the melody in the phrases you marked free.',
    );
  } else if (judged === 0 && block.unclear > 0) {
    parts.unshift(`Freestyle: ${block.unclear} free note${block.unclear === 1 ? '' : 's'} sung.`);
  }
  const off = [...block.offNotes].sort((a, b) => Math.abs(b.centsOff) - Math.abs(a.centsOff));
  return {
    summary: parts.join(' '),
    keyNote: keyNoteLine(block),
    offNotes: off.slice(0, MAX_OFF_NOTES).map(offKeyView),
    moreOff: Math.max(0, off.length - MAX_OFF_NOTES),
  };
}

function headlineFor(report: TakeReport, style: ScoringStyle): string {
  if (report.noMelody) {
    return "This song has no melody to follow, so everything you sang was judged against the song's key.";
  }
  const { okayCents } = SCORING_STYLES[style];
  if (report.inTuneRate === null) {
    return style === 'open'
      ? 'No notes to compare: nothing you sang was on the melody in this take.'
      : 'No notes to compare: nothing was sung over the melody in this take.';
  }
  const where = style === 'open' ? ' on the melody' : '';
  return `In tune: ${percent(report.inTuneRate)} of the notes you sang${where} were within ${okayCents} c.`;
}

/** The card's text for a report. */
export function describeReport(report: TakeReport): ReportView {
  const style = report.style ?? 'strict';
  const total = report.frames.hit + report.frames.okay + report.frames.miss;
  const off = report.notes
    .map((n) => offNote(n, style))
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .sort((a, b) => b.severity - a.severity);
  const freeRows = (report.freeSpans ?? []).map(
    (span): PhraseRowView => ({
      text: `Free phrase ${formatClock(span[0])} to ${formatClock(span[1])}`,
      atS: span[0],
      span: [span[0], span[1]],
    }),
  );
  return {
    style,
    hasMelody: !report.noMelody,
    headline: headlineFor(report, style),
    melodyShare:
      style === 'open' && !report.noMelody && report.melodyShare != null
        ? `On the melody: ${percent(report.melodyShare)} of the notes you sang.`
        : '',
    coverage: report.noMelody
      ? ''
      : `You sang ${report.notesSung} of the ${report.notesCovered} melody notes this take covers.`,
    frames:
      total === 0
        ? ''
        : `Frame by frame: ${percent(report.frames.hit / total)} on target, ` +
          `${percent(report.frames.okay / total)} close, ${percent(report.frames.miss / total)} off.`,
    offNotes: off.slice(0, MAX_OFF_NOTES).map((n) => n.view),
    moreOff: Math.max(0, off.length - MAX_OFF_NOTES),
    timing: timingLine(report.timingBiasS),
    phrases: report.worstPhrases.map(phraseView),
    phraseSpans: report.worstPhrases.map((p): Span => [p.startS, p.endS]),
    noPhrases: report.worstPhrases.length === 0 ? 'No phrase stood out as off.' : '',
    range: report.noMelody ? '' : rangeLine(report),
    freestyle: describeFreestyle(report.freestyle, style),
    freePhrases: freeRows,
  };
}
