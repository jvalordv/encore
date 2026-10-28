/**
 * What counts as a YouTube Data API key, so a bad paste is caught where it
 * happens and a stored value is checked before it is used. Google's keys are
 * about 39 characters of letters, digits, hyphen and underscore, but the
 * length is not promised, so only the alphabet and a sane limit are checked.
 * Pure.
 */

/** The longest key accepted. */
export const MAX_KEY_CHARS = 128;

/**
 * The key with surrounding space (and quotes, from a copied snippet) removed;
 * '' for blank input, meaning "no key"; null when the text cannot be a key.
 */
export function normalizeApiKey(text: string): string | null {
  const key = text.trim().replace(/^["']|["']$/g, '').trim();
  if (key === '') return '';
  return key.length <= MAX_KEY_CHARS && /^[A-Za-z0-9_-]+$/.test(key) ? key : null;
}
