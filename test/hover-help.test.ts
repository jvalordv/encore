/**
 * Tests for hover help (src/app/hover-help.ts): the delay and visibility
 * machine (waits, shows, hides on leave and dismiss, never leaves idle when
 * the switch is off, moves at once between controls) and the placement (below
 * and centred, above when below has no room, never outside the viewport).
 */
import { describe, expect, it } from 'vitest';
import { HELP_DELAY_MS, placeHelp, stepHelp } from '../src/app/hover-help';
import type { HelpPhase } from '../src/app/hover-help';

const idle: HelpPhase<string> = { phase: 'idle' };

describe('the help machine', () => {
  it('waits out the delay after entering, then shows', () => {
    expect(HELP_DELAY_MS).toBeGreaterThanOrEqual(300);
    expect(HELP_DELAY_MS).toBeLessThanOrEqual(500);
    const waiting = stepHelp(idle, { type: 'enter', target: 'a' }, true);
    expect(waiting).toEqual({ phase: 'pending', target: 'a' });
    expect(stepHelp(waiting, { type: 'timer' }, true)).toEqual({ phase: 'shown', target: 'a' });
  });

  it('does not show when the pointer left before the delay ran out', () => {
    const waiting = stepHelp(idle, { type: 'enter', target: 'a' }, true);
    const left = stepHelp(waiting, { type: 'leave', target: 'a' }, true);
    expect(left).toEqual(idle);
    expect(stepHelp(left, { type: 'timer' }, true)).toEqual(idle);
  });

  it('hides on leave, but only for the element in play', () => {
    const shown: HelpPhase<string> = { phase: 'shown', target: 'a' };
    expect(stepHelp(shown, { type: 'leave', target: 'b' }, true)).toEqual(shown);
    expect(stepHelp(shown, { type: 'leave', target: 'a' }, true)).toEqual(idle);
  });

  it('hides on dismiss (Escape, a press, a scroll) and when switched off', () => {
    const shown: HelpPhase<string> = { phase: 'shown', target: 'a' };
    expect(stepHelp(shown, { type: 'dismiss' }, true)).toEqual(idle);
    expect(stepHelp(shown, { type: 'off' }, true)).toEqual(idle);
    expect(stepHelp({ phase: 'pending', target: 'a' }, { type: 'dismiss' }, true)).toEqual(idle);
  });

  it('moves straight to the next control while one is showing', () => {
    const shown: HelpPhase<string> = { phase: 'shown', target: 'a' };
    expect(stepHelp(shown, { type: 'enter', target: 'b' }, true)).toEqual({ phase: 'shown', target: 'b' });
  });

  it('never leaves idle while hover help is off', () => {
    expect(stepHelp(idle, { type: 'enter', target: 'a' }, false)).toEqual(idle);
    expect(stepHelp({ phase: 'pending', target: 'a' }, { type: 'timer' }, false)).toEqual(idle);
  });

  it('ignores a timer that fires with nothing pending', () => {
    expect(stepHelp(idle, { type: 'timer' }, true)).toEqual(idle);
    const shown: HelpPhase<string> = { phase: 'shown', target: 'a' };
    expect(stepHelp(shown, { type: 'timer' }, true)).toEqual(shown);
  });
});

describe('placing the popup', () => {
  const view = { w: 800, h: 600 };
  const size = { w: 200, h: 40 };

  it('goes below the element, centred on it', () => {
    const at = placeHelp({ x: 300, y: 100, w: 100, h: 30 }, size, view);
    expect(at.side).toBe('below');
    expect(at.x).toBe(250);
    expect(at.y).toBe(138);
  });

  it('goes above when there is no room below', () => {
    const at = placeHelp({ x: 300, y: 560, w: 100, h: 30 }, size, view);
    expect(at.side).toBe('above');
    expect(at.y).toBe(560 - 8 - 40);
  });

  it('is pulled inside the viewport at the left and right edges', () => {
    const left = placeHelp({ x: 0, y: 100, w: 20, h: 20 }, size, view);
    expect(left.x).toBe(6);
    const right = placeHelp({ x: 790, y: 100, w: 10, h: 20 }, size, view);
    expect(right.x).toBe(800 - 200 - 6);
  });

  it('stays on screen for every target position, even a popup wider than the view', () => {
    for (const w of [120, 200, 900]) {
      for (let x = -50; x <= 850; x += 50) {
        for (let y = -20; y <= 640; y += 40) {
          const at = placeHelp({ x, y, w: 60, h: 24 }, { w, h: 48 }, view);
          expect(at.x).toBeGreaterThanOrEqual(6);
          expect(at.y).toBeGreaterThanOrEqual(6);
          if (w + 12 <= view.w) expect(at.x + w).toBeLessThanOrEqual(view.w - 6);
          expect(at.y + 48).toBeLessThanOrEqual(view.h - 6);
        }
      }
    }
  });
});
