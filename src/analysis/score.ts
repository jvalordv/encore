/**
 * Scoring a singer against the original vocal's melody (learning mode,
 * docs/COACHING.md). Everything here is measurement over numbers the
 * browser already has: the reference notes from the service, and pitch
 * frames on song time with the calibrated latency already taken off (the
 * input controller does that before a frame reaches the bus), so nothing in
 * this file shifts time. Three layers:
 *
 * - A frame against the note under it: its error in cents, folded into
 *   +-600 c when the singer covers another octave, and its grade (hit within
 *   25 c, okay within 50 c, else miss). `LiveScorer` does this for each frame
 *   on the frame bus and hands the grade to the lane.
 * - A take against the melody: per reference note the mean and spread of the
 *   error, the scoop, the onset delta against the note the singer actually
 *   began, and the held length; per take the in-tune rate, the timing bias,
 *   the worst phrases and the ranges (`reportTake`).
 * - The two scoring styles (docs/COACHING.md): `SCORING_STYLES` holds the
 *   windows and thresholds of Strict (the original's melody, as above) and
 *   Open (any octave, wider windows, freestyle judged against the key). The
 *   functions below take a style whose default is Strict, so a call that does
 *   not name one measures exactly what it always did. Freestyle and the live
 *   grades of Open live in open-score.ts.
 * - Nothing about wording. Tips and the card are built from the report
 *   elsewhere (src/coach/tips.ts, src/app/report.ts).
 *
 * Pure, no DOM. Checked on synthetic contours with known answers in
 * test/score.test.ts.
 */
import { splitPhrases } from './phrases';
import type { FreestyleReport } from './key-fit';
import { hzToMidi } from './pitch';
import type { PitchFrame } from './pitch';
import { MERGE_GAP_S, median, segmentTake } from './take-notes';
import type { NoteFrame, SungNote } from './take-notes';

export type { FreestyleReport, OffKeyNote } from './key-fit';

/** How a frame did against the note under it. */
export type Grade = 'hit' | 'okay' | 'miss';

/** What the lane paints a frame as: a grade, or 'free' for a freestyle frame. */
export type LiveGrade = Grade | 'free';

/** How learning mode judges: against the melody, or leniently with freestyle. */
export type ScoringStyle = 'strict' | 'open';

/** A frame within this many cents of the note is a hit (Strict). */
export const HIT_CENTS = 25;
/** ...within this many, okay; beyond it, a miss (Strict). */
export const OKAY_CENTS = 50;

/** What one scoring style measures with. */
export interface StyleRules {
  /** A frame within this many cents of its note is a hit. */
  hitCents: number;
  /** ...within this many, okay; beyond it, a miss. */
  okayCents: number;
  /** 'setting' follows the octave-invariant setting; 'always' ignores the octave. */
  octave: 'setting' | 'always';
  /** A note entered this far from the reference's onset is named early or late. */
  onsetToleranceS: number;
  /** The early and late tips fire when the median onset delta passes this. */
  timingTipS: number;
}

/** The two styles' numbers, in one table so they can be tuned in one place. */
export const SCORING_STYLES: Record<ScoringStyle, StyleRules> = {
  strict: { hitCents: HIT_CENTS, okayCents: OKAY_CENTS, octave: 'setting', onsetToleranceS: 0.15, timingTipS: 0.06 },
  open: { hitCents: 50, okayCents: 100, octave: 'always', onsetToleranceS: 0.15, timingTipS: 0.12 },
};

/** Whether a style folds the octave, given the octave-invariant setting. */
export function foldsOctave(style: ScoringStyle, octaveInvariant: boolean): boolean {
  return SCORING_STYLES[style].octave === 'always' || octaveInvariant;
}
/** A reference note counts as sung once this many frames were scored in it. */
export const MIN_SUNG_FRAMES = 5;
/** A reference note longer than this is "long": stability and held length apply. */
export const LONG_NOTE_S = 0.4;
/** The first stretch of a note, where a scoop lives (COACHING.md). */
export const SCOOP_WINDOW_S = 0.15;
/** Frames needed on each side of the scoop window to call it a measure. */
const SCOOP_MIN_FRAMES = 3;
/** Scored frames needed past the scoop window to measure a note's wobble. */
const STABILITY_MIN_FRAMES = 10;
/** A sung note must overlap a reference note this long to be its match. */
const MATCH_OVERLAP_S = 0.05;
/** A phrase needs this many scored frames (200 ms) to be ranked. */
export const MIN_PHRASE_FRAMES = 20;
/** The most phrases a report names. */
export const WORST_PHRASES = 3;
/** Slack at a take's edges when deciding which notes it covers. */
const COVER_SLACK_S = 0.2;
/** Guards a grade boundary against floating-point dust. */
const EPSILON = 1e-9;

/** One note of the melody being sung against. */
export interface ScoreNote {
  onsetS: number;
  offsetS: number;
  /** Fractional MIDI number. */
  midi: number;
}

/** The melody as scoring needs it: notes and unpitched stretches in time order. */
export interface ScoreReference {
  notes: ScoreNote[];
  /** Stretches [start_s, end_s] where something sounds but no note was sung. */
  unpitchedS: Array<[number, number]>;
  lowMidi: number;
  highMidi: number;
  /** Onset of the highest note, for pointing at where a song gets high. */
  highAtS: number;
}

/** The error in cents of a sung pitch against a note, folded when asked. */
export function centsOff(sungMidi: number, noteMidi: number, octaveInvariant = false): number {
  const cents = (sungMidi - noteMidi) * 100;
  if (!octaveInvariant) return cents;
  return ((((cents + 600) % 1200) + 1200) % 1200) - 600;
}

/** hit within the style's first window (25 cents in Strict), okay within the second, else miss. */
export function gradeCents(cents: number, style: ScoringStyle = 'strict'): Grade {
  const off = Math.abs(cents);
  const rules = SCORING_STYLES[style];
  if (off <= rules.hitCents + EPSILON) return 'hit';
  return off <= rules.okayCents + EPSILON ? 'okay' : 'miss';
}

/** Index of the last item starting at or before `t`, or -1. */
function lastStartingBy<T>(items: readonly T[], start: (item: T) => number, t: number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (start(items[mid]) <= t) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/**
 * Index of the reference note sounding at song time `t`, or -1 for none, and
 * -1 too inside an unpitched stretch (a spoken line or a breath has no pitch
 * to hold the singer to).
 */
export function noteAt(ref: ScoreReference, t: number): number {
  const region = lastStartingBy(ref.unpitchedS, (r) => r[0], t);
  if (region >= 0 && t < ref.unpitchedS[region][1]) return -1;
  const index = lastStartingBy(ref.notes, (n) => n.onsetS, t);
  return index >= 0 && t < ref.notes[index].offsetS ? index : -1;
}

/** A scored frame: the note it fell in, its error and its grade. */
export interface FrameScore {
  note: number;
  cents: number;
  grade: Grade;
}

/** True for a frame the tracker called voiced (it zeroes f0 below its clarity). */
export function isVoiced(frame: NoteFrame): boolean {
  return frame.f0 > 0 && Number.isFinite(frame.f0);
}

/** One frame against the melody; null when it is unvoiced or in no note. */
export function scoreFrame(
  frame: NoteFrame,
  ref: ScoreReference,
  octaveInvariant = false,
  style: ScoringStyle = 'strict',
): FrameScore | null {
  if (!isVoiced(frame)) return null;
  const note = noteAt(ref, frame.t);
  if (note < 0) return null;
  const cents = centsOff(hzToMidi(frame.f0), ref.notes[note].midi, foldsOctave(style, octaveInvariant));
  return { note, cents, grade: gradeCents(cents, style) };
}

/** What the live scorer reads from the session each frame. */
export interface LiveScorerSource {
  /** The melody to grade against, or null for none (karaoke mode, no melody). */
  reference(): ScoreReference | null;
  octaveInvariant(): boolean;
}

/** The part of the frame bus the live scorer needs. */
export interface FrameSubscribable<M extends { frame: PitchFrame }> {
  subscribe(cb: (message: M) => void): () => void;
}

/** Grades each frame on the bus for the lane; the sink gets null when none applies. */
export class LiveScorer {
  constructor(private readonly source: LiveScorerSource) {}

  /** Grade of one frame under the current melody, or null. */
  grade(frame: PitchFrame): Grade | null {
    const ref = this.source.reference();
    return ref === null ? null : (scoreFrame(frame, ref, this.source.octaveInvariant())?.grade ?? null);
  }

  /** Subscribes to the bus; returns the function that unsubscribes. */
  attach<M extends { frame: PitchFrame }>(
    bus: FrameSubscribable<M>,
    sink: (message: M, grade: Grade | null) => void,
  ): () => void {
    return bus.subscribe((message) => sink(message, this.grade(message.frame)));
  }
}

/** How one reference note was sung. Null fields were not measurable. */
export interface NoteResult {
  /** Index of the note in the reference. */
  index: number;
  onsetS: number;
  offsetS: number;
  /** The note asked for, fractional MIDI. */
  midi: number;
  /** Frames scored inside the note. */
  frames: number;
  /** Mean signed error in cents (sharp positive); null when not sung. */
  meanCents: number | null;
  /** Spread of the error past the scoop window, long notes only. */
  stdCents: number | null;
  /** How far the first 150 ms sit below the steady state; positive = slid up. */
  scoopUpCents: number | null;
  /** Sung onset minus the reference's, in seconds; positive = late. */
  onsetDeltaS: number | null;
  /** Sung duration over the reference's. */
  heldRatio: number | null;
}

/** How a phrase went: its notes (reference indices), span and error. */
export interface PhraseResult {
  first: number;
  last: number;
  startS: number;
  endS: number;
  /** Mean absolute error over the phrase's scored frames, in cents. */
  meanAbsCents: number;
  /** Share of the phrase's scored frames that missed, 0..1. */
  missShare: number;
}

/** A range of MIDI notes. */
export interface MidiRange {
  lowMidi: number;
  highMidi: number;
}

/** Everything measured about one take against the melody. */
export interface TakeReport {
  /** Reference notes the take spans. */
  notesCovered: number;
  /** Of those, notes the singer sang (enough voiced frames inside them). */
  notesSung: number;
  /** Share of the sung notes whose mean error is within 50 cents; null if none sung. */
  inTuneRate: number | null;
  /** Scored frames by grade. */
  frames: Record<Grade, number>;
  /** Median onset delta in seconds (positive = late); null without matches. */
  timingBiasS: number | null;
  /** One entry per covered note. */
  notes: NoteResult[];
  /** The worst phrases, worst first (at most three). */
  worstPhrases: PhraseResult[];
  songRange: MidiRange & { highAtS: number };
  /** The singer's p10 to p90 range over the whole take; null if nothing voiced. */
  sungRange: MidiRange | null;
  /*
   * The fields below are absent on a take scored before the styles existed
   * (read as Strict, with no freestyle), so stored takes still load.
   */
  /** The style the take was scored in. */
  style?: ScoringStyle;
  /** Open: the share of sung notes that were on the melody, 0..1; null if none were judged. */
  melodyShare?: number | null;
  /** True when the song had no melody, so everything sung was freestyle. */
  noMelody?: boolean;
  /** The freestyle notes: all of them in Open, those in free phrases in Strict. */
  freestyle?: FreestyleReport;
  /** Strict: the free phrases left out of the melody's measures, as [start, end]. */
  freeSpans?: Array<[number, number]>;
}

/** The p-th percentile (0..1) of numbers, interpolating between ranks. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(1, Math.max(0, p)) * (sorted.length - 1);
  const below = Math.floor(at);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (at - below);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function std(values: readonly number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/** How long two spans overlap, in seconds; 0 if they do not. */
function overlapS(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/**
 * Pairs each reference note with the sung note that overlaps it most; when one
 * sung note would serve two reference notes (a held note over a repeat), only
 * the larger overlap keeps it. Returns the sung note per reference index.
 */
function matchSung(notes: readonly ScoreNote[], sung: readonly SungNote[], wanted: ReadonlySet<number>): Map<number, SungNote> {
  const bestFor = new Map<number, { note: number; overlap: number }>();
  for (const i of wanted) {
    const ref = notes[i];
    let best = -1;
    let bestOverlap = MATCH_OVERLAP_S - EPSILON;
    sung.forEach((s, j) => {
      const overlap = overlapS(ref.onsetS, ref.offsetS, s.onsetS, s.offsetS);
      if (overlap > bestOverlap) {
        best = j;
        bestOverlap = overlap;
      }
    });
    if (best < 0) continue;
    const taken = bestFor.get(best);
    if (!taken || bestOverlap > taken.overlap) bestFor.set(best, { note: i, overlap: bestOverlap });
  }
  const out = new Map<number, SungNote>();
  for (const [j, { note }] of bestFor) out.set(note, sung[j]);
  return out;
}

/**
 * Joins a short piece that starts at a reference note's onset to the piece
 * right after it. A scoop that steps up more than 80 cents is cut off from the
 * note by the segmentation rule, which would make the singer read late with no
 * scoop; to the ear it is one note entered from below. A piece of SCOOP_WINDOW_S
 * or more is a note of its own (a wrong note held before the right one), and a
 * piece not near any reference onset is left alone. The segmentation rule
 * itself is unchanged.
 */
export function mergeScoops(sung: readonly SungNote[], notes: readonly ScoreNote[]): SungNote[] {
  const merged: SungNote[] = [];
  for (let i = 0; i < sung.length; i++) {
    let piece = sung[i];
    const start = piece.onsetS;
    const nearOnset = notes.some((n) => Math.abs(start - n.onsetS) <= SCOOP_WINDOW_S);
    while (nearOnset && i + 1 < sung.length) {
      const next = sung[i + 1];
      if (piece.offsetS - start >= SCOOP_WINDOW_S || next.onsetS - piece.offsetS >= MERGE_GAP_S) break;
      const frames = [...piece.frames, ...next.frames];
      piece = {
        onsetS: start,
        offsetS: next.offsetS,
        midi: median(frames.map((f) => f.midi)),
        frames,
      };
      i++;
    }
    merged.push(piece);
  }
  return merged;
}

/** The scoop of a sung note: its steady state minus its first 150 ms, in cents. */
function scoopUp(sung: SungNote): number | null {
  const cutoff = sung.onsetS + SCOOP_WINDOW_S;
  const head = sung.frames.filter((f) => f.t < cutoff).map((f) => f.midi);
  const rest = sung.frames.filter((f) => f.t >= cutoff).map((f) => f.midi);
  if (head.length < SCOOP_MIN_FRAMES || rest.length < SCOOP_MIN_FRAMES) return null;
  return (median(rest) - median(head)) * 100;
}

/** Orders the reference's notes and gives scoring the shape it wants. */
export function buildScoreReference(
  notes: ReadonlyArray<ScoreNote>,
  unpitchedS: ReadonlyArray<readonly [number, number]>,
  range: { lowMidi: number; highMidi: number },
): ScoreReference {
  const sorted = [...notes].sort((a, b) => a.onsetS - b.onsetS);
  let highAtS = 0;
  let top = -Infinity;
  for (const n of sorted) {
    if (n.midi > top) {
      top = n.midi;
      highAtS = n.onsetS;
    }
  }
  return {
    notes: sorted,
    unpitchedS: unpitchedS.map((r): [number, number] => [r[0], r[1]]).sort((a, b) => a[0] - b[0]),
    lowMidi: range.lowMidi,
    highMidi: range.highMidi,
    highAtS,
  };
}

/**
 * Measures a take against the melody. `frames` are the take's pitch frames in
 * time order on song time (what the recorder keeps). A note is covered when
 * the take spans it, and sung when MIN_SUNG_FRAMES voiced frames fell inside
 * it; the in-tune rate is over the sung notes, and the report says how many
 * of the covered notes that was, so a take that skipped half the song reads as
 * what it is.
 */
export function reportTake(
  frames: readonly PitchFrame[],
  ref: ScoreReference,
  octaveInvariant = false,
  style: ScoringStyle = 'strict',
): TakeReport {
  const rules = SCORING_STYLES[style];
  const songRange = { lowMidi: ref.lowMidi, highMidi: ref.highMidi, highAtS: ref.highAtS };
  const voicedMidi = frames.filter(isVoiced).map((f) => hzToMidi(f.f0));
  const sungRange = voicedMidi.length
    ? { lowMidi: percentile(voicedMidi, 0.1), highMidi: percentile(voicedMidi, 0.9) }
    : null;
  const empty: TakeReport = {
    notesCovered: 0,
    notesSung: 0,
    inTuneRate: null,
    frames: { hit: 0, okay: 0, miss: 0 },
    timingBiasS: null,
    notes: [],
    worstPhrases: [],
    songRange,
    sungRange,
  };
  if (frames.length === 0 || ref.notes.length === 0) return empty;

  const spanStart = frames[0].t - COVER_SLACK_S;
  const spanEnd = frames[frames.length - 1].t + COVER_SLACK_S;
  const covered = new Set<number>();
  ref.notes.forEach((n, i) => {
    if (n.onsetS >= spanStart && n.offsetS <= spanEnd) covered.add(i);
  });

  const scored = new Map<number, Array<{ t: number; cents: number }>>();
  const grades: Record<Grade, number> = { hit: 0, okay: 0, miss: 0 };
  for (const f of frames) {
    const s = scoreFrame(f, ref, octaveInvariant, style);
    if (!s || !covered.has(s.note)) continue;
    grades[s.grade]++;
    const list = scored.get(s.note) ?? [];
    list.push({ t: f.t, cents: s.cents });
    scored.set(s.note, list);
  }

  const sung = mergeScoops(segmentTake(frames), ref.notes);
  const matches = matchSung(ref.notes, sung, covered);
  const notes: NoteResult[] = [];
  for (const i of [...covered].sort((a, b) => a - b)) {
    const n = ref.notes[i];
    const own = scored.get(i) ?? [];
    const played = own.length >= MIN_SUNG_FRAMES;
    const match = matches.get(i);
    const long = n.offsetS - n.onsetS > LONG_NOTE_S;
    const steady = own.filter((f) => f.t >= (match?.onsetS ?? n.onsetS) + SCOOP_WINDOW_S).map((f) => f.cents);
    notes.push({
      index: i,
      onsetS: n.onsetS,
      offsetS: n.offsetS,
      midi: n.midi,
      frames: own.length,
      meanCents: played ? mean(own.map((f) => f.cents)) : null,
      stdCents: played && long && steady.length >= STABILITY_MIN_FRAMES ? std(steady) : null,
      scoopUpCents: played && match ? scoopUp(match) : null,
      onsetDeltaS: played && match ? match.onsetS - n.onsetS : null,
      heldRatio: played && match ? (match.offsetS - match.onsetS) / (n.offsetS - n.onsetS) : null,
    });
  }

  const sungNotes = notes.filter((n) => n.meanCents !== null);
  const inTune = sungNotes.filter((n) => Math.abs(n.meanCents ?? Infinity) <= rules.okayCents + EPSILON);
  const deltas = notes.flatMap((n) => (n.onsetDeltaS === null ? [] : [n.onsetDeltaS]));
  return {
    notesCovered: notes.length,
    notesSung: sungNotes.length,
    inTuneRate: sungNotes.length ? inTune.length / sungNotes.length : null,
    frames: grades,
    timingBiasS: deltas.length ? median(deltas) : null,
    notes,
    worstPhrases: worstPhrases(ref, scored, style),
    songRange,
    sungRange,
  };
}

/** The phrases the singer did worst on, by mean absolute error, worst first. */
function worstPhrases(
  ref: ScoreReference,
  scored: ReadonlyMap<number, ReadonlyArray<{ cents: number }>>,
  style: ScoringStyle,
): PhraseResult[] {
  const rules = SCORING_STYLES[style];
  const results: PhraseResult[] = [];
  for (const p of splitPhrases(ref.notes)) {
    const errors: number[] = [];
    for (let i = p.first; i <= p.last; i++) {
      for (const f of scored.get(i) ?? []) errors.push(f.cents);
    }
    if (errors.length < MIN_PHRASE_FRAMES) continue;
    const meanAbsCents = mean(errors.map(Math.abs));
    // A phrase sung inside a hit's width is not a problem to point at.
    if (meanAbsCents <= rules.hitCents) continue;
    const misses = errors.filter((c) => gradeCents(c, style) === 'miss').length;
    results.push({ ...p, meanAbsCents, missShare: misses / errors.length });
  }
  // Array sort is stable, so equally bad phrases keep their song order.
  return results.sort((a, b) => b.meanAbsCents - a.meanAbsCents).slice(0, WORST_PHRASES);
}
