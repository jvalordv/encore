/**
 * The voice alone (docs/COACHING.md, "Your voice"): what a take says about the
 * singing with no melody to compare against, which is the case for a YouTube
 * karaoke video and any song the service could not take a melody from. The
 * notes are the take's own (the W3 segmentation rule, take-notes.ts), and each
 * is measured against the nearest tone of the song's key (key-fit.ts), else of
 * a key estimated from the sung notes (key-estimate.ts) and labelled so, else
 * the nearest semitone at concert pitch. Per note: cents from that tone,
 * steadiness on held notes, the scoop into the note, drift, and vibrato
 * (contour-fit.ts). Per take: the bias and the shares within 25 and 50 cents,
 * the range, and the phrases with the breaths between them. Pure, no DOM;
 * checked on synthetic contours in test/voice.test.ts. It adds `voice` to a
 * `TakeReport`; a take stored before it has none.
 */
import type { KeyMap } from '../service/types';
import { measureContour, VIBRATO_MIN_CYCLES, VIBRATO_MIN_HZ } from './contour-fit';
import type { Vibrato } from './contour-fit';
import { estimateKey } from './key-estimate';
import { centsToScale, isClearSegment, keySegmentAt, PASSING_NOTE_S } from './key-fit';
import { hzToMidi } from './pitch';
import type { PitchFrame } from './pitch';
import { gradeCents, isVoiced, LONG_NOTE_S, percentile, SCOOP_WINDOW_S } from './score';
import type { LiveGrade } from './score';
import { MERGE_GAP_S, median, segmentTake } from './take-notes';
import type { NoteFrame, SungNote } from './take-notes';

/** A note must run this long for vibrato to be looked for. */
export const VIBRATO_NOTE_S = 0.5;
/**
 * A note must run this long for its spread to be reported: the scoop window
 * plus the cycles vibrato detection needs at the slowest rate searched, so any
 * vibrato in it can be fitted and taken out (0.65 s).
 */
export const STABILITY_NOTE_S = SCOOP_WINDOW_S + VIBRATO_MIN_CYCLES / VIBRATO_MIN_HZ;
/** A note must run this long for drift to be measured. */
export const DRIFT_NOTE_S = 0.6;
/** A silence longer than this between notes is a breath: it ends the phrase. */
export const BREATH_GAP_S = 0.25;
/** Frames needed on each side of the scoop window to call it a measure. */
const SCOOP_MIN_FRAMES = 3;

/** Pitch-class names for the key's label. */
const TONIC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** What the notes were measured against. */
export type VoiceReference = 'song_key' | 'estimated_key' | 'chromatic';

/** One sung note, measured. */
export interface VoiceNote {
  onsetS: number;
  offsetS: number;
  /** Median pitch, fractional MIDI. */
  midi: number;
  /** Signed cents from the nearest tone (sharp positive); null for a passing note. */
  centsOff: number | null;
  /** Spread in cents on a held note (over 400 ms), vibrato and drift taken out. */
  stdCents: number | null;
  /** Steady part minus the first 150 ms, in cents; positive is a scoop up into the note. */
  scoopCents: number | null;
  /** Slope in cents per second over a note over 600 ms, after its first 150 ms. */
  driftCps: number | null;
  vibrato: Vibrato | null;
}

/** The take-level numbers; each is null when too little was sung to say. */
export interface VoiceSummary {
  /** Notes measured for pitch (150 ms or longer). */
  judged: number;
  /** Median of the notes' signed cents from their tone. */
  biasCents: number | null;
  /** Shares of the judged notes within 25 and 50 cents, 0..1. */
  within25: number | null;
  within50: number | null;
  /** Held notes measured, and the median of their spreads. */
  held: number;
  stabilityCents: number | null;
  /** Median scoop over the notes it was measured on. */
  scoopCents: number | null;
  /** Long notes measured for drift, and the median slope (signed). */
  driftNotes: number;
  driftCps: number | null;
  /** Vibrato: notes it was found on out of the notes long enough to look. */
  vibratoNotes: number;
  vibratoOf: number;
  vibratoRateHz: number | null;
  vibratoExtentCents: number | null;
  vibratoRegularity: number | null;
  /** The voiced frames' p10 to p90, fractional MIDI. */
  range: { lowMidi: number; highMidi: number } | null;
  /** Phrases (notes with breaths under 250 ms between) and their lengths. */
  phraseCount: number;
  phraseMedianS: number | null;
  phraseLongestS: number | null;
  breathMedianS: number | null;
}

/** The voice section of a take's report. */
export interface VoiceReport {
  reference: VoiceReference;
  /** "C major" for a key; null for the chromatic fallback. */
  keyName: string | null;
  /** The correlation behind an estimated key; null otherwise. */
  keyConfidence: number | null;
  notes: VoiceNote[];
  /** Each phrase as [start, end] in song time. */
  phrases: Array<[number, number]>;
  summary: VoiceSummary;
}

/** Cents from the nearest semitone of concert pitch. */
export function centsToSemitone(midi: number): number {
  return (midi - Math.round(midi)) * 100;
}

function keyLabel(tonic: number, mode: 'major' | 'minor'): string {
  return `${TONIC_NAMES[tonic]} ${mode}`;
}

/**
 * Joins a short piece to the higher, longer one right after it: a scoop that
 * steps more than 80 cents is cut off by the segmentation rule, but to the ear
 * it is one note entered from below (as mergeScoops does against a melody).
 */
export function mergeRisingScoops(sung: readonly SungNote[]): SungNote[] {
  const out: SungNote[] = [];
  for (let i = 0; i < sung.length; i++) {
    const piece = sung[i];
    const next = sung[i + 1];
    const joins =
      next !== undefined &&
      piece.offsetS - piece.onsetS < SCOOP_WINDOW_S &&
      next.offsetS - next.onsetS >= SCOOP_WINDOW_S &&
      next.onsetS - piece.offsetS < MERGE_GAP_S &&
      next.midi > piece.midi;
    if (!joins) {
      out.push(piece);
      continue;
    }
    const frames = [...piece.frames, ...next.frames];
    out.push({ onsetS: piece.onsetS, offsetS: next.offsetS, midi: median(frames.map((f) => f.midi)), frames });
    i++;
  }
  return out;
}

/** The tone each note is measured against, and what that was. */
function referenceFor(
  notes: readonly SungNote[],
  key: KeyMap | null,
): { reference: VoiceReference; keyName: string | null; confidence: number | null; cents: (n: SungNote) => number } {
  const judged = notes.filter((n) => n.offsetS - n.onsetS >= PASSING_NOTE_S - 1e-9);
  const segmentOf = (n: SungNote): ReturnType<typeof keySegmentAt> => keySegmentAt(key, (n.onsetS + n.offsetS) / 2);
  if (key !== null && judged.length > 0 && judged.every((n) => isClearSegment(segmentOf(n)))) {
    const names = new Set<string>();
    for (const s of key.segments) if (isClearSegment(s)) names.add(keyLabel(s.tonic, s.mode));
    return {
      reference: 'song_key',
      keyName: names.size === 1 ? [...names][0] : null,
      confidence: null,
      cents: (n) => {
        const seg = segmentOf(n);
        return isClearSegment(seg) ? centsToScale(n.midi, seg.tonic, seg.mode, key.tuning_cents) : 0;
      },
    };
  }
  const estimate = estimateKey(notes);
  if (estimate !== null) {
    return {
      reference: 'estimated_key',
      keyName: keyLabel(estimate.tonic, estimate.mode),
      confidence: estimate.confidence,
      cents: (n) => centsToScale(n.midi, estimate.tonic, estimate.mode, 0),
    };
  }
  return { reference: 'chromatic', keyName: null, confidence: null, cents: (n) => centsToSemitone(n.midi) };
}

/** Steadiness, drift and vibrato of a note, from its frames after the scoop window. */
function steady(note: SungNote): ReturnType<typeof measureContour> {
  const after = note.frames.filter((f) => f.t >= note.onsetS + SCOOP_WINDOW_S);
  return measureContour(
    after.map((f) => f.t),
    after.map((f) => f.midi * 100),
  );
}

function scoopOf(note: SungNote): number | null {
  const cutoff = note.onsetS + SCOOP_WINDOW_S;
  const head = note.frames.filter((f) => f.t < cutoff).map((f) => f.midi);
  const rest = note.frames.filter((f) => f.t >= cutoff).map((f) => f.midi);
  if (head.length < SCOOP_MIN_FRAMES || rest.length < SCOOP_MIN_FRAMES) return null;
  return (median(rest) - median(head)) * 100;
}

/** One note measured; `tone` is its signed cents from the nearest tone. */
export function measureNote(note: SungNote, tone: number): VoiceNote {
  const length = note.offsetS - note.onsetS;
  const judged = length >= PASSING_NOTE_S - 1e-9;
  // Every look below needs a note over 400 ms.
  const contour = length > LONG_NOTE_S ? steady(note) : null;
  return {
    onsetS: note.onsetS,
    offsetS: note.offsetS,
    midi: note.midi,
    centsOff: judged ? tone : null,
    // Spread is reported only where vibrato could have been detected, so a
    // short note's vibrato is never counted as a wobble.
    stdCents: contour !== null && length > STABILITY_NOTE_S ? contour.stdCents : null,
    scoopCents: judged ? scoopOf(note) : null,
    driftCps: length > DRIFT_NOTE_S && contour !== null ? contour.driftCps : null,
    vibrato: length > VIBRATO_NOTE_S && contour !== null ? contour.vibrato : null,
  };
}

function medianOrNull(values: readonly number[]): number | null {
  return values.length === 0 ? null : median(values);
}

/** Notes grouped into phrases split at breaths; spans in time order. */
function phrasesOf(notes: readonly VoiceNote[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last !== undefined && n.onsetS - last[1] <= BREATH_GAP_S) last[1] = Math.max(last[1], n.offsetS);
    else out.push([n.onsetS, n.offsetS]);
  }
  return out;
}

function summarise(notes: readonly VoiceNote[], phrases: ReadonlyArray<[number, number]>, sung: readonly SungNote[]): VoiceSummary {
  const judged = notes.filter((n) => n.centsOff !== null);
  const off = judged.map((n) => Math.abs(n.centsOff ?? 0));
  const share = (limit: number): number | null =>
    judged.length === 0 ? null : off.filter((c) => c <= limit + 1e-9).length / judged.length;
  const spreads = notes.map((n) => n.stdCents).filter((c): c is number => c !== null);
  const scoops = notes.map((n) => n.scoopCents).filter((c): c is number => c !== null);
  const drifts = notes.map((n) => n.driftCps).filter((c): c is number => c !== null);
  const looked = notes.filter((n) => n.offsetS - n.onsetS > VIBRATO_NOTE_S);
  const vib = notes.map((n) => n.vibrato).filter((v): v is Vibrato => v !== null);
  const midis = sung.flatMap((n) => n.frames.map((f) => f.midi));
  const lengths = phrases.map(([a, b]) => b - a);
  const gaps = phrases.slice(1).map((p, i) => p[0] - phrases[i][1]);
  return {
    judged: judged.length,
    biasCents: medianOrNull(judged.map((n) => n.centsOff ?? 0)),
    within25: share(25),
    within50: share(50),
    held: spreads.length,
    stabilityCents: medianOrNull(spreads),
    scoopCents: medianOrNull(scoops),
    driftNotes: drifts.length,
    driftCps: medianOrNull(drifts),
    vibratoNotes: vib.length,
    vibratoOf: looked.length,
    vibratoRateHz: medianOrNull(vib.map((v) => v.rateHz)),
    vibratoExtentCents: medianOrNull(vib.map((v) => v.extentCents)),
    vibratoRegularity: medianOrNull(vib.map((v) => v.regularity)),
    range: midis.length === 0 ? null : { lowMidi: percentile(midis, 0.1), highMidi: percentile(midis, 0.9) },
    phraseCount: phrases.length,
    phraseMedianS: medianOrNull(lengths),
    phraseLongestS: lengths.length === 0 ? null : Math.max(...lengths),
    breathMedianS: medianOrNull(gaps),
  };
}

/**
 * The voice section for a take's frames (time order, song time). `key` is the
 * song's key map when the service sent one; with none, or an unclear one, the
 * key is estimated from the notes themselves.
 */
export function measureVoice(frames: readonly NoteFrame[], key: KeyMap | null): VoiceReport {
  const sung = mergeRisingScoops(segmentTake(frames));
  const ref = referenceFor(sung, key);
  const notes = sung.map((n) => measureNote(n, ref.cents(n)));
  const phrases = phrasesOf(notes);
  return {
    reference: ref.reference,
    keyName: ref.keyName,
    keyConfidence: ref.confidence,
    notes,
    phrases,
    summary: summarise(notes, phrases, sung),
  };
}

/**
 * One live frame as a tuner would grade it, for a song with no melody: cents
 * from the nearest tone of the song's key where it is clear, else the nearest
 * semitone, in Strict's windows (25 hit, 50 okay, beyond that a miss). Null for
 * an unvoiced frame. Not used in karaoke mode.
 */
export function gradeFrameTuner(frame: PitchFrame, key: KeyMap | null): LiveGrade | null {
  if (!isVoiced(frame)) return null;
  const midi = hzToMidi(frame.f0);
  const segment = keySegmentAt(key, frame.t);
  const cents =
    key !== null && isClearSegment(segment)
      ? centsToScale(midi, segment.tonic, segment.mode, key.tuning_cents)
      : centsToSemitone(midi);
  return gradeCents(cents, 'strict');
}
