/**
 * Studio, the utilitarian default skin and the copy fallback for every other
 * skin. Plain wording, no effects. Its copy table must stay complete: the
 * coaching messages are the Studio-voice text from docs/COACHING.md.
 */
import type { CompleteSkin } from './types';

/** The default skin; supplies any copy key another skin leaves out. */
export const studio: CompleteSkin = {
  id: 'studio',
  name: 'Studio',
  tagline: 'Plain numbers, no distractions.',
  fx: { particles: 'none', hitEffect: 'none', streakShake: false, confettiOnGrade: false },
  copy: {
    streak5: '5 in a row',
    streak10: '10 in a row',
    streak20: '20 in a row',
    stars0: 'No stars',
    stars1: '1 star',
    stars2: '2 stars',
    stars3: '3 stars',
    gradeS: 'Excellent',
    gradeA: 'Strong',
    gradeB: 'Solid',
    gradeC: 'Getting there',
    gradeD: 'Keep practising',
    reportTitle: 'Take report',
    workOnTitle: 'Work on this',
    bestMomentTitle: 'Best moment',
    flat_bias:
      'You sing under the note, most on the higher ones. Aim slightly above where it feels right.',
    sharp_bias: 'You push above the note. Relax the push on onsets.',
    scoop: 'You slide up into notes. Land on the centre, then add the slide on purpose.',
    unstable_sustain: 'Long notes wobble. Steady air; practise one sustained vowel at a time.',
    late_onsets: 'You are behind the beat. Breathe one beat earlier.',
    early_onsets: 'You come in ahead of the beat. Wait for it; listen for the note before.',
    phrase_fade: 'Phrases die at the end. Keep support to the last word.',
    out_of_range: 'This song sits above where your voice is comfortable today. Ease off the top notes rather than forcing them.',
    vibrato_wider: 'Their vibrato is narrower than yours here.',
    vibrato_slower: 'Their vibrato is faster; aim for a lighter, quicker shimmer.',
    held_shorter: 'The original holds these notes longer. Keep the air going to the end.',
    off_key:
      "Some of your free notes land outside the song's key. Build ad-libs from notes of the melody or the " +
      'bass line, and keep outside notes short, as passing notes.',
    softer_here: 'They sing this phrase softer.',
    brighter: 'Their tone is darker; try a rounder vowel.',
  },
};
