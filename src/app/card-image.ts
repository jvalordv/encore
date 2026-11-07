/**
 * Paints a laid-out report card (card-layout.ts) into a canvas and turns it
 * into a PNG blob. Hand-drawn from the layout, with the colours of the active
 * skin's tokens read from the page; no screenshot library. The one canvas
 * touch of saving a card; where no 2d canvas exists (a test run in Node) it
 * resolves with null.
 */
import type { CardColor, CardContent, CardLayout, Measure } from './card-layout';
import { layoutCard } from './card-layout';

/** The CSS token each colour role is read from, with a fallback. */
const TOKENS: Record<CardColor | 'background' | 'surface', [string, string]> = {
  background: ['--color-bg', '#ffffff'],
  surface: ['--color-surface-2', '#f2f2f2'],
  text: ['--color-text', '#111111'],
  muted: ['--color-text-muted', '#555555'],
  accent: ['--color-accent', '#0b57d0'],
  hit: ['--color-hit', '#1a7f37'],
};

/** Reads every colour role from the document's computed tokens. */
export function cardColors(doc: Document): Record<keyof typeof TOKENS, string> {
  const view = doc.defaultView;
  const style = view ? view.getComputedStyle(doc.documentElement) : null;
  const out = {} as Record<keyof typeof TOKENS, string>;
  for (const [role, [token, fallback]] of Object.entries(TOKENS) as Array<[keyof typeof TOKENS, [string, string]]>) {
    out[role] = style?.getPropertyValue(token).trim() || fallback;
  }
  return out;
}

/** Draws `layout` onto `ctx` in `colors` and `family`. */
export function paintCard(
  ctx: CanvasRenderingContext2D,
  layout: CardLayout,
  colors: Record<keyof typeof TOKENS, string>,
  family: string,
): void {
  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, layout.width, layout.height);
  ctx.fillStyle = colors.surface;
  ctx.fillRect(16, 16, layout.width - 32, layout.height - 32);
  ctx.fillStyle = colors.accent;
  ctx.fillRect(16, 16, 8, layout.height - 32);
  ctx.textBaseline = 'alphabetic';
  for (const item of layout.items) {
    ctx.font = `${item.bold ? 'bold ' : ''}${item.size}px ${family}`;
    ctx.fillStyle = colors[item.color];
    ctx.fillText(item.text, item.x, item.y);
  }
}

/** What the panel says when the card could not be drawn. */
export const CARD_FAILED = 'Could not draw the card in this browser.';

/** Runs `render`; null both when it has no canvas and when it throws or rejects. */
export async function drawCard(
  render: (doc: Document, content: CardContent) => Promise<Blob | null>,
  doc: Document,
  content: CardContent,
): Promise<Blob | null> {
  try {
    return await render(doc, content);
  } catch {
    return null;
  }
}

/** Renders the card to a PNG; null when canvas drawing is not available. */
export async function renderCardPng(doc: Document, content: CardContent): Promise<Blob | null> {
  const canvas = doc.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  const family = doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue('--font-body').trim() || 'sans-serif';
  const measure: Measure = (text, size, bold) => {
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${family}`;
    return ctx.measureText(text).width;
  };
  const layout = layoutCard(content, measure);
  canvas.width = layout.width;
  canvas.height = layout.height;
  paintCard(ctx, layout, cardColors(doc), family);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}
