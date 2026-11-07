/**
 * The Library and the favorites playlist: remembers each song as it loads,
 * keeps favorites ordered, loads an entry again (a link as a video, an upload
 * back from the service), plays the favorites through with Next, Previous and
 * auto-advance, and moves the list to and from a JSON file. The entries live
 * in a LibraryStore (IndexedDB, src/app/library.ts) and are mirrored into
 * `state.library`, which the panel draws. Writes are queued so a load noting
 * itself and a click on a star never overwrite each other. Nothing here
 * touches a song's takes: removing an entry leaves them with the song.
 */
import { ServiceClient } from '../../service/client';
import { entryAfterLoad, memoryLibraryStore, newestFirst } from '../library';
import type { LibraryEntry, LibraryStore, LoadedSong } from '../library';
import { describeImport, exportFavorites, parseFavorites } from '../library-share';
import { serviceOnly } from '../library-state';
import type { LibraryState, LibraryView } from '../library-state';
import { addFavorite, advanceTarget, favoritesOf, moveFavorite, neighbour, removeFavorite } from '../playlist';
import type { SessionCore } from './core';
import { messageOf } from './helpers';
import { MIC_CHECK_SONG_KEY } from './mic-check';

/** Settings-store key of the auto-advance choice ('off'; anything else is on). */
const AUTO_ADVANCE_KEY = 'autoAdvance';

/** Owns the Library state and the favorites playlist. */
export class LibraryController {
  private entries: LibraryEntry[] = [];
  private readonly ready: Promise<LibraryStore>;
  private chain: Promise<unknown> = Promise.resolve();
  // The favorite being loaded by the playlist; while set, a song change is
  // the playlist's own and does not end it.
  private expected: string | null = null;
  private serviceToken = 0;

  constructor(
    private readonly core: SessionCore,
    store: Promise<LibraryStore>,
  ) {
    const autoAdvance = core.settingsStore.get(AUTO_ADVANCE_KEY) !== 'off';
    core.store.patch({ library: { ...core.store.state.library, autoAdvance } });
    this.ready = store
      .catch(() => memoryLibraryStore())
      .then(async (backing) => {
        this.entries = newestFirst(await backing.list().catch(() => []));
        this.publish();
        void this.refreshCounts();
        return backing;
      });
    core.store.subscribe((state, changed) => {
      if (changed.has('song')) this.onSongChange(state.song?.hash ?? null);
      if (changed.has('karaoke') || changed.has('reference')) this.notePrepared();
      if (changed.has('takes')) void this.refreshCounts();
    });
  }

  private get state(): LibraryState {
    return this.core.store.state.library;
  }

  private set(fields: Partial<LibraryState>): void {
    this.core.store.patch({ library: { ...this.state, ...fields } });
  }

  private publish(): void {
    this.set({ entries: [...this.entries] });
  }

  /** Queues a change to the store, so changes apply one after another. */
  private mutate(work: (store: LibraryStore) => Promise<void>): Promise<void> {
    const run = this.chain.then(async () => work(await this.ready));
    this.chain = run.catch(() => {});
    return run.catch((error: unknown) => {
      this.core.store.setStatus(`The Library could not be saved: ${messageOf(error)}`, 'warn');
    });
  }

  /** Writes changed entries into the list and the store. */
  private async save(store: LibraryStore, changed: readonly LibraryEntry[]): Promise<void> {
    if (changed.length === 0) return;
    const byId = new Map(this.entries.map((e) => [e.id, e]));
    for (const entry of changed) byId.set(entry.id, entry);
    this.entries = newestFirst([...byId.values()]);
    await store.putMany(changed);
    this.publish();
  }

  /** Remembers a song that has just loaded (a new entry, or a refreshed one). */
  noteLoaded(song: LoadedSong): Promise<void> {
    return this.mutate(async (store) => {
      const existing = this.entries.find((e) => e.id === song.id) ?? null;
      await this.save(store, [entryAfterLoad(existing, song, Date.now())]);
      await this.refreshCounts();
    });
  }

  /** Marks the song in use as prepared once its stems or melody arrive. */
  private notePrepared(): void {
    const { song, karaoke, reference } = this.core.store.state;
    const stems = karaoke.phase === 'ready';
    const melody = reference.phase === 'ready';
    const id = song?.hash;
    if (!id || !(stems || melody)) return;
    void this.mutate(async (store) => {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry || ((entry.stems || !stems) && (entry.melody || !melody))) return;
      await this.save(store, [{ ...entry, stems: entry.stems || stems, melody: entry.melody || melody }]);
    });
  }

  /** Counts the saved takes of each song for the list. */
  private async refreshCounts(): Promise<void> {
    try {
      const takes = await (await this.core.takesReady).list();
      const counts: Record<string, number> = {};
      for (const take of takes) {
        if (take.kind === 'mic-check') continue;
        counts[take.songHash] = (counts[take.songHash] ?? 0) + 1;
      }
      this.set({ takeCounts: counts });
    } catch {
      // The count is a nicety; a take store that will not answer leaves it.
    }
  }

  /** Reads the service's songs for the "On the service" group. */
  private async refreshService(): Promise<void> {
    const token = ++this.serviceToken;
    await this.ready;
    const client = new ServiceClient({ baseUrl: this.core.current.serviceUrl });
    let rows: Awaited<ReturnType<ServiceClient['listSongs']>> = [];
    try {
      if (await client.health()) rows = await client.listSongs();
    } catch {
      rows = [];
    }
    if (token === this.serviceToken) this.set({ onService: serviceOnly(rows, this.entries) });
  }

  /** Shows or hides the Library; showing it refreshes what it counts. */
  setOpen(open: boolean): void {
    if (this.state.open === open) return;
    this.set({ open, ...(open ? {} : { notice: '' }) });
    if (open) {
      void this.refreshCounts();
      void this.refreshService();
    }
  }

  /** Chooses the list the panel shows. */
  setView(view: LibraryView): void {
    if (this.state.view !== view) this.set({ view });
  }

  /** Stars an entry, or takes the star off. */
  toggleFavorite(id: string): Promise<void> {
    return this.mutate(async (store) => {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) return;
      await this.save(store, entry.favorite ? removeFavorite(this.entries, id) : addFavorite(this.entries, id));
    });
  }

  /** Moves a favorite one place up or down the playlist. */
  moveFavorite(id: string, step: -1 | 1): Promise<void> {
    return this.mutate((store) => this.save(store, moveFavorite(this.entries, id, step)));
  }

  /** Removes an entry from the Library; its takes stay with the song. */
  removeEntry(id: string): Promise<void> {
    return this.mutate(async (store) => {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) return;
      await this.save(store, removeFavorite(this.entries, id).filter((e) => e.id !== id));
      await store.remove(id);
      this.entries = this.entries.filter((e) => e.id !== id);
      this.set({ notice: `Removed ${entry.title}. Its takes are kept.` });
      this.publish();
      void this.refreshService();
    });
  }

  /**
   * Loads an entry as the song; with `play`, starts it once it is in. True
   * when it is the song afterwards. A failed load leaves the song in use and
   * says why on the status line (an upload needs the service).
   */
  async loadEntry(id: string, options: { play?: boolean } = {}): Promise<boolean> {
    await this.ready;
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return false;
    this.setOpen(false);
    return this.loadThen(entry.id, options.play === true, () =>
      entry.source === 'youtube' && entry.videoId !== null
        ? this.core.songs.loadLink(`https://www.youtube.com/watch?v=${entry.videoId}`)
        : this.core.songs.loadStored(entry.id, entry.fileName ?? entry.title),
    );
  }

  /** Loads an upload that only the service holds. */
  async loadServiceSong(id: string): Promise<boolean> {
    const song = this.state.onService.find((s) => s.id === id);
    if (!song) return false;
    this.setOpen(false);
    return this.loadThen(song.id, false, () => this.core.songs.loadStored(song.id, song.name));
  }

  private async loadThen(id: string, play: boolean, load: () => Promise<void>): Promise<boolean> {
    await load();
    const loaded = this.core.store.state.song?.hash === id;
    if (loaded && play) this.core.playback.play();
    return loaded;
  }

  /** Starts the favorites playlist, from the top or from one entry. */
  async playFavorites(fromId?: string): Promise<void> {
    await this.ready;
    const ids = favoritesOf(this.entries).map((e) => e.id);
    const start = fromId !== undefined && ids.includes(fromId) ? fromId : ids[0];
    if (start === undefined) {
      this.core.store.setStatus('Star some songs first, then play the favorites.');
      return;
    }
    await this.goTo(start);
  }

  /** Plays the next favorite; says so at the end of the list. */
  async next(): Promise<void> {
    await this.step(1, 'That was the last favorite.');
  }

  /** Plays the favorite before this one. */
  async previous(): Promise<void> {
    await this.step(-1, 'This is the first favorite.');
  }

  private async step(by: -1 | 1, atEnd: string): Promise<void> {
    const ids = favoritesOf(this.entries).map((e) => e.id);
    const target = neighbour(ids, this.state.playlist.currentId, by);
    if (target === null) {
      this.core.store.setStatus(atEnd);
      return;
    }
    await this.goTo(target);
  }

  /** Makes `id` the playlist's song: loads it and plays it. */
  private async goTo(id: string): Promise<void> {
    this.expected = id;
    this.set({ playlist: { active: true, currentId: id } });
    try {
      await this.loadEntry(id, { play: true });
    } finally {
      // A later step may have taken over `expected`; only the last one clears.
      if (this.expected === id) {
        this.expected = null;
        // Another load won while this one was in flight, or this one failed.
        if (this.core.store.state.song?.hash !== id) this.stopPlaylist();
      }
    }
  }

  /** The song has ended: on to the next favorite when the playlist runs on. */
  songEnded(): void {
    const { playlist, autoAdvance } = this.state;
    if (!playlist.active || !autoAdvance) return;
    if (this.core.store.state.song?.hash !== playlist.currentId) return;
    const ids = favoritesOf(this.entries).map((e) => e.id);
    const target = advanceTarget(ids, playlist.currentId, playlist.active, autoAdvance);
    if (target === null) {
      this.core.store.setStatus('The favorites are finished.');
      return;
    }
    void this.goTo(target);
  }

  /** A different song became the one in use; the playlist ends unless it is its own. */
  private onSongChange(hash: string | null): void {
    const { playlist } = this.state;
    if (!playlist.active || this.expected !== null) return;
    // A Mic check borrows the song for a moment and puts it back.
    if (hash === MIC_CHECK_SONG_KEY) return;
    if (hash !== playlist.currentId) this.set({ playlist: { active: false, currentId: null } });
  }

  /** Ends the playlist; the song in use plays on. */
  stopPlaylist(): void {
    if (this.state.playlist.active) this.set({ playlist: { active: false, currentId: null } });
  }

  /** Turns moving on to the next favorite at a song's end on or off. */
  setAutoAdvance(on: boolean): void {
    this.core.settingsStore.set(AUTO_ADVANCE_KEY, on ? 'on' : 'off');
    this.set({ autoAdvance: on });
  }

  /** The favorites as the text of an export file; null when there are none. */
  exportText(): string | null {
    return favoritesOf(this.entries).length === 0 ? null : exportFavorites(this.entries);
  }

  /** Adds the favorites in an export file; answers with what to tell the singer. */
  async importText(text: string): Promise<string> {
    const parsed = parseFavorites(text);
    if (parsed.error !== null) {
      this.set({ notice: parsed.error });
      return parsed.error;
    }
    await this.refreshService();
    const known = new Set(this.entries.map((e) => e.id));
    const onService = new Set(this.state.onService.map((s) => s.id));
    const missing = parsed.songs.filter((s) => s.source === 'file' && !known.has(s.id) && !onService.has(s.id));
    await this.mutate(async (store) => {
      const work = new Map(this.entries.map((e) => [e.id, { ...e }]));
      let place = favoritesOf(this.entries).length;
      const touched = new Set<string>();
      for (const song of parsed.songs) {
        let entry = work.get(song.id);
        if (!entry) {
          entry = { ...entryAfterLoad(null, song, Date.now()), lastPlayedAt: null };
          work.set(song.id, entry);
          touched.add(song.id);
        }
        if (!entry.favorite) {
          entry.favorite = true;
          entry.order = place++;
          touched.add(song.id);
        }
      }
      await this.save(store, [...touched].map((id) => work.get(id)!));
    });
    const message = describeImport(parsed.songs.length, parsed.skipped, missing.length);
    this.set({ notice: message });
    void this.refreshService();
    return message;
  }

  /** Clears the line the last import, export or removal left. */
  clearNotice(): void {
    if (this.state.notice !== '') this.set({ notice: '' });
  }
}
