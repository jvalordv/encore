/**
 * Tests for the settings export and import (src/app/settings-io.ts): the
 * search key is left out unless asked for, unknown keys are ignored and
 * counted, bad values are clamped or fall back, keys the file lacks keep
 * their current value, and the summary names what changed.
 */
import { describe, expect, it } from 'vitest';
import { describeImport, exportSettingsText, parseSettingsText, SETTINGS_FILE_APP } from '../src/app/settings-io';
import { DEFAULT_SETTINGS, MAX_EMBED_OFFSET_S, sanitizeSettings } from '../src/app/settings';

const SKINS = ['studio', 'arcade', 'dreamhouse'];
const current = sanitizeSettings({ youtubeApiKey: 'AIzaSyA-secret-key-1234567890abcdefghijk', noteGuide: true });
const extras = { skin: 'arcade', autoAdvance: false };

describe('exportSettingsText', () => {
  it('leaves the search key out by default', () => {
    const text = exportSettingsText(current, extras, false);
    expect(text).not.toContain('secret');
    const file = JSON.parse(text);
    expect(file.app).toBe(SETTINGS_FILE_APP);
    expect('youtubeApiKey' in file.settings).toBe(false);
    expect(file.settings.noteGuide).toBe(true);
    expect(file.skin).toBe('arcade');
    expect(file.autoAdvance).toBe(false);
  });

  it('includes the key only when asked', () => {
    const file = JSON.parse(exportSettingsText(current, extras, true));
    expect(file.settings.youtubeApiKey).toBe(current.youtubeApiKey);
  });

  it('carries the hover help switch out and back in', () => {
    const quiet = sanitizeSettings({ hoverHelp: false });
    const file = JSON.parse(exportSettingsText(quiet, extras, false));
    expect(file.settings.hoverHelp).toBe(false);
    const parsed = parseSettingsText(JSON.stringify(file), DEFAULT_SETTINGS, SKINS);
    expect(parsed?.settings.hoverHelp).toBe(false);
    expect(parsed?.changed).toContain('Hover help');
    // A file with no such key leaves the switch where it was; a bad value reads as on.
    expect(parseSettingsText(JSON.stringify({ app: SETTINGS_FILE_APP, settings: {} }), quiet, SKINS)?.settings.hoverHelp).toBe(false);
    expect(sanitizeSettings({ hoverHelp: 'no' }).hoverHelp).toBe(true);
  });

  it('round-trips through the parser', () => {
    const parsed = parseSettingsText(exportSettingsText(current, extras, true), DEFAULT_SETTINGS, SKINS);
    expect(parsed?.settings).toEqual(current);
    expect(parsed?.skin).toBe('arcade');
    expect(parsed?.autoAdvance).toBe(false);
  });
});

describe('parseSettingsText', () => {
  const file = (settings: unknown, rest: Record<string, unknown> = {}): string =>
    JSON.stringify({ app: SETTINGS_FILE_APP, settings, ...rest });

  it('refuses text that is not a settings file', () => {
    expect(parseSettingsText('not json', DEFAULT_SETTINGS, SKINS)).toBeNull();
    expect(parseSettingsText('[1,2]', DEFAULT_SETTINGS, SKINS)).toBeNull();
    expect(parseSettingsText('{"settings": 3}', DEFAULT_SETTINGS, SKINS)).toBeNull();
  });

  it('ignores unknown keys and counts them', () => {
    const parsed = parseSettingsText(file({ keyboard: false, volume: 11, nested: { a: 1 } }, { extra: 1 }), DEFAULT_SETTINGS, SKINS);
    expect(parsed?.settings.keyboard).toBe(false);
    expect(parsed?.settings).not.toHaveProperty('volume');
    expect(parsed?.ignored).toBe(3);
  });

  it('clamps or defaults bad values', () => {
    const parsed = parseSettingsText(
      file({ embedOffsetS: 9, clarityThreshold: 5, guideLevel: 'loud', serviceUrl: 'ftp://x', mode: 'party', monitor: 7 }),
      DEFAULT_SETTINGS,
      SKINS,
    );
    expect(parsed?.settings.embedOffsetS).toBe(MAX_EMBED_OFFSET_S);
    expect(parsed?.settings.clarityThreshold).toBe(DEFAULT_SETTINGS.clarityThreshold);
    expect(parsed?.settings.guideLevel).toBe(DEFAULT_SETTINGS.guideLevel);
    expect(parsed?.settings.serviceUrl).toBe(DEFAULT_SETTINGS.serviceUrl);
    expect(parsed?.settings.mode).toBe('karaoke');
    expect(parsed?.settings.monitor).toBe('headphones');
  });

  it('keeps the current value, key included, for what the file lacks', () => {
    const parsed = parseSettingsText(file({ keyboard: false }), current, SKINS);
    expect(parsed?.settings.youtubeApiKey).toBe(current.youtubeApiKey);
    expect(parsed?.settings.noteGuide).toBe(true);
    expect(parsed?.changed).toEqual(['Keyboard']);
  });

  it('takes only a skin the app has', () => {
    expect(parseSettingsText(file({}, { skin: 'arcade' }), DEFAULT_SETTINGS, SKINS)?.skin).toBe('arcade');
    expect(parseSettingsText(file({}, { skin: 'neon' }), DEFAULT_SETTINGS, SKINS)?.skin).toBeNull();
  });

  it('sanitises the per-pair maps value by value', () => {
    const parsed = parseSettingsText(
      file({ latencyByDevicePair: { a: 0.1, b: 99, c: 'x' }, micTuningByDevicePair: { a: { clarityThreshold: 7 }, b: 3 } }),
      DEFAULT_SETTINGS,
      SKINS,
    );
    expect(parsed?.settings.latencyByDevicePair).toEqual({ a: 0.1 });
    expect(Object.keys(parsed?.settings.micTuningByDevicePair ?? {})).toEqual(['a']);
    expect(parsed?.settings.micTuningByDevicePair.a?.clarityThreshold).toBe(0.98);
  });
});

describe('describeImport', () => {
  it('says plainly what changed and what was ignored', () => {
    const parsed = parseSettingsText(
      JSON.stringify({ settings: { keyboard: false, noteGuide: true, bogus: 1 } }),
      DEFAULT_SETTINGS,
      SKINS,
    );
    expect(parsed).not.toBeNull();
    const text = describeImport(parsed!, ['Skin']);
    expect(text).toBe('Changed 3: Note guide, Keyboard, Skin. Ignored 1 entry this version does not use.');
  });

  it('says so when nothing changed', () => {
    const parsed = parseSettingsText(JSON.stringify({ settings: {} }), DEFAULT_SETTINGS, SKINS);
    expect(describeImport(parsed!, [])).toBe('Nothing changed: the file matches the settings already in use.');
  });
});
