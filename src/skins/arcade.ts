/**
 * Arcade, the neon high-score skin. Copy shouts. Only the fun-layer keys are
 * overridden here; the coaching-rule phrasings fall back to Studio until the
 * personality-copy task (ROADMAP P3-T5) writes them.
 */
import type { Skin } from './types';

/** Neon on black, combos, sparks and screen shake. */
export const arcade: Skin = {
  id: 'arcade',
  name: 'Arcade',
  tagline: 'Neon, combos, high scores.',
  fx: { particles: 'sparks', hitEffect: 'flash', streakShake: true, confettiOnGrade: false },
  copy: {
    streak5: 'COMBO ×5!',
    streak10: 'COMBO ×10!!',
    streak20: 'COMBO ×20! UNSTOPPABLE',
    stars0: 'MISS',
    stars1: 'OK',
    stars2: 'GREAT',
    stars3: 'PERFECT',
    gradeS: 'S RANK',
    gradeA: 'A RANK',
    gradeB: 'B RANK',
    gradeC: 'C RANK',
    gradeD: 'D RANK',
    reportTitle: 'RESULTS',
    workOnTitle: 'TRAINING MODE',
    bestMomentTitle: 'BEST COMBO',
  },
};
