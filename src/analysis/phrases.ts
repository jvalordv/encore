/**
 * The one phrase splitter. A phrase is a run of notes with no long rest
 * inside it: the unit a singer breathes, learns and replays by. Learning
 * mode ranks phrases by how they went (score.ts); later waves reuse the same
 * split for free phrases (W4) and for a second singer (W5), so there is
 * exactly one definition of where a phrase begins. Pure, no DOM.
 */

/** A rest of at least this many seconds between notes starts a new phrase. */
export const PHRASE_GAP_S = 0.6;

/** Slack for rests that are 0.6 s on paper but 0.5999999 s in floating point. */
const GAP_EPSILON_S = 1e-6;

/** The two times a note needs to be placed in a phrase. */
export interface PhraseNote {
  onsetS: number;
  offsetS: number;
}

/** A phrase: the notes `first` to `last` (inclusive indices) and its span. */
export interface Phrase {
  first: number;
  last: number;
  startS: number;
  endS: number;
}

/**
 * Splits notes, given in time order, into phrases. The rest between two notes
 * is measured from the latest end so far, so a long note that overlaps the next
 * keeps them together.
 */
export function splitPhrases(notes: readonly PhraseNote[], gapS: number = PHRASE_GAP_S): Phrase[] {
  const phrases: Phrase[] = [];
  let current: Phrase | null = null;
  for (let index = 0; index < notes.length; index++) {
    const note = notes[index];
    if (current !== null && note.onsetS - current.endS < gapS - GAP_EPSILON_S) {
      current.last = index;
      current.endS = Math.max(current.endS, note.offsetS);
    } else {
      current = { first: index, last: index, startS: note.onsetS, endS: note.offsetS };
      phrases.push(current);
    }
  }
  return phrases;
}
