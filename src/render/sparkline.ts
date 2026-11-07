/**
 * The sparkline path builder: a series of values as the points and the line
 * of a small inline SVG, with no chart library. Even spacing in x (one step
 * per take), the y range padded so a flat series sits mid-height, and the
 * last point drawn larger. Pure; the markup it returns holds only numbers it
 * computed and a label with markup characters stripped, so it is safe to set
 * as HTML. Checked in test/sparkline.test.ts.
 */

/** A point in the drawing's pixels. */
export interface SparkPoint {
  x: number;
  y: number;
}

/** Where each value lands in a width by height box with `pad` around it. */
export function sparklinePoints(values: readonly number[], width: number, height: number, pad = 3): SparkPoint[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  return values.map((v, i) => ({
    x: values.length === 1 ? width / 2 : pad + (i / (values.length - 1)) * innerW,
    // Higher values sit higher; a flat series is drawn at mid-height.
    y: span === 0 ? height / 2 : pad + (1 - (v - lo) / span) * innerH,
  }));
}

/** The SVG path (M and L commands, two decimals) through the points. */
export function sparklinePath(points: readonly SparkPoint[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
}

/** The sparkline as SVG markup: a line, a dot per take, the latest larger. */
export function sparklineSvg(values: readonly number[], width = 120, height = 32, label = ''): string {
  const points = sparklinePoints(values, width, height);
  const dots = points
    .map((p, i) => {
      const r = i === points.length - 1 ? 3 : 1.6;
      return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${r}" fill="currentColor"/>`;
    })
    .join('');
  const line =
    points.length > 1
      ? `<path d="${sparklinePath(points)}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`
      : '';
  const safe = label.replace(/[^\w .,:%+-]/g, '');
  return (
    `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" ` +
    `role="img" aria-label="${safe}">${line}${dots}</svg>`
  );
}
