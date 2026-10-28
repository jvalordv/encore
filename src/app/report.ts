/**
 * The report card's words, from a take's report (src/analysis/score.ts), as
 * pure functions so every sentence is tested without a page. Direct and
 * specific: which notes were off, which way and by how many cents, early or
 * late in milliseconds, the three worst phrases and where the voice sits
 * against the song. Numbers come straight from the report; nothing is
 * guessed or softened, and nothing here is shown in karaoke mode (the panel
 * decides that, src/app/learning.ts).
 */
import { OKAY_CENTS } from '../analysis/score';
import type { NoteResult, PhraseResult, TakeReport } from '../analysis/score';
import { noteName } from '../render/lane-geometry';
import { formatClock } from './state';

/** Seconds of song heard before a jump or a replay lands on a phrase. */
export const JUMP_LEAD_S = 1;
/** A note entered this far from the reference's onset is named as early or late. */
export const OFF_TIMING_S = 0.15;
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

/** Everything the card shows, as text. */
export interface ReportView {
  headline: string;
  coverage: string;
  frames: string;
  offNotes: MomentView[];
  /** Off notes beyond the ones listed. */
  moreOff: number;
  timing: string;
  phrases: MomentView[];
  noPhrases: string;
  range: string;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/** One off note in words, or null when it was neither off in pitch nor in time. */
function offNote(n: NoteResult): { view: MomentView; severity: number } | null {
  const parts: string[] = [];
  let severity = 0;
  if (n.meanCents !== null && Math.abs(n.meanCents) > OKAY_CENTS) {
    parts.push(`${Math.round(Math.abs(n.meanCents))} c ${n.meanCents < 0 ? 'flat' : 'sharp'}`);
    severity = Math.abs(n.meanCents) / OKAY_CENTS;
  }
  if (n.onsetDeltaS !== null && Math.abs(n.onsetDeltaS) > OFF_TIMING_S) {
    parts.push(`${Math.round(Math.abs(n.onsetDeltaS) * 1000)} ms ${n.onsetDeltaS < 0 ? 'early' : 'late'}`);
    severity = Math.max(severity, Math.abs(n.onsetDeltaS) / OFF_TIMING_S);
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

/** The card's text for a report. */
export function describeReport(report: TakeReport): ReportView {
  const total = report.frames.hit + report.frames.okay + report.frames.miss;
  const off = report.notes
    .map(offNote)
    .filter((n): n is NonNullable<typeof n> => n !== null)
    .sort((a, b) => b.severity - a.severity);
  const headline =
    report.inTuneRate === null
      ? 'No notes to compare: nothing was sung over the melody in this take.'
      : `In tune: ${percent(report.inTuneRate)} of the notes you sang were within ${OKAY_CENTS} c.`;
  return {
    headline,
    coverage: `You sang ${report.notesSung} of the ${report.notesCovered} melody notes this take covers.`,
    frames:
      total === 0
        ? ''
        : `Frame by frame: ${percent(report.frames.hit / total)} on target, ` +
          `${percent(report.frames.okay / total)} close, ${percent(report.frames.miss / total)} off.`,
    offNotes: off.slice(0, MAX_OFF_NOTES).map((n) => n.view),
    moreOff: Math.max(0, off.length - MAX_OFF_NOTES),
    timing: timingLine(report.timingBiasS),
    phrases: report.worstPhrases.map(phraseView),
    noPhrases: report.worstPhrases.length === 0 ? 'No phrase stood out as off.' : '',
    range: rangeLine(report),
  };
}
