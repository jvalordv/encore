/**
 * The words and numbers of the Progress view: which measures it tracks, each
 * one's unit and what a better value looks like, and a view model of rows
 * (the sparkline's values, best, latest, change since the first week, a line
 * on what the direction means, and an honest line on the trend) built from
 * the aggregation in analysis/progress.ts. Pure, so the panel only draws it;
 * checked in test/progress-view.test.ts. Nothing here is shown in karaoke
 * mode (the panel is learning mode's).
 */
import { buildSeries, pointsFor, REFERENCE_MEASURES, songsOf } from '../analysis/progress';
import type { MeasureId, ProgressStyle, Series, TakePoint, Target } from '../analysis/progress';
import type { VoiceReference } from '../analysis/voice';
import { noteName } from '../render/lane-geometry';

/** How one measure is shown. */
export interface MeasureSpec {
  id: MeasureId;
  label: string;
  target: Target;
  /** Slope per week, in the stored unit, under which the trend reads flat. */
  flatBelow: number;
  /** Stored value to the number shown (shares are stored 0..1). */
  scale: number;
  /** Unit after a value, and the word for a change ("points" for shares). */
  unit: string;
  changeUnit: string;
  decimals: number;
  /** Whether positive values carry a plus sign (they have a direction). */
  signed: boolean;
  /** What the direction means, in plain words. */
  meaning: string;
}

/** The measures in the order they are listed. */
export const MEASURES: readonly MeasureSpec[] = [
  {
    id: 'inTune',
    label: 'In tune on the melody',
    target: 'high',
    flatBelow: 0.02,
    scale: 100,
    unit: '%',
    changeUnit: ' points',
    decimals: 0,
    signed: false,
    meaning: 'Higher is better.',
  },
  {
    id: 'within25',
    label: 'Notes within 25 c',
    target: 'high',
    flatBelow: 0.02,
    scale: 100,
    unit: '%',
    changeUnit: ' points',
    decimals: 0,
    signed: false,
    meaning: 'Higher is better: the share of notes within 25 cents of their tone.',
  },
  {
    id: 'within50',
    label: 'Notes within 50 c',
    target: 'high',
    flatBelow: 0.02,
    scale: 100,
    unit: '%',
    changeUnit: ' points',
    decimals: 0,
    signed: false,
    meaning: 'Higher is better: the share of notes within 50 cents of their tone.',
  },
  {
    id: 'bias',
    label: 'Sharp or flat',
    target: 'zero',
    flatBelow: 2,
    scale: 1,
    unit: ' c',
    changeUnit: ' c',
    decimals: 0,
    signed: true,
    meaning: 'Closer to 0 c is better. Positive is sharp, negative is flat.',
  },
  {
    id: 'stability',
    label: 'Steadiness on held notes',
    target: 'low',
    flatBelow: 1,
    scale: 1,
    unit: ' c',
    changeUnit: ' c',
    decimals: 0,
    signed: false,
    meaning: 'Lower is better: how far a held note wanders, in cents.',
  },
  {
    id: 'scoop',
    label: 'Scoop into notes',
    target: 'zero',
    flatBelow: 2,
    scale: 1,
    unit: ' c',
    changeUnit: ' c',
    decimals: 0,
    signed: true,
    meaning: 'Closer to 0 c is better. Positive means sliding up into notes.',
  },
  {
    id: 'drift',
    label: 'Drift on long notes',
    target: 'zero',
    flatBelow: 2,
    scale: 1,
    unit: ' c/s',
    changeUnit: ' c/s',
    decimals: 0,
    signed: true,
    meaning: 'Closer to 0 c/s is better. Positive means going sharp as a note goes on.',
  },
  {
    id: 'vibratoRate',
    label: 'Vibrato rate',
    target: 'none',
    flatBelow: 0.2,
    scale: 1,
    unit: ' Hz',
    changeUnit: ' Hz',
    decimals: 1,
    signed: true,
    meaning: 'Neither better nor worse: shown so you can see it change.',
  },
  {
    id: 'vibratoExtent',
    label: 'Vibrato width',
    target: 'none',
    flatBelow: 3,
    scale: 1,
    unit: ' c',
    changeUnit: ' c',
    decimals: 0,
    signed: true,
    meaning: 'Neither better nor worse: shown so you can see it change.',
  },
  {
    id: 'rangeWidth',
    label: 'Range (middle 80% of what you sang)',
    target: 'none',
    flatBelow: 0.5,
    scale: 1,
    unit: ' semitones',
    changeUnit: ' semitones',
    decimals: 0,
    signed: true,
    meaning: 'Neither better nor worse: it depends on the song.',
  },
];

const STYLE_NAMES: Record<ProgressStyle, string> = { strict: 'Strict', open: 'Open', none: 'No melody' };
const REFERENCE_NAMES: Record<VoiceReference, string> = {
  song_key: "against the song's key",
  estimated_key: 'against an estimated key',
  chromatic: 'against the nearest semitone',
};
const REFERENCES: readonly VoiceReference[] = ['song_key', 'estimated_key', 'chromatic'];

/** The song picker's value for every song. */
export const ALL_SONGS = 'all';

/** A value in its unit; `signed` puts a plus on positive numbers. */
export function formatValue(spec: MeasureSpec, value: number, change = false): string {
  const n = value * spec.scale;
  const text = Math.abs(n).toFixed(spec.decimals);
  const zero = Number(text) === 0;
  const sign = n < 0 && !zero ? '-' : (spec.signed || change) && n > 0 && !zero ? '+' : '';
  return `${sign}${text}${change ? spec.changeUnit : spec.unit}`;
}

/** The sentence on a series' trend; says so when it rests on few takes. */
export function trendWords(series: Series, spec: MeasureSpec): string {
  const { kind, slopePerWeek, points } = series.trend;
  if (kind === 'not-enough') return `Not enough takes for a trend yet (it needs 3, there ${points === 1 ? 'is' : 'are'} ${points}).`;
  if (kind === 'short' || slopePerWeek === null) return `Not enough days yet: a weekly trend needs takes on 3 different days, and takes on one day count once (${points} so far).`;
  const caution = points < 5 ? ` Only ${points} takes, so take it as a hint.` : '';
  if (kind === 'flat') return `Holding steady over ${points} takes.${caution}`;
  const per = `${formatValue(spec, Math.abs(slopePerWeek), true).replace('+', '')} a week`;
  const word = kind === 'up' ? 'Rising' : 'Falling';
  let verdict = '';
  if (spec.target === 'high') verdict = kind === 'up' ? ', the better way' : ', the wrong way';
  else if (spec.target === 'low') verdict = kind === 'down' ? ', the better way' : ', the wrong way';
  else if (spec.target === 'zero') {
    const towardZero = kind === 'up' ? series.latest < 0 : series.latest > 0;
    verdict = towardZero ? ', toward 0' : ', away from 0';
  }
  return `${word} about ${per} over ${points} takes${verdict}.${caution}`;
}

/** One measure's row: the values to draw and the words around them. */
export interface ProgressRow {
  key: string;
  label: string;
  /** "Strict", "Open", a reference ("against the song's key") or null. */
  qualifier: string | null;
  values: number[];
  best: string | null;
  latest: string;
  /** The first week's median; null when none. */
  baseline: string | null;
  /** The change since it; null while the latest is within the first week. */
  change: string | null;
  meaning: string;
  trend: string;
  takes: number;
}

function latestText(spec: MeasureSpec, series: Series, points: readonly TakePoint[]): string {
  if (spec.id !== 'rangeWidth') return formatValue(spec, series.latest);
  const last = points.find((p) => p.id === series.points[series.points.length - 1].id);
  const range = last?.range;
  return range ? `${noteName(range.lowMidi)} to ${noteName(range.highMidi)}` : formatValue(spec, series.latest);
}

function rowOf(spec: MeasureSpec, series: Series, points: readonly TakePoint[]): ProgressRow {
  const styleName = series.style === null ? null : STYLE_NAMES[series.style];
  const refName = series.reference === null ? null : REFERENCE_NAMES[series.reference];
  const key =
    series.reference !== null ? `${spec.id}-${series.reference}` : styleName === null ? spec.id : `${spec.id}-${series.style}`;
  return {
    key,
    label: spec.id === 'inTune' && series.style === 'strict' ? 'In tune (within 50 c of the melody)' : spec.id === 'inTune' ? 'On the melody' : spec.label,
    qualifier: refName ?? (spec.id === 'inTune' ? styleName : null),
    values: series.points.map((p) => p.value),
    best: series.best === null ? null : formatValue(spec, series.best),
    latest: latestText(spec, series, points),
    baseline: series.baseline === null ? null : formatValue(spec, series.baseline),
    change: series.change === null ? null : formatValue(spec, series.change, true),
    meaning: spec.meaning,
    trend: trendWords(series, spec),
    takes: series.points.length,
  };
}

/** The rows for one song, or all songs when `songHash` is null. */
export function progressRows(all: readonly TakePoint[], songHash: string | null): ProgressRow[] {
  const points = pointsFor(all, songHash);
  const rows: ProgressRow[] = [];
  for (const spec of MEASURES) {
    // In-tune shares are per style: Strict's and Open's are different numbers.
    const styles: Array<ProgressStyle | null> = spec.id === 'inTune' ? ['strict', 'open'] : [null];
    // So are the key-relative measures: a song's key, an estimated one and
    // the nearest semitone are different yardsticks.
    const refs: Array<VoiceReference | null> = REFERENCE_MEASURES.includes(spec.id) ? [...REFERENCES] : [null];
    for (const style of styles) {
      for (const ref of refs) {
        const series = buildSeries(points, spec.id, style, spec.target, spec.flatBelow, ref);
        if (series !== null) rows.push(rowOf(spec, series, points));
      }
    }
  }
  return rows;
}

/** An entry of the song picker. */
export interface SongChoice {
  value: string;
  label: string;
}

/**
 * The picker's entries: all songs, then each song with takes, most recent
 * first; the loaded song is marked "This song" and leads the songs.
 */
export function songChoices(all: readonly TakePoint[], currentHash: string | null): SongChoice[] {
  const songs = songsOf(all);
  const mine = songs.filter((s) => s.hash === currentHash);
  const others = songs.filter((s) => s.hash !== currentHash);
  return [
    { value: ALL_SONGS, label: `All songs (${all.length} ${all.length === 1 ? 'take' : 'takes'})` },
    ...mine.map((s) => ({ value: s.hash, label: `This song: ${s.name} (${s.takes})` })),
    ...others.map((s) => ({ value: s.hash, label: `${s.name} (${s.takes})` })),
  ];
}

/** The song to show first: the loaded one when it has takes, else all. */
export function defaultSong(all: readonly TakePoint[], currentHash: string | null): string {
  return currentHash !== null && all.some((p) => p.songHash === currentHash) ? currentHash : ALL_SONGS;
}
