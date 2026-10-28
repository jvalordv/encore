/**
 * Persistent user settings: the devices last chosen, how the singer monitors
 * the song, the service address, whether a pasted YouTube link is sent to the
 * service by itself, the voicing threshold, the round-trip latency measured for
 * each device pair, the extra offset applied while a YouTube video supplies
 * the song, the level of the vocal guide in the karaoke mix and the practice
 * mode (karaoke, or the opt-in learning mode) and learning mode's scoring style
 * (Strict, or Open).
 * One object under one storage key, behind the KeyValueStore interface, so a
 * native shell can own storage later (see "Built to become an app" in
 * docs/ARCHITECTURE.md). Loading never throws and never trusts what it reads:
 * each field is checked on its own and falls back to its default, so a
 * hand-edited or older blob still yields a usable object. The skin is not in
 * here; it lives under `encore.skin` because index.html reads it before any
 * script runs.
 */
import type { ScoringStyle } from '../analysis/score';
import type { MonitorMode } from '../audio/mic';
import { normalizeApiKey } from '../search/key';
import { SEARCH_PROVIDER_IDS } from '../search/types';
import type { SearchProviderId } from '../search/types';
import type { KeyValueStore } from './storage';

/**
 * What the app does with the singing: 'karaoke' never judges; 'learning' is
 * the opt-in mode that says where the singing misses. Karaoke is the default
 * and nothing from learning leaks into it.
 */
export type PracticeMode = 'karaoke' | 'learning';

export type { ScoringStyle };

/** Everything the user has chosen that should survive a reload. */
export interface Settings {
  /** Last chosen microphone; null means the system default. */
  inputDeviceId: string | null;
  /** Last chosen output device; null means the system default. */
  outputDeviceId: string | null;
  /** Headphones open the mic raw; speakers add echo cancellation. */
  monitor: MonitorMode;
  /** Base URL of the optional Python service, without a trailing slash. */
  serviceUrl: string;
  /**
   * Send a YouTube link to the service as soon as it loads, which downloads
   * its audio. Off unless the singer turns it on: otherwise a link is only
   * sent when Prepare for scoring is pressed.
   */
  autoPrepareLinks: boolean;
  /** Clarity at or above which a pitch frame counts as voiced, 0..1. */
  clarityThreshold: number;
  /** Judge pitch modulo an octave (for singers covering another register). */
  octaveInvariant: boolean;
  /** Round-trip latency in seconds, keyed by `latencyKey(output, input)`. */
  latencyByDevicePair: Record<string, number>;
  /**
   * Seconds added to the latency while a YouTube video is the song, for the
   * path calibration cannot measure (the embed's own audio output), within
   * plus or minus MAX_EMBED_OFFSET_S.
   */
  embedOffsetS: number;
  /** Karaoke (default) or the opt-in learning mode; the header toggle sets it. */
  mode: PracticeMode;
  /**
   * Learning mode's scoring style: Strict (the original's melody) or Open
   * (lenient, with freestyle judged against the song's key). Strict by default.
   */
  scoring: ScoringStyle;
  /** Level of the original vocal in the "karaoke with a vocal guide" mix, 0..1. */
  guideLevel: number;
  /** Which search provider answers the song search; only 'youtube' exists. */
  searchProvider: SearchProviderId;
  /**
   * The person's own YouTube Data API key for the direct provider, or ''.
   * It stays in this browser's storage and goes nowhere but Google.
   */
  youtubeApiKey: string;
}

/** Key inside the key-value store; the localStorage adapter adds `encore.`. */
export const SETTINGS_KEY = 'settings';

/** Longest latency accepted, matching what latency.ts will load or save. */
export const MAX_LATENCY_S = 2;

/** The vocal guide's level until the singer moves the slider. */
export const DEFAULT_GUIDE_LEVEL = 0.5;

/** Largest embed offset accepted in either direction, in seconds. */
export const MAX_EMBED_OFFSET_S = 0.5;

/** Frozen so a stray write throws instead of changing every later default. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  inputDeviceId: null,
  outputDeviceId: null,
  monitor: 'headphones',
  serviceUrl: 'http://localhost:8765',
  autoPrepareLinks: false,
  clarityThreshold: 0.9,
  octaveInvariant: false,
  latencyByDevicePair: Object.freeze({}) as Record<string, number>,
  embedOffsetS: 0,
  mode: 'karaoke',
  scoring: 'strict',
  guideLevel: DEFAULT_GUIDE_LEVEL,
  searchProvider: 'youtube',
  youtubeApiKey: '',
});

/** The offset limited to plus or minus MAX_EMBED_OFFSET_S; NaN reads as 0. */
export function clampEmbedOffsetS(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(MAX_EMBED_OFFSET_S, Math.max(-MAX_EMBED_OFFSET_S, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A usable device id, or null for anything else (the empty id included). */
function deviceId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The stored mode if it is one we know; headphones for anything else. */
function monitorMode(value: unknown): MonitorMode {
  return value === 'speakers' ? 'speakers' : DEFAULT_SETTINGS.monitor;
}

/** The stored mode if it is one we know; karaoke for anything else. */
function practiceMode(value: unknown): PracticeMode {
  return value === 'learning' ? 'learning' : DEFAULT_SETTINGS.mode;
}

/** The stored scoring style if it is one we know; Strict for anything else. */
function scoringStyle(value: unknown): ScoringStyle {
  return value === 'open' ? 'open' : DEFAULT_SETTINGS.scoring;
}

/** The stored provider if it is one we know; the direct YouTube one otherwise. */
function searchProviderId(value: unknown): SearchProviderId {
  return SEARCH_PROVIDER_IDS.find((id) => id === value) ?? DEFAULT_SETTINGS.searchProvider;
}

/** A stored API key if it can be one; no key otherwise. */
function apiKey(value: unknown): string {
  return typeof value === 'string' ? (normalizeApiKey(value) ?? '') : '';
}

/** An http(s) URL without trailing slashes, or null when it is not one. */
function serviceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return text.replace(/\/+$/, '');
}

function clarity(value: unknown): number {
  const ok = typeof value === 'number' && Number.isFinite(value);
  return ok && value >= 0 && value <= 1 ? value : DEFAULT_SETTINGS.clarityThreshold;
}

/** A stored embed offset, clamped into range; the default for a non-number. */
function embedOffset(value: unknown): number {
  const ok = typeof value === 'number' && Number.isFinite(value);
  return ok ? clampEmbedOffsetS(value) : DEFAULT_SETTINGS.embedOffsetS;
}

/** A stored guide level if it is a number from 0 to 1; the default otherwise. */
function guide(value: unknown): number {
  const ok = typeof value === 'number' && Number.isFinite(value);
  return ok && value >= 0 && value <= 1 ? value : DEFAULT_SETTINGS.guideLevel;
}

/** Keeps the entries whose value is a plausible latency; drops the rest. */
function latencies(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const kept = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' &&
      Number.isFinite(entry[1]) &&
      entry[1] >= 0 &&
      entry[1] <= MAX_LATENCY_S,
  );
  // fromEntries defines own properties, so a "__proto__" key stays inert.
  return Object.fromEntries(kept);
}

/**
 * Turns anything (parsed JSON, a half-filled object) into a valid Settings.
 * Each field is judged alone; the result never shares objects with the input
 * or with DEFAULT_SETTINGS.
 */
export function sanitizeSettings(value: unknown): Settings {
  const raw = isRecord(value) ? value : {};
  return {
    inputDeviceId: deviceId(raw.inputDeviceId),
    outputDeviceId: deviceId(raw.outputDeviceId),
    monitor: monitorMode(raw.monitor),
    serviceUrl: serviceUrl(raw.serviceUrl) ?? DEFAULT_SETTINGS.serviceUrl,
    autoPrepareLinks:
      typeof raw.autoPrepareLinks === 'boolean'
        ? raw.autoPrepareLinks
        : DEFAULT_SETTINGS.autoPrepareLinks,
    clarityThreshold: clarity(raw.clarityThreshold),
    octaveInvariant:
      typeof raw.octaveInvariant === 'boolean'
        ? raw.octaveInvariant
        : DEFAULT_SETTINGS.octaveInvariant,
    latencyByDevicePair: latencies(raw.latencyByDevicePair),
    embedOffsetS: embedOffset(raw.embedOffsetS),
    mode: practiceMode(raw.mode),
    scoring: scoringStyle(raw.scoring),
    guideLevel: guide(raw.guideLevel),
    searchProvider: searchProviderId(raw.searchProvider),
    youtubeApiKey: apiKey(raw.youtubeApiKey),
  };
}

/** Reads the stored settings merged over the defaults; never throws. */
export function loadSettings(store: KeyValueStore): Settings {
  const text = store.get(SETTINGS_KEY);
  if (text === null) return sanitizeSettings(null);
  try {
    return sanitizeSettings(JSON.parse(text));
  } catch {
    // A corrupt blob must not lock the app out of its own settings.
    return sanitizeSettings(null);
  }
}

/** Writes the settings, validated first so bad values never reach storage. */
export function saveSettings(store: KeyValueStore, s: Settings): void {
  store.set(SETTINGS_KEY, JSON.stringify(sanitizeSettings(s)));
}
