/**
 * A key estimated from the singing itself, for a song with no key map (a
 * YouTube karaoke video the service has not read): the Krumhansl-Schmuckler
 * method. The duration-weighted histogram of the pitch classes sung is
 * correlated with the Krumhansl-Kessler major and minor profiles rotated to
 * each of the 24 tonics, and the best correlation names the key. The
 * correlation is the confidence; below `MIN_KEY_CONFIDENCE`, or without a clear
 * lead over the best unrelated key, there is "no clear key" and the caller
 * falls back to the nearest semitone. A relative major and minor share their
 * notes, so the lead is measured against keys other than the winner's relative.
 * Pure, no DOM; checked on synthetic melodies in test/key-estimate.test.ts.
 */
import type { SungNote } from './take-notes';

/** Krumhansl-Kessler probe-tone ratings, tonic first. */
const MAJOR_PROFILE: readonly number[] = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE: readonly number[] = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** The correlation the best key needs to be called a key at all. */
export const MIN_KEY_CONFIDENCE = 0.75;
/** ...and how far it must lead the best key that is not its relative. */
export const MIN_KEY_LEAD = 0.05;
/** Notes needed before a key is estimated. */
export const MIN_KEY_NOTES = 6;
/** Distinct pitch classes needed: a few repeated notes fit many keys. */
export const MIN_KEY_CLASSES = 5;
/** Notes shorter than this are passing tones and do not vote. */
const VOTING_NOTE_S = 0.15;

/** A key the singing points to. */
export interface KeyEstimate {
  /** Pitch class 0..11, C = 0. */
  tonic: number;
  mode: 'major' | 'minor';
  /** The Pearson correlation of the sung pitch classes with the key's profile. */
  confidence: number;
}

function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    ab += (a[i] - ma) * (b[i] - mb);
    aa += (a[i] - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  }
  return aa === 0 || bb === 0 ? 0 : ab / Math.sqrt(aa * bb);
}

/** The key the sung notes point to, or null when there is no clear one. */
export function estimateKey(notes: readonly SungNote[]): KeyEstimate | null {
  const voting = notes.filter((n) => n.offsetS - n.onsetS >= VOTING_NOTE_S);
  if (voting.length < MIN_KEY_NOTES) return null;
  const hist = new Array<number>(12).fill(0);
  for (const n of voting) hist[((Math.round(n.midi) % 12) + 12) % 12] += n.offsetS - n.onsetS;
  if (hist.filter((w) => w > 0).length < MIN_KEY_CLASSES) return null;
  const scored: KeyEstimate[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      // The profile rotated so that its tonic lands on this tonic's pitch class.
      const rotated = hist.map((_, pc) => profile[(pc - tonic + 12) % 12]);
      scored.push({ tonic, mode, confidence: pearson(hist, rotated) });
    }
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  const best = scored[0];
  const relative = best.mode === 'major' ? (best.tonic + 9) % 12 : (best.tonic + 3) % 12;
  const rival = scored.find((k) => k !== best && !(k.mode !== best.mode && k.tonic === relative));
  if (best.confidence < MIN_KEY_CONFIDENCE) return null;
  if (rival !== undefined && best.confidence - rival.confidence < MIN_KEY_LEAD) return null;
  return best;
}
