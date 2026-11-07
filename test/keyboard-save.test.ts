/**
 * Tests for the keyboard toggle and Save melody: Session.setKeyboard and
 * attachLane re-applying it, the toggle panel following the store, the Save
 * melody button's hidden and disabled states, and Session.melodyForExport.
 */
import { describe, expect, it, vi } from 'vitest';
import { mountKaraokePanel } from '../src/app/panels/karaoke';
import { mountKeyboardPanel } from '../src/app/panels/keyboard';
import { Session } from '../src/app/session';
import type { SessionCore } from '../src/app/session/core';
import { loadSettings } from '../src/app/settings';
import { StateStore } from '../src/app/state';
import { memoryStore } from '../src/app/storage';
import { memoryTakeStore } from '../src/app/takes';
import { byTestId, fakeHost } from './fake-dom';
import { fakeLane } from './session-harness';

const saveMelody = vi.hoisted(() => vi.fn());
vi.mock('../src/app/melody-download', () => ({ saveMelody }));

function bare() {
  const settings = memoryStore();
  const session = new Session({ settings, takes: memoryTakeStore() });
  const core = (session as unknown as { core: SessionCore }).core;
  return { session, settings, core };
}

describe('Session.setKeyboard', () => {
  it('sets, saves, tells the lane and patches the store', () => {
    const { session, settings } = bare();
    const lane = fakeLane();
    session.attachLane(lane);
    expect(session.store.state.keyboard).toBe(true);
    session.setKeyboard(false);
    expect(session.settings.keyboard).toBe(false);
    expect(loadSettings(settings).keyboard).toBe(false);
    expect(lane.setKeyboard).toHaveBeenLastCalledWith(false);
    expect(session.store.state.keyboard).toBe(false);
  });

  it('is applied to a lane attached later', () => {
    const { session } = bare();
    session.setKeyboard(false);
    const lane = fakeLane();
    session.attachLane(lane);
    expect(lane.setKeyboard).toHaveBeenCalledWith(false);
  });
});

describe('mountKeyboardPanel', () => {
  it('sends a change to the session and follows the store', () => {
    const store = new StateStore();
    const session = { setKeyboard: vi.fn() };
    const host = fakeHost();
    const dispose = mountKeyboardPanel(host, { store, session });
    const box = byTestId(host, 'keyboard-toggle');
    expect(box.checked).toBe(true);
    box.checked = false;
    box.fire('change');
    expect(session.setKeyboard).toHaveBeenCalledWith(false);
    store.patch({ keyboard: false });
    expect(box.checked).toBe(false);
    store.patch({ keyboard: true });
    expect(box.checked).toBe(true);
    dispose();
    expect(box.listenerCount()).toBe(0);
    expect(host.children).toHaveLength(0);
  });
});

describe('Save melody', () => {
  function mount(out: ReturnType<Session['melodyForExport']> = null) {
    const store = new StateStore();
    const session = { setMix: vi.fn(), setGuideLevel: vi.fn(), melodyForExport: vi.fn(() => out) };
    const host = fakeHost();
    mountKaraokePanel(host, { store, session });
    return { store, session, save: byTestId(host, 'save-melody') };
  }

  it('is hidden until the melody is ready, and disabled with no notes', () => {
    const { store, save } = mount();
    expect(save.hidden).toBe(true);
    store.patch({ reference: { phase: 'failed', notes: 0, message: '' } });
    expect(save.hidden).toBe(true);
    store.patch({ reference: { phase: 'ready', notes: 0, message: '' } });
    expect(save.hidden).toBe(false);
    expect(save.disabled).toBe(true);
    store.patch({ reference: { phase: 'ready', notes: 3, message: '' } });
    expect(save.disabled).toBe(false);
  });

  it('saves the exported melody on click, and nothing without one', () => {
    saveMelody.mockClear();
    const notes = [{ onsetS: 0, offsetS: 1, midi: 60 }];
    mount({ name: 'tune.mp3', notes }).save.fire('click');
    expect(saveMelody).toHaveBeenCalledWith(expect.anything(), 'tune.mp3', notes);
    saveMelody.mockClear();
    mount(null).save.fire('click');
    expect(saveMelody).not.toHaveBeenCalled();
  });
});

describe('Session.melodyForExport', () => {
  it('is null without notes and carries them, with a fallback name, with notes', () => {
    const { session, core } = bare();
    expect(session.melodyForExport()).toBeNull();
    const notes = [{ onsetS: 0, offsetS: 1, midi: 60 }];
    vi.spyOn(core.stems, 'melodyNotes').mockReturnValue(notes);
    expect(session.melodyForExport()).toEqual({ name: 'song', notes });
  });
});
