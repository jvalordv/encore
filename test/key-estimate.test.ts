/**
 * Tests for the key estimated from sung notes (src/analysis/key-estimate.ts):
 * a C-major melody reads as C major, an A-minor one as A minor, a transposed
 * one finds its tonic, and too few notes, too few pitch classes or a flat
 * chromatic spread give no key.
 */
import { describe, expect, it } from 'vitest';
import { estimateKey } from '../src/analysis/key-estimate';
import type { SungNote } from '../src/analysis/take-notes';

/** A melody: each entry is [midi, seconds], laid end to end. */
function melody(entries: ReadonlyArray<readonly [number, number]>): SungNote[] {
  let t = 0;
  return entries.map(([midi, seconds]) => {
    const note: SungNote = { onsetS: t, offsetS: t + seconds, midi, frames: [] };
    t += seconds + 0.1;
    return note;
  });
}

/** A tune in C major that touches all seven notes and leans on C, G and E. */
const ODE: ReadonlyArray<readonly [number, number]> = [
  [60, 0.8], [64, 0.4], [67, 0.4], [72, 0.6], [71, 0.3], [69, 0.3], [67, 0.6], [65, 0.3],
  [64, 0.3], [62, 0.3], [60, 0.8], [67, 0.5], [64, 0.4], [65, 0.3], [62, 0.3], [60, 1],
];

describe('estimateKey', () => {
  it('names C major from a C-major melody, with a confidence over the floor', () => {
    const key = estimateKey(melody(ODE));
    expect(key).toMatchObject({ tonic: 0, mode: 'major' });
    expect(key?.confidence).toBeGreaterThan(0.75);
  });

  it('names C major from a plain C-major scale up and down with a weighted tonic', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60, 60, 67, 64, 60];
    expect(estimateKey(melody(scale.map((m) => [m, 0.4] as const)))).toMatchObject({ tonic: 0, mode: 'major' });
  });

  it('finds the tonic of a melody moved up a tone, and of a minor one', () => {
    expect(estimateKey(melody(ODE.map(([m, s]) => [m + 2, s] as const)))).toMatchObject({ tonic: 2, mode: 'major' });
    // A minor: A B C D E F G A with the tonic and fifth leaned on.
    const minor = [69, 71, 72, 74, 76, 72, 69, 69, 76, 77, 76, 74, 72, 71, 69, 68, 69, 69, 64, 69];
    expect(estimateKey(melody(minor.map((m) => [m, 0.4] as const)))).toMatchObject({ tonic: 9, mode: 'minor' });
  });

  it('gives no key for too few notes, too few pitch classes, or an even chromatic spread', () => {
    expect(estimateKey(melody(ODE.slice(0, 4)))).toBeNull();
    expect(estimateKey(melody([60, 62, 60, 62, 60, 62, 64, 60].map((m) => [m, 0.5] as const)))).toBeNull();
    const chromatic = Array.from({ length: 24 }, (_, i) => [60 + (i % 12), 0.5] as const);
    expect(estimateKey(melody(chromatic))).toBeNull();
  });

  it('ignores passing notes under 150 ms', () => {
    const quick = melody(ODE.map(([m]) => [m, 0.1] as const));
    expect(estimateKey(quick)).toBeNull();
  });
});
