/**
 * The small choices a singer makes in the panels that are not settings: the
 * Library's All singers switch, which of its song rows are open, its list,
 * the Takes list's singer filter, the Progress picker, the search key box, the
 * Mic check's voice range, and the two Karaoke track boxes. They are kept in
 * one typed record under the storage key `ui`, validated on read so a damaged
 * or older value falls back to its default one field at a time, and carried by
 * the settings export. Pure: no storage, no DOM. The Session's
 * `UiChoicesController` (session/ui-choices.ts) reads and writes the record;
 * checked in test/ui-choices.test.ts. Things that are transient by nature (an
 * open drawer, a playing replay, a pending delete, the search text) are not
 * here.
 */
import type { MelodyRange } from '../analysis/test-melody';
import type { LibraryView } from './library-state';

/** Storage key of the record (the store adds its own prefix). */
export const UI_CHOICES_KEY = 'ui';

/** Most song rows remembered as open; the oldest are dropped past this. */
export const MAX_EXPANDED = 200;

/** Longest song id kept; a longer string is no id the app made. */
const MAX_ID_LENGTH = 200;

/** Every remembered choice. */
export interface UiChoices {
  /** The Library drawer's list: all songs or the favorites. */
  libraryView: LibraryView;
  /** The Library's All singers switch. */
  libraryAllSingers: boolean;
  /** Ids of the song rows whose takes are listed open. */
  libraryExpanded: string[];
  /** Whose takes the song panel's Takes list shows. */
  takesScope: 'mine' | 'all';
  /** The Progress drawer's picker: a song id, 'all', or null for its default. */
  progressSong: string | null;
  /** Whether the YouTube key box was left open once a key is saved. */
  searchKeyOpen: boolean;
  /** The Mic check's voice range. */
  micCheckRange: MelodyRange;
  /** Whether the backing notes show on the lane. */
  backingShown: boolean;
  /** Whether Save melody includes the backing track. */
  saveWithBacking: boolean;
}

/** What a fresh visit, and Reset all, gives. */
export const DEFAULT_UI_CHOICES: Readonly<UiChoices> = Object.freeze({
  libraryView: 'all',
  libraryAllSingers: false,
  libraryExpanded: [],
  takesScope: 'mine',
  progressSong: null,
  searchKeyOpen: false,
  micCheckRange: 'low',
  backingShown: true,
  saveWithBacking: false,
});

/** The plain name of each choice, for the import summary. */
export const UI_CHOICE_LABELS: Readonly<Record<keyof UiChoices, string>> = Object.freeze({
  libraryView: 'Library list',
  libraryAllSingers: 'Library All singers',
  libraryExpanded: 'Library open songs',
  takesScope: 'Takes list',
  progressSong: 'Progress song',
  searchKeyOpen: 'Search key box',
  micCheckRange: 'Mic check range',
  backingShown: 'Backing notes',
  saveWithBacking: 'Save with backing',
});

const KEYS = Object.keys(DEFAULT_UI_CHOICES) as Array<keyof UiChoices>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item !== '' && item.length <= MAX_ID_LENGTH) seen.add(item);
  }
  return [...seen].slice(-MAX_EXPANDED);
}

/**
 * The valid fields of `raw`, and only those: a field that is missing or has the
 * wrong type or an unknown value is left out, so it keeps whatever the caller
 * had. Unknown fields are ignored. `raw` need not be an object.
 */
export function uiChoicesPatch(raw: unknown): Partial<UiChoices> {
  if (!isRecord(raw)) return {};
  const out: Partial<UiChoices> = {};
  if (raw.libraryView === 'all' || raw.libraryView === 'favorites') out.libraryView = raw.libraryView;
  if (typeof raw.libraryAllSingers === 'boolean') out.libraryAllSingers = raw.libraryAllSingers;
  const expanded = idList(raw.libraryExpanded);
  if (expanded !== undefined) out.libraryExpanded = expanded;
  if (raw.takesScope === 'mine' || raw.takesScope === 'all') out.takesScope = raw.takesScope;
  if (raw.progressSong === null) out.progressSong = null;
  else if (typeof raw.progressSong === 'string' && raw.progressSong !== '' && raw.progressSong.length <= MAX_ID_LENGTH) {
    out.progressSong = raw.progressSong;
  }
  if (typeof raw.searchKeyOpen === 'boolean') out.searchKeyOpen = raw.searchKeyOpen;
  if (raw.micCheckRange === 'low' || raw.micCheckRange === 'high') out.micCheckRange = raw.micCheckRange;
  if (typeof raw.backingShown === 'boolean') out.backingShown = raw.backingShown;
  if (typeof raw.saveWithBacking === 'boolean') out.saveWithBacking = raw.saveWithBacking;
  return out;
}

/** `base` with the valid fields of `raw` laid over it; a copy, never `base` itself. */
export function sanitizeUiChoices(raw: unknown, base: Readonly<UiChoices> = DEFAULT_UI_CHOICES): UiChoices {
  return { ...base, libraryExpanded: [...base.libraryExpanded], ...uiChoicesPatch(raw) };
}

/** The record from its stored text; anything unusable reads as the defaults, field by field. */
export function parseUiChoices(text: string | null): UiChoices {
  if (text === null) return sanitizeUiChoices(null);
  try {
    return sanitizeUiChoices(JSON.parse(text) as unknown);
  } catch {
    return sanitizeUiChoices(null);
  }
}

/** The record as the text kept in storage. */
export function serializeUiChoices(choices: UiChoices): string {
  return JSON.stringify(sanitizeUiChoices(choices));
}

/** Plain names of the fields where `next` differs from `current`, in a stable order. */
export function changedUiChoices(current: Readonly<UiChoices>, next: Readonly<UiChoices>): string[] {
  return KEYS.filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k])).map((k) => UI_CHOICE_LABELS[k]);
}

/** `id` added to or taken out of `ids`, as the Library's open rows change. */
export function toggledId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id].slice(-MAX_EXPANDED);
}
