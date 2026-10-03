/**
 * Dreamhouse, the hot-pink, glitter-and-hearts skin. Copy is warm and extra.
 * Only the fun-layer keys are overridden here; the coaching-rule phrasings
 * fall back to Studio until the personality-copy task (ROADMAP P3-T5) writes
 * them.
 */
import type { Skin } from './types';

/** Pink, lavender and gold, with sparkles, hearts and confetti. */
export const dreamhouse: Skin = {
  id: 'dreamhouse',
  name: 'Dreamhouse',
  tagline: 'Glitter, hearts, and a standing ovation.',
  fx: { particles: 'sparkles', hitEffect: 'hearts', streakShake: false, confettiOnGrade: true },
  copy: {
    streak5: 'Sparkling! ✨',
    streak10: 'Gorgeous! ✨',
    streak20: 'That was a whole moment ✨',
    stars0: 'Warming up',
    stars1: 'Cute!',
    stars2: 'Gorgeous!',
    stars3: 'Iconic! ✨',
    gradeS: 'Absolute superstar ✨',
    gradeA: 'Gorgeous!',
    gradeB: 'Fabulous',
    gradeC: 'Getting glam',
    gradeD: 'Warm-up queen',
    reportTitle: "Tonight's Encore",
    workOnTitle: 'Your glow-up list',
    bestMomentTitle: 'Main character moment',
  },
};
