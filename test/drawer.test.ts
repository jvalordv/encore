/**
 * Tests for how a right-edge drawer is dismissed (src/app/drawer.ts): Escape
 * closes only an open drawer and only when nobody handled the key first
 * (a dialog over it takes it), a press counts as outside only when it lands
 * in none of the places that belong to the drawer, and the document listeners
 * are put back when the panel is taken down.
 */
import { describe, expect, it } from 'vitest';
import { attachDismiss, closesOnKey, isOutside } from '../src/app/drawer';
import { FakeDocument } from './fake-dom';

describe('closesOnKey', () => {
  it('closes an open drawer on Escape', () => {
    expect(closesOnKey('Escape', true, false)).toBe(true);
  });

  it('ignores other keys, a closed drawer and a key a dialog already handled', () => {
    expect(closesOnKey('Enter', true, false)).toBe(false);
    expect(closesOnKey('Escape', false, false)).toBe(false);
    expect(closesOnKey('Escape', true, true)).toBe(false);
  });
});

describe('isOutside', () => {
  const inside = { contains: (n: unknown) => n === 'in' };
  const other = { contains: (n: unknown) => n === 'also' };

  it('is outside only when no container holds the target', () => {
    expect(isOutside('x', [inside, other])).toBe(true);
    expect(isOutside('in', [inside, other])).toBe(false);
    expect(isOutside('also', [inside, other])).toBe(false);
  });

  it('skips missing containers and never counts a missing target', () => {
    expect(isOutside('x', [null, inside])).toBe(true);
    expect(isOutside(null, [inside])).toBe(false);
    expect(isOutside(undefined, [inside])).toBe(false);
  });
});

describe('attachDismiss', () => {
  function setup(open = true) {
    const doc = new FakeDocument();
    const state = { open, closed: [] as boolean[] };
    const detach = attachDismiss(doc as unknown as Document, {
      isOpen: () => state.open,
      close: (restore) => {
        state.open = false;
        state.closed.push(restore);
      },
      inside: () => [{ contains: (n: unknown) => n === 'drawer' }],
    });
    return { doc, state, detach };
  }

  it('closes on Escape asking for focus back, and marks the key handled', () => {
    const { doc, state } = setup();
    let prevented = false;
    doc.dispatch('keydown', { key: 'Escape', defaultPrevented: false, preventDefault: () => (prevented = true) });
    expect(state.closed).toEqual([true]);
    expect(prevented).toBe(true);
  });

  it('leaves a key that was already handled alone', () => {
    const { doc, state } = setup();
    doc.dispatch('keydown', { key: 'Escape', defaultPrevented: true, preventDefault: () => undefined });
    expect(state.closed).toEqual([]);
  });

  it('closes on a press outside without asking for focus, not on one inside', () => {
    const { doc, state } = setup();
    doc.dispatch('pointerdown', { target: 'drawer' });
    expect(state.closed).toEqual([]);
    doc.dispatch('pointerdown', { target: 'page' });
    expect(state.closed).toEqual([false]);
  });

  it('does nothing while closed, and nothing after it is detached', () => {
    const closedAlready = setup(false);
    closedAlready.doc.dispatch('pointerdown', { target: 'page' });
    expect(closedAlready.state.closed).toEqual([]);

    const { doc, state, detach } = setup();
    expect(doc.listenerCount()).toBe(2);
    detach();
    expect(doc.listenerCount()).toBe(0);
    doc.dispatch('pointerdown', { target: 'page' });
    expect(state.closed).toEqual([]);
  });
});
