/**
 * Songs dropped together, in the session. Takes the audio files from a drop or
 * the file picker, adds each to the Library and, when the service runs, sends
 * them to it one at a time so the stems, the key and the melody are ready
 * before the song is ever opened. The first song of a drop loads and plays at
 * once, as a single dropped file always has; its analysis is the stems
 * controller's own (session/stems.ts), and this controller only watches it.
 * The rest are analysed in the background, here, without touching the song in
 * use. Files dropped while the queue runs join its end. The queue's rules and
 * words are pure (src/app/ingest.ts); the panel under the drop zone draws them
 * (panels/ingest.ts). A song that fails is named with a plain reason and the
 * others go on; with no service the songs are still added.
 */
import { hashBytes } from '../../audio/player';
import { isAbortError, ServiceClient, settledThrough } from '../../service/client';
import type { SongStatus } from '../../service/types';
import {
  AUDIO_EXTENSION,
  ingestReducer,
  isAudioFile,
  isBusy,
  nextQueued,
  stageOf,
  UNREADABLE_REASON,
  uploadingStage,
} from '../ingest';
import type { IngestEvent, IngestState } from '../ingest';
import type { KaraokeState } from '../karaoke';
import type { LoadedSong } from '../library';
import { describeFailure, describeServiceError } from '../prepare';
import type { SessionCore } from './core';

/** What the service made for a song, as the Library's badge says it. */
interface Made {
  stems: boolean;
  melody: boolean;
  key: boolean;
}

/** Runs the queue of dropped songs, one at a time. */
export class IngestController {
  // The files waiting their turn, by queue id.
  private readonly files = new Map<number, File>();
  private running = false;
  // Set when the service has not answered, so the rest of the batch does not ask again.
  private serviceDown = false;
  // The queue id of the song loaded as the song in use whose analysis is under
  // way, or null; a lone file dropped meanwhile takes its place (addFiles).
  private foregroundId: number | null = null;
  private readonly controller = new AbortController();

  constructor(private readonly core: SessionCore) {}

  private get state(): IngestState {
    return this.core.store.state.ingest;
  }

  private send(event: IngestEvent): void {
    const next = ingestReducer(this.state, event);
    if (next !== this.state) this.core.store.patch({ ingest: next });
  }

  /**
   * Adds the audio files of a drop to the queue and starts it if it is idle:
   * the first file loads as the song, all of them go to the Library and then
   * to the service. Other files are turned away with a line. Files dropped
   * while the queue runs are appended and do not replace the song in use.
   */
  addFiles(files: readonly File[]): void {
    const audio = files.filter(isAudioFile);
    const other = files.filter((file) => !isAudioFile(file));
    if (audio.length === 0 && other.length === 0) return;
    const idle = !isBusy(this.state);
    // A single file dropped while only the song in use is still being analysed
    // is a plain choice of song: it loads now, as a lone drop always has,
    // and the song it replaces is analysed aside.
    const replacesForeground =
      audio.length === 1 &&
      !idle &&
      this.foregroundId !== null &&
      this.state.items.every(
        (item) => item.id === this.foregroundId || (item.phase !== 'queued' && item.phase !== 'working'),
      );
    const firstId = this.state.nextId;
    this.send({ type: 'add', names: audio.map((file) => file.name) });
    this.send({ type: 'skip', names: other.map((file) => file.name) });
    if (replacesForeground) {
      this.send({ type: 'start', id: firstId });
      void this.foreground(firstId, audio[0]);
      return;
    }
    audio.forEach((file, i) => this.files.set(firstId + i, file));
    if (idle) this.serviceDown = false;
    if (audio.length > 0 && !this.running) void this.drain(idle);
  }

  /**
   * Clears the lines a finished drop left under the drop zone (the failures,
   * the skipped files, the count). Does nothing while songs are being analysed.
   */
  dismiss(): void {
    if (!isBusy(this.state)) this.send({ type: 'clear' });
  }

  /** Stops the queue's calls to the service; the page is going away. */
  dispose(): void {
    this.controller.abort();
  }

  private async drain(loadFirst: boolean): Promise<void> {
    this.running = true;
    try {
      let first = loadFirst;
      while (!this.controller.signal.aborted) {
        const item = nextQueued(this.state);
        if (item === null) break;
        const file = this.files.get(item.id);
        this.files.delete(item.id);
        if (!file) {
          this.send({ type: 'fail', id: item.id, reason: 'The file was no longer there to read.' });
          continue;
        }
        this.send({ type: 'start', id: item.id });
        if (first) {
          first = false;
          await this.foreground(item.id, file);
        } else {
          await this.background(item.id, file);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private progress(id: number, stage: { stage: string; progress: number }): void {
    this.send({ type: 'progress', id, stage: stage.stage, progress: stage.progress });
  }

  /** Loads the file as the song and follows the stems controller's analysis of it. */
  private async foreground(id: number, file: File): Promise<void> {
    this.foregroundId = id;
    try {
      await this.followForeground(id, file);
    } finally {
      if (this.foregroundId === id) this.foregroundId = null;
    }
  }

  private async followForeground(id: number, file: File): Promise<void> {
    const { core } = this;
    const mirror = (karaoke: KaraokeState): void => {
      switch (karaoke.phase) {
        case 'checking':
          this.progress(id, { stage: 'checking the service', progress: 0 });
          break;
        case 'uploading':
          this.progress(id, uploadingStage(karaoke.uploadProgress));
          break;
        case 'preparing':
        case 'loading':
        case 'ready':
          this.progress(id, stageOf(karaoke.steps));
          break;
        default:
          break;
      }
    };
    const token = core.songs.loadToken;
    await core.songs.loadSong(file);
    const run = core.stems.runOf(file);
    if (run === undefined) {
      // Either a newer load took the player first, and the file is analysed
      // aside, or the file would not decode, which the status line explains.
      if (core.songs.loadToken !== token + 1) await this.background(id, file);
      else this.send({ type: 'fail', id, reason: UNREADABLE_REASON });
      return;
    }
    // The song counts as analysed once its melody has settled. The stems
    // controller goes on to the optional backing notes by itself, so waiting
    // for the whole run would hold this song at 100% and the queue behind it.
    let reached = (): void => {};
    const analysed = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const watch = (karaoke: KaraokeState): void => {
      mirror(karaoke);
      if (karaoke.phase === 'ready' && karaoke.steps !== null && settledThrough({ steps: karaoke.steps }, 'reference')) {
        reached();
      }
    };
    const unsubscribe = core.store.subscribe((state, changed) => {
      if (changed.has('karaoke') && !run.replaced()) watch(state.karaoke);
    });
    try {
      if (!run.replaced()) watch(core.store.state.karaoke);
      await Promise.race([run.done, analysed]);
      const { karaoke } = core.store.state;
      if (run.replaced()) {
        // Another song took over before the analysis ended; finish this one aside.
        unsubscribe();
        await this.background(id, file);
      } else if (karaoke.phase === 'failed') {
        this.send({ type: 'fail', id, reason: karaoke.message || 'The service could not analyse it.' });
      } else if (karaoke.phase === 'unavailable') {
        this.serviceDown = true;
        this.send({ type: 'needs-service', id });
      } else {
        this.send({ type: 'finish', id });
      }
    } finally {
      unsubscribe();
    }
  }

  /** Adds the file to the Library and has the service analyse it, without loading it. */
  private async background(id: number, file: File): Promise<void> {
    const { core } = this;
    const { signal } = this.controller;
    try {
      const hash = await hashBytes(new Uint8Array(await file.arrayBuffer()));
      const song = (songId: string): LoadedSong => ({
        id: songId,
        source: 'file',
        title: file.name.replace(AUDIO_EXTENSION, ''),
        videoId: null,
        fileName: file.name,
        durationS: 0,
      });
      await core.library.noteDropped(song(hash), { stems: false, melody: false, key: false });
      if (this.serviceDown) {
        this.send({ type: 'needs-service', id });
        return;
      }
      const client = new ServiceClient({ baseUrl: core.current.serviceUrl });
      if (!(await client.health(signal))) {
        this.serviceDown = true;
        this.send({ type: 'needs-service', id });
        return;
      }
      this.progress(id, uploadingStage(0));
      let status: SongStatus = await client.uploadSong(file, {
        signal,
        onProgress: (fraction) => this.progress(id, uploadingStage(fraction)),
      });
      if (!settledThrough(status, 'reference')) {
        this.progress(id, stageOf(status.steps));
        const outcome = await client.pollSong(status.song_id, {
          through: 'reference',
          signal,
          onUpdate: (update) => this.progress(id, stageOf(update.steps)),
        });
        if (outcome.kind === 'aborted') return;
        if (outcome.kind === 'settled' || outcome.kind === 'failed') status = outcome.status;
      }
      const { steps } = status;
      const made: Made = {
        stems: steps.separation.state === 'done',
        melody: steps.reference.state === 'done',
        key: steps.key.state === 'done',
      };
      await core.library.noteDropped(song(status.song_id), made);
      if (steps.separation.state === 'failed') {
        this.send({ type: 'fail', id, reason: describeFailure(status, 'separation') });
      } else {
        this.send({ type: 'finish', id });
      }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return;
      this.send({ type: 'fail', id, reason: describeServiceError(error) });
    }
  }
}
