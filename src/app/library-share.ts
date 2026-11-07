/**
 * Exporting and importing the favorites as a JSON file, so a list survives a
 * browser reset or moves to another machine. A link travels whole; an upload
 * travels as its hash and name only, because the audio stays in the service's
 * store, so it plays only where that store has it. Import trusts nothing in
 * the file: it is parsed defensively, every item is rebuilt from validated
 * fields, anything else is skipped and counted, the list is capped and
 * duplicates are dropped. Pure; the download and the file picker live in the
 * panel.
 */
import { cleanTitle, isVideoId, youtubeSongId } from './library';
import type { LibraryEntry, LoadedSong } from './library';
import { favoritesOf } from './playlist';

/** The `kind` written into an export, so a wrong file is told apart. */
export const FAVORITES_KIND = 'encore-favorites';
/** Most items one import will take; a larger list is cut. */
export const MAX_IMPORT_ITEMS = 500;
/** Suggested file name for an export. */
export const FAVORITES_FILE_NAME = 'encore-favorites.json';
const FILE_HASH = /^[0-9a-f]{64}$/;

/** The favorites, in order, as the text of an export file. */
export function exportFavorites(entries: readonly LibraryEntry[]): string {
  const items = favoritesOf(entries).map((e) =>
    e.source === 'youtube'
      ? { source: 'youtube', videoId: e.videoId, title: e.title, durationS: e.durationS }
      : { source: 'file', id: e.id, fileName: e.fileName, title: e.title, durationS: e.durationS },
  );
  return JSON.stringify({ kind: FAVORITES_KIND, version: 1, items }, null, 2);
}

/** What an import file held. */
export interface ParsedFavorites {
  /** The songs, in file order, ready to be favorites. */
  songs: LoadedSong[];
  /** Items left out: malformed, duplicated or over the cap. */
  skipped: number;
  /** Set when the file was not a favorites file at all. */
  error: string | null;
}

function songOf(raw: unknown): LoadedSong | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const durationS = typeof r.durationS === 'number' && Number.isFinite(r.durationS) ? Math.max(0, r.durationS) : 0;
  if (r.source === 'youtube') {
    if (!isVideoId(r.videoId)) return null;
    return {
      id: youtubeSongId(r.videoId),
      source: 'youtube',
      title: cleanTitle(r.title, r.videoId),
      videoId: r.videoId,
      fileName: null,
      durationS,
    };
  }
  if (r.source === 'file') {
    const id = typeof r.id === 'string' ? r.id.toLowerCase() : '';
    if (!FILE_HASH.test(id)) return null;
    const fileName = typeof r.fileName === 'string' ? r.fileName.trim().slice(0, 200) : '';
    return {
      id,
      source: 'file',
      title: cleanTitle(r.title, fileName !== '' ? fileName : id.slice(0, 8)),
      videoId: null,
      fileName: fileName !== '' ? fileName : null,
      durationS,
    };
  }
  return null;
}

/** Reads an export file's text; never throws. */
export function parseFavorites(text: string): ParsedFavorites {
  const none = (error: string): ParsedFavorites => ({ songs: [], skipped: 0, error });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return none('That file is not JSON, so it is not a favorites list.');
  }
  const body = data as { kind?: unknown; version?: unknown; items?: unknown } | null;
  if (typeof body !== 'object' || body === null || body.kind !== FAVORITES_KIND || !Array.isArray(body.items)) {
    return none('That file is not an Encore favorites list.');
  }
  if (body.version !== 1) return none('That favorites list is from a different version of Encore.');
  const songs: LoadedSong[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const item of body.items) {
    const song = songs.length < MAX_IMPORT_ITEMS ? songOf(item) : null;
    if (!song || seen.has(song.id)) {
      skipped += 1;
      continue;
    }
    seen.add(song.id);
    songs.push(song);
  }
  return { songs, skipped, error: null };
}

/**
 * The sentence an import ends with: how many favorites came in, how many
 * items were skipped, and which uploads the browser and service lack (`missing`
 * counts uploads found in neither).
 */
export function describeImport(added: number, skipped: number, missingUploads: number): string {
  const parts = [`Imported ${added} favorite${added === 1 ? '' : 's'}.`];
  if (skipped > 0) parts.push(`${skipped} item${skipped === 1 ? ' was' : 's were'} skipped.`);
  if (missingUploads > 0) {
    parts.push(
      `${missingUploads} upload${missingUploads === 1 ? ' is' : 's are'} not in this browser or on the ` +
        'service; uploads play only where the service holds the same file.',
    );
  }
  return parts.join(' ');
}
