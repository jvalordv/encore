/**
 * Tests for the song panel's size rules (src/app/panel-layout.ts): the width
 * clamp (a floor, half the window, and a stage that keeps the player's
 * width), the drag that folds the panel into the rail, the handle's keyboard,
 * the remembered layout read back from storage, and the one-open info note.
 */
import { describe, expect, it } from 'vitest';
import {
  COLLAPSE_BELOW,
  DEFAULT_LAYOUT,
  DEFAULT_WIDTH,
  KEY_STEP,
  KEY_STEP_BIG,
  MIN_WIDTH,
  NARROW_DEFAULT_WIDTH,
  RAIL_SECTIONS,
  RAIL_WIDTH,
  clampWidth,
  defaultWidth,
  effectiveWidth,
  keyResult,
  maxWidth,
  nextInfoOpen,
  parseLayout,
  resolveDrag,
  serializeLayout,
} from '../src/app/panel-layout';

describe('the width limits', () => {
  it('allows half of a wide window', () => {
    expect(maxWidth(1280)).toBe(640);
    expect(maxWidth(1600)).toBe(800);
  });

  it('keeps room for the player beside the panel in a mid-size window', () => {
    // 1000 px: half would be 500, but the stage would drop under 520 px.
    expect(maxWidth(1000)).toBe(1000 - 36 - 520);
  });

  it('never falls below the minimum', () => {
    expect(maxWidth(700)).toBe(MIN_WIDTH);
    expect(maxWidth(300)).toBe(MIN_WIDTH);
  });

  it('holds a width between the minimum and the maximum', () => {
    expect(clampWidth(100, 1280)).toBe(MIN_WIDTH);
    expect(clampWidth(333.4, 1280)).toBe(333);
    expect(clampWidth(5000, 1280)).toBe(640);
  });

  it('falls back to the default for a width that is not a number', () => {
    expect(clampWidth(Number.NaN, 1280)).toBe(DEFAULT_WIDTH);
    expect(clampWidth(Number.NaN, 800)).toBe(NARROW_DEFAULT_WIDTH);
  });
});

describe('the width in use', () => {
  it('is the default until one is chosen, narrower in a small window', () => {
    expect(defaultWidth(1280)).toBe(280);
    expect(defaultWidth(900)).toBe(220);
    expect(effectiveWidth(DEFAULT_LAYOUT, 1280)).toBe(280);
  });

  it('is the chosen width, held to the window', () => {
    expect(effectiveWidth({ width: 400, collapsed: false }, 1280)).toBe(400);
    expect(effectiveWidth({ width: 700, collapsed: false }, 1000)).toBe(444);
  });

  it('is the rail while folded, whatever width was chosen', () => {
    expect(effectiveWidth({ width: 400, collapsed: true }, 1280)).toBe(RAIL_WIDTH);
  });
});

describe('dragging the edge', () => {
  it('sets a width inside the limits', () => {
    expect(resolveDrag(350, 1280)).toEqual({ kind: 'width', width: 350 });
    expect(resolveDrag(COLLAPSE_BELOW, 1280)).toEqual({ kind: 'width', width: MIN_WIDTH });
    expect(resolveDrag(2000, 1280)).toEqual({ kind: 'width', width: 640 });
  });

  it('folds into the rail once narrower than the threshold', () => {
    expect(resolveDrag(COLLAPSE_BELOW - 1, 1280)).toEqual({ kind: 'collapse' });
    expect(resolveDrag(0, 1280)).toEqual({ kind: 'collapse' });
    expect(resolveDrag(-40, 1280)).toEqual({ kind: 'collapse' });
  });
});

describe('the handle keyboard', () => {
  it('moves the edge by a step, a bigger one with Shift', () => {
    expect(keyResult('ArrowRight', false, 300, 1280)).toEqual({ kind: 'width', width: 300 + KEY_STEP });
    expect(keyResult('ArrowLeft', false, 300, 1280)).toEqual({ kind: 'width', width: 300 - KEY_STEP });
    expect(keyResult('ArrowRight', true, 300, 1280)).toEqual({ kind: 'width', width: 300 + KEY_STEP_BIG });
  });

  it('stops at the limits', () => {
    expect(keyResult('ArrowLeft', false, MIN_WIDTH, 1280)).toEqual({ kind: 'width', width: MIN_WIDTH });
    expect(keyResult('ArrowRight', false, 640, 1280)).toEqual({ kind: 'width', width: 640 });
  });

  it('goes to the narrowest with Home and the widest with End', () => {
    expect(keyResult('Home', false, 400, 1280)).toEqual({ kind: 'width', width: MIN_WIDTH });
    expect(keyResult('End', false, 400, 1280)).toEqual({ kind: 'width', width: 640 });
  });

  it('folds or unfolds with Enter and ignores other keys', () => {
    expect(keyResult('Enter', false, 400, 1280)).toEqual({ kind: 'toggle' });
    expect(keyResult('a', false, 400, 1280)).toBeNull();
    expect(keyResult('ArrowUp', false, 400, 1280)).toBeNull();
  });
});

describe('the remembered layout', () => {
  it('round-trips', () => {
    const layout = { width: 333, collapsed: true };
    expect(parseLayout(serializeLayout(layout))).toEqual(layout);
    expect(parseLayout(serializeLayout(DEFAULT_LAYOUT))).toEqual(DEFAULT_LAYOUT);
  });

  it('reads nothing, junk and the wrong shapes as the default', () => {
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{nope')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('42')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('null')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('[]')).toEqual(DEFAULT_LAYOUT);
  });

  it('drops a width that cannot be right but keeps the fold', () => {
    expect(parseLayout('{"width":"wide","collapsed":true}')).toEqual({ width: null, collapsed: true });
    expect(parseLayout('{"width":10,"collapsed":false}')).toEqual({ width: null, collapsed: false });
    expect(parseLayout('{"width":99999,"collapsed":false}')).toEqual({ width: null, collapsed: false });
    expect(parseLayout('{"width":null,"collapsed":"yes"}')).toEqual({ width: null, collapsed: false });
  });

  it('returns a fresh object, so the default cannot be changed through it', () => {
    parseLayout(null).collapsed = true;
    expect(DEFAULT_LAYOUT.collapsed).toBe(false);
  });
});

describe('the info notes', () => {
  it('opens the pressed one, closes it on a second press, and swaps on another', () => {
    expect(nextInfoOpen(null, 'a')).toBe('a');
    expect(nextInfoOpen('a', 'a')).toBeNull();
    expect(nextInfoOpen('a', 'b')).toBe('b');
  });
});

describe('the rail sections', () => {
  it('lists each target once, with a label and a short glyph', () => {
    const targets = RAIL_SECTIONS.map((s) => s.target);
    expect(new Set(targets).size).toBe(targets.length);
    for (const section of RAIL_SECTIONS) {
      expect(section.label).not.toBe('');
      expect(section.glyph.length).toBeGreaterThan(0);
      expect(section.glyph.length).toBeLessThanOrEqual(2);
    }
  });
});
