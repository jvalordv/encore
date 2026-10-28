/**
 * The karaoke mix, apart from the audio that plays it: what the singer can
 * choose (the original, the instrumental, or the instrumental with the original
 * vocal turned low as a guide), the state the song panel draws, and the pure
 * rule that turns a choice into a level per stem. The separated stems come out
 * of the service scaled by one factor `g` so that they cannot clip (see
 * "Separation" in docs/ARCHITECTURE.md): they are the song times `g`. The
 * stems therefore play at unity and the original at `g`, which keeps every mix
 * at the same loudness and never scales a stem up. The controller that applies
 * these levels to the player is src/app/session/mix.ts.
 */

/**
 * What the singer hears: the song as it is, the backing only, or the backing
 * with the original vocal turned low as a guide.
 */
export type MixChoice = 'original' | 'karaoke' | 'guide';

/** The choices in the order the panel offers them. */
export const MIX_CHOICES: readonly MixChoice[] = ['original', 'karaoke', 'guide'];

/** How each choice is named on its button. */
export const MIX_LABELS: Readonly<Record<MixChoice, string>> = {
  original: 'Original',
  karaoke: 'Karaoke',
  guide: 'Karaoke + vocal guide',
};

/** What the song panel knows about the mix. */
export interface MixState {
  /** True once the stems are loaded; before that only the original exists. */
  available: boolean;
  choice: MixChoice;
  /** Level of the vocal stem in the guide mix, 0 to 1. */
  guideLevel: number;
}

/** The mix of a song with no stems yet. */
export function initialMix(guideLevel: number): MixState {
  return { available: false, choice: 'original', guideLevel };
}

/** A level for each stem the player can hold for a song. */
export interface StemLevels {
  original: number;
  no_vocals: number;
  vocals: number;
}

/** A level as a number from 0 to 1; NaN reads as 0. */
export function clampLevel(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The level of every stem for a choice. `stemGain` is the factor the stems were
 * made with (1 when there are none); `duck` scales the whole mix, which is how
 * a take is laid over the song at a lower level. Only one of the original and
 * the instrumental sounds at a time, so nothing doubles.
 */
export function mixLevels(
  choice: MixChoice,
  guideLevel: number,
  stemGain: number,
  duck = 1,
): StemLevels {
  const gain = stemGain > 0 && Number.isFinite(stemGain) ? Math.min(1, stemGain) : 1;
  const overall = clampLevel(duck);
  const original = choice === 'original';
  return {
    original: original ? gain * overall : 0,
    no_vocals: original ? 0 : overall,
    vocals: choice === 'guide' ? clampLevel(guideLevel) * overall : 0,
  };
}
