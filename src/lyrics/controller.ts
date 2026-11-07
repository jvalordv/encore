/**
 * The lyrics of the song in use: which text is loaded, the lookup in flight,
 * the title and artist the singer may correct, and the nudge and show/hide
 * choices. It has no DOM; src/app/panels/lyrics.ts draws it and feeds it the
 * song. Lyrics are only fetched when the singer asks (Find lyrics), or read
 * from the per-song cache when the song comes back. Importing only: nothing
 * here listens to or transcribes the singing.
 */
import { hasStamps, parseLrc, parsePlain, viewAt } from './lrc';
import type { LyricLine, LyricView } from './lrc';
import { LyricsError } from './lrclib';
import type { LrclibClient } from './lrclib';
import type { LyricsRecord, LyricsStore } from './store';
import { guessTitle } from './title';
import type { TitleGuess } from './title';

/** Seconds one press of the nudge buttons moves the lines. */
export const NUDGE_STEP_S = 0.1;
/** The nudge stays within this many seconds either way. */
const NUDGE_MAX_S = 10;

/** The song the lyrics are for. */
export interface LyricsSong {
  hash: string;
  name: string;
  durationS: number;
}

/** Where the lookup stands. */
export type LyricsPhase = 'idle' | 'searching' | 'ready' | 'missing' | 'error';

/** What the panel draws. */
export interface LyricsState {
  song: LyricsSong | null;
  query: TitleGuess;
  phase: LyricsPhase;
  message: string;
  record: LyricsRecord | null;
}

/** Whether the lane line should show: the singer's choice, else the default. */
export function lyricsShown(record: LyricsRecord | null, karaokeTrack: boolean): boolean {
  if (record === null || !record.synced) return false;
  return record.shown ?? !karaokeTrack;
}

type Listener = () => void;

/** Owns one song's lyrics and talks to the cache and LRCLIB. */
export class LyricsController {
  private current: LyricsState = {
    song: null,
    query: { title: '', artist: '' },
    phase: 'idle',
    message: '',
    record: null,
  };
  private lines: LyricLine[] = [];
  private token = 0;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly store: LyricsStore,
    private readonly client: LrclibClient,
  ) {}

  /** The state as drawn. */
  get state(): Readonly<LyricsState> {
    return this.current;
  }

  /** Registers a listener for any change; returns its remover. */
  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The current and next line at song time `t`, nudge included. */
  viewAt(t: number): LyricView {
    const record = this.current.record;
    return viewAt(this.lines, t + (record?.nudgeS ?? 0));
  }

  /** The plain lyrics to show unfollowed, or [] when the text is synced. */
  plainLines(): string[] {
    const record = this.current.record;
    return record && !record.synced ? parsePlain(record.text) : [];
  }

  /** Switches to a song (or none): reads its cache and guesses its name. */
  async select(song: LyricsSong | null): Promise<void> {
    if (song && song.hash === this.current.song?.hash) {
      // An embed publishes length 0 first; keep the record, take the news.
      this.set({ song: { ...this.current.song, name: song.name, durationS: song.durationS } });
      return;
    }
    if (!song && !this.current.song) return;
    const token = ++this.token;
    this.lines = [];
    this.set({
      song,
      query: song ? guessTitle(song.name) : { title: '', artist: '' },
      phase: 'idle',
      message: '',
      record: null,
    });
    if (!song) return;
    const cached = await this.store.get(song.hash).catch(() => null);
    if (token !== this.token || !cached) return;
    this.adopt(cached);
  }

  /** Replaces the title and artist the lookup will use. */
  setQuery(query: TitleGuess): void {
    this.set({ query });
  }

  /** Looks the song up on LRCLIB and keeps what it finds. */
  async find(): Promise<void> {
    const song = this.current.song;
    if (!song) return;
    const token = ++this.token;
    this.set({ phase: 'searching', message: 'Looking up lyrics…' });
    try {
      const durationS = song.durationS > 0 ? song.durationS : undefined;
      const found = await this.client.find({ ...this.current.query, durationS });
      if (token !== this.token) return;
      if (!found) {
        this.set({ phase: 'missing', message: 'LRCLIB has no lyrics for that. Check the spelling or paste them.' });
        return;
      }
      const synced = found.synced !== null && parseLrc(found.synced).length > 0;
      await this.keep({
        songHash: song.hash,
        text: synced ? (found.synced ?? '') : (found.plain ?? found.synced ?? ''),
        synced,
        source: 'lrclib',
        title: found.title,
        artist: found.artist,
        nudgeS: 0,
        shown: this.current.record?.shown,
      });
      if (token !== this.token) return;
      this.set({ message: synced ? '' : 'Only plain lyrics exist for this song; they are shown without timing.' });
    } catch (error) {
      if (token !== this.token) return;
      const message = error instanceof LyricsError ? error.message : 'The lyrics lookup failed.';
      this.set({ phase: 'error', message });
    }
  }

  /** Reads pasted or dropped text: LRC when it has stamps, else plain. */
  async importText(text: string): Promise<void> {
    const song = this.current.song;
    if (!song) return;
    const trimmed = text.trim();
    if (trimmed === '') {
      this.set({ phase: 'error', message: 'There is no text to read.' });
      return;
    }
    const synced = hasStamps(trimmed) && parseLrc(trimmed).length > 0;
    this.token++;
    await this.keep({
      songHash: song.hash,
      text: trimmed,
      synced,
      source: 'pasted',
      title: this.current.query.title,
      artist: this.current.query.artist,
      nudgeS: 0,
      shown: this.current.record?.shown,
    });
    this.set({ message: synced ? '' : 'No timing in that text; it is shown without following the song.' });
  }

  /** Says why a file or text was turned away, changing nothing else. */
  reject(message: string): void {
    this.set({ phase: 'error', message });
  }

  /** Shows or hides the lane line for this song and remembers the choice. */
  async setShown(shown: boolean): Promise<void> {
    await this.update({ shown });
  }

  /** Moves the lines `deltaS` sooner (+) or later (-), remembered per song. */
  async nudge(deltaS: number): Promise<void> {
    const record = this.current.record;
    if (!record) return;
    const next = Math.round((record.nudgeS + deltaS) * 100) / 100;
    await this.update({ nudgeS: Math.max(-NUDGE_MAX_S, Math.min(NUDGE_MAX_S, next)) });
  }

  /** Forgets this song's lyrics. */
  async clear(): Promise<void> {
    const song = this.current.song;
    if (!song) return;
    this.token++;
    this.lines = [];
    this.set({ phase: 'idle', message: '', record: null });
    await this.store.remove(song.hash).catch(() => undefined);
  }

  private async update(patch: Partial<LyricsRecord>): Promise<void> {
    const record = this.current.record;
    if (!record) return;
    const next = { ...record, ...patch };
    this.set({ record: next });
    await this.store.put(next).catch(() => undefined);
  }

  private async keep(record: LyricsRecord): Promise<void> {
    this.adopt(record);
    await this.store.put(record).catch(() => undefined);
  }

  private adopt(record: LyricsRecord): void {
    this.lines = record.synced ? parseLrc(record.text) : [];
    this.set({ record, phase: 'ready', message: '' });
  }

  private set(patch: Partial<LyricsState>): void {
    this.current = { ...this.current, ...patch };
    for (const l of [...this.listeners]) l();
  }
}
