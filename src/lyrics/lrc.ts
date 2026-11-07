/**
 * Reads lyrics into timed lines. An LRC file puts `[mm:ss.xx]` stamps before
 * each line (several stamps may share one line, for a chorus), may carry an
 * `[offset:+ms]` tag that shifts every stamp, and holds other `[ar:...]`
 * style tags that are metadata, not lyrics. Plain text has no stamps and is
 * only shown, never followed. Everything here is pure; src/lyrics/controller.ts
 * decides which text to read and the panel decides what to draw. A line with a
 * stamp and no words is a break (an instrumental gap) and is kept so the
 * previous line stops showing when it begins.
 */

/** One lyric line: when it starts in song time, and its words ('' = a break). */
export interface LyricLine {
  t: number;
  text: string;
}

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const LEADING_STAMPS = /^(?:\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/;
const OFFSET_TAG = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/im;

/** Seconds a stamp's minutes, seconds and fraction digits stand for. */
function stampSeconds(min: string, sec: string, frac: string | undefined): number {
  const fraction = frac === undefined ? 0 : Number(`0.${frac}`);
  return Number(min) * 60 + Number(sec) + fraction;
}

/** True when the text carries at least one `[mm:ss.xx]` stamp. */
export function hasStamps(text: string): boolean {
  return /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text);
}

/**
 * The timed lines of an LRC text, sorted by time. The offset tag is applied
 * (a positive offset makes lines come sooner, as players read it); stamps
 * that would land before zero are held at zero.
 */
export function parseLrc(text: string): LyricLine[] {
  const offsetMatch = OFFSET_TAG.exec(text);
  const offsetS = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
  const lines: LyricLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const lead = LEADING_STAMPS.exec(raw);
    if (!lead) continue;
    const words = raw.slice(lead[0].length).trim();
    for (const m of lead[0].matchAll(STAMP)) {
      lines.push({ t: Math.max(0, stampSeconds(m[1], m[2], m[3]) - offsetS), text: words });
    }
  }
  // A stable sort keeps two lines with one stamp in the order they were read.
  return lines.sort((a, b) => a.t - b.t);
}

/** The lines of plain text: trimmed, blank lines kept once as paragraph breaks. */
export function parsePlain(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

/** Index of the last line starting at or before `t`; -1 before the first. */
export function lineIndexAt(lines: readonly LyricLine[], t: number): number {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** What the lane shows at a moment: the line being sung and the one after. */
export interface LyricView {
  current: string;
  next: string;
}

/** The current line ('' in a break or before the first) and the next words. */
export function viewAt(lines: readonly LyricLine[], t: number): LyricView {
  const i = lineIndexAt(lines, t);
  const current = i >= 0 ? lines[i].text : '';
  let next = '';
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].text !== '') {
      next = lines[j].text;
      break;
    }
  }
  return { current, next };
}
