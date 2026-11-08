/**
 * The lane's faint trace: which frames feed it, that a clean take draws no
 * extra stroke, that the faint line is the voice colour at the skin's low
 * opacity and sits under the solid ribbon, and that the skins all define the
 * token behind it. Drawing is checked against a recording canvas, as data.
 */
import { describe, expect, it } from 'vitest';
import type { LaneFrame, LaneView } from '../src/render/lane-geometry';
import type { LaneStyle } from '../src/render/lane-style';
import { drawRibbon, faintTrace } from '../src/render/lane-ribbon';
import { SKIN_TOKENS } from '../src/skins';

const view: LaneView = { width: 600, height: 300, now: 1, windowS: 6, futureS: 1.5, midiLow: 48, midiHigh: 84 };
const style = { singers: ['#00aa55', '#aa0055'], ribbonWidth: 3, faintAlpha: 0.4 } as unknown as LaneStyle;

/** A canvas that records each stroke with the alpha and colour in force. */
function recorder() {
  const strokes: Array<{ alpha: number; colour: string }> = [];
  const ctx = {
    globalAlpha: 1,
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {
      strokes.push({ alpha: this.globalAlpha, colour: this.strokeStyle });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, strokes };
}

const voiced = (t: number): LaneFrame => ({ t, f0: 220, clarity: 0.95 });
const faint = (t: number): LaneFrame => ({ t, f0: 0, clarity: 0.8, faintF0: 220 });
const unvoiced = (t: number): LaneFrame => ({ t, f0: 0, clarity: 0.2 });

describe('faintTrace', () => {
  it('is empty when no frame is faint, so a clean take is drawn as before', () => {
    expect(faintTrace([voiced(0), voiced(0.01), unvoiced(0.02)])).toEqual([]);
  });

  it('follows the faint pitch and runs on through the voiced frames', () => {
    const trace = faintTrace([faint(0), voiced(0.01), unvoiced(0.02), faint(0.03)]);
    expect(trace.map((f) => [f.t, f.f0])).toEqual([
      [0, 220],
      [0.01, 220],
      [0.03, 220],
    ]);
  });
});

describe('drawRibbon with a faint trace', () => {
  it('strokes the faint line first, in the voice colour at the skin alpha', () => {
    const { ctx, strokes } = recorder();
    drawRibbon(ctx, view, style, [faint(0.9), faint(0.91), voiced(0.92), voiced(0.93)], 0, 100);
    expect(strokes.length).toBeGreaterThanOrEqual(2);
    expect(strokes[0]).toEqual({ alpha: 0.4, colour: '#00aa55' });
    for (const stroke of strokes.slice(1)) expect(stroke.alpha).toBeGreaterThan(0.4);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('draws only the solid ribbon when nothing is faint', () => {
    const { ctx, strokes } = recorder();
    drawRibbon(ctx, view, style, [voiced(0.9), voiced(0.91), voiced(0.92)], 1, 100);
    expect(strokes.every((s) => s.alpha > 0.4)).toBe(true);
    expect(strokes.every((s) => s.colour === '#aa0055')).toBe(true);
  });

  it('draws a faint-only stretch with no solid ribbon at all', () => {
    const { ctx, strokes } = recorder();
    drawRibbon(ctx, view, style, [faint(0.9), faint(0.91)], 0, 100);
    expect(strokes).toEqual([{ alpha: 0.4, colour: '#00aa55' }]);
  });
});

describe('the skin token', () => {
  it('is part of the contract every skin must define', () => {
    expect(SKIN_TOKENS).toContain('--lane-faint-alpha');
  });
});
