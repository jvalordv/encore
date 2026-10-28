/**
 * The pitch lane's grid layer: the background, the semitone rows (black-key
 * rows tinted like a piano roll), the octave lines and the piano-key gutter
 * that doubles as the pitch legend. It never moves between frames, so the
 * lane paints it once into an offscreen canvas and blits that.
 */
import { gutterWidth, isBlackKey, midiToY, noteName, pitchClass } from './lane-geometry';
import type { LaneView } from './lane-geometry';
import type { LaneStyle } from './lane-style';

/** Black keys cover this share of the gutter, like a piano roll. */
const BLACK_KEY_SHARE = 0.6;

/** Background, grid and piano-key gutter. */
export function drawGrid(ctx: CanvasRenderingContext2D, view: LaneView, style: LaneStyle): void {
  const { width, height, midiLow, midiHigh } = view;
  const rows = midiHigh - midiLow + 1;
  const rowHeight = height / rows;
  const gutter = gutterWidth(width);

  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);

  for (let midi = midiLow; midi <= midiHigh; midi++) {
    const top = midiToY(midi, midiLow, midiHigh, height) - rowHeight / 2;
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
}
