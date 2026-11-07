/**
 * Guesses what to ask LRCLIB for from a name the app already has: an upload's
 * file name or a YouTube video's title. Noise that videos add ("(Karaoke
 * Version)", "[Official Video]", "Lyrics", a channel suffix) is stripped, a
 * leading track number is dropped, and "Artist - Title" is split. The guess is
 * only a starting point; the panel lets the singer correct both fields.
 */

/** The title and artist to look up; artist is '' when none could be found. */
export interface TitleGuess {
  title: string;
  artist: string;
}

const NOISE =
  /karaoke|instrumental|backing|official|video|lyrics?|audio|visuali[sz]er|\bhd\b|\bhq\b|\b4k\b|remaster|version|with vocals|sing along|sing-along|music/i;
const BRACKETS = /\s*[([{][^)\]}]*[)\]}]/g;
const EXTENSION = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm|lrc)$/i;

/** Removes bracketed parts that are noise, keeping ones that are not ("(Reprise)"). */
function stripBrackets(text: string): string {
  return text.replace(BRACKETS, (part) => (NOISE.test(part) ? '' : part));
}

/**
 * The name with its noise taken off: extension, track number, noisy brackets,
 * a trailing "| channel" or "- Topic"/"VEVO" credit, and a trailing
 * "Lyrics", "Karaoke" or "Instrumental" word.
 */
export function cleanTitle(raw: string): string {
  let text = raw.replace(EXTENSION, '').replace(/_/g, ' ');
  text = text.replace(/^\s*\d{1,3}\s*[.)-]\s+/, '');
  text = stripBrackets(text);
  text = text.replace(/\s*\|.*$/, '');
  text = text.replace(/\s*-\s*(topic|vevo)\s*$/i, '').replace(/vevo\s*$/i, '');
  text = text.replace(/\s*[-–:]?\s*\b(karaoke|lyrics?|instrumental)\b(\s+(version|video))?\s*$/i, '');
  text = text.replace(/^\s*karaoke\s*[-–:]\s*/i, '');
  return text.replace(/\s+/g, ' ').trim();
}

/** Splits a cleaned name on its first " - " (or en dash) into artist and title. */
export function guessTitle(raw: string): TitleGuess {
  const cleaned = cleanTitle(raw);
  const split = /\s[-–—]\s/.exec(cleaned);
  if (!split) return { title: cleaned, artist: '' };
  const artist = cleaned.slice(0, split.index).trim();
  const title = cleaned.slice(split.index + split[0].length).trim();
  if (artist === '' || title === '') return { title: cleaned, artist: '' };
  return { title, artist };
}
