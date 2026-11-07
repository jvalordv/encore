/** Tests for the sparkline path builder (src/render/sparkline.ts). */
import { describe, expect, it } from 'vitest';
import { sparklinePath, sparklinePoints, sparklineSvg } from '../src/render/sparkline';

describe('sparklinePoints', () => {
  it('spreads takes evenly and puts higher values higher', () => {
    const pts = sparklinePoints([0, 5, 10], 100, 20, 0);
    expect(pts.map((p) => p.x)).toEqual([0, 50, 100]);
    expect(pts.map((p) => p.y)).toEqual([20, 10, 0]);
  });

  it('draws a flat series mid-height and one value mid-width', () => {
    expect(sparklinePoints([4, 4, 4], 100, 20).map((p) => p.y)).toEqual([10, 10, 10]);
    expect(sparklinePoints([4], 100, 20)).toEqual([{ x: 50, y: 10 }]);
    expect(sparklinePoints([], 100, 20)).toEqual([]);
  });
});

describe('sparklinePath and sparklineSvg', () => {
  it('writes M then L commands', () => {
    expect(
      sparklinePath([
        { x: 0, y: 1 },
        { x: 2.345, y: 3 },
      ]),
    ).toBe('M0.00 1.00 L2.35 3.00');
  });

  it('draws a line for two takes, only a dot for one, and strips markup from the label', () => {
    expect(sparklineSvg([1, 2], 120, 32, 'a')).toContain('<path');
    const one = sparklineSvg([1], 120, 32, 'x"><script>');
    expect(one).not.toContain('<path');
    expect(one).not.toContain('<script');
    expect((sparklineSvg([1, 2, 3]).match(/<circle/g) ?? []).length).toBe(3);
  });
});
