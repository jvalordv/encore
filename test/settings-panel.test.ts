/**
 * Tests for the Settings panel (src/app/panels/settings.ts) over a real
 * session core on fake parts: a value changed in the drawer reaches the
 * store and the inline control (the note guide's own checkbox), a value
 * changed at the inline control shows in the drawer, the settings the state
 * does not hold redraw on a save, Reset all asks first and keeps takes, the
 * export leaves the key out unless the box is ticked, and an import reports
 * what changed.
 */
import { describe, expect, it, vi } from 'vitest';
import { mountNoteGuidePanel } from '../src/app/panels/note-guide';
import { mountSettingsPanel } from '../src/app/panels/settings';
import type { SettingsPanelDeps, SkinPort } from '../src/app/panels/settings';
import { loadSettings } from '../src/app/settings';
import type { SessionCore } from '../src/app/session/core';
import { byTestId, fakeHost } from './fake-dom';
import type { FakeElement } from './fake-dom';
import { makeHarness } from './session-harness';

/** The slice of the Session the panel uses, over a core's controllers. */
function sessionOver(core: SessionCore): SettingsPanelDeps['session'] {
  return {
    get settings() {
      return core.current;
    },
    duet: core.duet,
    profiles: core.profiles,
    deviceLists: { inputs: [], outputs: [] },
    onDevices: () => () => undefined,
    refreshDevices: async () => ({ inputs: [], outputs: [] }),
    chooseInput: async () => undefined,
    chooseOutput: async () => undefined,
    setMonitor: async (mode) => core.input.setMonitor(mode),
    calibrate: async () => undefined,
    setLatency: (s) => core.latency.setLatency(s),
    setEmbedOffset: (s) => core.latency.setEmbedOffset(s),
    get micTuning() {
      return core.health.tuning();
    },
    resetMicTuning: () => core.micCheck.resetSettings(),
    setNoteGuide: (on) => core.health.setNoteGuide(on),
    setKeyboard: (on) => core.settings.setKeyboard(on),
    setHoverHelp: (on) => core.settings.setHoverHelp(on),
    setGuideLevel: (v) => core.mix.setGuideLevel(v),
    setBackingShown: (on) => core.backing.setShown(on),
    setMode: (m) => core.scoring.setMode(m),
    setScoring: (m) => core.scoring.setScoring(m),
    setOctaveInvariant: (on) => core.settings.setOctaveInvariant(on),
    setClarity: (v) => core.input.setClarity(v),
    setAutoAdvance: (on) => core.library.setAutoAdvance(on),
    setAutoPrepareLinks: (on) => core.prepare.setAutoPrepareLinks(on),
    setAutoReference: (on) => core.songReference.setAutoReference(on),
    setSearchKey: (t) => core.search.setKey(t),
    setServiceUrl: (t) => core.settings.setServiceUrl(t),
    testService: async () => true,
    exportSettings: (skin, key) => core.settings.exportText(skin, key),
    importSettings: (t, ids, skin) => core.settings.importText(t, ids, skin),
    resetAllSettings: () => core.settings.resetAll(),
    setLibraryOpen: (open) => core.library.setOpen(open),
  } as SettingsPanelDeps['session'];
}

function setup(saved?: Record<string, unknown>) {
  const h = makeHarness(saved);
  const session = sessionOver(h.core);
  let skinId = 'studio';
  const listeners = new Set<() => void>();
  const skin: SkinPort = {
    choices: [
      ['studio', 'Studio'],
      ['arcade', 'Arcade'],
    ],
    defaultId: 'studio',
    current: () => skinId,
    set: (id) => {
      skinId = id;
      for (const cb of listeners) cb();
    },
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const downloads: Array<{ text: string; name: string }> = [];
  const host = fakeHost();
  const toggle = fakeHost();
  const micCheckToggle = Object.assign(fakeHost(), { click: vi.fn() });
  mountSettingsPanel(host, {
    store: h.store,
    session,
    toggle: toggle as unknown as HTMLButtonElement,
    micCheckToggle: micCheckToggle as unknown as HTMLButtonElement,
    skin,
    download: (text, name) => downloads.push({ text, name }),
  });
  // The inline note guide, on the same store and session.
  const inlineHost = fakeHost();
  mountNoteGuidePanel(inlineHost, { store: h.store, session, readoutHost: fakeHost() });
  const open = (): void => toggle.fire('click');
  return { h, host, toggle, skin, downloads, inlineHost, open, micCheckToggle, session };
}

const change = (el: FakeElement, key: string, value: unknown): void => {
  el[key] = value;
  el.fire('change');
};

describe('settings panel and inline controls', () => {
  it('opens from the header button', () => {
    const { host, toggle, open } = setup();
    expect(host.hidden).toBe(true);
    open();
    expect(host.hidden).toBe(false);
    expect(toggle.attributes.get('aria-expanded')).toBe('true');
    byTestId(host, 'settings-close').fire('click');
    expect(host.hidden).toBe(true);
  });

  it('a value changed in the drawer reaches the store and the inline control', () => {
    const { h, host, inlineHost, open } = setup();
    open();
    change(byTestId(host, 'settings-note-guide'), 'checked', true);
    expect(h.store.state.noteGuide).toBe(true);
    expect(h.core.current.noteGuide).toBe(true);
    expect(byTestId(inlineHost, 'note-guide-toggle').checked).toBe(true);
  });

  it('the Hover help switch starts on, is stored, and shows in the state', () => {
    const { h, host, open } = setup();
    open();
    expect(byTestId(host, 'settings-hover-help').checked).toBe(true);
    change(byTestId(host, 'settings-hover-help'), 'checked', false);
    expect(h.store.state.hoverHelp).toBe(false);
    expect(h.core.current.hoverHelp).toBe(false);
    expect(loadSettings(h.settingsStore).hoverHelp).toBe(false);
  });

  it('a value changed at the inline control shows in the drawer', () => {
    const { host, inlineHost, open } = setup();
    open();
    expect(byTestId(host, 'settings-note-guide').checked).toBe(false);
    change(byTestId(inlineHost, 'note-guide-toggle'), 'checked', true);
    expect(byTestId(host, 'settings-note-guide').checked).toBe(true);
  });

  it('shows what the stores hold on opening, and redraws on a save', () => {
    const { h, host, open } = setup({ keyboard: false, clarityThreshold: 0.7, autoPrepareLinks: true });
    open();
    expect(byTestId(host, 'settings-keyboard').checked).toBe(false);
    expect(byTestId(host, 'settings-clarity').value).toBe('0.7');
    expect(byTestId(host, 'settings-auto-prepare').checked).toBe(true);
    // The inline slider's intent, not the drawer, changes the clarity.
    h.core.input.setClarity(0.55);
    expect(byTestId(host, 'settings-clarity').value).toBe('0.55');
    h.core.prepare.setAutoPrepareLinks(false);
    expect(byTestId(host, 'settings-auto-prepare').checked).toBe(false);
  });

  it('has a switch for getting the song reference automatically, off by default', () => {
    const { h, host, open } = setup();
    open();
    expect(byTestId(host, 'settings-auto-reference').checked).toBe(false);
    change(byTestId(host, 'settings-auto-reference'), 'checked', true);
    expect(h.core.current.autoReference).toBe(true);
    h.core.songReference.setAutoReference(false);
    expect(byTestId(host, 'settings-auto-reference').checked).toBe(false);
  });

  it('writes the settings the state does not hold', () => {
    const { h, host, open } = setup();
    open();
    change(byTestId(host, 'settings-octave'), 'checked', true);
    expect(h.core.current.octaveInvariant).toBe(true);
    const url = byTestId(host, 'settings-service-url');
    change(url, 'value', 'https://svc.test:1/');
    expect(h.core.current.serviceUrl).toBe('https://svc.test:1');
    change(url, 'value', 'nonsense');
    expect(byTestId(host, 'settings-service-note').textContent).toBe('That is not an http or https address.');
    expect(h.core.current.serviceUrl).toBe('https://svc.test:1');
  });

  it('switches the mode and the skin', () => {
    const { h, host, skin, open } = setup();
    open();
    byTestId(host, 'settings-mode-learning').fire('click');
    expect(h.store.state.mode).toBe('learning');
    expect(byTestId(host, 'settings-mode-learning').attributes.get('aria-pressed')).toBe('true');
    change(byTestId(host, 'settings-skin'), 'value', 'arcade');
    expect(skin.current()).toBe('arcade');
  });

  it('shows the second singer microphone only with a second singer', () => {
    const { host, open } = setup();
    open();
    expect(byTestId(host, 'settings-input-b-row').hidden).toBe(true);
    change(byTestId(host, 'settings-second-singer'), 'checked', true);
    expect(byTestId(host, 'settings-input-b-row').hidden).toBe(false);
  });

  it('Mic check closes the drawer and presses the header button', () => {
    const { host, micCheckToggle, open } = setup();
    open();
    byTestId(host, 'settings-mic-check').fire('click');
    expect(micCheckToggle.click).toHaveBeenCalledTimes(1);
    expect(host.hidden).toBe(true);
  });
});

describe('Reset all, export and import in the panel', () => {
  it('asks first, then resets settings and the skin, and keeps takes', async () => {
    const { h, host, skin, open } = setup({ noteGuide: true, keyboard: false, hoverHelp: false });
    await h.takeStore.save({
      songHash: 'h',
      songName: 's',
      createdAt: 1,
      durationS: 1,
      latencyS: 0,
      sampleRate: 48000,
      frames: [],
      wav: new Blob([]),
    });
    skin.set('arcade');
    open();
    byTestId(host, 'settings-reset').fire('click');
    expect(byTestId(host, 'settings-reset-confirm').hidden).toBe(false);
    expect(h.core.current.noteGuide).toBe(true);
    byTestId(host, 'settings-reset-no').fire('click');
    expect(byTestId(host, 'settings-reset-confirm').hidden).toBe(true);
    expect(h.core.current.noteGuide).toBe(true);
    byTestId(host, 'settings-reset').fire('click');
    byTestId(host, 'settings-reset-yes').fire('click');
    expect(h.core.current.noteGuide).toBe(false);
    expect(h.store.state.keyboard).toBe(true);
    // Reset turns hover help back on.
    expect(h.store.state.hoverHelp).toBe(true);
    expect(h.core.current.hoverHelp).toBe(true);
    expect(byTestId(host, 'settings-hover-help').checked).toBe(true);
    expect(skin.current()).toBe('studio');
    expect(byTestId(host, 'settings-note-guide').checked).toBe(false);
    expect(await h.takeStore.list()).toHaveLength(1);
  });

  it('exports without the key, and with it when the box is ticked', () => {
    const { host, downloads, open } = setup({ youtubeApiKey: 'secretkey1' });
    open();
    byTestId(host, 'settings-export').fire('click');
    expect(downloads[0]?.name).toBe('encore-settings.json');
    expect(downloads[0]?.text).not.toContain('secretkey1');
    change(byTestId(host, 'settings-export-key'), 'checked', true);
    byTestId(host, 'settings-export').fire('click');
    expect(downloads[1]?.text).toContain('secretkey1');
  });

  it('imports a file and reports what changed', async () => {
    const { h, host, skin, open } = setup();
    open();
    const text = JSON.stringify({ settings: { keyboard: false, nope: 1 }, skin: 'arcade' });
    const input = byTestId(host, 'settings-import-file');
    input.files = [{ text: async () => text }];
    input.fire('change');
    await vi.waitFor(() => expect(byTestId(host, 'settings-notice').textContent).toContain('Changed 2'));
    expect(byTestId(host, 'settings-notice').textContent).toContain('Ignored 1 entry');
    expect(h.store.state.keyboard).toBe(false);
    expect(skin.current()).toBe('arcade');
    expect(byTestId(host, 'settings-keyboard').checked).toBe(false);
  });
});

describe('settings panel while busy', () => {
  const ids = [
    'settings-input',
    'settings-output',
    'settings-input-b',
    'settings-latency',
    'settings-embed-offset',
    'settings-refresh',
    'settings-calibrate',
    'settings-mic-check',
    'settings-monitor-headphones',
    'settings-monitor-speakers',
  ];

  it.each([['recording'], ['calibrating']] as const)('disables the mic controls while %s', (key) => {
    const { h, host, open } = setup();
    // The output picker is also off in a browser that cannot choose one.
    h.store.patch({ output: { ...h.store.state.output, selectable: true } });
    open();
    for (const id of ids) expect(byTestId(host, id).disabled, id).toBe(false);
    h.store.patch({ [key]: true });
    for (const id of ids) expect(byTestId(host, id).disabled, id).toBe(true);
    h.store.patch({ [key]: false });
    expect(byTestId(host, 'settings-latency').disabled).toBe(false);
    expect(byTestId(host, 'settings-input').disabled).toBe(false);
  });

  it('keeps the drawer open when the Mic check toggle is disabled', () => {
    const { host, open, micCheckToggle, toggle } = setup();
    open();
    (micCheckToggle as { disabled: boolean }).disabled = true;
    byTestId(host, 'settings-mic-check').fire('click');
    expect(host.hidden).toBe(false);
    expect(micCheckToggle.click).not.toHaveBeenCalled();
    expect(toggle.attributes.get('aria-expanded')).toBe('true');
  });
});
