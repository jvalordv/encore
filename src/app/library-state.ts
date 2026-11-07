/**
 * What the Library panel shows, as plain state: the browser's entries, the
 * takes counted per song, the uploads only the service holds, the running
 * favorites playlist and the last thing worth telling. Pure helpers turn it
 * into the rows and words the panel draws (the panel holds no logic of its
 * own); the controller in session/library.ts is what changes it.
 */
import type { StarMeasureId } from '../analysis/stars';
import type { SongSummary } from '../service/types';
import type { LibraryEntry } from './library';
import { favoritesOf } from './playlist';

/** Which list the panel shows. */
export type LibraryView = 'all' | 'favorites';

/** An upload the service holds that this browser's Library does not list. */
export interface ServiceSong {
  id: string;
  name: string;
  durationS: number;
  /** True once the service has made its karaoke track. */
  stems: boolean;
}

/** The favorites playlist while it runs. */
export interface PlaylistState {
  active: boolean;
  /** The favorite playing (or just tried); null while inactive. */
  currentId: string | null;
}

/** The Library's slice of the app state. */
export interface LibraryState {
  open: boolean;
  view: LibraryView;
  entries: LibraryEntry[];
  /** Takes saved per song hash. */
  takeCounts: Record<string, number>;
  /** Best learning-take stars (0..3) per song hash. */
  songStars: Record<string, number>;
  /** The measure each song's stars were earned on (its latest take's). */
  songStarMeasure: Record<string, StarMeasureId>;
  /** Local days with a take of real singing, ascending (see analysis/streak.ts). */
  daysSung: number[];
  onService: ServiceSong[];
  playlist: PlaylistState;
  /** Move on to the next favorite when a song ends. */
  autoAdvance: boolean;
  /** One line about the last import, export or removal; '' when none. */
  notice: string;
}

/** A Library with nothing in it and the panel shut. */
export function initialLibrary(autoAdvance = true): LibraryState {
  return {
    open: false,
    view: 'all',
    entries: [],
    takeCounts: {},
    songStars: {},
    songStarMeasure: {},
    daysSung: [],
    onService: [],
    playlist: { active: false, currentId: null },
    autoAdvance,
    notice: '',
  };
}

/** The uploads the service holds that `entries` does not list. */
export function serviceOnly(rows: readonly SongSummary[], entries: readonly LibraryEntry[]): ServiceSong[] {
  const known = new Set(entries.map((e) => e.id));
  return rows
    .filter((row) => row.source === 'file' && row.has_audio && !known.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      durationS: row.duration_s ?? 0,
      stems: row.steps_done.includes('separation'),
    }));
}

/** The entries a view lists: all, newest first, or the favorites in order. */
export function entriesFor(state: Pick<LibraryState, 'view' | 'entries'>): LibraryEntry[] {
  return state.view === 'favorites' ? favoritesOf(state.entries) : state.entries;
}

/** 'Source label' for an entry's row. */
export function sourceLabel(entry: Pick<LibraryEntry, 'source'>): string {
  return entry.source === 'youtube' ? 'YouTube' : 'Upload';
}

/** A length as m:ss; '' when it is not known. */
export function lengthLabel(durationS: number): string {
  if (!(durationS > 0)) return '';
  const total = Math.round(durationS);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** When a song was last played, in words ("never" before it was). */
export function playedLabel(lastPlayedAt: number | null, now: number): string {
  if (lastPlayedAt === null) return 'never played';
  const minutes = Math.floor(Math.max(0, now - lastPlayedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The prepared badge: 'Prepared' with the melody when there is one; '' if not. */
export function preparedLabel(entry: Pick<LibraryEntry, 'stems' | 'melody'>): string {
  if (!entry.stems) return '';
  return entry.melody ? 'Prepared, with melody' : 'Prepared';
}

/** "3 takes" and its singular. */
export function takesLabel(count: number): string {
  return `${count} take${count === 1 ? '' : 's'}`;
}

/** What a Library row says about a song, as separate short pieces. */
export interface RowView {
  title: string;
  /** Source, length, last played, takes: the grey line under the title. */
  meta: string[];
  /** The prepared badge's words; '' for a song that is not prepared. */
  prepared: string;
}

/** The words of one Library row. */
export function rowOf(entry: LibraryEntry, takeCount: number, now: number): RowView {
  const length = lengthLabel(entry.durationS);
  const meta = [sourceLabel(entry), ...(length !== '' ? [length] : []), playedLabel(entry.lastPlayedAt, now)];
  if (takeCount > 0) meta.push(takesLabel(takeCount));
  return { title: entry.title, meta, prepared: preparedLabel(entry) };
}

/** "2 of 5" for the favorite playing, or '' when it is not in the list. */
export function playlistPosition(entries: readonly LibraryEntry[], currentId: string | null): string {
  const ids = favoritesOf(entries).map((e) => e.id);
  const at = currentId === null ? -1 : ids.indexOf(currentId);
  return at < 0 ? '' : `${at + 1} of ${ids.length}`;
}
