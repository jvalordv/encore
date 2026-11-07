/**
 * The duet's saved choices: whether there is a second singer, what each
 * singer is called, the colour of each singer's ribbon and the second mic.
 * They sit under one `duet` key of the settings (src/app/settings.ts), loaded
 * with the same rule as the rest: each field is judged alone and falls back to
 * its default, so a hand-edited blob still yields a usable object. A colour of
 * null means the skin's own singer colour (src/skins).
 */

/** Which singer: 0 is A (today's only input), 1 is B. */
export type SingerIndex = 0 | 1;

/** What the singer chose for the two singers. */
export interface DuetSettings {
  /** True when singer B is on: a second mic or turns on the one mic. */
  secondSinger: boolean;
  /** The names shown on the lane, the panel and the report cards. */
  names: [string, string];
  /** `#rrggbb` per singer, or null for the skin's colour. */
  colours: [string | null, string | null];
  /** Singer B's input; null means the system default. */
  inputDeviceIdB: string | null;
}

/** Longest name kept; the lane and the card have little room. */
export const NAME_MAX = 16;

/** The names until the singers type their own. */
export const DEFAULT_NAME_A = 'Singer A';
export const DEFAULT_NAME_B = 'Singer B';

/** A fresh default; never shared, so a stray write cannot change the next. */
export function defaultDuet(): DuetSettings {
  return {
    secondSinger: false,
    names: [DEFAULT_NAME_A, DEFAULT_NAME_B],
    colours: [null, null],
    inputDeviceIdB: null,
  };
}

/** The name trimmed and cut to NAME_MAX; the fallback when it is empty. */
export function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return text === '' ? fallback : text;
}

/** A `#rrggbb` colour, lower-cased, or null for anything else. */
export function cleanColour(value: unknown): string | null {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns anything (parsed JSON, a half-filled object) into valid duet settings. */
export function sanitizeDuet(value: unknown): DuetSettings {
  const raw = isRecord(value) ? value : {};
  const names: unknown[] = Array.isArray(raw.names) ? raw.names : [];
  const colours: unknown[] = Array.isArray(raw.colours) ? raw.colours : [];
  const id = raw.inputDeviceIdB;
  return {
    secondSinger: raw.secondSinger === true,
    names: [cleanName(names[0], DEFAULT_NAME_A), cleanName(names[1], DEFAULT_NAME_B)],
    colours: [cleanColour(colours[0]), cleanColour(colours[1])],
    inputDeviceIdB: typeof id === 'string' && id !== '' ? id : null,
  };
}
