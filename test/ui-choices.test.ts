/**
 * Tests for the remembered panel choices: the pure record
 * (src/app/ui-choices.ts) validates field by field, falls back to defaults on
 * a bad value, and caps the open rows; the Session's controller
 * (session/ui-choices.ts) keeps the state and the store in step, a new session
 * on the same store reads them back (a reload), Reset all and an import put
 * them back or replace them, and the controllers that keep their own copy
 * (the Library's list, the backing notes toggle) follow.
 */
import { describe, expect, it } from 'vitest';
import {
  changedUiChoices,
  DEFAULT_UI_CHOICES,
  MAX_EXPANDED,
  parseUiChoices,
  sanitizeUiChoices,
  serializeUiChoices,
  toggledId,
  UI_CHOICES_KEY,
  uiChoicesPatch,
} from '../src/app/ui-choices';
import { memoryStore } from '../src/app/storage';
import { makeHarness } from './session-harness';

describe('the record', () => {
  it('has the defaults for a fresh visit, without sharing the list', () => {
    const fresh = sanitizeUiChoices(null);
    expect(fresh).toEqual(DEFAULT_UI_CHOICES);
    fresh.libraryExpanded.push('x');
    expect(DEFAULT_UI_CHOICES.libraryExpanded).toEqual([]);
  });

  it('reads only the valid fields of a value, field by field', () => {
    expect(
      uiChoicesPatch({
        libraryView: 'favorites',
        libraryAllSingers: 'yes',
        libraryExpanded: ['a', '', 7, 'a', 'b'],
        takesScope: 'nobody',
        progressSong: 'all',
        searchKeyOpen: true,
        micCheckRange: 'tenor',
        backingShown: false,
        saveWithBacking: 1,
        madeUp: true,
      }),
    ).toEqual({
      libraryView: 'favorites',
      libraryExpanded: ['a', 'b'],
      progressSong: 'all',
      searchKeyOpen: true,
      backingShown: false,
    });
    expect(uiChoicesPatch('text')).toEqual({});
    expect(uiChoicesPatch([1, 2])).toEqual({});
    expect(uiChoicesPatch({ progressSong: null })).toEqual({ progressSong: null });
    expect(uiChoicesPatch({ progressSong: '' })).toEqual({});
  });

  it('lays a patch over a base, which it does not change', () => {
    const base = sanitizeUiChoices({ libraryAllSingers: true, libraryExpanded: ['a'] });
    const next = sanitizeUiChoices({ takesScope: 'all' }, base);
    expect(next).toMatchObject({ libraryAllSingers: true, libraryExpanded: ['a'], takesScope: 'all' });
    expect(base.takesScope).toBe('mine');
  });

  it('falls back to the defaults for text that is missing, damaged or not an object', () => {
    expect(parseUiChoices(null)).toEqual(DEFAULT_UI_CHOICES);
    expect(parseUiChoices('{not json')).toEqual(DEFAULT_UI_CHOICES);
    expect(parseUiChoices('7')).toEqual(DEFAULT_UI_CHOICES);
    expect(parseUiChoices('{"libraryAllSingers":true,"takesScope":"bad"}')).toEqual({
      ...DEFAULT_UI_CHOICES,
      libraryAllSingers: true,
    });
  });

  it('round-trips through its text', () => {
    const choices = sanitizeUiChoices({
      libraryView: 'favorites',
      libraryAllSingers: true,
      libraryExpanded: ['a', 'b'],
      takesScope: 'all',
      progressSong: 'hash-1',
      searchKeyOpen: true,
      micCheckRange: 'high',
      backingShown: false,
      saveWithBacking: true,
    });
    expect(parseUiChoices(serializeUiChoices(choices))).toEqual(choices);
  });

  it('keeps the newest open rows past the cap', () => {
    const many = Array.from({ length: MAX_EXPANDED + 5 }, (_, i) => `s${i}`);
    expect(uiChoicesPatch({ libraryExpanded: many }).libraryExpanded).toHaveLength(MAX_EXPANDED);
    expect(uiChoicesPatch({ libraryExpanded: many }).libraryExpanded?.at(-1)).toBe(`s${many.length - 1}`);
    expect(toggledId(many.slice(0, MAX_EXPANDED), 'new')).toHaveLength(MAX_EXPANDED);
  });

  it('opens and closes a row, and names what differs', () => {
    expect(toggledId(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggledId(['a', 'b'], 'a')).toEqual(['b']);
    expect(changedUiChoices(DEFAULT_UI_CHOICES, DEFAULT_UI_CHOICES)).toEqual([]);
    expect(
      changedUiChoices(DEFAULT_UI_CHOICES, sanitizeUiChoices({ libraryAllSingers: true, micCheckRange: 'high' })),
    ).toEqual(['Library All singers', 'Mic check range']);
  });
});

describe('the Session controller', () => {
  it('remembers a choice in the state and the store, and a new session reads it back', () => {
    const store = memoryStore();
    const first = makeHarness(undefined, undefined, store);
    first.core.ui.set({ libraryAllSingers: true, libraryExpanded: ['hash-x'], takesScope: 'all' });
    expect(first.store.state.ui.libraryAllSingers).toBe(true);
    expect(JSON.parse(store.get(UI_CHOICES_KEY) ?? '{}')).toMatchObject({ libraryAllSingers: true });

    const second = makeHarness(undefined, undefined, store);
    expect(second.store.state.ui).toMatchObject({
      libraryAllSingers: true,
      libraryExpanded: ['hash-x'],
      takesScope: 'all',
    });
  });

  it('ignores a value a reload would throw away', () => {
    const h = makeHarness();
    h.core.ui.set({ takesScope: 'everyone' as 'all' });
    expect(h.store.state.ui.takesScope).toBe('mine');
  });

  it('starts from the defaults when the stored text is damaged', () => {
    const store = memoryStore();
    store.set(UI_CHOICES_KEY, '[[[');
    expect(makeHarness(undefined, undefined, store).store.state.ui).toEqual(DEFAULT_UI_CHOICES);
  });

  it('keeps the Library list and the backing toggle across a reload', () => {
    const store = memoryStore();
    const first = makeHarness(undefined, undefined, store);
    first.core.library.setView('favorites');
    first.core.backing.setShown(false);
    const second = makeHarness(undefined, undefined, store);
    expect(second.store.state.library.view).toBe('favorites');
    expect(second.store.state.backing.shown).toBe(false);
  });

  it('puts every choice back on reset, including the controllers that keep a copy', () => {
    const h = makeHarness();
    h.core.ui.set({ libraryAllSingers: true, micCheckRange: 'high', saveWithBacking: true });
    h.core.library.setView('favorites');
    h.core.backing.setShown(false);
    h.core.ui.reset();
    expect(h.store.state.ui).toEqual(DEFAULT_UI_CHOICES);
    expect(h.store.state.library.view).toBe('all');
    expect(h.store.state.backing.shown).toBe(true);
  });
});
