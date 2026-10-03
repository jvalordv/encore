/**
 * The pitch lane canvas. Owns the <canvas>, keeps its bitmap matched to its
 * container (ResizeObserver plus devicePixelRatio) and draws the lane
 * furniture: background, semitone and octave grid, and a piano-key gutter.
 * All colours come from the active skin's tokens, re-read when the skin
 * changes. This is the placeholder renderer; the live f0 ribbon, playhead and
 * reference contour arrive with ROADMAP P1-T5.
 */
import { SKIN_EVENT } from '../skins';
import type { SkinToken } from '../skins';

/** Lowest MIDI note shown (C2). */
const DEFAULT_LOW_MIDI = 36;
/** Highest MIDI note shown (C6). */
const DEFAULT_HIGH_MIDI = 84;
/** Width of the piano-key gutter in CSS pixels. */
const GUTTER_WIDTH = 56;
/** Black keys cover this share of the gutter, like a piano roll. */
const BLACK_KEY_SHARE = 0.6;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);

/** Skin colours and fonts the lane draws with, resolved to plain strings. */
interface LaneStyle {
  background: string;
  grid: string;
  whiteKey: string;
  blackKey: string;
  caption: string;
  captionFont: string;
  labelFont: string;
}

/** Visible MIDI range, inclusive at both ends. */
export interface LaneOptions {
  lowMidi?: number;
  highMidi?: number;
}

/** Pitch class (0 = C) of a MIDI note, correct for negative numbers. */
function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** True when the MIDI note is a black piano key. */
export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.has(pitchClass(midi));
}

/** Scientific pitch name of a MIDI note, e.g. 60 is "C4". */
export function noteName(midi: number): string {
  return `${NOTE_NAMES[pitchClass(midi)]}${Math.floor(Math.round(midi) / 12) - 1}`;
}

/**
 * Vertical centre of a MIDI note's row. The range is split into equal
 * semitone rows, highest note at the top, so `midi` may be fractional and
 * lands between rows.
 */
export function midiToY(midi: number, lowMidi: number, highMidi: number, height: number): number {
  const rowHeight = height / (highMidi - lowMidi + 1);
  return height - (midi - lowMidi + 0.5) * rowHeight;
}

/** Perceived brightness (0 to 1) of a hex or rgb() colour; 0 if unparsed. */
function brightness(color: string): number {
  let channels: number[] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1];
    channels = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
  } else {
    const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
    if (rgb) channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  if (!channels) return 0;
  return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
}

/** Reads the lane's colours and fonts from the active skin's tokens. */
function readLaneStyle(): LaneStyle {
  const computed = getComputedStyle(document.documentElement);
  const token = (name: SkinToken): string => computed.getPropertyValue(name).trim();
  const text = token('--color-text');
  const surface = token('--color-surface');
  // The paler of text and surface is the white key, so a dark skin gets pale
  // keys and a light skin keeps pale keys with dark ones on top.
  const textIsPaler = brightness(text) >= brightness(surface);
  return {
    background: token('--lane-bg'),
    grid: token('--lane-grid'),
    whiteKey: textIsPaler ? text : surface,
    blackKey: textIsPaler ? surface : text,
    caption: token('--color-text-muted'),
    captionFont: token('--font-display'),
    labelFont: token('--font-mono'),
  };
}

/** Canvas renderer for the pitch lane. Call `destroy` to release listeners. */
export class PitchLane {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private readonly lowMidi: number;
  private readonly highMidi: number;
  private style: LaneStyle;
  private width = 0;
  private height = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly container: HTMLElement,
    options: LaneOptions = {},
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
    this.lowMidi = options.lowMidi ?? DEFAULT_LOW_MIDI;
    this.highMidi = options.highMidi ?? DEFAULT_HIGH_MIDI;
    this.style = readLaneStyle();

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    window.addEventListener(SKIN_EVENT, this.onSkin);
    // Display fonts load lazily, after the first draw; repaint once they land.
    document.fonts.addEventListener('loadingdone', this.onFonts);
    this.resize();
  }

  /** Matches the bitmap to the container's size and pixel ratio, then draws. */
  resize(): void {
    const ratio = window.devicePixelRatio || 1;
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    const bitmapWidth = Math.max(1, Math.round(this.width * ratio));
    const bitmapHeight = Math.max(1, Math.round(this.height * ratio));
    // Assigning a size clears the canvas, so only do it when it changed.
    if (this.canvas.width !== bitmapWidth) this.canvas.width = bitmapWidth;
    if (this.canvas.height !== bitmapHeight) this.canvas.height = bitmapHeight;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.draw();
  }

  /** Repaints the lane from the cached skin style. */
  draw(): void {
    const { ctx, width, height, style } = this;
    if (width === 0 || height === 0) return;
    const rows = this.highMidi - this.lowMidi + 1;
    const rowHeight = height / rows;
    const gutter = Math.min(GUTTER_WIDTH, width / 3);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = style.background;
    ctx.fillRect(0, 0, width, height);

    for (let midi = this.lowMidi; midi <= this.highMidi; midi++) {
      const top = midiToY(midi, this.lowMidi, this.highMidi, height) - rowHeight / 2;
      const black = isBlackKey(midi);

      // Lane rows: black-key rows are tinted so notes read like a piano roll.
      if (black) {
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = style.grid;
        ctx.fillRect(gutter, top, width - gutter, rowHeight);
        ctx.globalAlpha = 1;
      }

      // A short black key over a full-width white one is how a piano roll
      // reads at a glance, so the gutter doubles as the pitch legend.
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = style.whiteKey;
      ctx.fillRect(0, top, gutter, rowHeight);
      if (black) {
        ctx.fillStyle = style.blackKey;
        ctx.fillRect(0, top, gutter * BLACK_KEY_SHARE, rowHeight);
      }
      ctx.globalAlpha = 1;

      // Only the C lines are strong, so 49 rows stay readable.
      const octaveLine = pitchClass(midi) === 0;
      ctx.strokeStyle = style.grid;
      ctx.lineWidth = octaveLine ? 1.5 : 1;
      ctx.globalAlpha = octaveLine ? 1 : 0.35;
      const lineY = Math.round(top + rowHeight) + 0.5;
      ctx.beginPath();
      ctx.moveTo(octaveLine ? 0 : gutter, lineY);
      ctx.lineTo(width, lineY);
      ctx.stroke();
      ctx.globalAlpha = 1;

      if (octaveLine && rowHeight >= 5) {
        ctx.fillStyle = style.blackKey;
        ctx.font = `600 10px ${style.labelFont}`;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(noteName(midi), gutter - 5, top + rowHeight / 2);
      }
    }

    ctx.strokeStyle = style.grid;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(gutter + 0.5, 0);
    ctx.lineTo(gutter + 0.5, height);
    ctx.stroke();

    if (height >= 120 && width >= 240) {
      ctx.fillStyle = style.caption;
      ctx.font = `700 18px ${style.captionFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('pitch lane', gutter + (width - gutter) / 2, height / 2);
    }
  }

  /** Stops observing and removes every listener the lane added. */
  destroy(): void {
    this.observer.disconnect();
    window.removeEventListener(SKIN_EVENT, this.onSkin);
    document.fonts.removeEventListener('loadingdone', this.onFonts);
  }

  private readonly onSkin = (): void => {
    this.style = readLaneStyle();
    this.draw();
  };

  private readonly onFonts = (): void => this.draw();
}
