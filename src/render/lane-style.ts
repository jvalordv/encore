/**
 * The pitch lane's colours and fonts: the shape the layers draw with and the
 * reader that resolves it from the active skin's CSS tokens. Re-read on the
 * `encore:skin` event, so a skin switch recolours the lane without a reload.
 */
import type { SkinToken } from '../skins';

/** Skin colours and fonts the lane draws with, resolved to plain strings. */
export interface LaneStyle {
  background: string;
  grid: string;
  whiteKey: string;
  blackKey: string;
  caption: string;
  captionFont: string;
  labelFont: string;
  reference: string;
  accent: string;
  /** Colours of the three grades, painted over the ribbon in learning mode. */
  hit: string;
  okay: string;
  miss: string;
  singers: [string, string];
  ribbonWidth: number;
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
export function readLaneStyle(): LaneStyle {
  const computed = getComputedStyle(document.documentElement);
  const token = (name: SkinToken): string => computed.getPropertyValue(name).trim();
  const text = token('--color-text');
  const surface = token('--color-surface');
  // The paler of text and surface is the white key, so a dark skin gets pale
  // keys and a light skin keeps pale keys with dark ones on top.
  const textIsPaler = brightness(text) >= brightness(surface);
  const width = parseFloat(token('--lane-ribbon-width'));
  return {
    background: token('--lane-bg'),
    grid: token('--lane-grid'),
    whiteKey: textIsPaler ? text : surface,
    blackKey: textIsPaler ? surface : text,
    caption: token('--color-text-muted'),
    captionFont: token('--font-display'),
    labelFont: token('--font-mono'),
    reference: token('--color-reference'),
    accent: token('--color-accent'),
    hit: token('--color-hit'),
    okay: token('--color-okay'),
    miss: token('--color-miss'),
    singers: [token('--color-singer-a'), token('--color-singer-b')],
    ribbonWidth: Number.isFinite(width) ? Math.min(12, Math.max(1, width)) : 3,
  };
}
