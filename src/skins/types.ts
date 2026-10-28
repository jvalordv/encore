/**
 * Types for the skin system (docs/SKINS.md). A skin is a CSS token file plus a
 * `Skin` object carrying its metadata, FX config and personality copy. The
 * copy keys are defined once here so the type, the Studio table and the tests
 * cannot drift apart.
 */

/** Every user-facing string a skin may override, in display order. */
export const COPY_KEYS = [
  // Streak callouts, by tier.
  'streak5',
  'streak10',
  'streak20',
  // Phrase star captions.
  'stars0',
  'stars1',
  'stars2',
  'stars3',
  // Grade titles.
  'gradeS',
  'gradeA',
  'gradeB',
  'gradeC',
  'gradeD',
  // Report card headings.
  'reportTitle',
  'workOnTitle',
  'bestMomentTitle',
  // One phrasing per coaching rule id (docs/COACHING.md, Rules table).
  'flat_bias',
  'sharp_bias',
  'scoop',
  'unstable_sustain',
  'late_onsets',
  'early_onsets',
  'phrase_fade',
  'out_of_range',
  'vibrato_wider',
  'vibrato_slower',
  'held_shorter',
  'off_key',
  'softer_here',
  'brighter',
] as const;

/** One key of the shared personality-copy table. */
export type CopyKey = (typeof COPY_KEYS)[number];

/** The complete copy table: same facts in every skin, different voice. */
export type Copy = Record<CopyKey, string>;

/** Which effects a skin turns on; the renderer in src/render/ reads this. */
export interface SkinFx {
  particles: 'none' | 'sparks' | 'sparkles';
  hitEffect: 'none' | 'flash' | 'hearts';
  streakShake: boolean;
  confettiOnGrade: boolean;
}

/** A visual skin. Missing copy keys fall back to Studio via `copyFor`. */
export interface Skin {
  /** Lowercase single word; matches `src/skins/<id>.css` and `data-skin`. */
  id: string;
  /** Shown in the skin switcher. */
  name: string;
  tagline: string;
  fx: SkinFx;
  copy: Partial<Copy>;
}

/** A skin with a complete copy table; Studio is the fallback, so it must be. */
export interface CompleteSkin extends Skin {
  copy: Copy;
}
