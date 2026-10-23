/**
 * Persistent user settings: the devices last chosen, the service address, the
 * voicing threshold and the round-trip latency measured for each device pair.
 * One object under one storage key, behind the KeyValueStore interface, so a
 * native shell can own storage later (see "Built to become an app" in
 * docs/ARCHITECTURE.md). Loading never throws and never trusts what it reads:
 * each field is checked on its own and falls back to its default, so a
 * hand-edited or older blob still yields a usable object. The skin is not in
 * here; it lives under `encore.skin` because index.html reads it before any
 * script runs.
 */
import type { KeyValueStore } from './storage';

/** Everything the user has chosen that should survive a reload. */
export interface Settings {
  /** Last chosen microphone; null means the system default. */
  inputDeviceId: string | null;
  /** Last chosen output device; null means the system default. */
  outputDeviceId: string | null;
  /** Base URL of the optional Python service, without a trailing slash. */
  serviceUrl: string;
  /** Clarity at or above which a pitch frame counts as voiced, 0..1. */
  clarityThreshold: number;
  /** Judge pitch modulo an octave (for singers covering another register). */
  octaveInvariant: boolean;
  /** Round-trip latency in seconds, keyed by `latencyKey(output, input)`. */
  latencyByDevicePair: Record<string, number>;
}

/** Key inside the key-value store; the localStorage adapter adds `encore.`. */
export const SETTINGS_KEY = 'settings';

/** Longest latency accepted, matching what latency.ts will load or save. */
export const MAX_LATENCY_S = 2;

/** Frozen so a stray write throws instead of changing every later default. */
export const DEFAULT_SETTINGS: Settings = Object.freeze({
  inputDeviceId: null,
  outputDeviceId: null,
  serviceUrl: 'http://localhost:8765',
  clarityThreshold: 0.9,
  octaveInvariant: false,
  latencyByDevicePair: Object.freeze({}) as Record<string, number>,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A usable device id, or null for anything else (the empty id included). */
function deviceId(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
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
    serviceUrl: serviceUrl(raw.serviceUrl) ?? DEFAULT_SETTINGS.serviceUrl,
    clarityThreshold: clarity(raw.clarityThreshold),
    octaveInvariant:
      typeof raw.octaveInvariant === 'boolean'
        ? raw.octaveInvariant
        : DEFAULT_SETTINGS.octaveInvariant,
    latencyByDevicePair: latencies(raw.latencyByDevicePair),
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
