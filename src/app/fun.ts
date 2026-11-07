/**
 * The words of the fun extras (W6d), as pure functions over the active skin's
 * copy: the "N days in a row" chip, a song's stars and the personal-best
 * line. The streak is days sung and nothing more, so it is shown in both
 * modes; stars and personal bests are learning mode's and the panels that
 * show them are hidden in karaoke mode. Checked in test/fun.test.ts.
 */
import type { PersonalBest } from '../analysis/stars';
import type { TakeReport } from '../analysis/score';
import { STAR_MEASURE_LABELS, starMeasure, takeStars } from '../analysis/stars';
import { streakLabel, streakOf } from '../analysis/streak';
import { copyFor, DEFAULT_SKIN, findSkin } from '../skins';
import type { Skin } from '../skins/types';

/** The skin in force: the one `data-skin` names on <html>, else Studio. */
export function activeSkin(doc: Document): Skin {
  return findSkin(doc.documentElement?.dataset?.skin) ?? DEFAULT_SKIN;
}

/** The chip's text for the days sung as of day number `today`; '' for none. */
export function streakChipText(days: readonly number[], today: number, skin: Skin): string {
  const { current } = streakOf(days, today);
  return streakLabel(current, copyFor(skin, 'dayInARow'), copyFor(skin, 'daysInARow'));
}

/** A song's stars in words ("2 of 3 stars"); '' when it has none. */
export function starsText(stars: number, skin: Skin): string {
  return stars > 0 ? copyFor(skin, 'songStars').replace('{n}', String(stars)) : '';
}

/**
 * The stars line of a take: the stars in words and the measure they were
 * earned on, so lenient Open stars never pass for Strict ones; '' for none.
 */
export function starsLineFor(report: TakeReport, skin: Skin): string {
  const m = starMeasure(report);
  const text = starsText(takeStars(report), skin);
  if (m === null || text === '') return '';
  return `${text} (${STAR_MEASURE_LABELS[m.id]} ${Math.round(m.value * 100)}%)`;
}

/** Filled and empty star glyphs for a row, for example "★★☆". */
export function starGlyphs(stars: number): string {
  return '★'.repeat(stars) + '☆'.repeat(Math.max(0, 3 - stars));
}

/** The personal-best line: the lead, the measure and both numbers. */
export function personalBestText(best: PersonalBest, skin: Skin): string {
  const measure = STAR_MEASURE_LABELS[best.measure];
  return `${copyFor(skin, 'personalBest')}: ${measure} ${best.nowPercent}%, up from ${best.wasPercent}%.`;
}
