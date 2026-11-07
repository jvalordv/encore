/**
 * The pitch lane's turns layer: a strip along the top of the lane with one
 * block per stretch of the song, in the colour and name of whoever sings it
 * (a stretch for both is split into two halves), and the hit test for the
 * click that cycles a stretch through A, B and both. The strip only says whose
 * turn it is; it grades nothing, so karaoke mode shows it too.
 */
import { phraseAtX, timeAtX } from './lane-free';
import { viewX } from './lane-geometry';
import type { LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** One stretch the strip draws: its span and who sings it. */
export interface LaneTurn {
  startS: number;
  endS: number;
  who: 'a' | 'b' | 'both';
}

/** The strip's names and colours (null colours fall back to the skin's). */
export interface TurnLook {
  names: [string, string];
  colours: [string | null, string | null];
}

/** Height of the strip in CSS pixels. */
export const TURN_STRIP_PX = 16;

/** The stretch under pixel column `x`, or null in a gap or off the lane. */
export function turnAtX(view: LaneView, x: number, gutter: number, turns: readonly LaneTurn[]): LaneTurn | null {
  const t = timeAtX(view, x, gutter);
  if (t === null) return null;
  return turns.find((turn) => t >= turn.startS && t <= turn.endS) ?? null;
}

/** What a click on the lane asks for: a turn cycled or a phrase marked free. */
export type LaneClick = { kind: 'turn'; startS: number } | { kind: 'phrase'; span: [number, number] } | null;

/** Routes a click at column `x`: plain cycles the turn, Shift marks the phrase free. */
export function routeLaneClick(
  view: LaneView,
  x: number,
  gutter: number,
  shift: boolean,
  turns: readonly LaneTurn[],
  phrases: Parameters<typeof phraseAtX>[3],
): LaneClick {
  if (!shift) {
    const turn = turnAtX(view, x, gutter, turns);
    return turn === null ? null : { kind: 'turn', startS: turn.startS };
  }
  const phrase = phraseAtX(view, x, gutter, phrases);
  return phrase === null ? null : { kind: 'phrase', span: [phrase.startS, phrase.endS] };
}

/** The colour of a singer: the one the singers chose, else the skin's. */
export function singerColour(style: LaneStyle, look: TurnLook | null, singer: 0 | 1): string {
  return look?.colours[singer] ?? style.singers[singer];
}

/** Paints the strip; nothing without turns. */
export function drawTurns(
  ctx: CanvasRenderingContext2D,
  view: LaneView,
  style: LaneStyle,
  turns: readonly LaneTurn[],
  look: TurnLook | null,
  gutter: number,
): void {
  if (turns.length === 0 || look === null) return;
  ctx.font = `700 11px ${style.labelFont}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const turn of turns) {
    const x0 = Math.max(gutter, viewX(view, turn.startS, gutter));
    const x1 = Math.min(view.width, viewX(view, turn.endS, gutter));
    if (x1 <= x0) continue;
    const halves: Array<0 | 1> = turn.who === 'both' ? [0, 1] : [turn.who === 'a' ? 0 : 1];
    const h = TURN_STRIP_PX / halves.length;
    halves.forEach((singer, i) => {
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = singerColour(style, look, singer);
      ctx.fillRect(x0, i * h, x1 - x0 - 1, h);
      ctx.globalAlpha = 1;
    });
    // The name only where the block is wide enough to hold it.
    if (x1 - x0 > 60) {
      ctx.fillStyle = style.background;
      const label = turn.who === 'both' ? `${look.names[0]} + ${look.names[1]}` : look.names[turn.who === 'a' ? 0 : 1];
      ctx.fillText(label, x0 + 4, TURN_STRIP_PX / 2, x1 - x0 - 8);
    }
  }
}
