/**
 * The second and third lines of a replay item on the report card (learning
 * mode only): the numbers behind a worst note of "Your voice" or a worst
 * phrase, and one plain tip. Everything is said from what was measured and
 * nothing is guessed: a trait that was not measured is left out. The lyric
 * line sung at that moment comes from the imported lyrics, when there are
 * some. The tip comes from a rule over the dominant measured problem, its
 * thresholds named below and tested in test/replay-detail.test.ts. Pure, no
 * DOM; the summary line of each item stays in voice-report.ts and report.ts.
 */
import { SCOOP_WINDOW_S, SCORING_STYLES } from '../analysis/score';
import type { NoteResult, PhraseResult, ScoringStyle } from '../analysis/score';
import { median } from '../analysis/take-notes';
import type { VoiceNote, VoiceReference } from '../analysis/voice';
import { TIP_THRESHOLDS } from '../coach/tips';
import { lineIndexAt } from '../lyrics/lrc';
import type { LyricLine } from '../lyrics/lrc';
import { noteName } from '../render/lane-geometry';
import { formatClock } from './state';

/**
 * Every threshold a replay tip uses. Each shared number is read from the
 * take-level tips table (src/coach/tips.ts) so a replay tip never fires where
 * the card's own tips would stay quiet; a rule fires at or past its number.
 * Early and late entries use the scoring style's own limit.
 */
export const REPLAY_TIP_THRESHOLDS = {
  /** A note started this many cents away from the rest of it: a scoop. */
  scoopCents: TIP_THRESHOLDS.scoopCents,
  /** A held note's slope, in cents per second, either way. */
  driftCps: TIP_THRESHOLDS.driftCps,
  /** A held note's spread in cents once vibrato and drift are taken out. */
  wobbleCents: TIP_THRESHOLDS.wobbleCents,
  /** A vibrato's extent in cents either side of centre. */
  vibratoWideCents: TIP_THRESHOLDS.vibratoWideCents,
  /** A note this many cents from its tone is far from it (weights the pitch tip). */
  farCents: 60,
  /** A phrase's median signed error, in cents, that makes it a lean. */
  phraseBiasCents: TIP_THRESHOLDS.sharpCents,
  /** A phrase's median scoop, in cents. */
  phraseScoopCents: TIP_THRESHOLDS.scoopCents,
} as const;

/** The longest lyric quoted on a replay item, in characters. */
export const MAX_LYRIC_CHARS = 80;

const T = REPLAY_TIP_THRESHOLDS;
const SCOOP_MS = Math.round(SCOOP_WINDOW_S * 1000);

/** The lyric line sung at song time `t`, quoted; '' with no lyrics or in a break. */
export function lyricQuote(lines: readonly LyricLine[] | undefined, t: number): string {
  if (lines === undefined || lines.length === 0) return '';
  const i = lineIndexAt(lines, t);
  const text = i >= 0 ? lines[i].text.trim() : '';
  if (text === '') return '';
  const cut = text.length > MAX_LYRIC_CHARS ? `${text.slice(0, MAX_LYRIC_CHARS - 1).trimEnd()}…` : text;
  return `“${cut}”`;
}

/** A rounded amount with its direction; none when it rounds to zero. */
function amount(value: number, unit: string, up: string, down: string): string {
  const n = Math.round(Math.abs(value));
  return n === 0 ? `0 ${unit}` : `${n} ${unit} ${value < 0 ? down : up}`;
}

/** How the start of a note sat against the rest of it. */
function scoopText(cents: number): string {
  return Math.round(Math.abs(cents)) === 0
    ? `first ${SCOOP_MS} ms level with the rest`
    : `first ${SCOOP_MS} ms ${amount(cents, 'c', 'under', 'over')} the rest`;
}

function toneWord(reference: VoiceReference): string {
  switch (reference) {
    case 'song_key':
      return "tone of the song's key";
    case 'estimated_key':
      return 'tone of the estimated key';
    case 'chromatic':
      return 'nearest semitone';
  }
}

/** The advice whose measure is furthest past its threshold (ratio 1); the first wins a tie. */
function dominant<F extends string | undefined>(candidates: ReadonlyArray<[number, string]>, fallback: F): string | F {
  let best: string | F = fallback;
  let bestRatio = 0;
  for (const [ratio, tip] of candidates) {
    if (ratio >= 1 && ratio > bestRatio) {
      best = tip;
      bestRatio = ratio;
    }
  }
  return best;
}

/** The tip for one worst note of "Your voice", from its dominant measured problem. */
export function voiceNoteTip(n: VoiceNote): string {
  const cents = n.centsOff ?? 0;
  const pitchTip =
    cents < 0
      ? 'You landed under the tone. Aim slightly above where it feels right.'
      : 'You landed above the tone. Relax the push on the onset.';
  const candidates: Array<[number, string]> = [];
  if (n.scoopCents !== null) {
    candidates.push([
      Math.abs(n.scoopCents) / T.scoopCents,
      n.scoopCents > 0
        ? 'Start on the note, not below it. Set the pitch before you open the note.'
        : 'Start on the note, not above it. Set the pitch before you open the note.',
    ]);
  }
  if (n.driftCps !== null) {
    candidates.push([
      Math.abs(n.driftCps) / T.driftCps,
      n.driftCps > 0
        ? 'The pitch crept up while you held it. Keep the air steady to the end.'
        : 'The pitch sagged while you held it. Keep the air going to the end.',
    ]);
  }
  if (n.stdCents !== null) {
    candidates.push([
      n.stdCents / T.wobbleCents,
      'The held note wobbled. Steady air; practise one sustained vowel at a time.',
    ]);
  }
  if (n.vibrato !== null) {
    candidates.push([
      n.vibrato.extentCents / T.vibratoWideCents,
      'Your vibrato swings wide here. Relax the jaw and throat and let it narrow to a gentle pulse.',
    ]);
  }
  candidates.push([Math.abs(cents) / T.farCents, pitchTip]);
  return dominant(candidates, pitchTip);
}

/** The numbers behind one worst note of "Your voice", each only when it was measured. */
export function voiceNoteDetail(n: VoiceNote, reference: VoiceReference, lyric: string): string {
  const cents = n.centsOff ?? 0;
  const tone = noteName(n.midi - cents / 100);
  const parts: string[] = [];
  if (lyric) parts.push(lyric);
  parts.push(
    `sang ${noteName(n.midi)} against the ${toneWord(reference)} ${tone}: ` +
      amount(cents, 'c', 'sharp', 'flat'),
  );
  parts.push(`held ${(n.offsetS - n.onsetS).toFixed(1)} s`);
  if (n.stdCents !== null) parts.push(`spread ${Math.round(n.stdCents)} c`);
  if (n.scoopCents !== null) {
    parts.push(scoopText(n.scoopCents));
  }
  if (n.driftCps !== null) parts.push(`drift ${amount(n.driftCps, 'c/s', 'sharp', 'flat')}`);
  if (n.vibrato !== null) {
    parts.push(`vibrato ${n.vibrato.rateHz.toFixed(1)} Hz, ${Math.round(n.vibrato.extentCents)} c either side`);
  }
  return `${parts.join('; ')}.`;
}

/** What a worst phrase measured, drawn from its notes: each null when not measured. */
export interface PhraseMeasure {
  /** Median of the phrase notes' signed mean error, sharp positive. */
  biasCents: number | null;
  /** Median onset delta in seconds, late positive. */
  timingS: number | null;
  /** Median slide up into the notes, in cents. */
  scoopCents: number | null;
  /** Notes of the phrase that were sung, and notes it holds. */
  sung: number;
  of: number;
}

function medianOrNull(values: number[]): number | null {
  return values.length > 0 ? median(values) : null;
}

/** The phrase's notes, from the take's note results, as measures. */
export function measurePhrase(p: Pick<PhraseResult, 'first' | 'last'>, notes: readonly NoteResult[]): PhraseMeasure {
  const inside = notes.filter((n) => n.index >= p.first && n.index <= p.last);
  const pick = (get: (n: NoteResult) => number | null): number[] =>
    inside.map(get).filter((v): v is number => v !== null);
  return {
    biasCents: medianOrNull(pick((n) => n.meanCents)),
    timingS: medianOrNull(pick((n) => n.onsetDeltaS)),
    scoopCents: medianOrNull(pick((n) => n.scoopUpCents)),
    sung: inside.filter((n) => n.meanCents !== null).length,
    of: p.last - p.first + 1,
  };
}

/**
 * The tip for one worst phrase, from its dominant measured problem; none when
 * no measure reaches its threshold, since nothing then supports any advice.
 * Early and late entries fire at the scoring style's own limit.
 */
export function phraseTip(m: PhraseMeasure, style: ScoringStyle = 'strict'): string | undefined {
  const timingS = SCORING_STYLES[style].timingTipS;
  const candidates: Array<[number, string]> = [];
  if (m.timingS !== null) {
    candidates.push([
      Math.abs(m.timingS) / timingS,
      m.timingS < 0
        ? 'You come in ahead of the beat here. Wait for it; listen for the note before.'
        : 'You are behind the beat here. Breathe one beat earlier.',
    ]);
  }
  if (m.biasCents !== null) {
    candidates.push([
      Math.abs(m.biasCents) / T.phraseBiasCents,
      m.biasCents < 0
        ? 'You sing under the notes here. Aim slightly above where it feels right.'
        : 'You push above the notes here. Relax the push on the onsets.',
    ]);
  }
  if (m.scoopCents !== null) {
    candidates.push([
      Math.abs(m.scoopCents) / T.phraseScoopCents,
      m.scoopCents > 0
        ? 'You slide up into notes here. Start on the note, not below it.'
        : 'You come down into notes here. Start on the note, not above it.',
    ]);
  }
  return dominant(candidates, undefined);
}

/** The numbers behind one worst phrase of a Strict card, each only when measured. */
export function phraseDetail(p: PhraseResult, m: PhraseMeasure, lyric: string): string {
  const parts: string[] = [];
  if (lyric) parts.push(lyric);
  parts.push(`${formatClock(p.startS)} to ${formatClock(p.endS)}, ${(p.endS - p.startS).toFixed(1)} s`);
  const miss = Math.round(p.missShare * 100);
  if (p.hitShare !== undefined) {
    const hit = Math.round(p.hitShare * 100);
    parts.push(`${hit}% of frames on target, ${Math.max(0, 100 - hit - miss)}% close, ${miss}% off`);
  } else {
    parts.push(`${miss}% of frames off`);
  }
  parts.push(`${Math.round(p.meanAbsCents)} c off on average`);
  if (m.biasCents !== null) {
    parts.push(`median note ${amount(m.biasCents, 'c', 'sharp', 'flat')}`);
  }
  if (m.timingS !== null) {
    parts.push(`median entry ${Math.round(Math.abs(m.timingS) * 1000)} ms ${m.timingS < 0 ? 'early' : 'late'}`);
  }
  if (m.scoopCents !== null) {
    parts.push(scoopText(m.scoopCents));
  }
  parts.push(`${m.sung} of ${m.of} notes sung`);
  return `${parts.join('; ')}.`;
}
