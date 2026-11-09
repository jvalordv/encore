/**
 * The song panel's size, apart from the page: how wide the left panel may be,
 * when dragging it narrower folds it into the slim icon rail, what the arrow
 * keys on its drag handle do, and how the remembered layout is read back. All
 * pure, so the numbers are tested in test/panel-layout.test.ts;
 * src/app/panels/left-panel.ts only wires them to the DOM and to storage.
 */

/** Narrowest expanded panel. Also the width the old narrow layout used, so the
 * 780 px stacking breakpoint in style.css still leaves room for the player. */
export const MIN_WIDTH = 220;

/** Width of the panel when the person has not chosen one, and in narrow windows. */
export const DEFAULT_WIDTH = 280;
export const NARROW_DEFAULT_WIDTH = 220;
const NARROW_WINDOW = 900;

/** Width of the collapsed icon rail. */
export const RAIL_WIDTH = 52;

/** Dragging the panel narrower than this folds it into the rail. */
export const COLLAPSE_BELOW = 160;

/** The widest the panel may be, as a share of the window. */
export const MAX_SHARE = 0.5;

/** What the arrow keys move the edge by, and what Shift adds. */
export const KEY_STEP = 16;
export const KEY_STEP_BIG = 48;

/** Page padding and the gap between panel and stage, as laid out in style.css. */
const PAGE_CHROME = 24 + 12;

/** The least width the stage keeps beside the panel: a 480 px YouTube player,
 * its frame and a page scrollbar (see the 780 px note in style.css). */
const STAGE_RESERVE = 520;

/** Below this window width the panel stacks above the stage and has no handle. */
export const PHONE_MAX_WIDTH = 780;

/** What is remembered: the chosen width (null = the default) and whether it is folded. */
export interface PanelLayout {
  width: number | null;
  collapsed: boolean;
}

/** What a fresh visit, and Reset all, gives. */
export const DEFAULT_LAYOUT: PanelLayout = { width: null, collapsed: false };

/** The width used when none was chosen. */
export function defaultWidth(windowWidth: number): number {
  return windowWidth <= NARROW_WINDOW ? NARROW_DEFAULT_WIDTH : DEFAULT_WIDTH;
}

/**
 * The widest the panel may be in a window: half of it, but never so wide that
 * the stage beside it falls under the player's width; never below the minimum.
 */
export function maxWidth(windowWidth: number): number {
  const byShare = Math.floor(windowWidth * MAX_SHARE);
  const byStage = windowWidth - PAGE_CHROME - STAGE_RESERVE;
  return Math.max(MIN_WIDTH, Math.min(byShare, byStage));
}

/** `width` held between the minimum and the maximum for this window. */
export function clampWidth(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return defaultWidth(windowWidth);
  return Math.round(Math.max(MIN_WIDTH, Math.min(width, maxWidth(windowWidth))));
}

/** The width the panel really has: the rail when folded, else the chosen or default width. */
export function effectiveWidth(layout: PanelLayout, windowWidth: number): number {
  if (layout.collapsed) return RAIL_WIDTH;
  return clampWidth(layout.width ?? defaultWidth(windowWidth), windowWidth);
}

/** The outcome of dragging the edge to a raw width. */
export type DragResult = { kind: 'width'; width: number } | { kind: 'collapse' };

/** Dragging to `raw` pixels: a width in range, or the rail once it is narrower than the threshold. */
export function resolveDrag(raw: number, windowWidth: number): DragResult {
  if (raw < COLLAPSE_BELOW) return { kind: 'collapse' };
  return { kind: 'width', width: clampWidth(raw, windowWidth) };
}

/** What a key on the handle asks for; null when the key means nothing there. */
export type KeyResult = { kind: 'width'; width: number } | { kind: 'toggle' } | null;

/**
 * The handle's keyboard: Left and Right move the edge by a step (Shift for a
 * bigger one), Home and End go to the narrowest and widest, Enter folds or
 * unfolds. `current` is the width now showing.
 */
export function keyResult(key: string, shift: boolean, current: number, windowWidth: number): KeyResult {
  const step = shift ? KEY_STEP_BIG : KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'width', width: clampWidth(current - step, windowWidth) };
    case 'ArrowRight':
      return { kind: 'width', width: clampWidth(current + step, windowWidth) };
    case 'Home':
      return { kind: 'width', width: MIN_WIDTH };
    case 'End':
      return { kind: 'width', width: maxWidth(windowWidth) };
    case 'Enter':
      return { kind: 'toggle' };
    default:
      return null;
  }
}

/** The remembered layout from its stored text; anything unusable reads as the default. */
export function parseLayout(raw: string | null): PanelLayout {
  if (raw === null) return { ...DEFAULT_LAYOUT };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_LAYOUT };
  const { width, collapsed } = value as Record<string, unknown>;
  const usable = typeof width === 'number' && Number.isFinite(width) && width >= MIN_WIDTH && width <= 4000;
  return {
    width: usable ? Math.round(width) : null,
    collapsed: collapsed === true,
  };
}

/** The layout as the text kept in storage. */
export function serializeLayout(layout: PanelLayout): string {
  return JSON.stringify({ width: layout.width, collapsed: layout.collapsed });
}

/** The panel sections the rail offers, in panel order. */
export interface RailSection {
  /** Id of the element the icon scrolls to. */
  target: string;
  /** What the icon is called, for screen readers and hover. */
  label: string;
  /** The one or two characters drawn on the icon. */
  glyph: string;
}

export const RAIL_SECTIONS: readonly RailSection[] = [
  { target: 'search', label: 'Find a song', glyph: 'F' },
  { target: 'dropzone', label: 'Add a song', glyph: '+' },
  { target: 'song-reference', label: 'Song reference', glyph: 'R' },
  { target: 'karaoke', label: 'Karaoke track', glyph: 'K' },
  { target: 'lyrics', label: 'Lyrics', glyph: 'L' },
  { target: 'report', label: 'Learning mode', glyph: 'Le' },
  { target: 'devices', label: 'Devices', glyph: 'D' },
  { target: 'singers', label: 'Singers', glyph: 'S' },
  { target: 'timing', label: 'Latency', glyph: 'Ms' },
  { target: 'mic-check', label: 'Mic check', glyph: 'M' },
  { target: 'takes', label: 'Takes', glyph: 'T' },
];

/** The open info note after `pressed` is activated: the same one closes, another replaces it. */
export function nextInfoOpen(open: string | null, pressed: string): string | null {
  return open === pressed ? null : pressed;
}
