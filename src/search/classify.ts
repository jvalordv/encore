/**
 * Karaoke or original: a judgement from a video's title and channel alone,
 * for the badge on a search result. A title that says karaoke, instrumental,
 * backing track, sing along, off vocal and the like is a karaoke track, and so
 * is anything from a channel known to publish only those. The word list is
 * shared with the "Find the original" query (./query.ts), which removes the
 * same words. Pure.
 */
import type { ResultKind } from './types';

/**
 * Phrases that mark a video as a karaoke or backing track, as regular
 * expression sources. Matched on word edges, ignoring case; spaces stand for
 * a space, a hyphen or nothing ("sing along", "sing-along", "singalong").
 */
export const KARAOKE_PHRASES: readonly string[] = [
  'karaoke',
  'karaoké',
  'instrumentals?',
  'backing tracks?',
  'backing vocals? only',
  'sing along',
  'off vocals?',
  'minus one',
  '(?:no|without) (?:lead )?vocals?',
  'play along',
  'in the style of',
];

/**
 * Channels that publish karaoke tracks without always saying so in a title,
 * as regular expression sources. A channel whose name holds "karaoke" needs no
 * entry: the word list catches it.
 */
export const KARAOKE_CHANNELS: readonly string[] = [
  'sing king',
  'karafun',
  'sunfly',
  'lucky voice',
  'zzang',
  'ameritz',
  'party tyme',
  'singa',
  'sing2piano',
  'singsnap',
  'chartbuster',
];

/** Spaces in a phrase source match a space, a hyphen or nothing. */
function phraseSource(phrase: string): string {
  return phrase.replace(/ /g, '[ \\-]?');
}

/** The pattern for any karaoke phrase, on word edges, ignoring case. */
export const KARAOKE_WORDS = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${KARAOKE_PHRASES.map(phraseSource).join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** The pattern for any known channel, on word edges so "Singapore" is not "Singa". */
export const KARAOKE_CHANNEL_NAMES = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${KARAOKE_CHANNELS.map(phraseSource).join('|')})(?![\\p{L}\\p{N}])`,
  'iu',
);

/** True when the channel name is one of the known karaoke channels. */
export function isKaraokeChannel(channel: string): boolean {
  return KARAOKE_CHANNEL_NAMES.test(channel);
}

/** Karaoke when the title or the channel says so; original otherwise. */
export function classifyResult(title: string, channel: string): ResultKind {
  return KARAOKE_WORDS.test(title) || KARAOKE_WORDS.test(channel) || isKaraokeChannel(channel)
    ? 'karaoke'
    : 'original';
}
