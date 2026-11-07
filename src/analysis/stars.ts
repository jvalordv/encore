/**
 * Stars per song and personal bests, learning mode only (nothing here is read
 * in karaoke mode, which judges nothing). Each learning take has one primary
 * measure, a share between 0 and 1:
 *
 * - Strict with a melody: the in-tune share (notes within 50 c).
 * - No melody, Strict: the share of notes within 50 c of their tone (the
 *   voice section's measure against the key or the nearest semitone).
 * - Open: the share of sung notes that were on the melody or, off it, in the
 *   song's key; with no melody that is the in-key share alone.
 *
 * The stars follow the best take of the song: 1 star from 60 %, 2 from 75 %,
 * 3 from 90 % (docs/COACHING.md, "Stars"). A personal best is a take whose
 * share, in whole percent, tops every earlier take of the same song measured
 * the same way. Pure, no DOM; checked in test/stars.test.ts.
 */
import type { TakeReport } from './score';

/** Which share a take is starred on. */
export type StarMeasureId = 'inTune' | 'within50' | 'keyFit';

/** A take's primary measure. */
export interface StarMeasure {
  id: StarMeasureId;
  /** The share, 0..1. */
  value: number;
}

/** Shares at which a song earns its first, second and third star. */
export const STAR_CUTS: readonly [number, number, number] = [0.6, 0.75, 0.9];

/** What each measure is called where a line names it. */
export const STAR_MEASURE_LABELS: Record<StarMeasureId, string> = {
  inTune: 'in tune on the melody',
  within50: 'notes within 50 c',
  keyFit: 'on the melody or in key',
};

/** Short forms of the measure names, for a library row. */
export const STAR_MEASURE_SHORT: Record<StarMeasureId, string> = {
  inTune: 'in tune',
  within50: 'within 50 c',
  keyFit: 'in key',
};

/** The fields of a stored take the stars read (a TakeSummary fits). */
export interface StarTake {
  id: string;
  songHash: string;
  createdAt: number;
  kind?: 'song' | 'mic-check';
  report?: TakeReport;
}

function keyShare(report: TakeReport): number | null {
  const f = report.freestyle;
  if (f === undefined) return null;
  const judged = f.inKey + f.offKey;
  return judged > 0 ? f.inKey / judged : null;
}

/** The take's primary measure; null when it has nothing to star on. */
export function starMeasure(report: TakeReport): StarMeasure | null {
  if (report.style === 'open') {
    const onMelody = report.noMelody === true ? null : (report.melodyShare ?? null);
    const key = keyShare(report);
    const value = onMelody !== null && key !== null ? onMelody + (1 - onMelody) * key : (onMelody ?? key);
    return value === null ? null : { id: 'keyFit', value };
  }
  if (report.noMelody === true) {
    const within50 = report.voice?.summary.within50 ?? null;
    return within50 === null ? null : { id: 'within50', value: within50 };
  }
  return report.inTuneRate === null ? null : { id: 'inTune', value: report.inTuneRate };
}

/** Whole stars, 0..3, for a share. */
export function starsFor(value: number): number {
  return STAR_CUTS.filter((cut) => value >= cut).length;
}

/** Stars of one take; 0 when it has no measure. */
export function takeStars(report: TakeReport): number {
  const m = starMeasure(report);
  return m === null ? 0 : starsFor(m.value);
}

function counts(take: StarTake): take is StarTake & { report: TakeReport } {
  return take.kind !== 'mic-check' && take.report !== undefined;
}

/** A song's stars and the measure they were earned on. */
export interface SongStars {
  stars: number;
  measure: StarMeasureId;
}

/**
 * Best stars within one measure per song: the measure of the song's latest
 * learning take, so a lenient Open take never lifts a later Strict result.
 */
export function songStarsBySong(takes: readonly StarTake[]): Record<string, SongStars> {
  const latest: Record<string, { at: number; measure: StarMeasureId }> = {};
  for (const take of takes) {
    if (!counts(take)) continue;
    const m = starMeasure(take.report);
    if (m === null) continue;
    const seen = latest[take.songHash];
    if (seen === undefined || take.createdAt >= seen.at) latest[take.songHash] = { at: take.createdAt, measure: m.id };
  }
  const out: Record<string, SongStars> = {};
  for (const take of takes) {
    if (!counts(take)) continue;
    const m = starMeasure(take.report);
    const want = latest[take.songHash];
    if (m === null || want === undefined || m.id !== want.measure) continue;
    const stars = Math.max(out[take.songHash]?.stars ?? 0, starsFor(m.value));
    out[take.songHash] = { stars, measure: m.id };
  }
  return out;
}

/** The best stars of `songHash` on its latest measure; 0 for none. */
export function bestStars(takes: readonly StarTake[], songHash: string): number {
  return songStarsBySong(takes)[songHash]?.stars ?? 0;
}

/** Best stars (see songStarsBySong) for every song that has a learning take. */
export function starsBySong(takes: readonly StarTake[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [hash, s] of Object.entries(songStarsBySong(takes))) out[hash] = s.stars;
  return out;
}

/** A take that beat the song's earlier best. */
export interface PersonalBest {
  measure: StarMeasureId;
  /** Whole percent now and before. */
  nowPercent: number;
  wasPercent: number;
}

/**
 * Whether `take` beat the best earlier take of its song on its own measure.
 * The first take of a song, or a take measured another way than all before
 * it, has nothing to beat and is not a personal best.
 */
export function personalBest(take: StarTake, all: readonly StarTake[]): PersonalBest | null {
  if (!counts(take)) return null;
  const mine = starMeasure(take.report);
  if (mine === null) return null;
  let was: number | null = null;
  for (const other of all) {
    if (other.id === take.id || other.songHash !== take.songHash || !counts(other)) continue;
    if (other.createdAt > take.createdAt) continue;
    const m = starMeasure(other.report);
    if (m === null || m.id !== mine.id) continue;
    was = Math.max(was ?? 0, Math.round(m.value * 100));
  }
  const now = Math.round(mine.value * 100);
  return was !== null && now > was ? { measure: mine.id, nowPercent: now, wasPercent: was } : null;
}
