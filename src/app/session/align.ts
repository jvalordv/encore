/**
 * Scoring a karaoke track against its original: the run at the service. The
 * singer names an original: a song the service already holds, such as a
 * Library song analysed up front. (A video picked from the search is no longer
 * offered: it would need the service to download it.) The service then aligns
 * the karaoke song to it (`POST /songs/{id}/align`, a job) and this controller follows the job,
 * writing its progress into `state.align`. When the alignment is done the
 * borrowed melody replaces the lane's and Strict scoring applies to the
 * karaoke video; when it is refused (the arrangements differ) or fails, the
 * reason is shown and nothing changes, so the song panel can offer Open.
 *
 * One run at a time, and it belongs to the song in use: another song taking
 * over (`reset`, called by the stems controller) ends it.
 */
import { isAbortError, ServiceClient } from '../../service/client';
import { alignStateOf, initialAlign } from '../align';
import type { AlignState } from '../align';
import { describeServiceError } from '../prepare';
import type { SessionCore } from './core';

/** Said when the karaoke song is not on the service yet. */
export const NO_KARAOKE_SONG =
  'The service does not have this song yet, so there is nothing to match the original against.';
/** Said when the melody was written but could not be brought back. */
export const MELODY_NOT_LOADED = 'The service matched the songs but the melody could not be loaded.';

/** Follows one alignment job at a time for the song in use. */
export class AlignController {
  private controller: AbortController | null = null;

  constructor(private readonly core: SessionCore) {}

  private set(state: Partial<AlignState>): void {
    this.core.store.patch({ align: { ...this.core.store.state.align, ...state } });
  }

  /** Ends any run and clears what the panel says; another song has taken over. */
  reset(): void {
    this.controller?.abort();
    this.controller = null;
    if (this.core.store.state.align.phase !== 'idle') this.core.store.patch({ align: initialAlign() });
  }

  /** A prepared song was picked as the original: aligns to it. */
  async useSong(originalId: string): Promise<void> {
    await this.run((client, signal, karaokeId) => this.align(client, signal, karaokeId, originalId));
  }

  private async run(work: (client: ServiceClient, signal: AbortSignal, karaokeId: string) => Promise<void>): Promise<void> {
    const karaokeId = this.core.stems.songId();
    if (karaokeId === null) {
      this.core.store.patch({ align: { ...initialAlign(), phase: 'failed', message: NO_KARAOKE_SONG } });
      return;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.core.store.patch({ align: { ...initialAlign(), phase: 'working' } });
    const client = new ServiceClient({ baseUrl: this.core.current.serviceUrl });
    try {
      await work(client, controller.signal, karaokeId);
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return;
      this.set({ phase: 'failed', message: describeServiceError(error) });
    }
  }

  /** Asks for the alignment, follows it, and brings the melody in when done. */
  private async align(client: ServiceClient, signal: AbortSignal, karaokeId: string, originalId: string): Promise<void> {
    this.set({ phase: 'working', progress: 0, message: '' });
    await client.alignSong(karaokeId, originalId, signal);
    const result = await client.pollAlignment(karaokeId, {
      signal,
      onUpdate: (alignment) => this.core.store.patch({ align: alignStateOf(alignment) }),
    });
    if (result === null || signal.aborted) return;
    this.core.store.patch({ align: alignStateOf(result) });
    if (result.state !== 'done') return;
    if (!(await this.core.stems.adoptAligned(karaokeId)) && !signal.aborted) {
      this.set({ phase: 'failed', message: MELODY_NOT_LOADED });
    }
  }
}
