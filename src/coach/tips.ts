/**
 * Learning-mode tips: pure rules over a take's measurements (the report from
 * src/analysis/score.ts), never guesses. Each rule returns zero or one tip;
 * every threshold lives in `TIP_THRESHOLDS` so they can be tuned in one place;
 * and at most three tips come back, the strongest first, so the singer has
 * something to do rather than a wall of red. A tip carries its evidence (which
 * note, how far off) and a place to jump to, so the singer can hear it. Ids
 * and wording are the rows of the table in docs/COACHING.md: `general` rules in
 * both scoring styles (the bias rules on melody notes only, the early and late
 * rules at the style's own threshold), the `match` rule `held_shorter` in Strict
 * only, and the `open` rule `off_key` on freestyle notes, in Open and in free
 * phrases. The voice rules (`drift`, `vibrato_wide`, `vibrato_irregular`,
 * `short_phrases`, and the bias, scoop and wobble rules reading the voice
 * section when the song has no melody) run over `report.voice`, so a take with
 * no melody still gets tips. Per-skin phrasing is later. Comments in the table
 * say what each number means.
 */
import { LONG_NOTE_S, SCORING_STYLES } from '../analysis/score';
import type { NoteResult, TakeReport } from '../analysis/score';
import { median } from '../analysis/take-notes';
import type { VoiceNote } from '../analysis/voice';
import { noteName } from '../render/lane-geometry';

/** The rules this wave has, in the order ties are broken. */
export type TipId =
  | 'flat_bias'
  | 'sharp_bias'
  | 'scoop'
  | 'unstable_sustain'
  | 'late_onsets'
  | 'early_onsets'
  | 'out_of_range'
  | 'held_shorter'
  | 'off_key'
  | 'drift'
  | 'vibrato_wide'
  | 'vibrato_irregular'
  | 'short_phrases';

/** Every threshold a rule uses. A rule fires only strictly past its number. */
export const TIP_THRESHOLDS = {
  /** A note is flat when its mean error is under this many cents... */
  flatCents: -20,
  /** ...sharp when over this many. */
  sharpCents: 20,
  /** A bias tip needs more than this share of the sung notes. */
  biasShare: 0.4,
  /** Median slide up into notes, in cents. */
  scoopCents: 60,
  /** A long note wobbles when the spread of its error is over this many cents... */
  wobbleCents: 35,
  /** ...and the tip needs more than this share of the long notes to wobble. */
  wobbleShare: 0.3,
  /** The song's top note over the singer's p90 by more than this many semitones. */
  rangeSemitones: 2,
  /** A long note is short when held under this share of the original's length... */
  heldRatio: 0.7,
  /** ...and the tip needs more than this share of the long notes to be short. */
  heldShare: 0.3,
  /** Notes needed before a rule over all notes trusts its numbers. */
  minNotes: 4,
  /** Long notes needed before a rule over long notes trusts its numbers. */
  minLongNotes: 3,
  /** The off-key tip needs more than this share of the judged freestyle notes off key... */
  offKeyShare: 0.25,
  /** ...and at least this many judged (in key plus off key). */
  minFreestyle: 4,
  /** A long note drifts when its slope is over this many cents per second, either way... */
  driftCps: 20,
  /** ...and the tip needs more than this share of the notes over 600 ms to drift. */
  driftShare: 0.4,
  /** Vibrato is wide when its median extent is over this many cents either side of centre. */
  vibratoWideCents: 80,
  /** Vibrato is irregular when its median regularity (variance a steady swing explains) is under this. */
  vibratoRegularity: 0.7,
  /** Vibrato notes needed before a vibrato rule trusts its numbers. */
  minVibratoNotes: 3,
  /** Phrases are short when their median length is under this many seconds... */
  phraseS: 1.5,
  /** ...and the tip needs at least this many phrases. */
  minPhrases: 4,
} as const;

/** The advice for each rule, in plain words (docs/COACHING.md). */
export const TIP_MESSAGES: Record<TipId, string> = {
  flat_bias: 'You sing under the note, most on the higher ones. Aim slightly above where it feels right.',
  sharp_bias: 'You push above the note. Relax the push on onsets.',
  scoop: 'You slide up into notes. Land on the centre, then add the slide on purpose.',
  unstable_sustain: 'Long notes wobble. Steady air; practise one sustained vowel at a time.',
  late_onsets: 'You are behind the beat. Breathe one beat earlier.',
  early_onsets: 'You come in ahead of the beat. Wait for it; listen for the note before.',
  out_of_range:
    'This song sits above where your voice is comfortable today. Ease off the top notes rather than forcing them.',
  held_shorter: 'The original holds these notes longer. Keep the air going to the end.',
  off_key:
    "Some of your free notes land outside the song's key. Build ad-libs from notes of the melody or the " +
    'bass line, and keep outside notes short, as passing notes.',
  drift:
    'Long notes drift away from where they start. Set the pitch before you open the note and keep the air steady to the end.',
  vibrato_wide: 'Your vibrato swings wide. Relax the jaw and throat and let it narrow to a gentle pulse.',
  vibrato_irregular: 'Your vibrato wanders in speed. Keep the air steady and let it settle into an even pulse.',
  short_phrases:
    'You break lines into short pieces. Take a low breath and plan where you breathe, at the ends of lines.',
};

/** One tip: the advice, what it rests on, where to hear it, how strong it is. */
export interface Tip {
  id: TipId;
  message: string;
  /** Which notes, how far off, in a sentence. */
  evidence: string;
  /** Song time to jump to, in seconds. */
  jumpToS: number;
  /** How far past its threshold the measure is (1 = at it); orders the tips. */
  strength: number;
}

/** The most tips a take gets. */
export const MAX_TIPS = 3;

function clock(s: number): string {
  const total = Math.max(0, Math.floor(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function nameAt(n: NoteResult): string {
  return `${noteName(n.midi)} at ${clock(n.onsetS)}`;
}

function tip(id: TipId, evidence: string, jumpToS: number, strength: number): Tip {
  return { id, message: TIP_MESSAGES[id], evidence, jumpToS, strength };
}

/** Largest by `key`; the earliest wins a tie. */
function maxBy<T>(items: readonly T[], key: (item: T) => number): T {
  return items.reduce((best, item) => (key(item) > key(best) ? item : best));
}

/** The flat or sharp bias rule: `sign` is -1 for flat, +1 for sharp. */
function biasRule(report: TakeReport, sign: -1 | 1): Tip | null {
  const t = TIP_THRESHOLDS;
  const sung = report.notes.filter((n) => n.meanCents !== null);
  if (sung.length < t.minNotes) return null;
  const limit = sign < 0 ? t.flatCents : t.sharpCents;
  const off = sung.filter((n) => (sign < 0 ? (n.meanCents ?? 0) < limit : (n.meanCents ?? 0) > limit));
  const share = off.length / sung.length;
  if (!(share > t.biasShare)) return null;
  const worst = maxBy(off, (n) => Math.abs(n.meanCents ?? 0));
  const way = sign < 0 ? 'under' : 'over';
  const evidence =
    `${off.length} of ${sung.length} notes sat more than ${Math.abs(limit)} c ${way} the melody; ` +
    `the worst was ${nameAt(worst)}, ${Math.round(Math.abs(worst.meanCents ?? 0))} c ${way}.`;
  return tip(sign < 0 ? 'flat_bias' : 'sharp_bias', evidence, worst.onsetS, share / t.biasShare);
}

function scoopRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const measured = report.notes.filter((n) => n.scoopUpCents !== null);
  if (measured.length < t.minNotes) return null;
  const typical = median(measured.map((n) => n.scoopUpCents ?? 0));
  if (!(typical > t.scoopCents)) return null;
  const worst = maxBy(measured, (n) => n.scoopUpCents ?? 0);
  const evidence =
    `Your first 150 ms sat a median of ${Math.round(typical)} c under the rest of the note; ` +
    `the biggest slide was ${nameAt(worst)}, ${Math.round(worst.scoopUpCents ?? 0)} c.`;
  return tip('scoop', evidence, worst.onsetS, typical / t.scoopCents);
}

function wobbleRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const measured = report.notes.filter((n) => n.stdCents !== null);
  if (measured.length < t.minLongNotes) return null;
  const wobbly = measured.filter((n) => (n.stdCents ?? 0) > t.wobbleCents);
  const share = wobbly.length / measured.length;
  if (!(share > t.wobbleShare)) return null;
  const worst = maxBy(wobbly, (n) => n.stdCents ?? 0);
  const evidence =
    `${wobbly.length} of ${measured.length} long notes wandered more than ${t.wobbleCents} c; ` +
    `the worst was ${nameAt(worst)}, spread ${Math.round(worst.stdCents ?? 0)} c.`;
  return tip('unstable_sustain', evidence, worst.onsetS, share / t.wobbleShare);
}

/** The late or early rule: `sign` is +1 for late, -1 for early. */
function onsetRule(report: TakeReport, sign: -1 | 1): Tip | null {
  const t = TIP_THRESHOLDS;
  const limit = SCORING_STYLES[report.style ?? 'strict'].timingTipS;
  const timed = report.notes.filter((n) => n.onsetDeltaS !== null);
  const bias = report.timingBiasS;
  if (timed.length < t.minNotes || bias === null || !(bias * sign > limit)) return null;
  const worst = maxBy(timed, (n) => (n.onsetDeltaS ?? 0) * sign);
  const way = sign > 0 ? 'late' : 'early';
  const evidence =
    `Your entries came a median of ${Math.round(Math.abs(bias) * 1000)} ms ${way} over ${timed.length} notes; ` +
    `the worst was ${nameAt(worst)}, ${Math.round(Math.abs(worst.onsetDeltaS ?? 0) * 1000)} ms ${way}.`;
  return tip(sign > 0 ? 'late_onsets' : 'early_onsets', evidence, worst.onsetS, (bias * sign) / limit);
}

function rangeRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const { sungRange, songRange } = report;
  if (sungRange === null || report.notesSung < t.minNotes) return null;
  const over = songRange.highMidi - sungRange.highMidi;
  if (!(over > t.rangeSemitones)) return null;
  const evidence =
    `The song reaches ${noteName(songRange.highMidi)}; the top of your voice in this take was about ` +
    `${noteName(sungRange.highMidi)}, ${over.toFixed(1)} semitones lower.`;
  return tip('out_of_range', evidence, songRange.highAtS, over / t.rangeSemitones);
}

function heldRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const long = report.notes.filter((n) => n.heldRatio !== null && n.offsetS - n.onsetS > LONG_NOTE_S);
  if (long.length < t.minLongNotes) return null;
  const short = long.filter((n) => (n.heldRatio ?? 1) < t.heldRatio);
  const share = short.length / long.length;
  if (!(share > t.heldShare)) return null;
  const worst = maxBy(short, (n) => 1 - (n.heldRatio ?? 1));
  const evidence =
    `${short.length} of ${long.length} long notes were held under ${Math.round(t.heldRatio * 100)}% ` +
    `of the original's length; the shortest was ${nameAt(worst)}, held ` +
    `${Math.round((worst.heldRatio ?? 0) * 100)}% of it.`;
  return tip('held_shorter', evidence, worst.onsetS, share / t.heldShare);
}

function offKeyRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const free = report.freestyle;
  if (!free) return null;
  const judged = free.inKey + free.offKey;
  if (judged < t.minFreestyle) return null;
  const share = free.offKey / judged;
  if (!(share > t.offKeyShare)) return null;
  const worst = maxBy(free.offNotes, (n) => Math.abs(n.centsOff));
  const evidence =
    `${free.offKey} of ${judged} free notes (${Math.round(share * 100)}%) were more than 50 c from the key; ` +
    `the worst was ${noteName(worst.midi)} at ${clock(worst.onsetS)}, ${Math.round(Math.abs(worst.centsOff))} c ` +
    `from the nearest note of the key.`;
  return tip('off_key', evidence, worst.onsetS, share / t.offKeyShare);
}

/** What a voice rule reads: the voice section's notes, when there is no melody. */
function voiceOf(report: TakeReport): VoiceNote[] {
  return report.voice && report.noMelody === true ? report.voice.notes : [];
}

function toneName(report: TakeReport): string {
  const v = report.voice;
  if (v?.reference === 'chromatic') return 'the nearest semitone';
  if (v?.reference === 'estimated_key') return `the nearest note of ${v.keyName ?? 'the estimated key'}`;
  return 'the nearest note of the key';
}

function voiceNameAt(n: VoiceNote): string {
  return `${noteName(n.midi)} at ${clock(n.onsetS)}`;
}

/** The flat or sharp rule over the voice section: `sign` is -1 for flat, +1 for sharp. */
function voiceBiasRule(report: TakeReport, sign: -1 | 1): Tip | null {
  const t = TIP_THRESHOLDS;
  const sung = voiceOf(report).filter((n) => n.centsOff !== null);
  if (sung.length < t.minNotes) return null;
  const limit = sign < 0 ? t.flatCents : t.sharpCents;
  const off = sung.filter((n) => (sign < 0 ? (n.centsOff ?? 0) < limit : (n.centsOff ?? 0) > limit));
  const share = off.length / sung.length;
  if (!(share > t.biasShare)) return null;
  const worst = maxBy(off, (n) => Math.abs(n.centsOff ?? 0));
  const way = sign < 0 ? 'under' : 'over';
  const evidence =
    `${off.length} of ${sung.length} notes sat more than ${Math.abs(limit)} c ${way} ${toneName(report)}; ` +
    `the worst was ${voiceNameAt(worst)}, ${Math.round(Math.abs(worst.centsOff ?? 0))} c ${way}.`;
  return tip(sign < 0 ? 'flat_bias' : 'sharp_bias', evidence, worst.onsetS, share / t.biasShare);
}

function voiceScoopRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const measured = voiceOf(report).filter((n) => n.scoopCents !== null);
  if (measured.length < t.minNotes) return null;
  const typical = median(measured.map((n) => n.scoopCents ?? 0));
  if (!(typical > t.scoopCents)) return null;
  const worst = maxBy(measured, (n) => n.scoopCents ?? 0);
  const evidence =
    `Your first 150 ms sat a median of ${Math.round(typical)} c under the rest of the note; ` +
    `the biggest slide was ${voiceNameAt(worst)}, ${Math.round(worst.scoopCents ?? 0)} c.`;
  return tip('scoop', evidence, worst.onsetS, typical / t.scoopCents);
}

function voiceWobbleRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const measured = voiceOf(report).filter((n) => n.stdCents !== null);
  if (measured.length < t.minLongNotes) return null;
  const wobbly = measured.filter((n) => (n.stdCents ?? 0) > t.wobbleCents);
  const share = wobbly.length / measured.length;
  if (!(share > t.wobbleShare)) return null;
  const worst = maxBy(wobbly, (n) => n.stdCents ?? 0);
  const evidence =
    `${wobbly.length} of ${measured.length} long notes wandered more than ${t.wobbleCents} c ` +
    `(vibrato and drift taken out); the worst was ${voiceNameAt(worst)}, spread ${Math.round(worst.stdCents ?? 0)} c.`;
  return tip('unstable_sustain', evidence, worst.onsetS, share / t.wobbleShare);
}

function driftRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const measured = (report.voice?.notes ?? []).filter((n) => n.driftCps !== null);
  if (measured.length < t.minLongNotes) return null;
  const drifting = measured.filter((n) => Math.abs(n.driftCps ?? 0) > t.driftCps);
  const share = drifting.length / measured.length;
  if (!(share > t.driftShare)) return null;
  const worst = maxBy(drifting, (n) => Math.abs(n.driftCps ?? 0));
  const slope = Math.round(Math.abs(worst.driftCps ?? 0));
  const evidence =
    `${drifting.length} of ${measured.length} notes over 600 ms drifted more than ${t.driftCps} c a second; ` +
    `the worst was ${voiceNameAt(worst)}, ${slope} c/s ${(worst.driftCps ?? 0) < 0 ? 'flat' : 'sharp'}.`;
  return tip('drift', evidence, worst.onsetS, share / t.driftShare);
}

/** The vibrato rules: `wide` when the swing is too big, else the irregular one. */
function vibratoRule(report: TakeReport, wide: boolean): Tip | null {
  const t = TIP_THRESHOLDS;
  const vib = (report.voice?.notes ?? []).filter((n) => n.vibrato !== null);
  if (vib.length < t.minVibratoNotes) return null;
  const extent = median(vib.map((n) => n.vibrato?.extentCents ?? 0));
  const regularity = median(vib.map((n) => n.vibrato?.regularity ?? 0));
  if (wide) {
    if (!(extent > t.vibratoWideCents)) return null;
    const worst = maxBy(vib, (n) => n.vibrato?.extentCents ?? 0);
    const evidence =
      `Your vibrato on ${vib.length} notes swung a median of ${Math.round(extent)} c either side; ` +
      `the widest was ${voiceNameAt(worst)}, ${Math.round(worst.vibrato?.extentCents ?? 0)} c.`;
    return tip('vibrato_wide', evidence, worst.onsetS, extent / t.vibratoWideCents);
  }
  if (!(regularity < t.vibratoRegularity)) return null;
  const worst = maxBy(vib, (n) => 1 - (n.vibrato?.regularity ?? 1));
  const evidence =
    `Your vibrato on ${vib.length} notes was a median ${Math.round(regularity * 100)}% regular ` +
    `(a steady swing is over ${Math.round(t.vibratoRegularity * 100)}%); the least even was ` +
    `${voiceNameAt(worst)}, ${Math.round((worst.vibrato?.regularity ?? 0) * 100)}%.`;
  return tip('vibrato_irregular', evidence, worst.onsetS, t.vibratoRegularity / Math.max(regularity, 0.01));
}

function phraseRule(report: TakeReport): Tip | null {
  const t = TIP_THRESHOLDS;
  const voice = report.voice;
  const typical = voice?.summary.phraseMedianS;
  if (!voice || typical == null || voice.summary.phraseCount < t.minPhrases) return null;
  if (!(typical < t.phraseS)) return null;
  const shortest = voice.phrases.reduce((a, b) => (b[1] - b[0] < a[1] - a[0] ? b : a));
  const evidence =
    `Your ${voice.summary.phraseCount} phrases ran a median of ${typical.toFixed(1)} s between breaths; ` +
    `the shortest was at ${clock(shortest[0])}, ${(shortest[1] - shortest[0]).toFixed(1)} s.`;
  return tip('short_phrases', evidence, shortest[0], t.phraseS / typical);
}

/** The tips a take earns: the rules that fire, strongest first, at most three. */
export function tipsFor(report: TakeReport): Tip[] {
  // With no melody the voice section stands in for the melody's notes.
  const alone = report.noMelody === true;
  const fired = [
    alone ? voiceBiasRule(report, -1) : biasRule(report, -1),
    alone ? voiceBiasRule(report, 1) : biasRule(report, 1),
    alone ? voiceScoopRule(report) : scoopRule(report),
    alone ? voiceWobbleRule(report) : wobbleRule(report),
    onsetRule(report, 1),
    onsetRule(report, -1),
    rangeRule(report),
    // The original's lengths mean nothing to a singer who may ad-lib freely.
    (report.style ?? 'strict') === 'strict' ? heldRule(report) : null,
    offKeyRule(report),
    driftRule(report),
    vibratoRule(report, true),
    vibratoRule(report, false),
    phraseRule(report),
  ].filter((t): t is Tip => t !== null);
  // Array sort is stable, so equal strengths keep the table's order.
  return fired.sort((a, b) => b.strength - a.strength).slice(0, MAX_TIPS);
}
