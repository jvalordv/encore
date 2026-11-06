/**
 * The Mic check's test track: 40 s that start with a silent stretch, play a
 * melody for the speakers-only stretch, keep it going while the singer sings
 * along, and fall silent for the last stretch (the singer sings alone). The
 * melody is a voice-like harmonic tone with gentle vibrato over simple
 * stepwise notes, in a low (A2..A3) or high (A3..A4) range, and the reference
 * contour is its exact f0 at the project's 10 ms hop, in the shape the lane
 * and the bleed detector read. Pure: the samples and the contour come from
 * the same `melodyF0At`, so a test can compare them. Checked in
 * test/test-melody.test.ts.
 */
import type { LaneReference } from '../render/lane-geometry';

/** What a section of the check asks of the singer. */
export type SectionKind = 'silent' | 'sing';
/** The four stretches, in order. */
export type SectionLabel = 'quiet' | 'speakers' | 'sing-along' | 'sing-alone';
/** The range the melody sits in. */
export type MelodyRange = 'low' | 'high';

/** One labelled stretch of the check, on song time. */
export interface MicCheckSection {
  label: SectionLabel;
  kind: SectionKind;
  startS: number;
  endS: number;
}

/** The stretches' lengths in seconds, in order, with what each asks. */
export const MIC_CHECK_LAYOUT: ReadonlyArray<{ label: SectionLabel; kind: SectionKind; lengthS: number }> = [
  { label: 'quiet', kind: 'silent', lengthS: 5 },
  { label: 'speakers', kind: 'silent', lengthS: 10 },
  { label: 'sing-along', kind: 'sing', lengthS: 15 },
  { label: 'sing-alone', kind: 'sing', lengthS: 10 },
];

/** Seconds between contour samples (the project-wide 10 ms hop). */
export const MELODY_HOP_S = 0.01;
/** Seconds one note takes, rest included. */
const NOTE_S = 0.6;
/** Seconds of the note that sound; the rest is a breath. */
const NOTE_ON_S = 0.5;
/** Vibrato rate in Hz and depth in cents either way. */
const VIBRATO_HZ = 5;
const VIBRATO_CENTS = 30;
/** Fade in and out of each note, in seconds. */
const ATTACK_S = 0.03;
const RELEASE_S = 0.06;
/** Strength of harmonics 1..4 of the voice. */
const HARMONICS = [1, 0.5, 0.28, 0.14];
/** Loudest sample of the track, well under full scale. */
const PEAK = 0.5;
/** Semitones above the range's bottom note: a major scale, A to A. */
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12];
/** Frequency of the range's bottom note in Hz. */
const BASE_HZ: Record<MelodyRange, number> = { low: 110, high: 220 };

/** The track: samples, the exact melody and the stretches. */
export interface TestMelody {
  sampleRate: number;
  pcm: Float32Array;
  /** The melody's f0 per 10 ms; 0 where it is silent. */
  reference: LaneReference;
  sections: MicCheckSection[];
  durationS: number;
}

/** The sections laid end to end, every length multiplied by `scale`. */
export function micCheckSections(scale = 1): MicCheckSection[] {
  let at = 0;
  return MIC_CHECK_LAYOUT.map(({ label, kind, lengthS }) => {
    const section: MicCheckSection = { label, kind, startS: at, endS: at + lengthS * scale };
    at = section.endS;
    return section;
  });
}

/** Index into the scale for note `n`: up and down it, a step at a time. */
function degreeOf(n: number): number {
  const span = SCALE.length - 1;
  const k = n % (2 * span);
  return k <= span ? k : 2 * span - k;
}

/** Start of the melody (after the quiet stretch) and its end, in seconds. */
function melodySpan(sections: readonly MicCheckSection[]): [number, number] {
  return [sections[1]!.startS, sections[2]!.endS];
}

/**
 * The melody's f0 in Hz at song time `t`, vibrato included; 0 outside the
 * melody and in the breath that ends each note. `sections` fixes where the
 * melody lies.
 */
export function melodyF0At(t: number, range: MelodyRange, sections: readonly MicCheckSection[]): number {
  const [from, to] = melodySpan(sections);
  if (!(t >= from) || !(t < to)) return 0;
  const into = t - from;
  const n = Math.floor(into / NOTE_S);
  if (into - n * NOTE_S >= NOTE_ON_S) return 0;
  const base = BASE_HZ[range] * 2 ** (SCALE[degreeOf(n)]! / 12);
  return base * 2 ** ((VIBRATO_CENTS * Math.sin(2 * Math.PI * VIBRATO_HZ * t)) / 1200);
}

/** Envelope 0..1 of the note holding `t`: a soft attack and release. */
function envelopeAt(t: number, sections: readonly MicCheckSection[]): number {
  const [from, to] = melodySpan(sections);
  const into = t - from;
  const inNote = into - Math.floor(into / NOTE_S) * NOTE_S;
  const noteEnd = Math.min(NOTE_ON_S, to - from - Math.floor(into / NOTE_S) * NOTE_S);
  const attack = Math.min(1, inNote / ATTACK_S);
  const release = Math.min(1, (noteEnd - inNote) / RELEASE_S);
  return Math.max(0, Math.min(attack, release));
}

/**
 * Builds the track at `sampleRate`. `durationScale` shortens every section by
 * that factor (the end-to-end run uses it); 1 is the real 40 s.
 */
export function generateTestMelody(sampleRate: number, range: MelodyRange, durationScale = 1): TestMelody {
  const sections = micCheckSections(durationScale);
  const durationS = sections[sections.length - 1]!.endS;
  const pcm = new Float32Array(Math.round(durationS * sampleRate));
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    const f0 = melodyF0At(t, range, sections);
    if (f0 > 0) {
      phase += (2 * Math.PI * f0) / sampleRate;
      let v = 0;
      for (let k = 0; k < HARMONICS.length; k++) v += HARMONICS[k]! * Math.sin((k + 1) * phase);
      v *= envelopeAt(t, sections);
      pcm[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  if (peak > 0) {
    const gain = PEAK / peak;
    for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i]! * gain;
  }
  const hops = Math.floor(durationS / MELODY_HOP_S) + 1;
  const f0Hz = new Float64Array(hops);
  for (let i = 0; i < hops; i++) f0Hz[i] = melodyF0At(i * MELODY_HOP_S, range, sections);
  return { sampleRate, pcm, reference: { hopS: MELODY_HOP_S, t0S: 0, f0Hz }, sections, durationS };
}
