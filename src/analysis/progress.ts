/**
 * Progress over time (docs/COACHING.md, "Progress"): learning-mode takes
 * turned into per-measure series, per song or over all songs. Only stored
 * summaries are read. A take is a point when it has a report and is not a
 * Mic check take; fields an older take lacks are null in its point, never a
 * guess. Strict's in-tune share and Open's share on the melody are different
 * numbers, so each style keeps its own series for that measure; the voice
 * measures mean the same in every style and share one series. Per series:
 * best, latest, a baseline (the median over the first week, by local
 * calendar days) with the change since it, and a trend, the Theil-Sen slope
 * per week over one median value per local day (so a session of close takes
 * counts as one day), which a stray take cannot bend. Within 25 c, within
 * 50 c and sharp or flat are measured against a key or the nearest semitone,
 * and those are different numbers, so each reference keeps its own series. Pure, no DOM; checked on
 * synthetic takes in test/progress.test.ts.
 */
import type { TakeReport } from './score';
import type { VoiceReference } from './voice';

/** Which numbers a take can contribute. */
export type MeasureId =
  | 'inTune'
  | 'within25'
  | 'within50'
  | 'bias'
  | 'stability'
  | 'scoop'
  | 'drift'
  | 'vibratoRate'
  | 'vibratoExtent'
  | 'rangeWidth';

/** What a take was scored as: a melody in Strict or Open, or no melody. */
export type ProgressStyle = 'strict' | 'open' | 'none';

/** The fields of a stored take the view reads (a TakeSummary fits). */
export interface ProgressTake {
  id: string;
  songHash: string;
  songName: string;
  createdAt: number;
  kind?: 'song' | 'mic-check';
  report?: TakeReport;
}

/** One take, reduced to the numbers the view tracks. */
export interface TakePoint {
  id: string;
  songHash: string;
  songName: string;
  /** Epoch milliseconds. */
  at: number;
  style: ProgressStyle;
  /** What the voice measures were taken against; null when the take has none. */
  reference: VoiceReference | null;
  /** Each measure, or null where the take has none. */
  values: Record<MeasureId, number | null>;
  /** The p10 to p90 range, fractional MIDI; null when none was measured. */
  range: { lowMidi: number; highMidi: number } | null;
}

/** Days in the baseline window: the first take's local day and the six after. */
export const BASELINE_DAYS = 7;
/** Fewest points a trend is called for. */
export const MIN_TREND_POINTS = 3;
const DAY_MS = 86_400_000;
const WEEK_DAYS = 7;
/** Fewest distinct local days a weekly slope is called for. */
export const MIN_TREND_DAYS = 3;
/** The measures whose meaning depends on the reference they were taken against. */
export const REFERENCE_MEASURES: readonly MeasureId[] = ['within25', 'within50', 'bias'];

/** The style a report was scored in; reports from before the styles are Strict. */
export function styleOf(report: TakeReport): ProgressStyle {
  if (report.noMelody === true) return 'none';
  return report.style === 'open' ? 'open' : 'strict';
}

/** The in-tune share of a take: Strict's rate, Open's share on the melody. */
function inTuneOf(report: TakeReport, style: ProgressStyle): number | null {
  if (style === 'strict') return report.inTuneRate ?? null;
  if (style === 'open') return report.melodyShare ?? null;
  return null;
}

/** One take as a point; null for a Mic check take or one with no report. */
export function takePoint(take: ProgressTake): TakePoint | null {
  const report = take.report;
  if (take.kind === 'mic-check' || report === undefined) return null;
  const style = styleOf(report);
  const v = report.voice?.summary;
  const range = v?.range ?? report.sungRange ?? null;
  return {
    id: take.id,
    songHash: take.songHash,
    songName: take.songName,
    at: take.createdAt,
    style,
    reference: report.voice?.reference ?? null,
    range,
    values: {
      inTune: inTuneOf(report, style),
      within25: v?.within25 ?? null,
      within50: v?.within50 ?? null,
      bias: v?.biasCents ?? null,
      stability: v?.stabilityCents ?? null,
      scoop: v?.scoopCents ?? null,
      drift: v?.driftCps ?? null,
      vibratoRate: v?.vibratoRateHz ?? null,
      vibratoExtent: v?.vibratoExtentCents ?? null,
      rangeWidth: range === null ? null : range.highMidi - range.lowMidi,
    },
  };
}

/** The points of the takes that count, oldest first. */
export function takePoints(takes: readonly ProgressTake[]): TakePoint[] {
  const points: TakePoint[] = [];
  for (const take of takes) {
    const point = takePoint(take);
    if (point !== null) points.push(point);
  }
  return points.sort((a, b) => a.at - b.at);
}

/** A local calendar day as a whole number, steady across clock changes. */
export function localDayNumber(ms: number): number {
  const d = new Date(ms);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** The median of numbers; null for none. */
export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** One value of a series. */
export interface SeriesPoint {
  id: string;
  at: number;
  value: number;
}

/** What the trend says; 'short' is takes on too few days to show a slope. */
export type TrendKind = 'not-enough' | 'short' | 'up' | 'down' | 'flat';

/** The direction of a series over time. */
export interface Trend {
  kind: TrendKind;
  /** Theil-Sen slope in the measure's unit per week; null unless computed. */
  slopePerWeek: number | null;
  /** Points it was computed from. */
  points: number;
}

/**
 * The Theil-Sen slope per week over one median value per local day: takes
 * minutes apart in one session are one day's point, so they cannot make a
 * wild slope. Null under three distinct days.
 */
export function theilSenPerWeek(points: readonly SeriesPoint[]): number | null {
  const byDay = new Map<number, number[]>();
  for (const p of points) {
    const d = localDayNumber(p.at);
    const list = byDay.get(d);
    if (list === undefined) byDay.set(d, [p.value]);
    else list.push(p.value);
  }
  if (byDay.size < MIN_TREND_DAYS) return null;
  const daily = [...byDay.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([d, values]) => ({ d, v: medianOf(values) ?? 0 }));
  const slopes: number[] = [];
  for (let i = 0; i < daily.length; i++) {
    for (let j = i + 1; j < daily.length; j++) {
      slopes.push(((daily[j].v - daily[i].v) / (daily[j].d - daily[i].d)) * WEEK_DAYS);
    }
  }
  return medianOf(slopes);
}

/**
 * The trend of a series. Under three takes there is none to call; under
 * three different days the slope per week would extrapolate noise, so it says
 * so. `flatBelow` is the slope per week that counts as flat.
 */
export function trendOf(points: readonly SeriesPoint[], flatBelow: number): Trend {
  if (points.length < MIN_TREND_POINTS) return { kind: 'not-enough', slopePerWeek: null, points: points.length };
  const slope = theilSenPerWeek(points);
  if (slope === null) return { kind: 'short', slopePerWeek: null, points: points.length };
  const kind: TrendKind = Math.abs(slope) < flatBelow ? 'flat' : slope > 0 ? 'up' : 'down';
  return { kind, slopePerWeek: slope, points: points.length };
}

/** How a measure's values are judged: higher, lower, nearer zero, or not at all. */
export type Target = 'high' | 'low' | 'zero' | 'none';

/** One measure's series for one group of takes. */
export interface Series {
  measure: MeasureId;
  /** The style the series is limited to; null for a measure that mixes them. */
  style: ProgressStyle | null;
  /** The reference the series is limited to; null for a measure that mixes them. */
  reference: VoiceReference | null;
  points: SeriesPoint[];
  /** The best value by the measure's target; null for a neutral measure. */
  best: number | null;
  latest: number;
  /** Median over the first week; null when no take had the measure then. */
  baseline: number | null;
  /** Latest minus baseline; null while the latest is itself in the first week. */
  change: number | null;
  trend: Trend;
}

/** The best of the values by a target; null for 'none' or no values. */
export function bestOf(values: readonly number[], target: Target): number | null {
  if (values.length === 0 || target === 'none') return null;
  if (target === 'high') return Math.max(...values);
  if (target === 'low') return Math.min(...values);
  return values.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a));
}

/**
 * The series of one measure over `points` (oldest first). The first week is
 * the local calendar day of the group's first take and the six after it, so
 * a measure that turns up late does not move it. Null when no point has the
 * measure.
 */
export function buildSeries(
  points: readonly TakePoint[],
  measure: MeasureId,
  style: ProgressStyle | null,
  target: Target,
  flatBelow: number,
  reference: VoiceReference | null = null,
): Series | null {
  if (points.length === 0) return null;
  const firstDay = localDayNumber(points[0].at);
  const kept: SeriesPoint[] = [];
  const week: number[] = [];
  let latestInWeek = false;
  for (const p of points) {
    if (style !== null && p.style !== style) continue;
    if (reference !== null && p.reference !== reference) continue;
    const value = p.values[measure];
    if (value === null) continue;
    kept.push({ id: p.id, at: p.at, value });
    const inWeek = localDayNumber(p.at) < firstDay + BASELINE_DAYS;
    if (inWeek) week.push(value);
    latestInWeek = inWeek;
  }
  if (kept.length === 0) return null;
  const baseline = medianOf(week);
  const latest = kept[kept.length - 1].value;
  return {
    measure,
    style,
    reference,
    points: kept,
    best: bestOf(
      kept.map((k) => k.value),
      target,
    ),
    latest,
    baseline,
    change: baseline === null || latestInWeek ? null : latest - baseline,
    trend: trendOf(kept, flatBelow),
  };
}

/** The songs among the points, most recently sung first. */
export function songsOf(points: readonly TakePoint[]): Array<{ hash: string; name: string; takes: number }> {
  const seen = new Map<string, { hash: string; name: string; takes: number; last: number }>();
  for (const p of points) {
    const entry = seen.get(p.songHash) ?? { hash: p.songHash, name: p.songName, takes: 0, last: 0 };
    entry.takes++;
    if (p.at >= entry.last) {
      entry.last = p.at;
      entry.name = p.songName;
    }
    seen.set(p.songHash, entry);
  }
  return [...seen.values()].sort((a, b) => b.last - a.last).map(({ hash, name, takes }) => ({ hash, name, takes }));
}

/** The points of one song, or all of them when `songHash` is null. */
export function pointsFor(points: readonly TakePoint[], songHash: string | null): TakePoint[] {
  return songHash === null ? [...points] : points.filter((p) => p.songHash === songHash);
}
