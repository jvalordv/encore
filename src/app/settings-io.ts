/**
 * Export and import of the settings as one JSON file, for the Settings panel.
 * The file holds the `Settings` object and everything else that says how the
 * app was left, which lives under its own storage keys: the chosen skin, the
 * auto-advance choice, the singer profiles, the song panel's layout (width,
 * folded) and the remembered panel choices (src/app/ui-choices.ts); and
 * nothing else: no takes, library, lyrics or favorites. The YouTube search key is the one
 * secret in it, so it is left out unless the person asks. Importing never
 * trusts the file: only known keys are read, the result goes through
 * `sanitizeSettings` (so a bad value is clamped or falls back to its
 * default), a key the file does not carry keeps its current value, and the
 * words to show the person say what changed. Pure: no storage, no DOM.
 */
import { layoutPatchFromValue } from './panel-layout';
import type { PanelLayout } from './panel-layout';
import { sanitizeList } from './profiles';
import type { Profile } from './profiles';
import { DEFAULT_SETTINGS, sanitizeSettings } from './settings';
import type { Settings } from './settings';
import { sanitizeUiChoices, uiChoicesPatch } from './ui-choices';
import type { UiChoices } from './ui-choices';

/** Name of the file the panel offers for download. */
export const SETTINGS_FILE_NAME = 'encore-settings.json';

/** Marks a file as ours, so another app's JSON is not read as settings. */
export const SETTINGS_FILE_APP = 'encore-settings';

/** What an export holds beyond `Settings` itself. */
export interface SettingsExtras {
  skin: string;
  autoAdvance: boolean;
  /** The singer profiles (names, colours, ids; never takes). */
  profiles?: readonly Profile[];
  /** The song panel's width and fold; left out of the file when absent. */
  layout?: PanelLayout;
  /** The remembered panel choices; left out of the file when absent. */
  ui?: UiChoices;
}

/**
 * Settings the app once had and has dropped. An older export may still carry
 * them; they are skipped without being counted as unrecognised.
 */
const RETIRED_KEYS: readonly string[] = ['autoPrepareLinks'];

/** The plain name of each setting, for the import summary. */
export const SETTING_LABELS: Readonly<Record<keyof Settings, string>> = Object.freeze({
  inputDeviceId: 'Microphone',
  outputDeviceId: 'Output',
  monitor: 'Monitor mode',
  serviceUrl: 'Service address',
  autoReference: 'Get the song reference automatically',
  clarityThreshold: 'Clarity threshold',
  octaveInvariant: 'Octave invariance',
  latencyByDevicePair: 'Latency',
  micTuningByDevicePair: 'Mic tuning',
  embedOffsetS: 'Embed offset',
  mode: 'Practice mode',
  scoring: 'Scoring style',
  guideLevel: 'Vocal guide level',
  noteGuide: 'Note guide',
  keyboard: 'Keyboard',
  hoverHelp: 'Hover help',
  searchProvider: 'Search provider',
  youtubeApiKey: 'YouTube key',
  duet: 'Singers',
});

const KNOWN_KEYS = Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>;
const TOP_LEVEL = ['app', 'version', 'settings', 'skin', 'autoAdvance', 'profiles', 'layout', 'ui'];

/** What reading a file produced; `null` from the parser means not ours. */
export interface ParsedImport {
  /** The settings to apply: the current ones with the file's valid values. */
  settings: Settings;
  /** The skin to apply, or null when the file has none the app knows. */
  skin: string | null;
  /** The auto-advance choice, or null when the file does not carry one. */
  autoAdvance: boolean | null;
  /** The singers the file lists, or null when it has none. */
  profiles: Profile[] | null;
  /** The usable fields of the song panel's layout, or null when the file has none. */
  layout: Partial<PanelLayout> | null;
  /** The panel choices the file carries and are valid, or null when it has none. */
  ui: Partial<UiChoices> | null;
  /** Plain names of what would change, in a stable order. */
  changed: string[];
  /** How many entries were not recognised and so ignored. */
  ignored: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The text of an export. The search key is dropped unless `includeKey`, so
 * a file shared for support carries no secret.
 */
export function exportSettingsText(settings: Settings, extras: SettingsExtras, includeKey: boolean): string {
  const copy: Partial<Settings> = sanitizeSettings(settings);
  if (!includeKey) delete copy.youtubeApiKey;
  return JSON.stringify(
    {
      app: SETTINGS_FILE_APP,
      version: 1,
      settings: copy,
      skin: extras.skin,
      autoAdvance: extras.autoAdvance,
      profiles: extras.profiles ?? [],
      ...(extras.layout ? { layout: { width: extras.layout.width, collapsed: extras.layout.collapsed } } : {}),
      ...(extras.ui ? { ui: sanitizeUiChoices(extras.ui) } : {}),
    },
    null,
    2,
  );
}

/**
 * Reads an export over the `current` settings. Returns null for text that is
 * not JSON or has no settings object. `skinIds` are the skins the app has.
 */
export function parseSettingsText(
  text: string,
  current: Settings,
  skinIds: readonly string[],
): ParsedImport | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.settings)) return null;
  const given = raw.settings;
  const merged: Record<string, unknown> = { ...current };
  let ignored = Object.keys(raw).filter((k) => !TOP_LEVEL.includes(k)).length;
  for (const key of Object.keys(given)) {
    // A key the app does not have is counted, never copied.
    if ((KNOWN_KEYS as string[]).includes(key)) merged[key] = given[key];
    else if (!RETIRED_KEYS.includes(key)) ignored += 1;
  }
  const settings = sanitizeSettings(merged);
  // The two slots' names and colours are the singers' profiles (the `profiles`
  // list), so the duet's own copy in the file never changes them.
  settings.duet = {
    ...settings.duet,
    names: [current.duet.names[0], current.duet.names[1]],
    colours: [current.duet.colours[0], current.duet.colours[1]],
  };
  const changed = KNOWN_KEYS.filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(current[k])).map(
    (k) => SETTING_LABELS[k],
  );
  const skin = typeof raw.skin === 'string' && skinIds.includes(raw.skin) ? raw.skin : null;
  const autoAdvance = typeof raw.autoAdvance === 'boolean' ? raw.autoAdvance : null;
  const profiles = Array.isArray(raw.profiles) ? sanitizeList(raw.profiles) : null;
  const layout = layoutPatchFromValue(raw.layout);
  const ui = isRecord(raw.ui) ? uiChoicesPatch(raw.ui) : null;
  return {
    settings,
    skin,
    autoAdvance,
    profiles: profiles && profiles.length > 0 ? profiles : null,
    layout,
    ui,
    changed,
    ignored,
  };
}

/** One plain sentence about an import, given what the app changed. */
export function describeImport(parsed: ParsedImport, changedExtras: string[]): string {
  const all = [...parsed.changed, ...changedExtras];
  const head =
    all.length === 0
      ? 'Nothing changed: the file matches the settings already in use.'
      : `Changed ${all.length}: ${all.join(', ')}.`;
  const n = parsed.ignored;
  const tail = n === 0 ? '' : ` Ignored ${n} ${n === 1 ? 'entry' : 'entries'} this version does not use.`;
  return head + tail;
}
