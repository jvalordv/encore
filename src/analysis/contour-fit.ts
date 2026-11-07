/**
 * The shape of one held note's pitch contour, by least squares: a straight
 * line (drift) plus, where there is one, a sinusoid at a vibrato rate. The
 * line and the sinusoid are fitted together so that a vibrato cut at a partial
 * cycle does not leak into the slope and a slope does not read as vibrato.
 * From the fit come the drift in cents per second, the steadiness (the spread
 * left once the line and any vibrato are taken out, so a singer's vibrato is
 * never called a wobble) and the vibrato itself (rate, extent, regularity).
 * Vibrato is called only for a 4 to 8 Hz oscillation of at least 25 cents that
 * explains half of the contour's variance over two full cycles and whose rate
 * stands out from every rate 1 Hz or more away, so a wander that fits no one
 * rate in particular is not taken for vibrato; tracker noise on a steady note
 * is far under all of these. Pure, no DOM; checked on
 * synthetic contours in test/contour-fit.test.ts.
 */

/** The vibrato band, in Hz. */
export const VIBRATO_MIN_HZ = 4;
export const VIBRATO_MAX_HZ = 8;
/** An oscillation under this amplitude, in cents, is tracker jitter. */
export const VIBRATO_MIN_EXTENT_CENTS = 25;
/** The share of the detrended variance the oscillation must explain. */
export const VIBRATO_MIN_REGULARITY = 0.5;
/**
 * The best rate must explain this much more of the variance than the best rate
 * at least 1 Hz away: a real vibrato is a peak, a wander is a plateau.
 */
export const VIBRATO_MIN_PEAK_MARGIN = 0.1;
/** Full cycles of the vibrato the contour must hold to call it. */
export const VIBRATO_MIN_CYCLES = 2;
/** Fewest frames (100 ms of the tracker's grid) a contour needs to be fitted. */
export const MIN_CONTOUR_FRAMES = 10;
/** The rates tried, wider than the band so an edge peak can be rejected. */
const SCAN_FROM_HZ = 3;
const SCAN_TO_HZ = 9;
const SCAN_STEP_HZ = 0.1;

/** A vibrato found in a note. */
export interface Vibrato {
  rateHz: number;
  /** Amplitude (peak from centre) in cents. */
  extentCents: number;
  /** 0..1: the share of the note's variance the steady oscillation explains. */
  regularity: number;
}

/** What a contour is made of. */
export interface ContourMeasure {
  /** Slope of the line, cents per second. */
  driftCps: number;
  /** Spread in cents left after the line (and the vibrato, if any). */
  stdCents: number;
  vibrato: Vibrato | null;
}

interface Fit {
  slope: number;
  sse: number;
  sine: number;
  cosine: number;
}

/** Solves the normal equations A x = b by Gaussian elimination; null if singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const k = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= k * m[col][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];
    for (let c = r + 1; c < n; c++) sum -= m[r][c] * x[c];
    x[r] = sum / m[r][r];
  }
  return x;
}

/** Fits level + line (+ sinusoid at `hz`) to `ys` over `ts`, which are centred. */
function fit(ts: readonly number[], ys: readonly number[], hz: number | null): Fit | null {
  const width = hz === null ? 2 : 4;
  const rows = ts.map((t) => {
    const row = [1, t];
    if (hz !== null) row.push(Math.sin(2 * Math.PI * hz * t), Math.cos(2 * Math.PI * hz * t));
    return row;
  });
  const ata = Array.from({ length: width }, () => new Array<number>(width).fill(0));
  const aty = new Array<number>(width).fill(0);
  rows.forEach((row, i) => {
    for (let r = 0; r < width; r++) {
      aty[r] += row[r] * ys[i];
      for (let c = 0; c < width; c++) ata[r][c] += row[r] * row[c];
    }
  });
  const x = solve(ata, aty);
  if (x === null) return null;
  let sse = 0;
  rows.forEach((row, i) => {
    let predicted = 0;
    for (let r = 0; r < width; r++) predicted += row[r] * x[r];
    sse += (ys[i] - predicted) ** 2;
  });
  return { slope: x[1], sse, sine: width === 4 ? x[2] : 0, cosine: width === 4 ? x[3] : 0 };
}

/**
 * Measures one contour: `ts` in seconds, `ys` in cents. Null when there are too
 * few frames or the fit is degenerate.
 */
export function measureContour(ts: readonly number[], ys: readonly number[]): ContourMeasure | null {
  const n = ts.length;
  if (n < MIN_CONTOUR_FRAMES || ys.length !== n) return null;
  const mid = (ts[0] + ts[n - 1]) / 2;
  const centred = ts.map((t) => t - mid);
  const line = fit(centred, ys, null);
  if (line === null) return null;
  let best: { hz: number; fit: Fit } | null = null;
  const scan: Array<{ hz: number; sse: number }> = [];
  for (let hz = SCAN_FROM_HZ; hz <= SCAN_TO_HZ + 1e-9; hz += SCAN_STEP_HZ) {
    const f = fit(centred, ys, hz);
    if (f === null) continue;
    scan.push({ hz, sse: f.sse });
    if (best === null || f.sse < best.fit.sse) best = { hz, fit: f };
  }
  if (best !== null && line.sse > 1e-9) {
    const extent = Math.hypot(best.fit.sine, best.fit.cosine);
    const regularity = (line.sse - best.fit.sse) / line.sse;
    const span = ts[n - 1] - ts[0];
    const rival = Math.min(
      ...scan.filter((r) => Math.abs(r.hz - (best?.hz ?? 0)) >= 1 - 1e-9).map((r) => r.sse),
    );
    const peaked = (rival - best.fit.sse) / line.sse >= VIBRATO_MIN_PEAK_MARGIN;
    const found =
      best.hz >= VIBRATO_MIN_HZ - 1e-9 &&
      best.hz <= VIBRATO_MAX_HZ + 1e-9 &&
      extent >= VIBRATO_MIN_EXTENT_CENTS &&
      regularity >= VIBRATO_MIN_REGULARITY &&
      span * best.hz >= VIBRATO_MIN_CYCLES &&
      peaked;
    if (found) {
      return {
        driftCps: best.fit.slope,
        stdCents: Math.sqrt(best.fit.sse / n),
        vibrato: { rateHz: best.hz, extentCents: extent, regularity },
      };
    }
  }
  return { driftCps: line.slope, stdCents: Math.sqrt(line.sse / n), vibrato: null };
}
