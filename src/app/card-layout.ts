/**
 * The layout of a report card saved as a picture, as pure data: which line of
 * text goes where, in what size and which colour role. Nothing here touches a
 * canvas; `measure` is passed in (the canvas's own `measureText` in the
 * browser, a fixed width per character in tests), so the wrapping and the
 * positions are tested without a page. The painter in card-image.ts maps the
 * colour roles onto the skin's tokens. Learning mode only: it is built from a
 * report card, which karaoke mode never has.
 */

/** Which skin colour a line is drawn in. */
export type CardColor = 'text' | 'muted' | 'accent' | 'hit';

/** The words of a card, as the report panel already has them. */
export interface CardContent {
  /** The skin's report title ("Take report"). */
  title: string;
  songName: string;
  /** Local date as yyyy-mm-dd. */
  date: string;
  /** "2 of 3 stars", or '' when none is to be shown. */
  stars: string;
  /** The personal-best line, or ''. */
  personalBest: string;
  headline: string;
  /** Further lines in order (share on melody, timing, phrases, range ...). */
  lines: string[];
  /** The skin's name, signed at the foot. */
  skinName: string;
}

/** One line of text placed on the card. */
export interface CardItem {
  text: string;
  /** Left edge, and the baseline's y, in pixels. */
  x: number;
  y: number;
  /** Font size in pixels. */
  size: number;
  bold: boolean;
  color: CardColor;
}

/** The finished layout: the canvas size and every line. */
export interface CardLayout {
  width: number;
  height: number;
  items: CardItem[];
}

/** Width in pixels of `text` set at `size` pixels. */
export type Measure = (text: string, size: number, bold: boolean) => number;

/** Card width in pixels; the height follows the content. */
export const CARD_WIDTH = 900;
/** Space around the content. */
export const CARD_MARGIN = 48;
const LINE_GAP = 1.35;

/** Splits one word into pieces no wider than `maxWidth` (one character at least). */
function splitWord(word: string, maxWidth: number, size: number, bold: boolean, measure: Measure): string[] {
  const pieces: string[] = [];
  let piece = '';
  for (const ch of Array.from(word)) {
    if (piece !== '' && measure(piece + ch, size, bold) > maxWidth) {
      pieces.push(piece);
      piece = ch;
    } else {
      piece += ch;
    }
  }
  if (piece !== '') pieces.push(piece);
  return pieces;
}

/** Breaks `text` into lines no wider than `maxWidth`; a word wider than that is split by characters. */
export function wrapText(text: string, maxWidth: number, size: number, bold: boolean, measure: Measure): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const whole of words) {
    const pieces = measure(whole, size, bold) > maxWidth ? splitWord(whole, maxWidth, size, bold, measure) : [whole];
    for (const piece of pieces.slice(0, -1)) {
      if (line !== '') lines.push(line);
      lines.push(piece);
      line = '';
    }
    const word = pieces[pieces.length - 1] ?? whole;
    const next = line === '' ? word : `${line} ${word}`;
    if (line !== '' && measure(next, size, bold) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/** Lays the card out top to bottom, wrapping to the card's width. */
export function layoutCard(content: CardContent, measure: Measure): CardLayout {
  const inner = CARD_WIDTH - 2 * CARD_MARGIN;
  const items: CardItem[] = [];
  let y = CARD_MARGIN;

  const add = (text: string, size: number, bold: boolean, color: CardColor, gapBefore = 0): void => {
    if (text === '') return;
    y += gapBefore;
    for (const line of wrapText(text, inner, size, bold, measure)) {
      y += size * LINE_GAP;
      items.push({ text: line, x: CARD_MARGIN, y: Math.round(y), size, bold, color });
    }
  };

  add(content.title, 20, true, 'accent');
  add(content.songName, 34, true, 'text', 8);
  add(content.date, 18, false, 'muted', 2);
  add(content.stars, 30, true, 'accent', 16);
  add(content.personalBest, 20, true, 'hit', 8);
  add(content.headline, 26, true, 'text', 20);
  content.lines.forEach((line, i) => add(line, 20, false, 'text', i === 0 ? 12 : 6));
  add(content.skinName, 16, false, 'muted', 28);

  return { width: CARD_WIDTH, height: Math.round(y + CARD_MARGIN), items };
}

/** The file name a card is saved under: `<song>-<date>-card.png`. */
export function cardFileName(songName: string, date: string): string {
  const stem = songName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem === '' ? 'song' : stem}-${date}-card.png`;
}

/** A local date as yyyy-mm-dd. */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
