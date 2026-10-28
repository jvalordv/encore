/**
 * Open scoring and freestyle (docs/COACHING.md, "Scoring styles"), beside the
 * melody scoring in score.ts. In Open a sung note that matches a melody note at
 * any octave, within Open's okay window (100 cents), is on the melody and is
 * measured exactly as Strict measures a note, with Open's wider windows. A note
 * that matches none, or comes where there is no melody (a gap, a song with no
 * reference, a karaoke track), is freestyle: judged against the song's key
 * (key-fit.ts) as in key, off key, unclear or passing, never as a miss. In
 * Strict the same rule applies inside the phrases the singer marked free
 * (free-phrases.ts); the rest of a Strict take is W3's measurement untouched.
 *
 * Three entry points, all pure and tested on synthetic contours in
 * test/open-score.test.ts:
 *
 * - `scoreTake`: a whole take to a `TakeReport`, in either style.
 * - `gradeFrameOpen`: one live frame to a grade for the lane, `free` for a
 *   freestyle frame and `miss` only for one well outside a clear key.
 * - `StyledScorer`: the frame-bus subscriber that picks between W3's grade,
 *   the Open grade and no grade, for the lane.
 */
import type { KeyMap } from '../service/types';
import { inSpans, noteInSpan } from './free-phrases';
import type { Span } from './free-phrases';
import { fitFrame, fitNote, keyStatusOver } from './key-fit';
import { hzToMidi } from './pitch';
import type { PitchFrame } from './pitch';
import {
  buildScoreReference,
  centsOff,
  gradeCents,
  isVoiced,
  LiveScorer,
  mergeScoops,
  noteAt,
  reportTake,
  SCORING_STYLES,
} from './score';
import type {
  FreestyleReport,
  FrameSubscribable,
  LiveGrade,
  OffKeyNote,
  ScoreReference,
  ScoringStyle,
  TakeReport,
} from './score';
import { segmentTake } from './take-notes';
import type { SungNote } from './take-notes';

/** A sung note must overlap a melody note this long to count as sung on it. */
const MATCH_OVERLAP_S = 0.05;
/** Guards a window boundary against floating-point dust. */
const EPSILON = 1e-9;

/** The melody of a song that has none. */
const NO_MELODY: ScoreReference = buildScoreReference([], [], { lowMidi: 0, highMidi: 0 });

/** What a take is scored with beyond its frames and the melody. */
export interface TakeScoreOptions {
  style: ScoringStyle;
  /** The octave-invariant setting; Strict follows it, Open always folds. */
  octaveInvariant: boolean;
  /** The song's key, or null when the service has none. */
  key: KeyMap | null;
  /** The phrases marked free, as spans; they matter in Strict only. */
  freeSpans: ReadonlyArray<Span>;
}

/** A sung note and whether it was on the melody. */
interface Classified {
  note: SungNote;
  onMelody: boolean;
}

function overlapS(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** True when the sung note matches a melody note: overlapping it and within Open's okay window. */
function onMelody(note: SungNote, ref: ScoreReference): boolean {
  const okay = SCORING_STYLES.open.okayCents;
  for (const r of ref.notes) {
    if (r.onsetS >= note.offsetS) break;
    if (overlapS(r.onsetS, r.offsetS, note.onsetS, note.offsetS) < MATCH_OVERLAP_S - EPSILON) continue;
    if (Math.abs(centsOff(note.midi, r.midi, true)) <= okay + EPSILON) return true;
  }
  return false;
}

/** The notes sung in a take whose middle falls where `inRegion` says, each marked on or off the melody. */
function classify(
  frames: readonly PitchFrame[],
  ref: ScoreReference,
  inRegion: (t: number) => boolean,
): Classified[] {
  return mergeScoops(segmentTake(frames), ref.notes)
    .filter((n) => inRegion((n.onsetS + n.offsetS) / 2))
    .map((note) => ({ note, onMelody: onMelody(note, ref) }));
}

/** What the key made of the freestyle notes. */
function freestyleReport(notes: readonly SungNote[], key: KeyMap | null): FreestyleReport {
  const report: FreestyleReport = { inKey: 0, offKey: 0, unclear: 0, passing: 0, offNotes: [], keyStatus: 'none' };
  const judgedAt: number[] = [];
  for (const n of notes) {
    const fit = fitNote(n.midi, n.onsetS, n.offsetS, key);
    if (fit.fit === 'passing') {
      report.passing++;
      continue;
    }
    judgedAt.push((n.onsetS + n.offsetS) / 2);
    if (fit.fit === 'unclear') {
      report.unclear++;
    } else if (fit.fit === 'in_key') {
      report.inKey++;
    } else {
      report.offKey++;
      const off: OffKeyNote = { onsetS: n.onsetS, offsetS: n.offsetS, midi: n.midi, centsOff: fit.centsOff ?? 0 };
      report.offNotes.push(off);
    }
  }
  report.keyStatus = keyStatusOver(key, judgedAt);
  return report;
}

/** The frames with those inside `blank` spans made unvoiced, so melody scoring does not see them. */
function blankFrames(frames: readonly PitchFrame[], blank: ReadonlyArray<SungNote>): PitchFrame[] {
  if (blank.length === 0) return [...frames];
  const spans = [...blank].sort((a, b) => a.onsetS - b.onsetS);
  let at = 0;
  return frames.map((f) => {
    while (at < spans.length && spans[at].offsetS <= f.t) at++;
    const inside = at < spans.length && f.t >= spans[at].onsetS;
    return inside ? { ...f, f0: 0 } : f;
  });
}

function scoreOpen(frames: readonly PitchFrame[], ref: ScoreReference | null, o: TakeScoreOptions): TakeReport {
  const melody = ref !== null && ref.notes.length > 0 ? ref : NO_MELODY;
  const sung = classify(frames, melody, () => true);
  const freestyle = sung.filter((c) => !c.onMelody).map((c) => c.note);
  const block = freestyleReport(freestyle, o.key);
  const base = reportTake(blankFrames(frames, freestyle), melody, true, 'open');
  const onTheMelody = sung.length - freestyle.length;
  const judged = onTheMelody + block.inKey + block.offKey + block.unclear;
  return {
    ...base,
    style: 'open',
    melodyShare: judged === 0 ? null : onTheMelody / judged,
    ...(melody === NO_MELODY ? { noMelody: true } : {}),
    freestyle: block,
  };
}

function scoreStrict(frames: readonly PitchFrame[], ref: ScoreReference | null, o: TakeScoreOptions): TakeReport {
  const melody = ref ?? NO_MELODY;
  const free = o.freeSpans.filter((span) => melody.notes.some((n) => noteInSpan(n, span)));
  if (free.length === 0) return { ...reportTake(frames, melody, o.octaveInvariant, 'strict'), style: 'strict' };
  // Indices of the notes that stay, so the report still points into the full melody.
  const kept: number[] = [];
  melody.notes.forEach((n, i) => {
    if (!free.some((span) => noteInSpan(n, span))) kept.push(i);
  });
  const measured = reportTake(
    frames,
    { ...melody, notes: kept.map((i) => melody.notes[i]) },
    o.octaveInvariant,
    'strict',
  );
  const strictPart: TakeReport = {
    ...measured,
    notes: measured.notes.map((n) => ({ ...n, index: kept[n.index] })),
    worstPhrases: measured.worstPhrases.map((p) => ({ ...p, first: kept[p.first], last: kept[p.last] })),
  };
  const sung = classify(frames, melody, (t) => inSpans(free, t));
  return {
    ...strictPart,
    style: 'strict',
    freestyle: freestyleReport(
      sung.filter((c) => !c.onMelody).map((c) => c.note),
      o.key,
    ),
    freeSpans: free.map((s): [number, number] => [s[0], s[1]]),
  };
}

/**
 * Measures a take. `ref` is the melody, or null for a song without one (Open
 * then scores everything as freestyle; Strict has nothing to measure). Strict
 * with no free phrase gives exactly `reportTake`'s numbers, with `style` set.
 */
export function scoreTake(frames: readonly PitchFrame[], ref: ScoreReference | null, o: TakeScoreOptions): TakeReport {
  return o.style === 'open' ? scoreOpen(frames, ref, o) : scoreStrict(frames, ref, o);
}

/**
 * One live frame in Open, or inside a free phrase: on the melody note under it
 * (folded, within 100 cents) it is hit or okay by Open's windows; anywhere
 * else it is `free`, except where the key is clear and the pitch is more than
 * 50 cents from every scale tone, which is `miss`. Null for an unvoiced frame.
 */
export function gradeFrameOpen(frame: PitchFrame, ref: ScoreReference | null, key: KeyMap | null): LiveGrade | null {
  if (!isVoiced(frame)) return null;
  const midi = hzToMidi(frame.f0);
  if (ref !== null) {
    const note = noteAt(ref, frame.t);
    if (note >= 0) {
      const cents = centsOff(midi, ref.notes[note].midi, true);
      if (Math.abs(cents) <= SCORING_STYLES.open.okayCents + EPSILON) return gradeCents(cents, 'open');
    }
  }
  return fitFrame(midi, frame.t, key) === 'off_key' ? 'miss' : 'free';
}

/** What the live scorer reads from the session each frame. */
export interface StyledScorerSource {
  /** False while nothing is graded (karaoke mode, or Strict without a melody). */
  scoring(): boolean;
  /** The melody, or null for a song with none. */
  reference(): ScoreReference | null;
  style(): ScoringStyle;
  octaveInvariant(): boolean;
  key(): KeyMap | null;
  freeSpans(): ReadonlyArray<Span>;
}

/** Grades each frame on the bus for the lane, in the style in force. */
export class StyledScorer {
  private readonly strict: LiveScorer;

  constructor(private readonly source: StyledScorerSource) {
    this.strict = new LiveScorer({
      reference: () => source.reference(),
      octaveInvariant: () => source.octaveInvariant(),
    });
  }

  /** Grade of one frame, or null when it gets none. */
  grade(frame: PitchFrame): LiveGrade | null {
    const { source } = this;
    if (!source.scoring()) return null;
    if (source.style() === 'open' || inSpans(source.freeSpans(), frame.t)) {
      return gradeFrameOpen(frame, source.reference(), source.key());
    }
    return this.strict.grade(frame);
  }

  /** Subscribes to the bus; returns the function that unsubscribes. */
  attach<M extends { frame: PitchFrame }>(
    bus: FrameSubscribable<M>,
    sink: (message: M, grade: LiveGrade | null) => void,
  ): () => void {
    return bus.subscribe((message) => sink(message, this.grade(message.frame)));
  }
}
