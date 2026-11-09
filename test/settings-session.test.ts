/**
 * Tests for the settings controller (src/app/session/settings.ts) on fake
 * parts: Reset all puts every setting back but leaves takes, the Library and
 * the per-song stores alone, import applies through the same intents and says
 * what changed, both refuse while recording, and the service address is
 * validated.
 */
import { describe, expect, it } from 'vitest';
import { saveShift } from '../src/app/key-shift';
import { loadSettings, SETTINGS_KEY } from '../src/app/settings';
import { makeHarness } from './session-harness';

const SKINS = ['studio', 'arcade'];

const saved = {
  mode: 'learning',
  scoring: 'open',
  noteGuide: true,
  keyboard: false,
  guideLevel: 0.2,
  clarityThreshold: 0.7,
  octaveInvariant: true,
  autoPrepareLinks: true,
  serviceUrl: 'http://svc.test:9000',
  embedOffsetS: 0.1,
  youtubeApiKey: 'abc123',
  latencyByDevicePair: { 'x|y': 0.12 },
  duet: { secondSinger: true, names: ['Ann', 'Bo'], colours: ['#112233', null], inputDeviceIdB: null },
};

describe('Reset all', () => {
  it('returns every setting to its default, in the state and in storage', () => {
    const h = makeHarness(saved);
    expect(h.store.state.noteGuide).toBe(true);
    expect(h.core.settings.resetAll()).toBe(true);
    const now = loadSettings(h.settingsStore);
    expect(now.mode).toBe('karaoke');
    expect(now.scoring).toBe('strict');
    expect(now.noteGuide).toBe(false);
    expect(now.keyboard).toBe(true);
    expect(now.octaveInvariant).toBe(false);
    expect(now.autoPrepareLinks).toBe(false);
    expect(now.serviceUrl).toBe('http://localhost:8765');
    expect(now.youtubeApiKey).toBe('');
    expect(now.latencyByDevicePair).toEqual({});
    expect(now.duet.secondSinger).toBe(false);
    // The singers are people, not preferences: a reset keeps their names.
    expect(now.duet.names).toEqual(['Ann', 'Bo']);
    expect(h.store.state.profiles.list.map((p) => p.name)).toEqual(['Ann', 'Bo']);
    expect(h.store.state.mode).toBe('karaoke');
    expect(h.store.state.noteGuide).toBe(false);
    expect(h.store.state.keyboard).toBe(true);
    expect(h.store.state.search.hasKey).toBe(false);
    expect(h.store.state.library.autoAdvance).toBe(true);
    expect(h.store.state.duet.secondSinger).toBe(false);
  });

  it('keeps takes, the Library and the per-song stores', async () => {
    const h = makeHarness(saved);
    await h.takeStore.save({
      songHash: 'h1',
      songName: 'one',
      createdAt: 1,
      durationS: 1,
      latencyS: 0,
      sampleRate: 48000,
      frames: [],
      wav: new Blob([]),
    });
    await h.libraryStore.put({
      id: 'h1',
      source: 'file',
      title: 'one',
      videoId: null,
      fileName: 'one.mp3',
      durationS: 1,
      addedAt: 1,
      lastPlayedAt: null,
      takes: 0,
      stems: false,
      melody: false,
      favorite: true,
      order: 0,
    } as never);
    saveShift(h.settingsStore, 'h1', 2);
    h.core.settings.resetAll();
    expect(await h.takeStore.list()).toHaveLength(1);
    expect(await h.libraryStore.list()).toHaveLength(1);
    expect((await h.libraryStore.list())[0]?.favorite).toBe(true);
    expect(h.settingsStore.get('shift.h1')).not.toBeNull();
  });

  it('refuses while recording', () => {
    const h = makeHarness(saved);
    h.store.patch({ recording: true });
    expect(h.core.settings.resetAll()).toBe(false);
    expect(h.core.current.noteGuide).toBe(true);
  });
});

describe('busy states', () => {
  const MESSAGE = 'Finish recording, calibrating or the Mic check first.';
  const blockers: Array<[string, (h: ReturnType<typeof makeHarness>) => void]> = [
    ['recording', (h) => h.store.patch({ recording: true })],
    ['calibrating', (h) => h.store.patch({ calibrating: true })],
    ['starting a take', (h) => void (h.core.takes.startingRecord = true)],
    ['a Mic check', (h) => void (h.core.micCheck.active = true)],
  ];
  it.each(blockers)('resetAll and importText refuse while %s', (_name, block) => {
    const h = makeHarness(saved);
    block(h);
    expect(h.core.settings.resetAll()).toBe(false);
    expect(h.store.state.status?.text).toBe(MESSAGE);
    expect(h.core.current.noteGuide).toBe(true);
    const out = h.core.settings.importText('{"settings":{"noteGuide":false}}', SKINS, 'studio');
    expect(out).toEqual({ message: MESSAGE, applied: false, skin: null });
    expect(h.core.current.noteGuide).toBe(true);
  });
});

describe('importText', () => {
  it('applies through the intents and says what changed', () => {
    const h = makeHarness();
    const text = JSON.stringify({
      app: 'encore-settings',
      settings: { noteGuide: true, keyboard: false, serviceUrl: 'http://other.test:1', bogus: 1 },
      skin: 'arcade',
      autoAdvance: false,
    });
    const out = h.core.settings.importText(text, SKINS, 'studio');
    expect(out.applied).toBe(true);
    expect(out.skin).toBe('arcade');
    expect(out.message).toBe(
      'Changed 5: Service address, Note guide, Keyboard, Skin, Auto-advance. ' +
        'Ignored 1 entry this version does not use.',
    );
    expect(h.store.state.noteGuide).toBe(true);
    expect(h.store.state.keyboard).toBe(false);
    expect(h.store.state.library.autoAdvance).toBe(false);
    expect(h.core.current.serviceUrl).toBe('http://other.test:1');
    expect(JSON.parse(h.settingsStore.get(SETTINGS_KEY) ?? '{}').noteGuide).toBe(true);
  });

  it('refuses a file that is not ours and changes nothing', () => {
    const h = makeHarness();
    const out = h.core.settings.importText('nope', SKINS, 'studio');
    expect(out.applied).toBe(false);
    expect(out.message).toBe('That file is not an Encore settings file.');
    expect(h.store.state.noteGuide).toBe(false);
  });

  it('refuses while recording', () => {
    const h = makeHarness();
    h.store.patch({ recording: true });
    const out = h.core.settings.importText('{"settings":{"noteGuide":true}}', SKINS, 'studio');
    expect(out.applied).toBe(false);
    expect(h.core.current.noteGuide).toBe(false);
  });
});

describe('the settings the inline controls do not own', () => {
  it('validates the service address and trims its slashes', () => {
    const h = makeHarness();
    expect(h.core.settings.setServiceUrl('not a url')).toBe(false);
    expect(h.core.current.serviceUrl).toBe('http://localhost:8765');
    expect(h.core.settings.setServiceUrl('https://svc.example:9000//')).toBe(true);
    expect(h.core.current.serviceUrl).toBe('https://svc.example:9000');
  });

  it('bumps the settings revision on every save', () => {
    const h = makeHarness();
    const before = h.store.state.settingsRev;
    h.core.settings.setOctaveInvariant(true);
    expect(h.core.current.octaveInvariant).toBe(true);
    expect(h.store.state.settingsRev).toBeGreaterThan(before);
  });

  it('exports without the key unless asked', () => {
    const h = makeHarness(saved);
    expect(h.core.settings.exportText('studio', false)).not.toContain('abc123');
    expect(h.core.settings.exportText('studio', true)).toContain('abc123');
  });
});
